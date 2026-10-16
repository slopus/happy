package com.slopus.happy.ui.home

import com.slopus.happy.attachments.AttachmentNotice
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.BotRequest
import com.slopus.happy.model.Machine
import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.RigModeOption
import com.slopus.happy.model.RigModelOption
import com.slopus.happy.model.RigSpawnException
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionType
import com.slopus.happy.model.Settings
import com.slopus.happy.model.SpawnTargetOverride
import com.slopus.happy.model.StartPhase
import com.slopus.happy.model.UnavailableWorkspaceException
import com.slopus.happy.model.WorktreeSelection
import com.slopus.happy.model.collectMachineChoices
import com.slopus.happy.model.collectSessionPlaces
import com.slopus.happy.model.collectSessionWorkspaces
import com.slopus.happy.model.describeBotNameProblem
import com.slopus.happy.model.findMachineChoice
import com.slopus.happy.model.resolveAbsolutePath
import com.slopus.happy.model.resolveAgentMachine
import com.slopus.happy.model.resolveHappyAgentSpawnTarget
import com.slopus.happy.model.resolveNewSessionAgent
import com.slopus.happy.model.resolveRigPendingRetryDelayMs
import com.slopus.happy.model.resolveWorktreeCreationMachine
import com.slopus.happy.model.rigSessionCreation
import com.slopus.happy.model.settings.AgentDefaults
import com.slopus.happy.model.spawnConfiguration
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.HappyAgentSpawnTarget
import com.slopus.happy.sync.SpawnSessionOptions
import com.slopus.happy.sync.SpawnSessionResult
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Why a start was refused before anything was asked of a machine (useStartSessionFromDraft's alerts). */
enum class StartRefusal(val message: String) {
    NoMachine("Please select a machine"),
    UnknownMachine("This session’s computer is not registered with this account, so nothing can start a session on it. Check that Happy is running there and signed in to this account."),
    HappyAgentMissing("Happy Agent is not running on this computer"),
    HappyCliMissing("Happy CLI is not available on your computer. Run `happy daemon start` on your computer, then try again."),
    HappyAgentOffline("Machine is offline"),
    HappyCliOffline("Happy CLI is offline on your computer. Run `happy daemon start` on your computer, then try again."),
    CannotStartHappyAgent("This machine cannot start Happy agent sessions"),
    ProjectNeedsHappyAgent("Only Happy Agent knows where this project is, so no other harness can open it. Switch the harness back to Happy Agent, or pick the project’s folder."),
    WorkspaceUnavailable("The selected Happy Agent workspace is no longer available."),
    BotsUnsupported("Happy Agent on this computer cannot create bots yet. Update it and try again."),
}

sealed interface StartResult {
    /** [notices]: what the first message's images ran into (an upload that failed). */
    data class Started(
        val sessionId: String,
        val notices: List<AttachmentNotice> = emptyList(),
        /** A bot that came without its face: offerBotFaceRetry. */
        val faceFailure: BotFaceFailure? = null,
    ) : StartResult
    data class Refused(val refusal: StartRefusal) : StartResult
    /** The machine, git or the server said no; [message] in their words. */
    data class Failed(val message: String) : StartResult
    /** The session is there but the first message is not: the agent takes no images. Send again reuses it. */
    data class NotSent(val notices: List<AttachmentNotice>) : StartResult
    /** Stopped, declined, or nothing to send. */
    data object Abandoned : StartResult
}

private const val MAX_PENDING_RESULTS = 20

/** git said no to the worktree; the message is git's. */
private class WorktreeException(message: String) : Exception(message)
private const val CONFIGURATION_UNAVAILABLE = "The selected agent configuration is unavailable"

/**
 * useStartSessionFromDraft: everything between Send and the new session's
 * screen. The draft is resolved again against the computer as it is now (a
 * stale Claude pick never spawns Claude where only Codex runs), a worktree
 * is created if asked for, the machine is asked for the session (pending
 * answers are retried, a missing directory is offered to be created), the
 * session is awaited, the prompt sent, and the draft's text cleared if it
 * wasn't edited meanwhile. [phase] says which wait is on. [cancel] hands
 * the composer back at once; a session that arrives afterwards is stopped.
 */
class SessionStarter(
    private val machines: () -> List<Machine>,
    private val sessions: () -> List<Session>,
    private val settings: () -> Settings,
    private val drafts: NewSessionDraftStore,
    private val machineActions: MachineActions,
    private val sessionActions: SessionActions,
    private val sender: FirstMessageSender,
    /** sync.ensureSessionReady: true once the session is in the store. */
    private val awaitSession: suspend (String) -> Boolean,
    private val scope: CoroutineScope,
    private val faces: BotFaceWearer = BotFaceWearer { _, _ -> BotFaceFailure(BotFaceLeg.Painting, "No faces here") },
    private val requestId: () -> String = { UUID.randomUUID().toString() },
) {
    private val phaseState = MutableStateFlow<StartPhase?>(null)
    val phase: StateFlow<StartPhase?> = phaseState.asStateFlow()

    private var run: Job? = null
    private val requestIds = HashMap<String, String>()

    /** Sessions made for a start whose message did not go out: pressing Send again reuses them. */
    private val createdSessions = HashMap<String, String>()

    fun cancel() {
        val current = run ?: return
        run = null
        phaseState.value = null
        current.cancel()
    }

    /**
     * Starts from the stored draft, or from [draft] when a caller names its
     * own place, with [attachments] going out with the first message.
     * [target] is a Happy Agent destination the caller already knows (a
     * chat opened beside another), used instead of resolving the draft's.
     * [bot] makes a bot on the draft's computer instead: Happy Agent's, with
     * no first message, then the face. [confirmDirectory] asks whether to
     * create a missing directory.
     */
    suspend fun start(
        draft: NewSessionDraft = drafts.draft.value,
        attachments: List<AttachmentPreview> = emptyList(),
        target: SpawnTargetOverride? = null,
        bot: BotRequest? = null,
        confirmDirectory: suspend (String) -> Boolean,
    ): StartResult {
        if (run != null) return StartResult.Abandoned
        bot?.let { request -> describeBotNameProblem(request.name)?.let { return StartResult.Failed(it) } }
        val prepared = when (val result = prepare(draft, target, bot)) {
            is Prepared.Refused -> return StartResult.Refused(result.refusal)
            is Prepared.Unavailable -> return StartResult.Failed(result.message)
            is Prepared.Ready -> result
        }
        val outcome = CompletableDeferred<StartResult>()
        val job = scope.launch {
            outcome.complete(
                try {
                    execute(prepared, draft, if (bot != null) emptyList() else attachments, confirmDirectory)
                } catch (e: CancellationException) {
                    StartResult.Abandoned
                } catch (e: Exception) {
                    StartResult.Failed(e.message ?: "Failed to start session")
                },
            )
        }
        run = job
        job.invokeOnCompletion {
            if (!outcome.isCompleted) outcome.complete(StartResult.Abandoned)
            if (run === job) {
                run = null
                phaseState.value = null
            }
        }
        return outcome.await()
    }

    private sealed interface Prepared {
        data class Refused(val refusal: StartRefusal) : Prepared
        data class Unavailable(val message: String) : Prepared
        data class Ready(
            val machine: Machine,
            val agent: AgentType,
            val options: SpawnSessionOptions,
            val worktreeMachine: Machine?,
            val worktreeNew: Boolean,
            val publishedRetryAfterMs: Long?,
            val signature: String,
            /** The code agent's picks, pinned on the session before the send; Happy Agent's ride the spawn. */
            val modes: Map<AgentModeField, String?>?,
            val bot: BotRequest? = null,
        ) : Prepared
    }

    /** One pick with its fallbacks, as the hook's resolveOption: the first known key, else the first option. */
    private fun <T> resolveOption(options: List<T>, key: (T) -> String, preferred: List<String?>): T? =
        preferred.firstNotNullOfOrNull { wanted -> wanted?.let { options.find { option -> key(option) == wanted } } } ?: options.firstOrNull()

    private fun prepare(draft: NewSessionDraft, targetOverride: SpawnTargetOverride?, bot: BotRequest? = null): Prepared {
        val machines = machines()
        val choice = findMachineChoice(collectMachineChoices(machines), draft.selectedMachineId)
            ?: return Prepared.Refused(if (draft.selectedMachineId != null) StartRefusal.UnknownMachine else StartRefusal.NoMachine)
        // A bot is Happy Agent's to make, whatever harness the draft last chose.
        val agent = if (bot != null) AgentType.Rig else resolveNewSessionAgent(choice, draft.agentType, draft.pickedAgentType)
        val agentChanged = agent != draft.agentType
        val rig = agent == AgentType.Rig
        val machine = resolveAgentMachine(choice, agent)
            ?: return Prepared.Refused(if (rig) StartRefusal.HappyAgentMissing else StartRefusal.HappyCliMissing)
        if (!machine.isOnline) return Prepared.Refused(if (rig) StartRefusal.HappyAgentOffline else StartRefusal.HappyCliOffline)
        val rigCreation = if (rig) machine.metadata.rigSessionCreation() ?: return Prepared.Refused(StartRefusal.CannotStartHappyAgent) else null
        if (bot != null && rigCreation?.supportsBots != true) return Prepared.Refused(StartRefusal.BotsUnsupported)

        val draftProjectId = draft.selectedProjectId?.trim()?.takeIf { it.isNotEmpty() }
        if (bot == null && draftProjectId != null && !rig) return Prepared.Refused(StartRefusal.ProjectNeedsHappyAgent)

        val selectedPath = draft.selectedPath?.trim()?.takeIf { it.isNotEmpty() } ?: "~"
        val directory = resolveAbsolutePath(selectedPath, machine.metadata?.homeDir)
        val sessions = sessions()
        val selectedProjectId = draftProjectId
            ?: collectSessionPlaces(choice.machineIds, sessions, selectedPath).find { it.path == selectedPath }?.projectId
        val requestedWorktree = if (draft.sessionType == SessionType.Worktree) draft.worktreeKey ?: WorktreeSelection.NEW else WorktreeSelection.NONE
        // A bot is its own destination, settled before the workspace routes are consulted.
        val target = if (bot != null) {
            HappyAgentSpawnTarget.Bot(bot.name)
        } else if (rig && targetOverride != null) {
            targetOverride.target
        } else if (rig) {
            try {
                resolveHappyAgentSpawnTarget(selectedProjectId, requestedWorktree, collectSessionWorkspaces(choice.machineIds, selectedProjectId, sessions))
            } catch (_: UnavailableWorkspaceException) {
                return Prepared.Refused(StartRefusal.WorkspaceUnavailable)
            }
        } else {
            null
        }
        val supportsWorktrees = rigCreation?.supportsWorktrees ?: (agent != AgentType.OpenClaw)
        val worktreeMachine = if (target != null) null else resolveWorktreeCreationMachine(choice, agent, supportsWorktrees)
        val worktree = if (target == null && worktreeMachine == null && requestedWorktree == WorktreeSelection.NEW) WorktreeSelection.NONE else requestedWorktree
        val spawnDirectory = if (worktree != WorktreeSelection.NONE && worktree != WorktreeSelection.NEW && target == null) worktree else directory

        var modes: Map<AgentModeField, String?>? = null
        val options = if (rigCreation != null) {
            // Happy Agent's own catalog: what the machine published, the draft's picks where it still offers them.
            val model = resolveOption(rigCreation.models, RigModelOption::key, if (agentChanged) listOf(rigCreation.defaultModelKey) else listOf(draft.modelMode, rigCreation.defaultModelKey))
            val permission = resolveOption(
                rigCreation.permissionModes,
                RigModeOption::key,
                if (agentChanged) listOf(rigCreation.defaultPermissionMode) else listOf(draft.permissionMode, rigCreation.defaultPermissionMode),
            )
            if (model == null || permission == null) return Prepared.Unavailable(CONFIGURATION_UNAVAILABLE)
            val effortDefault = rigCreation.defaultEffortForModel(model.key)
            val effort = resolveOption(rigCreation.effortsForModel(model.key), { it }, if (agentChanged) listOf(effortDefault) else listOf(draft.effortLevel, effortDefault))
            val config = try {
                rigCreation.spawnConfiguration(model.key, permission.key, effort)
            } catch (e: RigSpawnException) {
                return Prepared.Unavailable(e.message ?: CONFIGURATION_UNAVAILABLE)
            }
            SpawnSessionOptions(
                machineId = machine.id,
                directory = spawnDirectory,
                agent = agent.wire,
                permissionMode = config.permissionMode,
                providerId = config.providerId,
                modelId = config.modelId,
                effort = config.effort,
                happyAgentTarget = target,
            )
        } else {
            // The code agents take the user's defaults over the code's.
            val defaults = AgentDefaults.resolve(settings().agentDefaultOverrides, agent.wire, machine.metadata?.happyCliVersion)
            val permission = if (agentChanged) defaults.permissionMode else draft.permissionMode ?: defaults.permissionMode
            val model = if (agentChanged) defaults.modelMode else AgentDefaults.retireModelMode(agent.wire, draft.modelMode) ?: defaults.modelMode
            val effort = if (agentChanged) defaults.effortLevel else draft.effortLevel ?: defaults.effortLevel
            // Pinned as launched: a later change of defaults must not rewrite this session's mode.
            modes = mapOf(
                AgentModeField.PERMISSION_MODE to permission,
                AgentModeField.MODEL_MODE to model,
                AgentModeField.EFFORT_LEVEL to effort,
            )
            SpawnSessionOptions(
                machineId = machine.id,
                directory = spawnDirectory,
                agent = agent.wire,
                // Codex's Default is a concrete ask-first policy, not the absence of one.
                permissionMode = permission.takeIf { agent == AgentType.Codex || it != "default" },
                modelMode = model.takeIf { it != "default" },
                effortLevel = effort,
            )
        }
        val signature = listOf(
            machine.id, agent.wire, draftProjectId?.let { "project:$it" } ?: selectedPath, worktree,
            options.modelMode ?: options.modelId, options.permissionMode, options.effortLevel ?: options.effort,
            bot?.let { "bot:${it.name}:${it.faceSeed}" },
        ).joinToString("\u0000")
        return Prepared.Ready(
            machine = machine,
            agent = agent,
            options = options.copy(clientRequestId = requestIds.getOrPut(signature, requestId)),
            worktreeMachine = worktreeMachine,
            worktreeNew = worktree == WorktreeSelection.NEW && target == null,
            publishedRetryAfterMs = rigCreation?.pendingRetryAfterMs,
            signature = signature,
            modes = modes,
            bot = bot,
        )
    }

    private suspend fun execute(
        prepared: Prepared.Ready,
        draft: NewSessionDraft,
        attachments: List<AttachmentPreview>,
        confirmDirectory: suspend (String) -> Boolean,
    ): StartResult {
        val sessionId = createdSessions[prepared.signature] ?: when (val spawned = create(prepared, confirmDirectory)) {
            is SpawnSessionResult.Success -> spawned.sessionId
            is SpawnSessionResult.Error -> return StartResult.Failed(spawned.errorMessage)
            is SpawnSessionResult.Pending -> return StartResult.Failed("The session was created, but it is still syncing. It should appear shortly.")
            is SpawnSessionResult.RequestToApproveDirectoryCreation -> return StartResult.Abandoned
        }
        phaseState.value = StartPhase.Opening
        val job = currentCoroutineContext()[Job]
        var notices = emptyList<AttachmentNotice>()
        var faceFailure: BotFaceFailure? = null
        try {
            if (!awaitSession(sessionId)) {
                createdSessions.remove(prepared.signature)
                requestIds.remove(prepared.signature)
                return StartResult.Failed("Failed to start session")
            }
            prepared.modes?.let { sender.pinModes(sessionId, it) }
            // A face that cannot be painted or delivered is no reason to lose the bot: it opens without one.
            prepared.bot?.let { bot ->
                phaseState.value = StartPhase.Avatar
                faceFailure = faces.wear(sessionId, bot.faceSeed)
                phaseState.value = StartPhase.Opening
            }
            // A bot takes no first message: the prompt typed for a session stays in the draft.
            val prompt = if (prepared.bot != null) "" else draft.input.trim()
            val sent = try {
                if (prompt.isEmpty() && attachments.isEmpty()) FirstSend(true) else sender.send(sessionId, prompt, attachments) { job?.isActive != false }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The session is kept for the next Send rather than spawned again.
                createdSessions[prepared.signature] = sessionId
                throw e
            }
            if (!sent.sent) {
                createdSessions[prepared.signature] = sessionId
                return if (sent.notices.isEmpty()) StartResult.Abandoned else StartResult.NotSent(sent.notices)
            }
            notices = sent.notices
        } catch (e: CancellationException) {
            createdSessions.remove(prepared.signature)
            scope.launch { stopAbandoned(prepared, sessionId) }
            throw e
        }
        createdSessions.remove(prepared.signature)
        requestIds.remove(prepared.signature)
        // Only what was consumed is cleared: text typed meanwhile stays.
        if (prepared.bot == null) drafts.change { current -> if (current.input == draft.input) current.copy(input = "") else current }
        return StartResult.Started(sessionId, notices, faceFailure)
    }

    /** The worktree, if one is asked for, then the spawn. */
    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun create(prepared: Prepared.Ready, confirmDirectory: suspend (String) -> Boolean): SpawnSessionResult {
        var options = prepared.options
        if (prepared.worktreeNew) {
            phaseState.value = StartPhase.Worktree
            when (val created = machineActions.createWorktree(prepared.worktreeMachine!!.id, options.directory)) {
                is WorktreeOutcome.Failed -> throw WorktreeException(created.message)
                is WorktreeOutcome.Created -> options = options.copy(directory = created.path)
            }
        }
        phaseState.value = StartPhase.Spawning
        // The spawn outlives a Stop: whatever it hands back afterwards is put down.
        val spawning = scope.async { spawn(options, prepared.publishedRetryAfterMs, confirmDirectory) }
        val spawned = try {
            spawning.await()
        } catch (e: CancellationException) {
            requestIds.remove(prepared.signature)
            spawning.invokeOnCompletion { error ->
                if (error == null) {
                    (spawning.getCompleted() as? SpawnSessionResult.Success)?.let { scope.launch { stopAbandoned(prepared, it.sessionId) } }
                }
            }
            throw e
        }
        return spawned
    }

    private suspend fun spawn(options: SpawnSessionOptions, publishedRetryAfterMs: Long?, confirmDirectory: suspend (String) -> Boolean): SpawnSessionResult {
        var result = machineActions.spawnSession(options)
        var pending = 0
        while (result is SpawnSessionResult.Pending && pending < MAX_PENDING_RESULTS) {
            pending++
            delay(resolveRigPendingRetryDelayMs(result.retryAfterMs, publishedRetryAfterMs))
            result = machineActions.spawnSession(options)
        }
        if (result is SpawnSessionResult.RequestToApproveDirectoryCreation) {
            return if (confirmDirectory(result.directory)) {
                spawn(options.copy(approvedNewDirectoryCreation = true), publishedRetryAfterMs, confirmDirectory)
            } else {
                result
            }
        }
        return result
    }

    /**
     * A session nobody is waiting for. Happy Agent's is killed; Happy CLI's
     * daemon is asked first, then the session, then the server retires it.
     */
    private suspend fun stopAbandoned(prepared: Prepared.Ready, sessionId: String) {
        if (prepared.agent == AgentType.Rig) {
            sessionActions.kill(sessionId)
            return
        }
        if (machineActions.stopSession(prepared.machine.id, sessionId).success) return
        if (sessionActions.kill(sessionId).success) return
        sessionActions.archiveOnServer(sessionId)
    }
}

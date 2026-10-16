package com.slopus.happy.ui.home

import android.content.SharedPreferences
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.HappyAgentSpawnTarget
import com.slopus.happy.model.Machine
import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionType
import com.slopus.happy.model.Settings
import com.slopus.happy.model.StartPhase
import com.slopus.happy.model.UnavailableWorkspaceException
import com.slopus.happy.model.WorktreeSelection
import com.slopus.happy.model.collectMachineChoices
import com.slopus.happy.model.collectSessionPlaces
import com.slopus.happy.model.collectSessionWorkspaces
import com.slopus.happy.model.findMachineChoice
import com.slopus.happy.model.isRigMachine
import com.slopus.happy.model.resolveAbsolutePath
import com.slopus.happy.model.resolveAgentMachine
import com.slopus.happy.model.resolveHappyAgentSpawnTarget
import com.slopus.happy.model.resolveNewSessionAgent
import com.slopus.happy.model.resolveWorktreeCreationMachine
import com.slopus.happy.model.settings.AgentDefaults
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

/** ops.ts machineSpawnNewSession's request, before the RPC layer shapes it for Happy CLI or Happy Agent. */
data class SpawnRequest(
    val machineId: String,
    val agent: AgentType,
    val directory: String,
    val approvedNewDirectoryCreation: Boolean,
    val permissionMode: String?,
    val modelMode: String?,
    val effortLevel: String?,
    val happyAgentTarget: HappyAgentSpawnTarget?,
    /** Kept across retries of the same request, so a second press is deduplicated by Happy Agent. */
    val clientRequestId: String,
)

/** ops.ts SpawnSessionResult */
sealed interface SpawnOutcome {
    data class Success(val sessionId: String) : SpawnOutcome
    data class Error(val message: String) : SpawnOutcome
    data class Pending(val retryAfterMs: Long?) : SpawnOutcome
    data class ApproveDirectory(val directory: String) : SpawnOutcome
}

sealed interface WorktreeOutcome {
    data class Created(val path: String) : WorktreeOutcome
    data class Failed(val message: String?) : WorktreeOutcome
}

/** The machine RPCs the home screens run (ops.ts). A seam until Sync's RPC lands. */
interface MachineActions {
    suspend fun spawnSession(request: SpawnRequest): SpawnOutcome
    suspend fun createWorktree(machineId: String, basePath: String): WorktreeOutcome
    suspend fun stopSession(machineId: String, sessionId: String): ActionResult
    suspend fun stopDaemon(machineId: String): ActionResult

    /** No socket yet: nothing can be asked of a machine. */
    object Unavailable : MachineActions {
        private const val NO_CONNECTION = "Not connected to the machine"
        override suspend fun spawnSession(request: SpawnRequest): SpawnOutcome = SpawnOutcome.Error(NO_CONNECTION)
        override suspend fun createWorktree(machineId: String, basePath: String): WorktreeOutcome = WorktreeOutcome.Failed(NO_CONNECTION)
        override suspend fun stopSession(machineId: String, sessionId: String): ActionResult = ActionResult.Failure(null)
        override suspend fun stopDaemon(machineId: String): ActionResult = ActionResult.Failure(null)
    }
}

/** The chat's sendMessage for a new session's first message. A seam until the chat lands. */
fun interface FirstMessageSender {
    /** True once the server accepted the message. */
    suspend fun send(sessionId: String, text: String): Boolean
}

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
}

sealed interface StartResult {
    data class Started(val sessionId: String) : StartResult
    data class Refused(val refusal: StartRefusal) : StartResult
    /** The machine, git or the server said no; [message] in their words. */
    data class Failed(val message: String) : StartResult
    /** Stopped, declined, or nothing to send. */
    data object Abandoned : StartResult
}

/** persistence.ts's draft under `new-session-draft-v1`, published as it changes. */
class NewSessionDraftStore(private val prefs: SharedPreferences, private val clock: () -> Long = System::currentTimeMillis) {
    private val state = MutableStateFlow(NewSessionDraft.parse(prefs.getString(KEY, null)) ?: NewSessionDraft())
    val draft: StateFlow<NewSessionDraft> = state.asStateFlow()

    @Synchronized
    fun change(transform: (NewSessionDraft) -> NewSessionDraft) {
        val next = transform(state.value)
        if (next == state.value) return
        val stamped = next.copy(updatedAt = clock())
        prefs.edit().putString(KEY, stamped.toJson().toString()).apply()
        state.value = stamped
    }

    companion object {
        const val PREFS_NAME = "new-session"
        const val KEY = "new-session-draft-v1"
    }
}

private const val MAX_PENDING_RESULTS = 20
private const val DEFAULT_PENDING_RETRY_MS = 1_000L

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
    private val requestId: () -> String = { UUID.randomUUID().toString() },
) {
    private val phaseState = MutableStateFlow<StartPhase?>(null)
    val phase: StateFlow<StartPhase?> = phaseState.asStateFlow()

    private var run: Job? = null
    private val requestIds = HashMap<String, String>()

    fun cancel() {
        val current = run ?: return
        run = null
        phaseState.value = null
        current.cancel()
    }

    /**
     * Starts from the stored draft, or from [draft] when a caller names its
     * own place. [confirmDirectory] asks whether to create a missing one.
     */
    suspend fun start(
        draft: NewSessionDraft = drafts.draft.value,
        confirmDirectory: suspend (String) -> Boolean,
    ): StartResult {
        if (run != null) return StartResult.Abandoned
        val prepared = when (val result = prepare(draft)) {
            is Prepared.Refused -> return StartResult.Refused(result.refusal)
            is Prepared.Ready -> result
        }
        val outcome = CompletableDeferred<StartResult>()
        val job = scope.launch {
            outcome.complete(
                try {
                    execute(prepared, draft, confirmDirectory)
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
        data class Ready(
            val machine: Machine,
            val agent: AgentType,
            val request: SpawnRequest,
            val worktreeMachine: Machine?,
            val worktreeNew: Boolean,
            val signature: String,
        ) : Prepared
    }

    private fun prepare(draft: NewSessionDraft): Prepared {
        val machines = machines()
        val choice = findMachineChoice(collectMachineChoices(machines), draft.selectedMachineId)
            ?: return Prepared.Refused(if (draft.selectedMachineId != null) StartRefusal.UnknownMachine else StartRefusal.NoMachine)
        val agent = resolveNewSessionAgent(choice, draft.agentType, draft.pickedAgentType)
        val agentChanged = agent != draft.agentType
        val rig = agent == AgentType.Rig
        val machine = resolveAgentMachine(choice, agent)
            ?: return Prepared.Refused(if (rig) StartRefusal.HappyAgentMissing else StartRefusal.HappyCliMissing)
        if (!machine.isOnline) return Prepared.Refused(if (rig) StartRefusal.HappyAgentOffline else StartRefusal.HappyCliOffline)
        val rigCanStart = machine.metadata.isRigMachine() && machine.metadata?.capabilities?.newSession == true
        if (rig && !rigCanStart) return Prepared.Refused(StartRefusal.CannotStartHappyAgent)

        val draftProjectId = draft.selectedProjectId?.trim()?.takeIf { it.isNotEmpty() }
        if (draftProjectId != null && !rig) return Prepared.Refused(StartRefusal.ProjectNeedsHappyAgent)

        // Happy Agent resolves its own catalog defaults; the code agents take the user's over the code's.
        val defaults = if (rig) null else AgentDefaults.resolve(settings().agentDefaultOverrides, agent.wire, machine.metadata?.happyCliVersion)
        val permission = if (agentChanged) defaults?.permissionMode else draft.permissionMode ?: defaults?.permissionMode
        val model = if (agentChanged) defaults?.modelMode else AgentDefaults.retireModelMode(agent.wire, draft.modelMode) ?: defaults?.modelMode
        val effort = if (agentChanged) defaults?.effortLevel else draft.effortLevel ?: defaults?.effortLevel

        val selectedPath = draft.selectedPath?.trim()?.takeIf { it.isNotEmpty() } ?: "~"
        val directory = resolveAbsolutePath(selectedPath, machine.metadata?.homeDir)
        val sessions = sessions()
        val selectedProjectId = draftProjectId
            ?: collectSessionPlaces(choice.machineIds, sessions, selectedPath).find { it.path == selectedPath }?.projectId
        val requestedWorktree = if (draft.sessionType == SessionType.Worktree) draft.worktreeKey ?: WorktreeSelection.NEW else WorktreeSelection.NONE
        val target = if (rig) {
            try {
                resolveHappyAgentSpawnTarget(selectedProjectId, requestedWorktree, collectSessionWorkspaces(choice.machineIds, selectedProjectId, sessions))
            } catch (_: UnavailableWorkspaceException) {
                return Prepared.Refused(StartRefusal.WorkspaceUnavailable)
            }
        } else {
            null
        }
        val supportsWorktrees = if (rig) machine.metadata?.capabilities?.worktrees == true else agent != AgentType.OpenClaw
        val worktreeMachine = if (target != null) null else resolveWorktreeCreationMachine(choice, agent, supportsWorktrees)
        val worktree = if (target == null && worktreeMachine == null && requestedWorktree == WorktreeSelection.NEW) WorktreeSelection.NONE else requestedWorktree
        val signature = listOf(machine.id, agent.wire, draftProjectId?.let { "project:$it" } ?: selectedPath, worktree, model, permission, effort).joinToString("\u0000")
        val spawnDirectory = if (worktree != WorktreeSelection.NONE && worktree != WorktreeSelection.NEW && target == null) worktree else directory
        return Prepared.Ready(
            machine = machine,
            agent = agent,
            request = SpawnRequest(
                machineId = machine.id,
                agent = agent,
                directory = spawnDirectory,
                approvedNewDirectoryCreation = false,
                permissionMode = permission,
                modelMode = model,
                effortLevel = effort,
                happyAgentTarget = target,
                clientRequestId = requestIds.getOrPut(signature, requestId),
            ),
            worktreeMachine = worktreeMachine,
            worktreeNew = worktree == WorktreeSelection.NEW && target == null,
            signature = signature,
        )
    }

    private suspend fun execute(prepared: Prepared.Ready, draft: NewSessionDraft, confirmDirectory: suspend (String) -> Boolean): StartResult {
        var request = prepared.request
        if (prepared.worktreeNew) {
            phaseState.value = StartPhase.Worktree
            when (val created = machineActions.createWorktree(prepared.worktreeMachine!!.id, request.directory)) {
                is WorktreeOutcome.Failed -> return StartResult.Failed(created.message ?: "Failed to create worktree")
                is WorktreeOutcome.Created -> request = request.copy(directory = created.path)
            }
        }
        phaseState.value = StartPhase.Spawning
        // The spawn outlives a Stop: whatever it hands back afterwards is put down.
        val spawning = scope.async { spawn(request, confirmDirectory) }
        val spawned = try {
            spawning.await()
        } catch (e: CancellationException) {
            requestIds.remove(prepared.signature)
            spawning.invokeOnCompletion { error ->
                if (error == null) {
                    (spawning.getCompleted() as? SpawnOutcome.Success)?.let { scope.launch { stopAbandoned(prepared, it.sessionId) } }
                }
            }
            throw e
        }
        val sessionId = when (spawned) {
            is SpawnOutcome.Success -> spawned.sessionId
            is SpawnOutcome.Error -> return StartResult.Failed(spawned.message)
            is SpawnOutcome.Pending -> return StartResult.Failed("The session was created, but it is still syncing. It should appear shortly.")
            is SpawnOutcome.ApproveDirectory -> return StartResult.Abandoned
        }
        phaseState.value = StartPhase.Opening
        try {
            if (!awaitSession(sessionId)) {
                requestIds.remove(prepared.signature)
                return StartResult.Failed("Failed to start session")
            }
            val prompt = draft.input.trim()
            if (prompt.isNotEmpty() && !sender.send(sessionId, prompt)) return StartResult.Abandoned
        } catch (e: CancellationException) {
            scope.launch { stopAbandoned(prepared, sessionId) }
            throw e
        }
        requestIds.remove(prepared.signature)
        // Only what was consumed is cleared: text typed meanwhile stays.
        drafts.change { current -> if (current.input == draft.input) current.copy(input = "") else current }
        return StartResult.Started(sessionId)
    }

    private suspend fun spawn(request: SpawnRequest, confirmDirectory: suspend (String) -> Boolean): SpawnOutcome {
        var result = machineActions.spawnSession(request)
        var pending = 0
        while (result is SpawnOutcome.Pending && pending < MAX_PENDING_RESULTS) {
            pending++
            delay(result.retryAfterMs ?: DEFAULT_PENDING_RETRY_MS)
            result = machineActions.spawnSession(request)
        }
        if (result is SpawnOutcome.ApproveDirectory) {
            return if (confirmDirectory(result.directory)) spawn(request.copy(approvedNewDirectoryCreation = true), confirmDirectory) else result
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
        if (machineActions.stopSession(prepared.machine.id, sessionId) is ActionResult.Success) return
        if (sessionActions.kill(sessionId) is ActionResult.Success) return
        sessionActions.archiveOnServer(sessionId)
    }
}

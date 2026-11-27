package com.slopus.happy.call

import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.chat.MessageDelivery
import com.slopus.happy.chat.UserDisplay
import com.slopus.happy.model.Machine
import com.slopus.happy.model.MachineChoice
import com.slopus.happy.model.ProjectGroupData
import com.slopus.happy.model.ProjectWorkspaceGroup
import com.slopus.happy.model.RigSessionCreation
import com.slopus.happy.model.RigSpawnException
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.SessionState
import com.slopus.happy.model.activityAt
import com.slopus.happy.model.buildPathProjectGroups
import com.slopus.happy.model.buildProjectGroups
import com.slopus.happy.model.collectMachineChoices
import com.slopus.happy.model.displayName
import com.slopus.happy.model.findMachineChoice
import com.slopus.happy.model.isArchived
import com.slopus.happy.model.isProjectSession
import com.slopus.happy.model.isRig
import com.slopus.happy.model.isTask
import com.slopus.happy.model.resolveRigPendingRetryDelayMs
import com.slopus.happy.model.rigSessionCreation
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.model.spawnConfiguration
import com.slopus.happy.sync.HappyAgentSpawnTarget
import com.slopus.happy.sync.SpawnSessionOptions
import com.slopus.happy.sync.SpawnSessionResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.util.UUID

/**
 * What a call needs of a Happy CLI account (the app's, over its sync): its
 * home's sessions, each chat as the chat screen reduces it, the composer's
 * model and effort chips and its sender, and the computers new work starts on.
 */
interface LegacyCallAccount {
    /** Home's sessions now, as the call lists them ([LegacyCallTargets.directory]). */
    fun directory(): List<CallTarget>
    /** The same, each time home's sessions change. */
    val directoryChanges: Flow<List<CallTarget>>
    /** A session this phone has that home doesn't list (a Happy CLI session that stopped, say): read, never sent to. */
    fun unlisted(sessionId: String): CallTarget?
    /**
     * One session's chat as its screen reduces it. Collecting it opens the
     * chat as the screen does (its newest page, a catch-up); it never marks
     * the chat read.
     */
    fun chat(sessionId: String): Flow<ChatState>
    /** Up to the server's newest message, as opening the chat asks for. */
    suspend fun catchUp(sessionId: String)
    /** Read up to what the server last listed, with the live socket up: what this phone has is current. */
    suspend fun isCurrent(sessionId: String): Boolean
    /** The composer's model and effort chips for [chat]'s session ([LegacyCallTargets.modes]). */
    fun modes(chat: ChatState): LegacyCallModes
    /** Picks [model] and [effort] (null: as they are) as the chips do; the next message goes with them. */
    suspend fun setModes(sessionId: String, model: String?, effort: String?)
    /**
     * [text] as the composer sends it, from voice: the draft is left alone. Waits up to [waitOnlineMillis] for the
     * session to be online (live presence, else the stored flag, as the chat has it), then checks again as it goes
     * into the outbox: refused there if it is archived, being archived or not online. [onAccepted] runs once it is
     * in the outbox, even if the caller stopped waiting. False when nothing was queued.
     */
    suspend fun send(sessionId: String, text: String, waitOnlineMillis: Long, onAccepted: () -> Unit): Boolean
    /** Where a new task, or with [bot] a new bot, starts by voice now ([LegacyCallTargets.newWorkPlace]). */
    fun newWorkPlace(bot: Boolean): LegacyNewWork
    /** Asks the computer for the session, once: a pending answer is asked again by the caller. */
    suspend fun spawn(options: SpawnSessionOptions): SpawnSessionResult
    /** The new session's row in the store, pulled in by a sync if need be; false if it never comes. */
    suspend fun awaitSession(sessionId: String): Boolean
}

/** A session's model and effort as the composer's chips offer them, for the call. */
data class LegacyCallModes(
    val models: List<CallModel> = emptyList(),
    val mode: CallMode? = null,
    val modelLocked: Boolean = false,
    val effortLocked: Boolean = false,
)

/** Where new work starts by voice on a Happy CLI account: a computer with Happy Agent that can, or why none. */
sealed interface LegacyNewWork {
    data class Ready(val machineId: String, val creation: RigSessionCreation) : LegacyNewWork
    data class Refused(val reason: String) : LegacyNewWork
}

/** Where calls find Happy CLI accounts: the open one, and where each one's call history is kept. */
interface LegacyCallAccounts {
    /** [accountId] while it is the open account; null otherwise. */
    fun account(accountId: String): LegacyCallAccount?
    /** Its calls' history ([CallHistory]), gone with the account. */
    fun historyFile(accountId: String): File?
}

/**
 * A call's tools and context over a Happy CLI account (iOS's
 * `LegacyCallTargets`): home's sessions for the directory, each chat as its
 * screen reduces it for what is read and heard, and the composer's sender,
 * marked as voice's, for what is sent, with the model and effort its chips
 * would pick. New work is Happy Agent's spawn of a task or a bot on the
 * computer compose would use, its first message sent once it is made; until
 * then it is a draft of the call's own, and after, the call reads and sends
 * to the session it made under the draft's reference. A call reads what
 * comes, but never marks it read: that is the screen's. Runs on the main
 * thread.
 */
class LegacyCallTargets(
    private val cli: LegacyCallAccount,
    private val screen: () -> CallScreen?,
) : HeldCallTargets {
    private val held = HashMap<String, Job>()
    /** Each followed chat as it was last reduced. */
    private val latest = HashMap<String, ChatState>()
    /** The message IDs the call sent under: the same ID again went the first time. */
    private val sent: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet() // marked from the sender's thread
    /** New work the call started, by its draft's ID, and the session that made it once there is one. */
    private val drafts = HashMap<String, Draft>()
    /** Sends and starts under way, by message ID: one the tool's deadline left behind still finishes, and the same ID again waits for it. */
    private val sending = HashMap<String, Deferred<CallSendOutcome>>()
    private val watching = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    override var onChange: ((CallTargetState) -> Unit)? = null
    private var closed = false

    private class Draft(val target: CallTarget, val place: LegacyNewWork.Ready, var made: String? = null)

    override val account: CallAccount get() = CallAccount.HappyCli

    override fun close() {
        closed = true
        held.clear()
        latest.clear()
        drafts.clear()
        sending.clear()
        watching.coroutineContext[Job]?.cancel()
        onChange = null
    }

    override val focusedNow: String? get() = screen()?.focused?.let(::called)

    /** Bumped as a draft makes its session, so the directory is told under the draft's ref at once. */
    private val aliases = MutableStateFlow(0)

    override val directoryChanges: Flow<List<CallTarget>> get() = combine(cli.directoryChanges, aliases) { list, _ -> list.map(::outward) }

    /** By the call's own IDs: a draft's, once it made a session. */
    override val following: List<String> get() = held.keys.toList()

    private fun listed(sessionId: String): CallTarget? = cli.directory().firstOrNull { it.agentId == sessionId }

    /** The session [agentId] names: itself, or what a draft of the call's made. */
    private fun session(agentId: String): String? = drafts[agentId]?.let { it.made } ?: agentId.takeUnless { it in drafts }

    /** What the call calls [sessionId]: the draft that made it, else itself. */
    private fun called(sessionId: String): String = drafts.entries.firstOrNull { it.value.made == sessionId }?.key ?: sessionId

    /** [target] under the call's own ID, so a session new work made stays the one ref the call knows it by. */
    private fun outward(target: CallTarget): CallTarget = called(target.agentId).let { if (it == target.agentId) target else target.copy(agentId = it) }

    override suspend fun directory(): List<CallTarget> = onMain { cli.directory().map(::outward) }

    override suspend fun state(agentId: String): CallTargetState? = onMain {
        val draft = drafts[agentId]
        if (draft != null && draft.made == null) return@onMain draftState(draft)
        val id = session(agentId) ?: return@onMain null
        // Made, but not on this phone yet: still the draft as it was.
        val target = listed(id) ?: cli.unlisted(id) ?: return@onMain draft?.let(::draftState)
        val chat = latest[id]?.takeIf(::isRead) ?: withTimeoutOrNull(READ_MILLIS) { cli.chat(id).first(::isRead) } ?: return@onMain null
        read(chat, target, agentId)
    }

    /** As opening the chat would: its catch-up, until it is in or [limitMillis] runs out. */
    override suspend fun refreshed(agentId: String, limitMillis: Long): CallTargetState? = onMain {
        val id = session(agentId)
        if (id != null) {
            withTimeoutOrNull(limitMillis) {
                try {
                    cli.catchUp(id)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // What the phone has is the answer, not current.
                }
            }
        }
        state(agentId)
    }

    private fun isRead(chat: ChatState): Boolean = chat.sessionLoaded && chat.snapshot.loaded

    /** [chat] of [target]'s session, told under [called] (a draft's ref, for the session it made). */
    private suspend fun read(chat: ChatState, target: CallTarget, called: String): CallTargetState {
        val modes = cli.modes(chat)
        val state = state(chat, target, cli.isCurrent(target.agentId))
            .copy(models = modes.models, mode = modes.mode, modelLocked = modes.modelLocked, effortLocked = modes.effortLocked)
        return if (called == target.agentId) state else state.copy(target = state.target.copy(agentId = called))
    }

    override suspend fun focused(): String? = onMain { focusedNow }

    override suspend fun open(agentId: String): Boolean = onMain {
        if (closed) return@onMain false
        val id = session(agentId) ?: return@onMain false
        if (listed(id) == null && cli.unlisted(id) == null) return@onMain false
        val screen = screen() ?: return@onMain false
        if (screen.focused != id) {
            screen.press(CallControl.Row(id))
            if (closed) return@onMain false
            screen.open(id)
        }
        true
    }

    override suspend fun send(agentId: String, text: String, id: String, change: CallModeChange?): CallSendOutcome = onMain {
        if (closed) return@onMain CallSendOutcome.Refused("The call has ended.")
        if (id in sent) return@onMain CallSendOutcome.Queued
        // Not cancelled with the tool's deadline: a send the agent heard nothing of still goes, once, and is kept as sent.
        val going = sending.getOrPut(id) {
            val draft = drafts[agentId]
            watching.async { if (draft != null && draft.made == null) start(draft, text, id, change) else deliver(agentId, text, id, change) }
        }
        // A refusal is the answer once: the same words asked again are a new try.
        going.await().also { if (it is CallSendOutcome.Refused) sending.remove(id) }
    }

    /** One message to a session that is (or a draft made): checked where it goes, as the composer's send would be. */
    private suspend fun deliver(agentId: String, text: String, id: String, change: CallModeChange?): CallSendOutcome {
        val session = session(agentId) ?: return CallSendOutcome.Refused("That conversation can't take a message now.")
        // Checked again here, where the send happens: a permission asked for meanwhile still stops it.
        val now = state(session) ?: return CallSendOutcome.Refused("That conversation can't be read now.")
        return when {
            !now.writable -> CallSendOutcome.Refused("That conversation can't take a message now.")
            now.needsInput -> CallSendOutcome.Refused("It's waiting for the person in the app; answer there first.")
            closed -> CallSendOutcome.Refused("The call has ended.")
            else -> {
                change?.let { switch(session, now, it) }
                if (cli.send(session, text, waitOnlineMillis = 0) { sent += id }) {
                    CallSendOutcome.Queued
                } else {
                    CallSendOutcome.Refused("That conversation can't take a message now.")
                }
            }
        }
    }

    /** The chips' pick for the call: another model at the effort asked for or its own default, or another effort. */
    private suspend fun switch(sessionId: String, state: CallTargetState, change: CallModeChange) {
        val model = change.modelId?.takeIf { it != state.mode?.modelId }
        val effort = change.effort ?: model?.let { id -> state.models.firstOrNull { it.id == id }?.defaultEffort?.ifEmpty { null } }
        if (model != null || effort != null) cli.setModes(sessionId, model, effort)
    }

    override suspend fun follow(agentId: String, following: Boolean) = onMain {
        val id = session(agentId) ?: return@onMain
        if (!following) {
            held.remove(agentId)?.cancel()
            latest.remove(id)
            return@onMain
        }
        if (closed || held.containsKey(agentId) || listed(id) == null) return@onMain
        // Held and told under the call's own ID: a draft's, for the session it made.
        held[agentId] = watching.launch {
            cli.chat(id).collect { chat ->
                latest[id] = chat
                val target = listed(id) ?: return@collect
                if (isRead(chat)) onChange?.invoke(read(chat, target, agentId))
            }
        }
    }

    // New work

    override suspend fun newWorkRefusal(kind: CallTarget.Kind, name: String): String? = onMain {
        val bot = kind == CallTarget.Kind.Bot
        if (bot && name.isBlank()) return@onMain CallContext.CLI_BOT_NAME
        (cli.newWorkPlace(bot) as? LegacyNewWork.Refused)?.reason
    }

    override suspend fun startsWork(): Boolean = onMain { cli.newWorkPlace(false) is LegacyNewWork.Ready || cli.newWorkPlace(true) is LegacyNewWork.Ready }

    override suspend fun draft(kind: CallTarget.Kind, name: String): CallTarget? = onMain {
        if (closed) return@onMain null
        val place = cli.newWorkPlace(kind == CallTarget.Kind.Bot) as? LegacyNewWork.Ready ?: return@onMain null
        val title = CallTarget.clean(name).ifEmpty { if (kind == CallTarget.Kind.Bot) "New Bot" else "New Task" }
        val target = CallTarget(NEW_WORK_PREFIX + UUID.randomUUID(), title, kind, CallTarget.Status.Idle)
        drafts[target.agentId] = Draft(target, place)
        target
    }

    override suspend fun discard(agentId: String) = onMain {
        if (drafts[agentId]?.made == null) drafts.remove(agentId)
        Unit
    }

    override suspend fun unlisted(agentId: String): CallTarget? = onMain {
        drafts[agentId]?.let { draft -> draft.made?.let { listed(it) ?: cli.unlisted(it) }?.copy(agentId = agentId) ?: draft.target }
            ?: cli.unlisted(agentId)
    }

    /** New work not made yet: empty, takes its first message, on the models its computer offers. */
    private fun draftState(draft: Draft): CallTargetState {
        val creation = draft.place.creation
        val models = creation.models.map { CallModel(it.key, it.name, it.thinkingLevels, it.defaultThinkingLevel ?: it.thinkingLevels.firstOrNull().orEmpty()) }
        val mode = creation.models.firstOrNull { it.key == creation.defaultModelKey }?.let {
            CallMode(it.key, it.name, creation.defaultEffortForModel(it.key).orEmpty())
        }
        return CallTargetState(draft.target, models = models, mode = mode)
    }

    /**
     * Happy Agent's spawn of [draft] under [messageId], so the same words again reach the same new work, then its
     * first message: as compose's start does, on the model and effort asked for, else the computer's defaults.
     */
    private suspend fun start(draft: Draft, text: String, messageId: String, change: CallModeChange?): CallSendOutcome {
        val creation = draft.place.creation
        val config = try {
            creation.spawnConfiguration(change?.modelId, null, change?.effort ?: change?.modelId?.let(creation::defaultEffortForModel))
        } catch (e: RigSpawnException) {
            return CallSendOutcome.Refused(e.message ?: CallContext.CLI_NEW_WORK_REFUSED)
        }
        val bot = draft.target.kind == CallTarget.Kind.Bot
        val name = draft.target.title.takeUnless { it == "New Task" || it == "New Bot" }
        val options = SpawnSessionOptions(
            machineId = draft.place.machineId,
            directory = "~",
            agent = "rig",
            permissionMode = config.permissionMode,
            providerId = config.providerId,
            modelId = config.modelId,
            effort = config.effort,
            clientRequestId = messageId,
            happyAgentTarget = if (bot) HappyAgentSpawnTarget.Bot(name.orEmpty()) else HappyAgentSpawnTarget.Task(name),
        )
        var result = cli.spawn(options)
        var asked = 1
        while (result is SpawnSessionResult.Pending && asked < MAX_PENDING) {
            delay(resolveRigPendingRetryDelayMs(result.retryAfterMs, creation.pendingRetryAfterMs))
            result = cli.spawn(options)
            asked++
        }
        val session = when (result) {
            is SpawnSessionResult.Success -> result.sessionId
            is SpawnSessionResult.Error -> return CallSendOutcome.Refused(result.errorMessage)
            is SpawnSessionResult.Pending -> return CallSendOutcome.Refused("It's still starting on the computer; look for it in the app.")
            is SpawnSessionResult.RequestToApproveDirectoryCreation -> return CallSendOutcome.Refused(CallContext.CLI_NEW_WORK_REFUSED)
        }
        // The draft's ref is the session's from now on, before home lists it under its own ID.
        draft.made = session
        aliases.value++
        if (!cli.awaitSession(session)) return CallSendOutcome.Refused("It started, but hasn't reached this phone yet; look for it in the app.")
        // Just made: it comes online as its computer takes it up.
        if (!cli.send(session, text, waitOnlineMillis = NEW_ONLINE_MILLIS) { sent += messageId }) {
            return CallSendOutcome.Refused("It started, but its first message couldn't be kept on this phone.")
        }
        return CallSendOutcome.Queued
    }

    override suspend fun back(): CallScreenMove = onMain {
        val screen = screen() ?: return@onMain CallScreenMove.Refused("The call has ended.")
        if (closed) return@onMain CallScreenMove.Refused("The call has ended.")
        if (screen.atHome) return@onMain CallScreenMove.Refused("This is home; there is nothing to go back to.")
        screen.press(CallControl.Back)
        if (closed) return@onMain CallScreenMove.Refused("The call has ended.")
        if (!screen.back()) return@onMain CallScreenMove.Refused("This is home; there is nothing to go back to.")
        CallScreenMove.Moved(screen.atHome)
    }

    override suspend fun home(): CallScreenMove = onMain {
        val screen = screen() ?: return@onMain CallScreenMove.Refused("The call has ended.")
        if (closed) return@onMain CallScreenMove.Refused("The call has ended.")
        if (!screen.atHome) screen.press(CallControl.Back)
        if (closed) return@onMain CallScreenMove.Refused("The call has ended.")
        screen.home()
        CallScreenMove.Moved(true)
    }

    private suspend fun <T> onMain(block: suspend () -> T): T = withContext(Dispatchers.Main.immediate) { block() }

    companion object {
        private const val READ_MILLIS = 3_000L
        /** As compose's start: how many pending answers it waits through. */
        private const val MAX_PENDING = 20
        /** How long new work's first message waits for its session to come online. */
        private const val NEW_ONLINE_MILLIS = 15_000L
        /** A draft's ID: never a session's. */
        const val NEW_WORK_PREFIX = "new:"

        /** What a session nobody has named yet is called: its home row's "New chat". */
        const val NEW_CHAT = "New chat"

        /** The prefix Happy Agent gives a failed run's last words (`The run failed: …`). */
        const val RUN_FAILED = "The run failed: "

        /**
         * Home's sessions as the call lists them, in an order activity never
         * changes (a reply moves nothing): bots, then tasks, each newest made
         * first; then every other session under its project, and its worktree
         * where it has one, projects by their newest session, the project's
         * own checkout before its worktrees, each newest made first. What home
         * archives is left out (a Happy CLI session that stopped, one being
         * archived here in [archiving]), and side chats; a Happy Agent session
         * whose computer is offline is listed, to read.
         */
        fun directory(sessions: Collection<Session>, archiving: Set<String> = emptySet()): List<CallTarget> {
            val listed = sessions.filter { it.metadata?.isSideChat != true && !it.isArchived(archiving) }
            val newest = compareByDescending<Session> { it.createdAt }.thenBy { it.id }
            val bots = listed.filter { it.metadata?.bot != null }.sortedWith(newest)
            val tasks = listed.filter { it.metadata?.bot == null && it.isTask }.sortedWith(newest)
            val rest = listed.filter { it.metadata?.bot == null && !it.isTask }
            val byId = rest.associateBy { it.id }
            val row = { session: Session -> SessionRowData(id = session.id, createdAt = session.createdAt) }
            val rig = rest.filter { it.metadata.isRig() }
            val groups = buildProjectGroups(rig.filter { it.isProjectSession() }, row) { it.active } +
                buildPathProjectGroups(rig.filter { !it.isProjectSession() }, row, { it.active }, "rig") +
                buildPathProjectGroups(rest.filter { !it.metadata.isRig() }, row, { it.active }, "happy")
            val result = ArrayList<CallTarget>(listed.size)
            bots.mapTo(result) { target(it, emptyList()) }
            tasks.mapTo(result) { target(it, emptyList()) }
            fun made(rows: List<SessionRowData>) = rows.maxOfOrNull { it.createdAt } ?: 0L
            val projects = groups.sortedWith(compareByDescending<ProjectGroupData> { made(it.workspaces.flatMap { w -> w.sessions }) }.thenBy { it.id })
            for (group in projects) {
                val project = CallTarget.Parent("project:${group.id}", CallTarget.clean(group.name), "project")
                val workspaces = group.workspaces.sortedWith(
                    compareBy<ProjectWorkspaceGroup> { it.id.isNotEmpty() }.thenByDescending { made(it.sessions) }.thenBy { it.id },
                )
                for (workspace in workspaces) {
                    val parents = if (workspace.id.isEmpty()) listOf(project) else listOf(
                        project,
                        CallTarget.Parent("workspace:${group.id}\u0000${workspace.id}", CallTarget.clean(workspace.name ?: workspace.id), "workspace"),
                    )
                    workspace.sessions.mapNotNull { byId[it.id] }.sortedWith(newest).mapTo(result) { target(it, parents) }
                }
            }
            return result
        }

        /** [session] as the call names it outside the directory (one home archived): its kind, nothing it sits under. */
        fun unlisted(session: Session): CallTarget = target(session, emptyList())

        private fun target(session: Session, parents: List<CallTarget.Parent>) = CallTarget(
            agentId = session.id,
            title = CallTarget.clean(session.displayName()?.takeIf { it.isNotBlank() } ?: NEW_CHAT),
            kind = when {
                session.metadata?.bot != null -> CallTarget.Kind.Bot
                session.isTask -> CallTarget.Kind.Task
                else -> CallTarget.Kind.Conversation
            },
            status = when (session.state) {
                SessionState.Thinking -> CallTarget.Status.Running
                SessionState.PermissionRequired, SessionState.InputRequired -> CallTarget.Status.NeedsInput
                SessionState.Waiting, SessionState.Disconnected -> CallTarget.Status.Idle
            },
            parents = parents,
            activityAt = session.activityAt().takeIf { it > 0 },
        )

        /**
         * Where new work starts by voice: on the computer compose would use
         * ([composeMachineId]), else on the only one that can, a computer
         * with Happy Agent online that makes tasks, or with [bot] bots. None
         * can: refused, as is a choice of several with compose on none of them.
         */
        fun newWorkPlace(machines: List<Machine>, composeMachineId: String?, bot: Boolean): LegacyNewWork {
            fun able(choice: MachineChoice): LegacyNewWork.Ready? {
                val machine = choice.rigMachine?.takeIf { it.isOnline } ?: return null
                val creation = machine.metadata.rigSessionCreation()?.takeIf { if (bot) it.supportsBots else it.supportsTasks } ?: return null
                return LegacyNewWork.Ready(machine.id, creation)
            }
            val choices = collectMachineChoices(machines)
            findMachineChoice(choices, composeMachineId)?.let(::able)?.let { return it }
            val able = choices.mapNotNull(::able)
            return when (able.size) {
                1 -> able.single()
                0 -> LegacyNewWork.Refused(CallContext.CLI_NEW_WORK_REFUSED)
                else -> LegacyNewWork.Refused(CallContext.CLI_NEW_WORK_SEVERAL)
            }
        }

        /**
         * The composer's chips as the call offers them: each model it lists
         * with the efforts [efforts] gives for it, what the next message goes
         * with, and whether the computer keeps either as it is.
         */
        fun modes(composer: ComposerModes, efforts: (String) -> List<ModeOption>): LegacyCallModes {
            val models = composer.availableModels.filter { !it.disabled }.map { option ->
                val levels = efforts(option.key).filter { !it.disabled }.map { it.key }
                CallModel(option.key, option.name, levels, option.defaultThinkingLevel?.takeIf { it in levels } ?: levels.firstOrNull().orEmpty())
            }
            val mode = composer.modelMode?.let { CallMode(it.key, it.name, composer.effortLevel?.key.orEmpty()) }
            return LegacyCallModes(models, mode, modelLocked = !composer.canChangeModel, effortLocked = !composer.canChangeEffort)
        }

        /**
         * A session's chat as the call reads it: the person's and the agent's
         * words only, never tools, thinking or events. A run is the agent's
         * turn where the session says which rows are of one (Happy Agent's),
         * else what the agent did after the person's message up to their next
         * one. It is over once a newer one starts or the session stopped
         * thinking, and its answer is the agent's last words in it; a turn
         * that failed ([ChatSnapshot.failedTurns]) ended in an error, its
         * reason Happy Agent's last words ([RUN_FAILED]). A message that came
         * before the agent said anything cuts the run short (`steering`), so
         * the two are one exchange. While the session thinks, its last words
         * with nothing after them may still grow (`final` false). A permission
         * or a question waiting is a flag, never its words. Who wrote each of
         * the person's messages is named as the chat names them, the account's
         * own being "the person".
         */
        fun state(chat: ChatState, target: CallTarget, fresh: Boolean): CallTargetState {
            val messages = ArrayList<CallMessage>()
            val turns = ArrayList<CallTurn>()
            val users = HashMap<String, CallMessage>()
            val names = HashMap<String, String>()
            var me: String? = null
            val failed: Set<String?> = chat.snapshot.failedTurns
            // The run going: its ID (the session's turn, else its first row's), the turn it is, the person's message that started it, its last words.
            var run: String? = null
            var turn: String? = null
            var asked: CallMessage? = null
            var reply: CallMessage? = null
            var failure: String? = null
            val running = ArrayList<Int>()
            var lastIsText = false
            fun end(ended: String) {
                val id = run ?: return
                val error = if (turn != null && turn in failed) failure ?: "" else null
                turns += CallTurn(id, asked?.text, reply?.text, if (error != null) "error" else ended, error?.takeIf { it.isNotEmpty() }, reply?.time, asked?.author)
                asked?.let { users[id] = it }
                for (index in running) messages[index] = messages[index].copy(turn = id)
                running.clear()
                run = null
                turn = null
                asked = null
                reply = null
                failure = null
            }
            /** An agent row of [rowTurn]: a run of another turn ends the one before. */
            fun agent(rowId: String, rowTurn: String?) {
                if (rowTurn != null && turn != null && rowTurn != turn) end(if (reply != null) "completed" else "steering")
                if (run == null) run = rowTurn ?: rowId
                if (rowTurn != null && turn == null) {
                    turn = rowTurn
                    // The person's message that started it keeps its run, under the turn's ID.
                    run = rowTurn
                }
            }
            for (row in chat.snapshot.rows.asReversed()) {
                when (row) {
                    is ChatRow.User -> {
                        val text = when (val display = row.display) {
                            is UserDisplay.Text -> display.text
                            is UserDisplay.Goal -> display.goal
                            is UserDisplay.Command -> listOfNotNull("/${display.commandName}", display.args).joinToString(" ")
                        }
                        if (text.isEmpty()) continue
                        row.message.author?.let { author ->
                            names[author.id] = author.name
                            if (author.owner == true) me = author.id
                        }
                        // The person wrote again: the run before is over, or, with nothing said yet, cut short.
                        if (run != null) end(if (reply != null) "completed" else "steering")
                        val delivery = when (row.delivery) {
                            MessageDelivery.Sending -> CallMessage.Delivery.Queued
                            MessageDelivery.Failed -> CallMessage.Delivery.Failed
                            else -> CallMessage.Delivery.Accepted
                        }
                        val message = CallMessage(row.message.id, CallMessage.Role.User, text, (row.time ?: row.message.createdAt).takeIf { it > 0 },
                            delivery = delivery, author = row.message.author?.id)
                        messages += message
                        run = row.message.id
                        asked = message
                        lastIsText = false
                    }
                    is ChatRow.AgentText -> {
                        val text = row.message.text
                        if (text.isEmpty()) continue
                        agent(row.message.id, row.message.turn)
                        if (row.message.turn != null && row.message.turn in failed && text.startsWith(RUN_FAILED)) {
                            // The failure's own words: the reason, not an answer.
                            failure = text.removePrefix(RUN_FAILED).trim()
                            lastIsText = false
                            continue
                        }
                        val message = CallMessage(row.message.id, CallMessage.Role.Assistant, text, row.message.createdAt.takeIf { it > 0 })
                        running += messages.size
                        messages += message
                        reply = message
                        lastIsText = true
                    }
                    is ChatRow.Tool -> {
                        agent(row.message.id, row.message.turn)
                        lastIsText = false
                    }
                    is ChatRow.Event -> Unit
                }
            }
            if (run != null && (reply != null || (turn != null && turn in failed)) && !chat.thinking) end("completed")
            // The last words of the run still going may grow while nothing came after them.
            if (chat.thinking && lastIsText && running.isNotEmpty()) {
                val index = running.last()
                messages[index] = messages[index].copy(final = false)
            }
            val exchanges = CallTurn.exchanges(turns)
            val pending = if (exchanges.open) exchanges.asker?.let(users::get) ?: asked else asked
            val needsInput = chat.sessionState == SessionState.PermissionRequired || chat.sessionState == SessionState.InputRequired
            val status = when {
                needsInput -> CallTarget.Status.NeedsInput
                chat.thinking -> CallTarget.Status.Running
                else -> CallTarget.Status.Idle
            }
            // A session takes messages while it is online: a stopped Happy CLI session or Happy Agent's offline one is read, not sent to.
            val takes = chat.online && chat.session?.metadata?.lifecycleState != "archived"
            return CallTargetState(
                target = target.copy(status = status),
                messages = messages,
                turns = turns,
                unanswered = pending,
                working = chat.thinking,
                needsInput = needsInput,
                writable = chat.session != null && chat.snapshot.loaded && takes,
                hasMore = chat.snapshot.hasMoreOlder,
                fresh = fresh,
            ).named(names, me)
        }
    }
}

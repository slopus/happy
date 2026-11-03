package com.slopus.happy.ui.home

import com.slopus.happy.R
import com.slopus.happy.model.Session
import com.slopus.happy.model.isTask
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.SessionOps
import com.slopus.happy.sync.TaskOpResult
import com.slopus.happy.agent.Intent
import com.slopus.happy.agent.IntentOutbox
import com.slopus.happy.agent.IntentRefusal
import com.slopus.happy.agent.IntentStorage
import com.slopus.happy.agent.MemoryIntentStorage
import com.slopus.happy.net.HappyJson
import com.slopus.happy.data.HappyStore
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * The session operations the home list and session info run (sync/ops.ts),
 * as [SessionOps] answers them; tests use a fake.
 */
interface SessionActions {
    /** sessionKill: the `killSession` RPC to the session's agent. */
    suspend fun kill(sessionId: String): OpResult

    /** sessionArchive: the server retires a session whose agent is already gone. */
    suspend fun archiveOnServer(sessionId: String): OpResult

    /** sessionDelete: the session and everything in it, permanently. */
    suspend fun delete(sessionId: String): OpResult

    /** Happy Agent's `leaveTask`: out of this person's list, running on for the rest. */
    suspend fun leaveTask(sessionId: String): TaskOpResult = TaskOpResult.Unreachable

    /** A task's archive: its machine alone, by `killSession`. */
    suspend fun archiveTask(sessionId: String): TaskOpResult = TaskOpResult.Unreachable
}

/** [SessionActions] over the signed-in account's [SessionOps]; signed out, nothing can be reached. */
class LiveSessionActions(private val ops: () -> SessionOps?) : SessionActions {
    override suspend fun kill(sessionId: String): OpResult = ops()?.kill(sessionId) ?: SIGNED_OUT

    override suspend fun archiveOnServer(sessionId: String): OpResult = ops()?.archive(sessionId) ?: SIGNED_OUT

    override suspend fun delete(sessionId: String): OpResult = ops()?.delete(sessionId) ?: SIGNED_OUT

    override suspend fun leaveTask(sessionId: String): TaskOpResult = ops()?.leaveTask(sessionId) ?: TaskOpResult.Unreachable

    override suspend fun archiveTask(sessionId: String): TaskOpResult = ops()?.archiveTask(sessionId) ?: TaskOpResult.Unreachable

    private companion object {
        val SIGNED_OUT = OpResult(false)
    }
}

/** Why an archive failed, for the alert: the bot case has its own words in happy-app. */
sealed interface ArchiveResult {
    data object Archived : ArchiveResult
    data class Failed(val message: String?, val bot: Boolean) : ArchiveResult

    /** A task's archive or leave its machine didn't take ([taskFailureMessage] says why). */
    data class TaskFailed(val leave: Boolean, val result: TaskOpResult) : ArchiveResult
}

/**
 * happy-ios HomeSessionActions.message for a task: the machine's own words
 * when it gave a reason; otherwise "Connect to the task's machine…" when it
 * couldn't be reached, the update sentence for an older Happy Agent that
 * can't leave, else the plain failure.
 */
fun taskFailureMessage(failure: ArchiveResult.TaskFailed, string: (Int) -> String): String = when (val result = failure.result) {
    is TaskOpResult.Refused -> result.reason ?: string(if (failure.leave) R.string.task_failed_to_leave else R.string.session_info_failed_to_archive_session)
    TaskOpResult.Unreachable -> string(if (failure.leave) R.string.task_leave_needs_machine else R.string.task_archive_needs_machine)
    TaskOpResult.Unsupported -> string(if (failure.leave) R.string.task_cannot_leave else R.string.session_info_failed_to_archive_session)
    TaskOpResult.Done -> ""
}

/**
 * useSessionQuickActions' archive, a task's leave and a delete, kept until
 * the account has them (iOS a4049a03a, docs/offline-first.md). The row
 * leaves the list on the press ([archiving], [deleting]), is kept so through
 * a kill and relaunch ([bind]'s outbox, in the account's store), and comes
 * back only if the machine or server refuses. One try is made at once for
 * whoever waits; what the account can't reach yet goes once the socket is
 * back. A bot is only killed; anything else first gets [archive]'s
 * `cleanup` (maybeCleanupWorktree's prompt to delete its worktree), then is
 * killed, and retired on the server when its agent can't be reached.
 */
class SessionArchiver(private val actions: SessionActions) {
    private val state = MutableStateFlow<Set<String>>(emptySet())
    private val deleted = MutableStateFlow<Set<String>>(emptySet())
    private val unheard = MutableStateFlow<ArchiveResult?>(null)

    /** storage.ts archivingSessionIds: archived or left here, not yet confirmed by the server. */
    val archiving: StateFlow<Set<String>> = state.asStateFlow()

    /** Deleted here: gone from every list now, whatever a list read meanwhile says. */
    val deleting: StateFlow<Set<String>> = deleted.asStateFlow()

    /** A refusal no screen waited on (it came after a relaunch, or once the account was back), until home has said it ([heard]). */
    val refusal: StateFlow<ArchiveResult?> = unheard.asStateFlow()

    fun heard() {
        unheard.value = null
    }

    @Volatile private var outbox: IntentOutbox = IntentOutbox(CoroutineScope(SupervisorJob() + Dispatchers.Default), MemoryIntentStorage())
        .also { it.handle(KINDS, ::deliver) }

    /** Whether the account's socket is up: a machine out of reach while it isn't is this phone's doing, and waits. */
    @Volatile private var reachable: () -> Boolean = { true }

    /**
     * The signed-in account's kept intents, sent while [online]: what they
     * hold leaves the lists at once. A refusal puts its row back; one no
     * screen waited on waits in [refusal].
     */
    fun bind(scope: CoroutineScope, outbox: IntentOutbox, online: StateFlow<Boolean>) {
        state.value = emptySet()
        deleted.value = emptySet()
        this.outbox = outbox
        reachable = { online.value }
        outbox.handle(KINDS, ::deliver)
        scope.launch {
            outbox.pending.collect { pending ->
                state.update { it + pending.filter { intent -> intent.kind != Intent.DELETE }.map(Intent::target) }
                deleted.update { it + pending.filter { intent -> intent.kind == Intent.DELETE }.map(Intent::target) }
            }
        }
        scope.launch {
            outbox.rejections.collect { rejection ->
                putBack(rejection.intent)
                if (!rejection.heard) unheard.value = decode(rejection.intent, rejection.reason)
            }
        }
        scope.launch { online.collect(outbox::setOnline) }
    }

    suspend fun archive(session: Session, cleanup: suspend () -> Unit = {}): ArchiveResult {
        // A task is archived by its machine alone, never on the server, and keeps no worktree.
        if (session.isTask) return settle(Intent.ARCHIVE, session.id, "task")
        val bot = session.metadata?.bot != null
        if (!bot) {
            // The row goes on the press, before maybeCleanupWorktree asks.
            state.update { it + session.id }
            try {
                cleanup()
            } catch (e: Throwable) {
                state.update { it - session.id }
                throw e
            }
        }
        return settle(Intent.ARCHIVE, session.id, if (bot) "bot" else "session")
    }

    /** Leaves a task: the row goes at once and comes back only if its machine doesn't take it. */
    suspend fun leave(session: Session): ArchiveResult = settle(Intent.LEAVE, session.id, "task")

    /** Deletes a session and its messages for good: gone here at once, from the server now or once it can be reached. */
    suspend fun delete(session: Session): OpResult {
        // Best effort: a running agent would otherwise keep writing into a deleted session.
        if (session.isOnline) actions.kill(session.id)
        return when (val result = settle(Intent.DELETE, session.id, "session")) {
            is ArchiveResult.Failed -> OpResult(false, result.message)
            else -> OpResult(true)
        }
    }

    /** Kept, shown, then tried once for whoever waits: [ArchiveResult.Archived] while it stands, taken or still on its way. */
    private suspend fun settle(kind: String, sessionId: String, of: String): ArchiveResult {
        val outbox = outbox
        val intent = outbox.enqueue(kind, sessionId, buildJsonObject { put("kind", of) })
        if (kind == Intent.DELETE) deleted.update { it + sessionId } else state.update { it + sessionId }
        val verdict = outbox.attempt(intent.id) as? IntentOutbox.Verdict.Refused ?: return ArchiveResult.Archived
        putBack(intent)
        return decode(intent, verdict.reason)
    }

    private fun putBack(intent: Intent) {
        if (intent.kind == Intent.DELETE) deleted.update { it - intent.target } else state.update { it - intent.target }
    }

    /** One try of a kept archive, leave or delete, for the outbox. */
    private suspend fun deliver(intent: Intent) {
        val id = intent.target
        val failure: JsonObject? = when (intent.kind) {
            Intent.ARCHIVE -> when (intent.of) {
                "task" -> task(false, actions.archiveTask(id))
                "bot" -> actions.kill(id).takeUnless { it.success }?.let { failed(it.message, bot = true) }
                else -> (actions.kill(id).takeIf { it.success } ?: actions.archiveOnServer(id)).takeUnless { it.success }?.let { failed(it.message) }
            }
            Intent.LEAVE -> task(true, actions.leaveTask(id))
            Intent.DELETE -> actions.delete(id).takeUnless { it.success }?.let { failed(it.message) }
            else -> null
        }
        // Out of reach because this phone is: it goes once the account is back.
        if (failure != null && !reachable()) throw IOException("The account can't be reached")
        if (failure != null) throw IntentRefusal(failure.toString())
    }

    private companion object {
        val KINDS = setOf(Intent.ARCHIVE, Intent.LEAVE, Intent.DELETE)

        fun failed(message: String?, bot: Boolean = false) = buildJsonObject { put("message", message); put("bot", bot) }

        fun task(leave: Boolean, result: TaskOpResult): JsonObject? = when (result) {
            TaskOpResult.Done -> null
            is TaskOpResult.Refused -> buildJsonObject { put("leave", leave); put("task", "refused"); put("message", result.reason) }
            TaskOpResult.Unreachable -> buildJsonObject { put("leave", leave); put("task", "unreachable") }
            TaskOpResult.Unsupported -> buildJsonObject { put("leave", leave); put("task", "unsupported") }
        }

        /** The refusal [deliver] kept, as the screens say it. */
        fun decode(intent: Intent, reason: String): ArchiveResult {
            val failure = runCatching { HappyJson.parseToJsonElement(reason) as? JsonObject }.getOrNull()
            val message = (failure?.get("message") as? JsonPrimitive)?.contentOrNull
            val leave = (failure?.get("leave") as? JsonPrimitive)?.booleanOrNull ?: (intent.kind == Intent.LEAVE)
            return when ((failure?.get("task") as? JsonPrimitive)?.contentOrNull) {
                "refused" -> ArchiveResult.TaskFailed(leave, TaskOpResult.Refused(message))
                "unreachable" -> ArchiveResult.TaskFailed(leave, TaskOpResult.Unreachable)
                "unsupported" -> ArchiveResult.TaskFailed(leave, TaskOpResult.Unsupported)
                else -> ArchiveResult.Failed(message, (failure?.get("bot") as? JsonPrimitive)?.booleanOrNull == true)
            }
        }
    }
}

/** The account's kept intents, in its own store ([HappyStore.intents]), off the main thread. */
class StoreIntentStorage(private val store: HappyStore, private val current: () -> Boolean = { true }) : IntentStorage {
    private val serializer = ListSerializer(Intent.serializer())

    override suspend fun load(): List<Intent> = withContext(Dispatchers.IO) {
        if (!current()) return@withContext emptyList()
        runCatching { store.intents()?.let { HappyJson.decodeFromString(serializer, it) } }.getOrNull().orEmpty()
    }

    override suspend fun save(intents: List<Intent>) = withContext(Dispatchers.IO) {
        // An account switched away from: its database is no longer the store's.
        if (!current()) return@withContext
        store.saveIntents(intents.takeIf { it.isNotEmpty() }?.let { HappyJson.encodeToString(serializer, it) })
    }
}

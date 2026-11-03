package com.slopus.happy.ui.home

import com.slopus.happy.R
import com.slopus.happy.model.Session
import com.slopus.happy.model.isTask
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.SessionOps
import com.slopus.happy.sync.TaskOpResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

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
 * useSessionQuickActions' archive. The row leaves the list on the press
 * ([archiving]) and only comes back if the archive fails. A bot is only
 * killed; anything else first gets [archive]'s `cleanup` (maybeCleanupWorktree's
 * prompt to delete its worktree), then is killed, and retired on the server
 * when its agent can't be reached.
 */
class SessionArchiver(private val actions: SessionActions) {
    private val state = MutableStateFlow<Set<String>>(emptySet())

    /** storage.ts archivingSessionIds: archived here, not yet confirmed by the server. */
    val archiving: StateFlow<Set<String>> = state.asStateFlow()

    suspend fun archive(session: Session, cleanup: suspend () -> Unit = {}): ArchiveResult {
        // A task is archived by its machine alone, never on the server, and keeps no worktree.
        if (session.isTask) return task(session, leave = false)
        state.update { it + session.id }
        val bot = session.metadata?.bot != null
        val result = try {
            if (bot) {
                actions.kill(session.id)
            } else {
                cleanup()
                actions.kill(session.id).takeIf { it.success } ?: actions.archiveOnServer(session.id)
            }
        } catch (e: Throwable) {
            state.update { it - session.id }
            throw e
        }
        if (result.success) return ArchiveResult.Archived
        state.update { it - session.id }
        return ArchiveResult.Failed(result.message, bot)
    }

    /** Leaves a task: the row goes at once and comes back only if its machine doesn't take it. */
    suspend fun leave(session: Session): ArchiveResult = task(session, leave = true)

    private suspend fun task(session: Session, leave: Boolean): ArchiveResult {
        state.update { it + session.id }
        val result = try {
            if (leave) actions.leaveTask(session.id) else actions.archiveTask(session.id)
        } catch (e: Throwable) {
            state.update { it - session.id }
            throw e
        }
        if (result == TaskOpResult.Done) return ArchiveResult.Archived
        state.update { it - session.id }
        return ArchiveResult.TaskFailed(leave, result)
    }
}

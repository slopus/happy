package com.slopus.happy.ui.home

import com.slopus.happy.model.Session
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.SessionOps
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
}

/** [SessionActions] over the signed-in account's [SessionOps]; signed out, nothing can be reached. */
class LiveSessionActions(private val ops: () -> SessionOps?) : SessionActions {
    override suspend fun kill(sessionId: String): OpResult = ops()?.kill(sessionId) ?: SIGNED_OUT

    override suspend fun archiveOnServer(sessionId: String): OpResult = ops()?.archive(sessionId) ?: SIGNED_OUT

    override suspend fun delete(sessionId: String): OpResult = ops()?.delete(sessionId) ?: SIGNED_OUT

    private companion object {
        val SIGNED_OUT = OpResult(false)
    }
}

/** Why an archive failed, for the alert: the bot case has its own words in happy-app. */
sealed interface ArchiveResult {
    data object Archived : ArchiveResult
    data class Failed(val message: String?, val bot: Boolean) : ArchiveResult
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
}

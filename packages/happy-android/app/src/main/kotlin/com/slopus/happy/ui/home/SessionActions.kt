package com.slopus.happy.ui.home

import com.slopus.happy.model.Session
import com.slopus.happy.sync.SyncApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** sync/ops.ts results: success, or what went wrong in the server's or agent's words (null: say it generically). */
sealed interface ActionResult {
    data object Success : ActionResult
    data class Failure(val message: String?) : ActionResult
}

/**
 * The session operations the home list and session info run (sync/ops.ts).
 * A seam until the socket RPCs land in Sync: the tests use a fake.
 */
interface SessionActions {
    /** sessionKill: the `killSession` RPC to the session's agent. */
    suspend fun kill(sessionId: String): ActionResult

    /** sessionArchive: the server retires a session whose agent is already gone. */
    suspend fun archiveOnServer(sessionId: String): ActionResult

    /** sessionDelete: the session and everything in it, permanently. */
    suspend fun delete(sessionId: String): ActionResult
}

/**
 * [SessionActions] over what Sync offers today: the server endpoints.
 * There is no RPC yet, so [kill] fails the way an unreachable agent does and
 * archiving takes happy-app's fallback for a dead agent.
 */
class ServerSessionActions(private val api: () -> SyncApi?) : SessionActions {
    override suspend fun kill(sessionId: String): ActionResult = ActionResult.Failure(null)

    override suspend fun archiveOnServer(sessionId: String): ActionResult = call { it.archiveSession(sessionId) }

    override suspend fun delete(sessionId: String): ActionResult = call { it.deleteSession(sessionId) }

    private suspend fun call(block: suspend (SyncApi) -> Unit): ActionResult {
        val api = api() ?: return ActionResult.Failure(null)
        return try {
            block(api)
            ActionResult.Success
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ActionResult.Failure(e.message)
        }
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
 * killed; anything else is killed, and retired on the server when its agent
 * can't be reached.
 *
 * Not ported: maybeCleanupWorktree's prompt to delete a worktree checkout,
 * which needs the machine RPC.
 */
class SessionArchiver(private val actions: SessionActions) {
    private val state = MutableStateFlow<Set<String>>(emptySet())

    /** storage.ts archivingSessionIds: archived here, not yet confirmed by the server. */
    val archiving: StateFlow<Set<String>> = state.asStateFlow()

    suspend fun archive(session: Session): ArchiveResult {
        state.update { it + session.id }
        val bot = session.metadata?.bot != null
        val result = try {
            if (bot) {
                actions.kill(session.id)
            } else {
                when (val killed = actions.kill(session.id)) {
                    ActionResult.Success -> killed
                    is ActionResult.Failure -> actions.archiveOnServer(session.id)
                }
            }
        } catch (e: Throwable) {
            state.update { it - session.id }
            throw e
        }
        return when (result) {
            ActionResult.Success -> ArchiveResult.Archived
            is ActionResult.Failure -> {
                state.update { it - session.id }
                ArchiveResult.Failed(result.message, bot)
            }
        }
    }
}

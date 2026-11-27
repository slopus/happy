package com.slopus.happy.resume

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.chat.ChatActions
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.Settings
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.sync.MessageMetaResolver
import com.slopus.happy.sync.SpawnSessionResult
import com.slopus.happy.sync.UnsupportedPermissionModeException
import java.util.WeakHashMap
import kotlinx.coroutines.CancellationException

/** What a failed resume says, in the screen's language. */
data class ResumeTexts(val unexpectedDirectory: String, val unknownError: String)

@Composable
fun rememberResumeTexts(): ResumeTexts {
    val unexpectedDirectory = stringResource(R.string.session_info_resume_session_unexpected_directory_prompt)
    val unknownError = stringResource(R.string.errors_unknown_error)
    return remember(unexpectedDirectory, unknownError) { ResumeTexts(unexpectedDirectory, unknownError) }
}

sealed interface ResumeOutcome {
    /** Running again as [sessionId] (the same id when the daemon reconnects it): open it. */
    data class Resumed(val sessionId: String) : ResumeOutcome

    /** A resume of the same session is still running; the tap is dropped. */
    data object InFlight : ResumeOutcome

    /** Not resumed; [message] goes in an error alert. */
    data class Failed(val message: String) : ResumeOutcome
}

/** The account side of a resume; the chat goes through its own seams, tests use a fake. */
interface ResumeOps {
    /** The session's composer picks: its mode picks are what a resume runs with. */
    fun mirror(sessionId: String): ComposerMirror

    /** The account's saved agent defaults, under the session's own picks. */
    fun overrides(): AgentDefaultOverrides?

    /** ops.ts machineResumeSession. */
    suspend fun resume(machineId: String, sessionId: String, model: String?, permissionMode: String?): SpawnSessionResult

    /** sync.refreshSessions: the resumed session's new state. */
    suspend fun refreshSessions()

    /** ops.ts sessionSetAgentModes with just the permission mode. */
    suspend fun setPermissionMode(sessionId: String, mode: String)
}

/** [ResumeOps] over a signed-in account and its synced settings. */
class AccountResumeOps(private val account: AccountSync, private val settings: () -> Settings) : ResumeOps {
    override fun mirror(sessionId: String) = account.composer.mirrors.value[sessionId] ?: ComposerMirror()

    override fun overrides() = settings().agentDefaultOverrides

    override suspend fun resume(machineId: String, sessionId: String, model: String?, permissionMode: String?) =
        account.machineOps.resumeSession(machineId, sessionId, model = model, permissionMode = permissionMode)

    override suspend fun refreshSessions() {
        account.syncNow()
    }

    override suspend fun setPermissionMode(sessionId: String, mode: String) {
        account.composer.setAgentModes(sessionId, mapOf(AgentModeField.PERMISSION_MODE to mode))
    }
}

/**
 * useSessionQuickActions.ts `performResume`, the one resume behind the chat's
 * notice, Session Info and the home row menu. It runs with the model and
 * permission mode a message would send with, refusing a mode the session's
 * CLI can't parse rather than swapping in another; once resumed the sessions
 * are refreshed and the permission pick is pinned on the session again.
 * A second resume of a session while one runs is dropped (useHappyAction).
 */
class SessionResumer {
    private val inFlight = mutableSetOf<String>()

    suspend fun resume(
        ops: ResumeOps?,
        sessionId: String,
        machineId: String,
        metadata: SessionMetadata?,
        texts: ResumeTexts,
    ): ResumeOutcome {
        if (!synchronized(inFlight) { inFlight.add(sessionId) }) return ResumeOutcome.InFlight
        return try {
            if (ops == null) ResumeOutcome.Failed(texts.unknownError) else run(ops, sessionId, machineId, metadata, texts)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ResumeOutcome.Failed(e.message?.takeIf { it.isNotBlank() } ?: texts.unknownError)
        } finally {
            synchronized(inFlight) { inFlight.remove(sessionId) }
        }
    }

    private suspend fun run(ops: ResumeOps, sessionId: String, machineId: String, metadata: SessionMetadata?, texts: ResumeTexts): ResumeOutcome {
        val mirror = ops.mirror(sessionId)
        val meta = try {
            MessageMetaResolver.mode(metadata, mirror, ops.overrides())
        } catch (e: UnsupportedPermissionModeException) {
            return ResumeOutcome.Failed(e.message ?: texts.unknownError)
        }
        return when (val result = ops.resume(machineId, sessionId, meta.model?.value, meta.permissionMode)) {
            is SpawnSessionResult.Success -> {
                // The session is running either way: a failed refresh or pin still opens it.
                quietly { ops.refreshSessions() }
                mirror.permissionMode?.let { mode -> quietly { ops.setPermissionMode(result.sessionId, mode) } }
                ResumeOutcome.Resumed(result.sessionId)
            }
            is SpawnSessionResult.RequestToApproveDirectoryCreation -> ResumeOutcome.Failed(texts.unexpectedDirectory)
            is SpawnSessionResult.Error -> ResumeOutcome.Failed(result.errorMessage.ifEmpty { texts.unknownError })
            is SpawnSessionResult.Pending -> ResumeOutcome.Failed(texts.unknownError)
        }
    }

    private suspend fun quietly(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    companion object {
        private val instances = WeakHashMap<AppGraph, SessionResumer>()

        /** One per [AppGraph], so a resume in flight is seen from every screen. */
        @Synchronized
        fun of(graph: AppGraph): SessionResumer = instances.getOrPut(graph) { SessionResumer() }

        /** The signed-in account's [ResumeOps]; null while signed out. */
        fun ops(graph: AppGraph): ResumeOps? = graph.account.value?.let { AccountResumeOps(it) { graph.settings.settings.value } }
    }
}

/** [ResumeOps] through the chat's [ChatActions] seam, with the picks its composer shows. */
class ChatResumeOps(
    private val actions: ChatActions,
    private val mirror: () -> ComposerMirror,
    private val overrides: () -> AgentDefaultOverrides?,
) : ResumeOps {
    override fun mirror(sessionId: String) = mirror()

    override fun overrides() = overrides.invoke()

    override suspend fun resume(machineId: String, sessionId: String, model: String?, permissionMode: String?) =
        actions.resume(sessionId, machineId, model, permissionMode)

    override suspend fun refreshSessions() = actions.refreshSessions()

    override suspend fun setPermissionMode(sessionId: String, mode: String) =
        actions.setModes(sessionId, mapOf(AgentModeField.PERMISSION_MODE to mode))
}

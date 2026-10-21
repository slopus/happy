package com.slopus.happy.ui.home

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.chat.prettyJson
import com.slopus.happy.diagnostics.ClientLogs
import com.slopus.happy.model.Session
import com.slopus.happy.model.forkSource
import com.slopus.happy.resume.ResumeOutcome
import com.slopus.happy.resume.ResumeTexts
import com.slopus.happy.resume.rememberResumeTexts
import com.slopus.happy.sync.SpawnSessionResult
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.confirm
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The session alert and the archive, as the list's rows run them. */
class SessionMenus(
    private val services: HomeServices,
    private val buildMenu: (Session) -> Alert?,
    private val showError: (String?, Boolean) -> Unit,
    /** maybeCleanupWorktree's "Delete Worktree?". */
    private val confirmCleanup: suspend () -> Boolean = { false },
    /** On the press, before the machine is asked: a screen standing on the chat leaves first. */
    private val onBeforeArchive: (sessionId: String) -> Unit = {},
) {
    /** useSessionActionAlert: "Session", one button per action, then Cancel. */
    fun open(sessionId: String) {
        val session = services.session(sessionId) ?: return
        buildMenu(session)
    }

    /** useSessionArchiveAction: the same archive the menu runs. */
    fun archive(sessionId: String) {
        val session = services.session(sessionId) ?: return
        onBeforeArchive(sessionId)
        services.launch {
            val result = services.archiver.archive(session) { services.cleanupWorktree(session, confirmCleanup) }
            if (result is ArchiveResult.Failed) showError(result.message, result.bot)
        }
    }
}

@Composable
internal fun rememberSessionMenus(
    services: HomeServices,
    continuationExperiments: Boolean,
    devMode: Boolean,
    onOpenSession: (String) -> Unit,
    onDetails: ((String) -> Unit)?,
    onDuplicate: (Session) -> Unit,
    showAlert: (Alert) -> Unit,
    onBeforeArchive: (sessionId: String) -> Unit = {},
): SessionMenus {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val strings = SessionMenuStrings(
        title = stringResource(R.string.session_actions_title),
        details = stringResource(R.string.profile_details),
        resume = stringResource(R.string.session_info_resume_session),
        fork = stringResource(R.string.session_fork_action),
        duplicate = stringResource(R.string.session_duplicate_action),
        copyMetadata = stringResource(R.string.session_info_copy_metadata),
        cleanupTitle = stringResource(R.string.session_info_worktree_cleanup_title),
        cleanupMessage = stringResource(R.string.session_info_worktree_cleanup_message),
        cleanupDelete = stringResource(R.string.session_info_worktree_cleanup_delete),
        cleanupKeep = stringResource(R.string.session_info_worktree_cleanup_keep),
        archive = stringResource(R.string.session_archive_action),
        cancel = stringResource(R.string.common_cancel),
        error = stringResource(R.string.common_error),
        ok = stringResource(R.string.common_ok),
        archiveFailed = stringResource(R.string.session_info_failed_to_archive_session),
        botArchiveFailed = stringResource(R.string.home_bot_archive_offline),
        forkFailed = stringResource(R.string.session_fork_error_generic),
        resumeFailed = stringResource(R.string.session_info_resume_session_subtitle),
        blocks = mapOf(
            ResumeBlock.MissingMachine to stringResource(R.string.session_info_resume_session_missing_machine),
            ResumeBlock.MissingBackendId to stringResource(R.string.session_info_resume_session_missing_backend_id),
            ResumeBlock.SameMachineOnly to stringResource(R.string.session_info_resume_session_same_machine_only),
            ResumeBlock.MachineOffline to stringResource(R.string.session_info_resume_session_machine_offline),
        ),
        metadataCopied = stringResource(R.string.session_info_metadata_copied),
        metadataCopyFailed = stringResource(R.string.session_info_failed_to_copy_metadata),
        success = stringResource(R.string.common_success),
        resumeTexts = rememberResumeTexts(),
    )
    return remember(services, continuationExperiments, devMode, onOpenSession, onDetails, onDuplicate, strings, context, scope, showAlert, onBeforeArchive) {
        fun error(message: String) = showAlert(Alert(strings.error, message, listOf(AlertButton(strings.ok))))

        // copySessionMetadataToClipboard's answer either way.
        fun copied(ok: Boolean) =
            if (ok) showAlert(Alert(strings.success, strings.metadataCopied, listOf(AlertButton(strings.ok)))) else error(strings.metadataCopyFailed)

        // Resume and fork answer like a spawn; anything but a session is a failure here.
        fun spawned(result: SpawnSessionResult, fallback: String) = when (result) {
            is SpawnSessionResult.Success -> onOpenSession(result.sessionId)
            is SpawnSessionResult.Error -> error(result.errorMessage.ifEmpty { fallback })
            else -> error(fallback)
        }
        lateinit var menus: SessionMenus
        menus = SessionMenus(
            services = services,
            buildMenu = { session ->
                val machine = services.machine(session.metadata?.machineId)
                val ids = sessionActionIds(session, machine, continuationExperiments, devMode)
                val buttons = ids.mapNotNull { id ->
                    when (id) {
                        SessionActionId.Details -> onDetails?.let { AlertButton(strings.details) { it(session.id) } }
                        SessionActionId.Resume -> AlertButton(strings.resume) {
                            val availability = resumeAvailability(session, machine)
                            val machineId = session.metadata?.machineId
                            if (!availability.canResume || machineId == null) {
                                error(availability.block?.let(strings.blocks::getValue) ?: strings.resumeFailed)
                            } else {
                                scope.launch {
                                    when (val outcome = services.continuations.resume(machineId, session.id, session.metadata, strings.resumeTexts)) {
                                        is ResumeOutcome.Resumed -> onOpenSession(outcome.sessionId)
                                        is ResumeOutcome.Failed -> error(outcome.message)
                                        ResumeOutcome.InFlight -> Unit
                                    }
                                }
                            }
                        }
                        SessionActionId.Fork -> AlertButton(strings.fork) {
                            val source = session.forkSource() ?: return@AlertButton
                            scope.launch {
                                val ops = services.machineOps ?: return@launch error(strings.forkFailed)
                                spawned(ops.forkAndSpawn(source), strings.forkFailed)
                            }
                        }
                        SessionActionId.Duplicate -> AlertButton(strings.duplicate) { onDuplicate(session) }
                        SessionActionId.CopyMetadata -> AlertButton(strings.copyMetadata) {
                            val metadata = session.metadata ?: return@AlertButton error(strings.error)
                            copied(copyToClipboard(context, prettyJson(metadata.raw)))
                        }
                        SessionActionId.CopyMetadataAndLogs -> AlertButton(strings.copyMetadata + " & Client Logs") {
                            val metadata = session.metadata ?: return@AlertButton error(strings.error)
                            scope.launch {
                                val logs = withContext(Dispatchers.IO) { ClientLogs.read() }
                                copied(copyToClipboard(context, ClientLogs.metadataAndLogs(prettyJson(metadata.raw), logs)))
                            }
                        }
                        SessionActionId.Archive -> AlertButton(strings.archive, destructive = true) { menus.archive(session.id) }
                    }
                }
                Alert(strings.title, null, buttons + AlertButton(strings.cancel)).also(showAlert)
            },
            showError = { message, bot -> error(message ?: if (bot) strings.botArchiveFailed else strings.archiveFailed) },
            confirmCleanup = {
                confirm(showAlert, strings.cleanupTitle, strings.cleanupMessage, strings.cleanupDelete, strings.cleanupKeep, destructive = true)
            },
            onBeforeArchive = onBeforeArchive,
        )
        menus
    }
}

private data class SessionMenuStrings(
    val title: String,
    val details: String,
    val resume: String,
    val fork: String,
    val duplicate: String,
    val copyMetadata: String,
    val cleanupTitle: String,
    val cleanupMessage: String,
    val cleanupDelete: String,
    val cleanupKeep: String,
    val archive: String,
    val cancel: String,
    val error: String,
    val ok: String,
    val archiveFailed: String,
    val botArchiveFailed: String,
    val forkFailed: String,
    val resumeFailed: String,
    val blocks: Map<ResumeBlock, String>,
    val metadataCopied: String,
    val metadataCopyFailed: String,
    val success: String,
    val resumeTexts: ResumeTexts,
)

/** Clipboard.setStringAsync: false when the system refuses the clip (too large, or not allowed). */
internal fun copyToClipboard(context: Context, text: String): Boolean = try {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Happy", text))
    true
} catch (_: RuntimeException) {
    false
}

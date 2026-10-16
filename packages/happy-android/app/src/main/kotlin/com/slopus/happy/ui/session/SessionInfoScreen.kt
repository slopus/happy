package com.slopus.happy.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.diagnostics.ClientLogs
import com.slopus.happy.model.InfoSetting
import com.slopus.happy.model.Machine
import com.slopus.happy.model.SandboxSummary
import com.slopus.happy.model.Session
import com.slopus.happy.model.aiProviderName
import com.slopus.happy.model.dangerouslySkipPermissions
import com.slopus.happy.model.displayName
import com.slopus.happy.model.forkSource
import com.slopus.happy.model.formatOSPlatform
import com.slopus.happy.model.formatPathRelativeToHome
import com.slopus.happy.model.gitPresentation
import com.slopus.happy.model.isCliOutdated
import com.slopus.happy.model.isRig
import com.slopus.happy.model.resumeCommand
import com.slopus.happy.model.rigIdentity
import com.slopus.happy.model.sandboxSummary
import com.slopus.happy.model.shortId
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.SpawnSessionResult
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderBackButton
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Octicon
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.components.confirm
import com.slopus.happy.ui.home.ArchiveResult
import com.slopus.happy.ui.home.ResumeBlock
import com.slopus.happy.ui.home.canForkSession
import com.slopus.happy.ui.home.formatLocaleDateTime
import com.slopus.happy.ui.home.gitAddedColor
import com.slopus.happy.ui.home.gitRemovedColor
import com.slopus.happy.ui.home.resumeAvailability
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.ZoneId

/** Chat's header info button opens this. */
@Serializable data class SessionInfoRoute(val id: String)

object SessionInfoTags {
    const val LOADING = "sessionInfo.loading"
    const val DELETED = "sessionInfo.deleted"
    const val CHANGES = "sessionInfo.changes"
    const val MACHINE = "sessionInfo.machine"
    const val RESUME = "sessionInfo.resume"
    const val FORK = "sessionInfo.fork"
    const val DUPLICATE = "sessionInfo.duplicate"
    const val PARENT = "sessionInfo.parent"
    const val ARCHIVE = "sessionInfo.archive"
    const val DELETE = "sessionInfo.delete"
    const val OUTDATED = "sessionInfo.outdated"
    const val SESSION_ID = "sessionInfo.sessionId"
    const val RESUME_COMMAND = "sessionInfo.resumeCommand"
    const val COPY_METADATA = "sessionInfo.copyMetadata"
    const val COPY_METADATA_AND_LOGS = "sessionInfo.copyMetadataAndLogs"
    const val RAW_JSON = "sessionInfo.rawJson"
}

/** info.tsx's icon colours (iOS system colours) and sizes. */
object SessionInfoSpec {
    val blue = Color(0xFF007AFF)
    val red = Color(0xFFFF3B30)
    val orange = Color(0xFFFF9500)
    val purple = Color(0xFF5856D6)
    val magenta = Color(0xFF9C27B0)
    val codex = Color(0xFF10A37F)
    val green = Color(0xFF30D158)
    val online = Color(0xFF34C759)
    val gray = Color(0xFF8E8E93)
    val yellow = Color(0xFFFFCC00)
    val icon = 29.dp
    val changesIcon = 26.dp
    val code = happyTextStyle(fontSize = 12, lineHeight = 18, family = PlexMono)
    const val UPDATE_COMMAND = "npm install -g happy@latest"
}

/** What info.tsx runs against the session; tests use a fake. */
interface SessionInfoControls {
    /** useSessionQuickActions' archive: kill, or retire on the server when the agent is gone. */
    suspend fun archive(session: Session): ArchiveResult

    /** sessionDelete, after a best-effort kill of a session still running. */
    suspend fun delete(session: Session): OpResult

    /** maybeCleanupWorktree, before an archive or delete: [confirm] asks whether to delete the worktree. */
    suspend fun cleanupWorktree(session: Session, confirm: suspend () -> Boolean) {}
}

@Immutable
class SessionInfoActions(
    val onBack: () -> Unit,
    val onOpenSession: (String) -> Unit,
    val onOpenMachine: (String) -> Unit,
    /** The session's changes screen. */
    val onChanges: (String) -> Unit,
    /**
     * Archived: leave this screen, and the chat behind it for [successor],
     * the checkout's neighbouring tab, when there is one ([tabSuccessor]).
     */
    val onArchived: (successor: String?) -> Unit,
    /** Deleted: leave this screen and the chat behind it. */
    val onDeleted: () -> Unit,
    val copyToClipboard: (String) -> Unit,
    /** useWorktreeTabSuccessor, read when archive is pressed, before the chat leaves its checkout. */
    val tabSuccessor: (sessionId: String) -> String? = { null },
    /** log.getLogs() for "Copy session metadata & Client Logs". */
    val clientLogs: suspend () -> List<String> = { withContext(Dispatchers.IO) { ClientLogs.read() } },
)

/**
 * session/[id]/info.tsx. The header names the session, centred. While the
 * first sync is out, an hourglass and "Loading"; a session that's gone says
 * so. Otherwise: quick actions (changes with Happy Agent's counts, the
 * machine, resume, fork, duplicate, the parent, archive and delete), the
 * outdated-CLI warning, the session's ids and times (each id copies), its
 * metadata, agent state, activity and, in dev mode, the raw JSON.
 *
 * Archive and delete first offer to delete a clean worktree nobody else is
 * in (maybeCleanupWorktree). An archived chat that was one tab of a
 * checkout hands over to its neighbouring tab.
 *
 * Not ported: the live git status (only Happy Agent's published summary is
 * shown). A delete waits for the server instead of leaving first, so a
 * failure can still be shown here. Client logs are the app's own logcat.
 */
@Composable
fun SessionInfoScreen(
    session: Session?,
    ready: Boolean,
    agentState: JsonObject?,
    machine: Machine?,
    continuationExperiments: Boolean,
    devMode: Boolean,
    controls: SessionInfoControls,
    continuations: SessionContinuations,
    actions: SessionInfoActions,
    modifier: Modifier = Modifier,
    zone: ZoneId = ZoneId.systemDefault(),
) {
    val colors = HappyTheme.colors
    val newChat = stringResource(R.string.session_new_chat)
    val title = when {
        session != null -> session.displayName() ?: newChat
        ready -> stringResource(R.string.errors_session_deleted)
        else -> ""
    }
    Screen(
        modifier = modifier,
        header = { Header(title = title, alignment = TitleAlignment.Center, left = { HeaderBackButton(onClick = actions.onBack) }) },
    ) {
        when {
            !ready -> Placeholder(Ionicon.HourglassOutline, Modifier.testTag(SessionInfoTags.LOADING)) {
                Text(
                    stringResource(R.string.common_loading),
                    style = happyTextStyle(fontSize = 17, weight = FontWeight.SemiBold),
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 16.dp),
                )
            }
            session == null -> Placeholder(Ionicon.TrashOutline, Modifier.testTag(SessionInfoTags.DELETED)) {
                Text(
                    stringResource(R.string.errors_session_deleted),
                    style = happyTextStyle(fontSize = 20, weight = FontWeight.SemiBold),
                    color = colors.text,
                    modifier = Modifier.padding(top = 16.dp),
                )
                Text(
                    stringResource(R.string.errors_session_deleted_description),
                    style = happyTextStyle(fontSize = 15),
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 8.dp).padding(horizontal = 32.dp),
                )
            }
            else -> SessionInfoContent(session, agentState, machine, continuationExperiments, devMode, controls, continuations, actions, zone)
        }
    }
}

@Composable
private fun Placeholder(icon: Ionicon, modifier: Modifier, content: @Composable () -> Unit) {
    Column(
        modifier = modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, size = 48.dp, color = HappyTheme.colors.textSecondary)
        content()
    }
}

@Composable
private fun SessionInfoContent(
    session: Session,
    agentState: JsonObject?,
    machine: Machine?,
    continuationExperiments: Boolean,
    devMode: Boolean,
    controls: SessionInfoControls,
    continuations: SessionContinuations,
    actions: SessionInfoActions,
    zone: ZoneId,
) {
    val colors = HappyTheme.colors
    val scope = rememberCoroutineScope()
    var alert by remember { mutableStateOf<Alert?>(null) }
    var forking by remember { mutableStateOf(false) }
    var archiving by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var duplicating by remember { mutableStateOf(false) }
    val metadata = session.metadata
    val errorTitle = stringResource(R.string.common_error)
    val successTitle = stringResource(R.string.common_success)
    val ok = stringResource(R.string.common_ok)
    val cancel = stringResource(R.string.common_cancel)
    fun show(title: String, message: String?) {
        alert = Alert(title, message, listOf(AlertButton(ok)))
    }
    fun copy(text: String, confirmation: String) {
        actions.copyToClipboard(text)
        show(successTitle, confirmation)
    }
    val cleanupTitle = stringResource(R.string.session_info_worktree_cleanup_title)
    val cleanupMessage = stringResource(R.string.session_info_worktree_cleanup_message)
    val cleanupDelete = stringResource(R.string.session_info_worktree_cleanup_delete)
    val cleanupKeep = stringResource(R.string.session_info_worktree_cleanup_keep)
    suspend fun cleanupWorktree() = controls.cleanupWorktree(session) {
        confirm({ alert = it }, cleanupTitle, cleanupMessage, cleanupDelete, cleanupKeep, destructive = true)
    }

    val resume = resumeAvailability(session, machine)
    val canFork = canForkSession(session, machine, continuationExperiments)
    val forkSource = session.forkSource()
    val outdated = isCliOutdated(metadata?.version)
    val resumeSubtitle = when (resume.block) {
        ResumeBlock.MissingMachine -> stringResource(R.string.session_info_resume_session_missing_machine)
        ResumeBlock.MissingBackendId -> stringResource(R.string.session_info_resume_session_missing_backend_id)
        ResumeBlock.SameMachineOnly -> stringResource(R.string.session_info_resume_session_same_machine_only)
        ResumeBlock.MachineOffline -> stringResource(R.string.session_info_resume_session_machine_offline)
        null -> stringResource(R.string.session_info_resume_session_subtitle)
    }
    val forkFailed = stringResource(R.string.session_fork_error_generic)
    val missingMetadata = stringResource(R.string.session_fork_error_missing_metadata)
    val archiveFailed = stringResource(R.string.session_info_failed_to_archive_session)
    val botArchiveFailed = stringResource(R.string.home_bot_archive_offline)
    val deleteFailed = stringResource(R.string.session_info_failed_to_delete_session)
    val deleteTitle = stringResource(R.string.session_info_delete_session)
    val deleteWarning = stringResource(R.string.session_info_delete_session_warning)

    fun spawned(result: SpawnSessionResult, fallback: String) = when (result) {
        is SpawnSessionResult.Success -> actions.onOpenSession(result.sessionId)
        is SpawnSessionResult.Error -> show(errorTitle, result.errorMessage.ifEmpty { fallback })
        else -> show(errorTitle, fallback)
    }

    ItemList {
        ItemGroup(title = stringResource(R.string.session_info_quick_actions)) {
            val git = metadata.gitPresentation()
            Item(
                title = stringResource(R.string.files_changes),
                icon = { Icon(Octicon.FileDiff, size = SessionInfoSpec.changesIcon, color = SessionInfoSpec.blue) },
                rightElement = if (git.changedFileCount != null || git.changes != null) {
                    {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            git.changedFileCount?.let {
                                Text(pluralResource(R.plurals.files_changed_files, it.toInt(), it.toInt()), style = happyTextStyle(fontSize = 12), color = colors.textSecondary)
                            }
                            git.changes?.let { changes ->
                                val prefix = if (changes.approximate) "~" else ""
                                Text("$prefix+${changes.insertions}", style = happyTextStyle(fontSize = 12), color = gitAddedColor(colors))
                                Text("$prefix-${changes.deletions}", style = happyTextStyle(fontSize = 12), color = gitRemovedColor(colors))
                            }
                            Icon(Ionicon.ChevronForward, size = 17.dp, color = colors.grouped.chevron)
                        }
                    }
                } else {
                    null
                },
                onClick = { actions.onChanges(session.id) },
                modifier = Modifier.testTag(SessionInfoTags.CHANGES),
            )
            metadata?.machineId?.ifEmpty { null }?.let { machineId ->
                Item(
                    title = stringResource(R.string.session_info_view_machine),
                    subtitle = stringResource(R.string.session_info_view_machine_subtitle),
                    icon = { Icon(Ionicon.ServerOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                    onClick = { actions.onOpenMachine(machineId) },
                    modifier = Modifier.testTag(SessionInfoTags.MACHINE),
                )
            }
            if (resume.canShowResume) {
                Item(
                    title = stringResource(R.string.session_info_resume_session),
                    subtitle = resumeSubtitle,
                    icon = { Icon(Ionicon.PlayCircleOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                    onClick = {
                        val machineId = metadata?.machineId
                        if (!resume.canResume || machineId == null) {
                            show(errorTitle, resumeSubtitle)
                        } else {
                            scope.launch { spawned(continuations.resume(machineId, session.id), resumeSubtitle) }
                        }
                    },
                    modifier = Modifier.testTag(SessionInfoTags.RESUME),
                )
            }
            if (canFork) {
                Item(
                    title = stringResource(R.string.session_fork_action),
                    subtitle = stringResource(R.string.session_fork_subtitle),
                    icon = { Icon(Ionicon.GitBranchOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                    loading = forking,
                    onClick = {
                        val source = forkSource ?: return@Item show(errorTitle, missingMetadata)
                        forking = true
                        scope.launch {
                            try {
                                spawned(continuations.fork(source), forkFailed)
                            } finally {
                                forking = false
                            }
                        }
                    },
                    modifier = Modifier.testTag(SessionInfoTags.FORK),
                )
                Item(
                    title = stringResource(R.string.session_duplicate_action),
                    subtitle = stringResource(R.string.session_duplicate_subtitle),
                    icon = { Icon(Ionicon.TimeOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                    onClick = { duplicating = true },
                    modifier = Modifier.testTag(SessionInfoTags.DUPLICATE),
                )
            }
            metadata?.parentSessionId?.ifEmpty { null }?.let { parent ->
                Item(
                    title = stringResource(R.string.session_forked_from_label),
                    subtitle = stringResource(R.string.session_forked_from_subtitle),
                    icon = { Icon(Ionicon.ReturnUpBackOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.purple) },
                    onClick = { actions.onOpenSession(parent) },
                    modifier = Modifier.testTag(SessionInfoTags.PARENT),
                )
            }
            Item(
                title = stringResource(R.string.session_info_archive_session),
                subtitle = stringResource(R.string.session_info_archive_session_subtitle),
                icon = { Icon(Ionicon.ArchiveOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.red) },
                loading = archiving,
                onClick = {
                    archiving = true
                    val successor = actions.tabSuccessor(session.id)
                    scope.launch {
                        try {
                            if (metadata?.bot == null) cleanupWorktree()
                            when (val result = controls.archive(session)) {
                                ArchiveResult.Archived -> actions.onArchived(successor)
                                is ArchiveResult.Failed -> show(errorTitle, result.message ?: if (result.bot) botArchiveFailed else archiveFailed)
                            }
                        } finally {
                            archiving = false
                        }
                    }
                },
                modifier = Modifier.testTag(SessionInfoTags.ARCHIVE),
            )
            if (metadata?.bot == null) {
                Item(
                    title = deleteTitle,
                    subtitle = stringResource(R.string.session_info_delete_session_subtitle),
                    icon = { Icon(Ionicon.TrashOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.red) },
                    loading = deleting,
                    onClick = {
                        alert = Alert(
                            deleteTitle,
                            deleteWarning,
                            listOf(
                                AlertButton(cancel),
                                AlertButton(deleteTitle, destructive = true) {
                                    deleting = true
                                    scope.launch {
                                        try {
                                            cleanupWorktree()
                                            val result = controls.delete(session)
                                            if (result.success) actions.onDeleted() else show(errorTitle, result.message ?: deleteFailed)
                                        } finally {
                                            deleting = false
                                        }
                                    }
                                },
                            ),
                        )
                    },
                    modifier = Modifier.testTag(SessionInfoTags.DELETE),
                )
            }
        }

        if (outdated) {
            ItemGroup {
                Item(
                    title = stringResource(R.string.session_info_cli_version_outdated),
                    subtitle = stringResource(R.string.session_info_update_cli_instructions),
                    icon = { Icon(Ionicon.WarningOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.orange) },
                    showChevron = false,
                    onClick = { copy(SessionInfoSpec.UPDATE_COMMAND, SessionInfoSpec.UPDATE_COMMAND) },
                    modifier = Modifier.testTag(SessionInfoTags.OUTDATED),
                )
            }
        }

        ItemGroup {
            val sessionIdCopied = stringResource(R.string.session_info_happy_session_id_copied)
            Item(
                title = stringResource(R.string.session_info_happy_session_id),
                subtitle = shortId(session.id),
                icon = { Icon(Ionicon.FingerPrintOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                onClick = { copy(session.id, sessionIdCopied) },
                modifier = Modifier.testTag(SessionInfoTags.SESSION_ID),
            )
            metadata?.claudeSessionId?.ifEmpty { null }?.let { id ->
                val copied = stringResource(R.string.session_info_claude_code_session_id_copied)
                Item(
                    title = stringResource(R.string.session_info_claude_code_session_id),
                    subtitle = shortId(id),
                    icon = { Icon(Ionicon.CodeOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.magenta) },
                    onClick = { copy(id, copied) },
                )
            }
            metadata?.codexThreadId?.ifEmpty { null }?.let { id ->
                val copied = stringResource(R.string.session_info_codex_thread_id_copied)
                Item(
                    title = stringResource(R.string.session_info_codex_thread_id),
                    subtitle = shortId(id),
                    icon = { Icon(Ionicon.TerminalOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.codex) },
                    onClick = { copy(id, copied) },
                )
            }
            if (!session.isOnline) {
                metadata.resumeCommand()?.let { command -> CopyableItem(command, actions.copyToClipboard) }
            }
            Item(
                title = stringResource(R.string.session_info_connection_status),
                detail = stringResource(if (session.isOnline) R.string.status_online else R.string.status_offline),
                icon = { Icon(Ionicon.PulseOutline, size = SessionInfoSpec.icon, color = if (session.isOnline) SessionInfoSpec.online else SessionInfoSpec.gray) },
                showChevron = false,
            )
            Item(
                title = stringResource(R.string.session_info_created),
                subtitle = formatLocaleDateTime(session.createdAt, zone),
                icon = { Icon(Ionicon.CalendarOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                showChevron = false,
            )
            Item(
                title = stringResource(R.string.session_info_last_updated),
                subtitle = formatLocaleDateTime(session.updatedAt, zone),
                icon = { Icon(Ionicon.TimeOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                showChevron = false,
            )
            Item(
                title = stringResource(R.string.session_info_sequence),
                detail = session.seq.toString(),
                icon = { Icon(Ionicon.GitCommitOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                showChevron = false,
            )
        }

        if (metadata != null) {
            ItemGroup(title = stringResource(R.string.session_info_metadata)) {
                InfoRow(stringResource(R.string.session_info_host), metadata.host, Ionicon.DesktopOutline)
                InfoRow(stringResource(R.string.session_info_path), formatPathRelativeToHome(metadata.path, metadata.homeDir), Ionicon.FolderOutline)
                metadata.version?.ifEmpty { null }?.let { version ->
                    Item(
                        title = stringResource(R.string.session_info_cli_version),
                        subtitle = version,
                        detail = if (outdated) "⚠️" else null,
                        icon = { Icon(Ionicon.GitBranchOutline, size = SessionInfoSpec.icon, color = if (outdated) SessionInfoSpec.orange else SessionInfoSpec.purple) },
                        showChevron = false,
                    )
                }
                metadata.os?.ifEmpty { null }?.let { InfoRow(stringResource(R.string.session_info_operating_system), formatOSPlatform(it), Ionicon.HardwareChipOutline) }
                if (metadata.isRig()) {
                    val client = metadata.client
                    InfoRow(
                        stringResource(R.string.home_info_client),
                        (client?.name ?: "Rig") + (client?.version?.ifEmpty { null }?.let { " $it" } ?: ""),
                        Ionicon.TerminalOutline,
                    )
                }
                InfoRow(stringResource(R.string.session_info_ai_provider), metadata.aiProviderName(), Ionicon.SparklesOutline)
                metadata.rigIdentity()?.modelName?.let { InfoRow(stringResource(R.string.home_info_model), it, Ionicon.HardwareChipOutline) }
                if (!metadata.isRig()) {
                    InfoRow(stringResource(R.string.home_info_sandbox), sandboxText(sandboxSummary(metadata.sandbox, metadata.homeDir)), Ionicon.ShieldOutline)
                    InfoRow(
                        stringResource(R.string.home_info_skip_permissions),
                        settingText(dangerouslySkipPermissions(metadata.dangerouslySkipPermissions, metadata.flavor, metadata.sandbox)),
                        Ionicon.WarningOutline,
                    )
                }
                metadata.hostPid?.takeIf { it != 0.0 }?.let { pid ->
                    InfoRow(stringResource(R.string.session_info_process_id), formatNumber(pid), Ionicon.TerminalOutline)
                }
                metadata.happyHomeDir?.ifEmpty { null }?.let {
                    InfoRow(stringResource(R.string.session_info_happy_home), formatPathRelativeToHome(it, metadata.homeDir), Ionicon.HomeOutline)
                }
                val metadataCopied = stringResource(R.string.session_info_metadata_copied)
                Item(
                    title = stringResource(R.string.session_info_copy_metadata),
                    icon = { Icon(Ionicon.CopyOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                    onClick = { copy(prettyJson.encodeToString(JsonObject.serializer(), metadata.raw), metadataCopied) },
                    modifier = Modifier.testTag(SessionInfoTags.COPY_METADATA),
                )
                Item(
                    title = stringResource(R.string.session_info_copy_metadata) + "\n& Client Logs",
                    icon = { Icon(Ionicon.DocumentTextOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                    onClick = {
                        scope.launch {
                            val logs = actions.clientLogs()
                            copy(ClientLogs.metadataAndLogs(prettyJson.encodeToString(JsonObject.serializer(), metadata.raw), logs), metadataCopied)
                        }
                    },
                    modifier = Modifier.testTag(SessionInfoTags.COPY_METADATA_AND_LOGS),
                )
            }
        }

        if (agentState != null && metadata?.client?.id != "rig") {
            ItemGroup(title = stringResource(R.string.session_info_agent_state)) {
                val controlled = (agentState["controlledByUser"] as? JsonPrimitive)?.booleanOrNull == true
                Item(
                    title = stringResource(R.string.session_info_controlled_by_user),
                    detail = stringResource(if (controlled) R.string.common_yes else R.string.common_no),
                    icon = { Icon(Ionicon.PersonOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.orange) },
                    showChevron = false,
                )
                val requests = (agentState["requests"] as? JsonObject)?.size ?: 0
                if (requests > 0) {
                    Item(
                        title = stringResource(R.string.session_info_pending_requests),
                        detail = requests.toString(),
                        icon = { Icon(Ionicon.HourglassOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.orange) },
                        showChevron = false,
                    )
                }
            }
        }

        ItemGroup(title = stringResource(R.string.session_info_activity)) {
            Item(
                title = stringResource(R.string.session_info_thinking),
                detail = stringResource(if (session.thinking) R.string.common_yes else R.string.common_no),
                icon = { Icon(Ionicon.BulbOutline, size = SessionInfoSpec.icon, color = if (session.thinking) SessionInfoSpec.yellow else SessionInfoSpec.gray) },
                showChevron = false,
            )
            if (session.thinking) {
                Item(
                    title = stringResource(R.string.session_info_thinking_since),
                    subtitle = formatLocaleDateTime(session.thinkingAt, zone),
                    icon = { Icon(Ionicon.TimerOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.yellow) },
                    showChevron = false,
                )
            }
            metadata?.activity?.let { activity ->
                if (activity.subagentsRunning + activity.subagentsQueued > 0) {
                    DetailRow(
                        stringResource(R.string.home_info_subagents),
                        stringResource(R.string.home_info_subagents_detail, formatNumber(activity.subagentsRunning), formatNumber(activity.subagentsQueued)),
                        Ionicon.PeopleOutline,
                    )
                }
                if (activity.workflowsRunning > 0) {
                    DetailRow(stringResource(R.string.home_info_workflows), stringResource(R.string.home_info_running, formatNumber(activity.workflowsRunning)), Ionicon.GitNetworkOutline)
                }
                if (activity.processesRunning > 0) {
                    DetailRow(stringResource(R.string.home_info_processes), stringResource(R.string.home_info_running, formatNumber(activity.processesRunning)), Ionicon.TerminalOutline)
                }
                if (activity.tasksPending + activity.tasksInProgress > 0) {
                    DetailRow(
                        stringResource(R.string.home_info_tasks),
                        stringResource(R.string.home_info_tasks_detail, formatNumber(activity.tasksInProgress), formatNumber(activity.tasksPending)),
                        Ionicon.CheckboxOutline,
                    )
                }
            }
        }

        if (devMode) {
            ItemGroup(title = stringResource(R.string.home_info_raw_json), modifier = Modifier.testTag(SessionInfoTags.RAW_JSON)) {
                agentState?.let {
                    RawJson(stringResource(R.string.home_info_raw_agent_state), Ionicon.CodeWorkingOutline, SessionInfoSpec.orange, it)
                }
                metadata?.let {
                    RawJson(stringResource(R.string.home_info_raw_metadata), Ionicon.InformationCircleOutline, SessionInfoSpec.purple, it.raw)
                }
                RawJson(
                    stringResource(R.string.home_info_raw_status),
                    Ionicon.AnalyticsOutline,
                    SessionInfoSpec.blue,
                    buildJsonObject {
                        put("isConnected", session.isOnline)
                        put("state", session.state.name)
                    },
                )
                RawJson(stringResource(R.string.home_info_raw_session), Ionicon.DocumentTextOutline, SessionInfoSpec.online, sessionJson(session, agentState))
            }
        }
    }

    if (duplicating) {
        DuplicateSheet(
            source = forkSource,
            continuations = continuations,
            onDismiss = { duplicating = false },
            onDuplicated = actions.onOpenSession,
        )
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

@Composable
private fun InfoRow(title: String, subtitle: String, icon: Ionicon) {
    Item(
        title = title,
        subtitle = subtitle,
        icon = { Icon(icon, size = SessionInfoSpec.icon, color = SessionInfoSpec.purple) },
        showChevron = false,
    )
}

@Composable
private fun DetailRow(title: String, detail: String, icon: Ionicon) {
    Item(
        title = title,
        detail = detail,
        icon = { Icon(icon, size = SessionInfoSpec.icon, color = SessionInfoSpec.purple) },
        showChevron = false,
    )
}

/** info.tsx `CopyableItem`: the resume command, copied with a checkmark for two seconds. */
@Composable
private fun CopyableItem(command: String, copyToClipboard: (String) -> Unit) {
    var copied by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Item(
        title = stringResource(R.string.home_info_resume_command),
        subtitle = command,
        icon = { Icon(Ionicon.PlayCircleOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.green) },
        showChevron = false,
        rightElement = {
            Icon(
                if (copied) Ionicon.Checkmark else Ionicon.CopyOutline,
                size = 18.dp,
                color = if (copied) SessionInfoSpec.green else SessionInfoSpec.gray,
            )
        },
        onClick = {
            copyToClipboard(command)
            copied = true
            scope.launch {
                kotlinx.coroutines.delay(2_000)
                copied = false
            }
        },
        modifier = Modifier.testTag(SessionInfoTags.RESUME_COMMAND),
    )
}

@Composable
private fun RawJson(title: String, icon: Ionicon, color: Color, json: JsonObject) {
    val colors = HappyTheme.colors
    Item(title = title, icon = { Icon(icon, size = SessionInfoSpec.icon, color = color) }, showChevron = false)
    Box(
        modifier = Modifier
            .padding(start = 16.dp, end = 16.dp, bottom = 12.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(colors.surfaceHigh)
            .horizontalScroll(rememberScrollState())
            .padding(12.dp),
    ) {
        Text(prettyJson.encodeToString(JsonObject.serializer(), json), style = SessionInfoSpec.code, color = colors.text)
    }
}

@Composable
private fun sandboxText(summary: SandboxSummary): String = when (summary) {
    SandboxSummary.Disabled -> stringResource(R.string.home_info_disabled)
    is SandboxSummary.Text -> summary.text
    is SandboxSummary.Enabled -> buildList {
        add(stringResource(R.string.home_info_enabled))
        summary.isolation?.let { add("isolation=$it") }
        summary.network?.let { add("network=$it") }
        summary.workspace?.let { add("workspace=$it") }
    }.joinToString(" | ")
}

@Composable
private fun settingText(setting: InfoSetting): String = stringResource(
    when (setting) {
        InfoSetting.Enabled -> R.string.home_info_enabled
        InfoSetting.Disabled -> R.string.home_info_disabled
        InfoSetting.Unknown -> R.string.home_info_unknown
    },
)

/** A number as JS prints it: whole numbers without a decimal point. */
private fun formatNumber(value: Double): String =
    if (value == Math.floor(value) && !value.isInfinite()) value.toLong().toString() else value.toString()

/** The session as stored, for the dev-mode dump (JSON.stringify(session)). */
private fun sessionJson(session: Session, agentState: JsonObject?): JsonObject = buildJsonObject {
    put("id", session.id)
    put("seq", session.seq)
    put("createdAt", session.createdAt)
    put("updatedAt", session.updatedAt)
    put("active", session.active)
    put("activeAt", session.activeAt)
    session.metadata?.let { put("metadata", it.raw) }
    put("metadataVersion", session.metadataVersion)
    agentState?.let { put("agentState", it) }
    put("agentStateVersion", session.agentStateVersion)
    put("thinking", session.thinking)
    put("thinkingAt", session.thinkingAt)
}

/** JSON.stringify(value, null, 2). */
private val prettyJson = Json { prettyPrint = true; prettyPrintIndent = "  " }

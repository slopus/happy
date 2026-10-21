package com.slopus.happy.ui.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.prettyJson
import com.slopus.happy.diagnostics.ClientLogs
import com.slopus.happy.model.Machine
import com.slopus.happy.model.Session
import com.slopus.happy.model.aiProviderName
import com.slopus.happy.model.dangerouslySkipPermissions
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
import com.slopus.happy.resume.ResumeOutcome
import com.slopus.happy.resume.rememberResumeTexts
import com.slopus.happy.sync.SpawnSessionResult
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Octicon
import com.slopus.happy.ui.components.confirm
import com.slopus.happy.ui.home.ArchiveResult
import com.slopus.happy.ui.home.GitChanges
import com.slopus.happy.ui.home.ResumeBlock
import com.slopus.happy.ui.home.canForkSession
import com.slopus.happy.ui.home.formatLocaleDateTime
import com.slopus.happy.ui.home.resumeAvailability
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.ZoneId

@Composable
internal fun SessionInfoContent(
    session: Session,
    agentState: JsonObject?,
    machine: Machine?,
    continuationExperiments: Boolean,
    debugBuild: Boolean,
    controls: SessionInfoControls,
    continuations: SessionContinuations,
    actions: SessionInfoActions,
    zone: ZoneId,
    live: SessionInfoLive,
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
    fun copy(text: String, confirmation: String, failure: String) {
        if (actions.copyToClipboard(text)) show(successTitle, confirmation) else show(errorTitle, failure)
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
    val resumeTexts = rememberResumeTexts()
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
            val git = metadata.gitPresentation(live.gitStatus, live.gitStatusFiles)
            Item(
                title = stringResource(R.string.files_changes),
                icon = { Icon(Octicon.FileDiff, size = SessionInfoSpec.changesIcon, color = SessionInfoSpec.blue) },
                rightElement = if (git.changedFileCount != null || git.changes != null) {
                    {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            git.changedFileCount?.let {
                                Text(pluralResource(R.plurals.files_changed_files, it.toInt(), it.toInt()), style = happyTextStyle(fontSize = 12), color = colors.textSecondary)
                            }
                            git.changes?.let { GitChanges(it) }
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
                            scope.launch {
                                when (val outcome = continuations.resume(machineId, session.id, metadata, resumeTexts)) {
                                    is ResumeOutcome.Resumed -> actions.onOpenSession(outcome.sessionId)
                                    is ResumeOutcome.Failed -> show(errorTitle, outcome.message)
                                    ResumeOutcome.InFlight -> Unit
                                }
                            }
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
                    // handleCopyUpdateCommand: a refused copy says Error / Error.
                    onClick = { copy(SessionInfoSpec.UPDATE_COMMAND, SessionInfoSpec.UPDATE_COMMAND, errorTitle) },
                    modifier = Modifier.testTag(SessionInfoTags.OUTDATED),
                )
            }
        }

        ItemGroup {
            val sessionIdCopied = stringResource(R.string.session_info_happy_session_id_copied)
            val sessionIdFailed = stringResource(R.string.session_info_failed_to_copy_session_id)
            Item(
                title = stringResource(R.string.session_info_happy_session_id),
                subtitle = shortId(session.id),
                icon = { Icon(Ionicon.FingerPrintOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                onClick = { copy(session.id, sessionIdCopied, sessionIdFailed) },
                modifier = Modifier.testTag(SessionInfoTags.SESSION_ID),
            )
            metadata?.claudeSessionId?.ifEmpty { null }?.let { id ->
                val copied = stringResource(R.string.session_info_claude_code_session_id_copied)
                val failed = stringResource(R.string.session_info_failed_to_copy_claude_code_session_id)
                Item(
                    title = stringResource(R.string.session_info_claude_code_session_id),
                    subtitle = shortId(id),
                    icon = { Icon(Ionicon.CodeOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.magenta) },
                    onClick = { copy(id, copied, failed) },
                )
            }
            metadata?.codexThreadId?.ifEmpty { null }?.let { id ->
                val copied = stringResource(R.string.session_info_codex_thread_id_copied)
                val failed = stringResource(R.string.session_info_failed_to_copy_codex_thread_id)
                Item(
                    title = stringResource(R.string.session_info_codex_thread_id),
                    subtitle = shortId(id),
                    icon = { Icon(Ionicon.TerminalOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.codex) },
                    onClick = { copy(id, copied, failed) },
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
                        settingText(dangerouslySkipPermissions(metadata.dangerouslySkipPermissions, metadata.flavor, metadata.sandbox, live.composer.permissionMode)),
                        Ionicon.WarningOutline,
                        Modifier.testTag(SessionInfoTags.SKIP_PERMISSIONS),
                    )
                }
                metadata.hostPid?.takeIf { it != 0.0 }?.let { pid ->
                    InfoRow(stringResource(R.string.session_info_process_id), formatNumber(pid), Ionicon.TerminalOutline)
                }
                metadata.happyHomeDir?.ifEmpty { null }?.let {
                    InfoRow(stringResource(R.string.session_info_happy_home), formatPathRelativeToHome(it, metadata.homeDir), Ionicon.HomeOutline)
                }
                val metadataCopied = stringResource(R.string.session_info_metadata_copied)
                val metadataFailed = stringResource(R.string.session_info_failed_to_copy_metadata)
                Item(
                    title = stringResource(R.string.session_info_copy_metadata),
                    icon = { Icon(Ionicon.CopyOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                    onClick = { copy(prettyJson(metadata.raw), metadataCopied, metadataFailed) },
                    modifier = Modifier.testTag(SessionInfoTags.COPY_METADATA),
                )
                Item(
                    title = stringResource(R.string.session_info_copy_metadata) + "\n& Client Logs",
                    icon = { Icon(Ionicon.DocumentTextOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.blue) },
                    onClick = {
                        scope.launch {
                            val logs = actions.clientLogs()
                            copy(ClientLogs.metadataAndLogs(prettyJson(metadata.raw), logs), metadataCopied, metadataFailed)
                        }
                    },
                    modifier = Modifier.testTag(SessionInfoTags.COPY_METADATA_AND_LOGS),
                )
            }
        }

        if (agentState != null && metadata?.client?.id != "rig") AgentStateGroup(agentState)
        ActivityGroup(session, zone)
        // info.tsx gates the dump on __DEV__ alone: debug builds, whatever the dev mode setting.
        if (debugBuild) RawJsonGroup(session, agentState, live.composer)
    }

    if (duplicating) {
        DuplicateSheet(
            source = forkSource,
            continuations = continuations,
            onDismiss = { duplicating = false },
            onDuplicated = actions.onReplaceWithSession,
        )
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

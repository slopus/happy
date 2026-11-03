package com.slopus.happy.ui.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.prettyJson
import com.slopus.happy.chat.resolveChatHeaderGit
import com.slopus.happy.diagnostics.ClientLogs
import com.slopus.happy.model.Machine
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.ui.chat.ComposerPermissionOptions
import com.slopus.happy.ui.chat.composerPermissionTitle
import com.slopus.happy.ui.components.PickerSheetSection
import com.slopus.happy.ui.conversation.ConversationPopup
import com.slopus.happy.model.aiProviderName
import com.slopus.happy.model.dangerouslySkipPermissions
import com.slopus.happy.model.forkSource
import com.slopus.happy.model.formatOSPlatform
import com.slopus.happy.model.formatPathRelativeToHome
import com.slopus.happy.model.gitPresentation
import com.slopus.happy.model.isCliOutdated
import com.slopus.happy.model.isRig
import com.slopus.happy.model.isTask
import com.slopus.happy.model.canLeaveTask
import com.slopus.happy.model.taskCanArchive
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
import com.slopus.happy.ui.settings.SettingsTile
import com.slopus.happy.ui.settings.SettingsTiles
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.confirm
import com.slopus.happy.ui.home.ArchiveResult
import com.slopus.happy.ui.home.taskFailureMessage
import com.slopus.happy.ui.home.GitChanges
import com.slopus.happy.ui.home.ResumeBlock
import com.slopus.happy.ui.home.canForkSession
import com.slopus.happy.ui.home.formatLocaleDateTime
import com.slopus.happy.ui.home.resumeAvailability
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
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
    permission: SessionInfoPermission?,
) {
    val colors = HappyTheme.colors
    val resources = LocalResources.current
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
        permission?.takeIf { metadata != null && it.modes.canChangePermission && it.modes.availableModes.isNotEmpty() }?.let {
            PermissionGroup(it, metadata) { field, option ->
                scope.launch {
                    try {
                        it.select(field, option)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        show(errorTitle, e.message)
                    }
                }
            }
        }
        ItemGroup(title = stringResource(R.string.session_info_quick_actions)) {
            val git = metadata.gitPresentation(live.gitStatus, live.gitStatusFiles)
            Item(
                title = stringResource(R.string.files_changes),
                icon = { SettingsTile(Ionicon.GitCompareOutline, SettingsTiles.blue) },
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
                    icon = { SettingsTile(Ionicon.ServerOutline, SettingsTiles.blue) },
                    onClick = { actions.onOpenMachine(machineId) },
                    modifier = Modifier.testTag(SessionInfoTags.MACHINE),
                )
            }
            if (resume.canShowResume) {
                Item(
                    title = stringResource(R.string.session_info_resume_session),
                    subtitle = resumeSubtitle,
                    icon = { SettingsTile(Ionicon.PlayCircleOutline, SettingsTiles.blue) },
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
                    icon = { SettingsTile(Ionicon.GitBranchOutline, SettingsTiles.blue) },
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
                    icon = { SettingsTile(Ionicon.TimeOutline, SettingsTiles.blue) },
                    onClick = { duplicating = true },
                    modifier = Modifier.testTag(SessionInfoTags.DUPLICATE),
                )
            }
            metadata?.parentSessionId?.ifEmpty { null }?.let { parent ->
                Item(
                    title = stringResource(R.string.session_forked_from_label),
                    subtitle = stringResource(R.string.session_forked_from_subtitle),
                    icon = { SettingsTile(Ionicon.ReturnUpBackOutline, SettingsTiles.purple) },
                    onClick = { actions.onOpenSession(parent) },
                    modifier = Modifier.testTag(SessionInfoTags.PARENT),
                )
            }
            // A task: anyone in it may leave, only its owner or the team's may archive (happy-ios 36b11c5bf).
            val task = session.isTask
            fun finished(result: ArchiveResult, successor: String?) = when (result) {
                ArchiveResult.Archived -> actions.onArchived(successor)
                is ArchiveResult.Failed -> show(errorTitle, result.message ?: if (result.bot) botArchiveFailed else archiveFailed)
                is ArchiveResult.TaskFailed -> show(errorTitle, taskFailureMessage(result, resources::getString))
            }
            if (task && session.canLeaveTask) {
                Item(
                    title = stringResource(R.string.task_leave),
                    icon = { SettingsTile(Ionicon.ExitOutline, SettingsTiles.red) },
                    destructive = true,
                    loading = archiving,
                    onClick = {
                        archiving = true
                        val successor = actions.tabSuccessor(session.id)
                        scope.launch {
                            try {
                                finished(controls.leave(session), successor)
                            } finally {
                                archiving = false
                            }
                        }
                    },
                    modifier = Modifier.testTag(SessionInfoTags.LEAVE_TASK),
                )
            }
            if (!task || session.taskCanArchive) {
                Item(
                    title = stringResource(if (task) R.string.task_archive else R.string.session_info_archive_session),
                    subtitle = if (task) null else stringResource(R.string.session_info_archive_session_subtitle),
                    icon = { SettingsTile(Ionicon.ArchiveOutline, SettingsTiles.red) },
                    destructive = true,
                    loading = archiving,
                    onClick = {
                        archiving = true
                        val successor = actions.tabSuccessor(session.id)
                        scope.launch {
                            try {
                                if (metadata?.bot == null && !task) cleanupWorktree()
                                finished(controls.archive(session), successor)
                            } finally {
                                archiving = false
                            }
                        }
                    },
                    modifier = Modifier.testTag(SessionInfoTags.ARCHIVE),
                )
            }
            // A bot or a task keeps one conversation for life: never deleted.
            if (metadata?.bot == null && !task) {
                Item(
                    title = deleteTitle,
                    subtitle = stringResource(R.string.session_info_delete_session_subtitle),
                    icon = { SettingsTile(Ionicon.TrashOutline, SettingsTiles.red) },
                    destructive = true,
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
                    icon = { SettingsTile(Ionicon.WarningOutline, SettingsTiles.orange) },
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
                icon = { SettingsTile(Ionicon.FingerPrintOutline, SettingsTiles.blue) },
                onClick = { copy(session.id, sessionIdCopied, sessionIdFailed) },
                modifier = Modifier.testTag(SessionInfoTags.SESSION_ID),
            )
            metadata?.claudeSessionId?.ifEmpty { null }?.let { id ->
                val copied = stringResource(R.string.session_info_claude_code_session_id_copied)
                val failed = stringResource(R.string.session_info_failed_to_copy_claude_code_session_id)
                Item(
                    title = stringResource(R.string.session_info_claude_code_session_id),
                    subtitle = shortId(id),
                    icon = { SettingsTile(Ionicon.CodeOutline, SettingsTiles.orange) },
                    onClick = { copy(id, copied, failed) },
                )
            }
            metadata?.codexThreadId?.ifEmpty { null }?.let { id ->
                val copied = stringResource(R.string.session_info_codex_thread_id_copied)
                val failed = stringResource(R.string.session_info_failed_to_copy_codex_thread_id)
                Item(
                    title = stringResource(R.string.session_info_codex_thread_id),
                    subtitle = shortId(id),
                    icon = { SettingsTile(Ionicon.TerminalOutline, SettingsTiles.gray) },
                    onClick = { copy(id, copied, failed) },
                )
            }
            if (!session.isOnline) {
                metadata.resumeCommand()?.let { command -> CopyableItem(command, actions.copyToClipboard) }
            }
            Item(
                title = stringResource(R.string.session_info_connection_status),
                detail = stringResource(if (session.isOnline) R.string.status_online else R.string.status_offline),
                icon = { SettingsTile(Ionicon.PulseOutline, if (session.isOnline) SettingsTiles.green else SettingsTiles.gray) },
                showChevron = false,
            )
            Item(
                title = stringResource(R.string.session_info_created),
                subtitle = formatLocaleDateTime(session.createdAt, zone),
                icon = { SettingsTile(Ionicon.CalendarOutline, SettingsTiles.blue) },
                showChevron = false,
            )
            Item(
                title = stringResource(R.string.session_info_last_updated),
                subtitle = formatLocaleDateTime(session.updatedAt, zone),
                icon = { SettingsTile(Ionicon.TimeOutline, SettingsTiles.blue) },
                showChevron = false,
            )
            Item(
                title = stringResource(R.string.session_info_sequence),
                detail = session.seq.toString(),
                icon = { SettingsTile(Ionicon.GitCommitOutline, SettingsTiles.blue) },
                showChevron = false,
            )
        }

        if (metadata != null) {
            ItemGroup(title = stringResource(R.string.session_info_metadata)) {
                InfoRow(stringResource(R.string.session_info_host), metadata.host, Ionicon.DesktopOutline)
                InfoRow(stringResource(R.string.session_info_path), formatPathRelativeToHome(metadata.path, metadata.homeDir), Ionicon.FolderOutline)
                // Once under the chat's name in its header (iOS 60158d2ac): the workspace, else the live branch, else the start's.
                resolveChatHeaderGit(metadata, live.gitStatus).subtitle?.let {
                    InfoRow(stringResource(R.string.session_info_branch), it, Ionicon.GitBranchOutline, Modifier.testTag(SessionInfoTags.BRANCH))
                }
                metadata.version?.ifEmpty { null }?.let { version ->
                    Item(
                        title = stringResource(R.string.session_info_cli_version),
                        subtitle = version,
                        detail = if (outdated) "⚠️" else null,
                        icon = { SettingsTile(Ionicon.GitBranchOutline, if (outdated) SettingsTiles.orange else SettingsTiles.purple) },
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
                    icon = { SettingsTile(Ionicon.CopyOutline, SettingsTiles.blue) },
                    onClick = { copy(prettyJson(metadata.raw), metadataCopied, metadataFailed) },
                    modifier = Modifier.testTag(SessionInfoTags.COPY_METADATA),
                )
                Item(
                    title = stringResource(R.string.session_info_copy_metadata) + "\n& Client Logs",
                    icon = { SettingsTile(Ionicon.DocumentTextOutline, SettingsTiles.blue) },
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

/**
 * The chat's permission mode as the first card (iOS's `permissionRow`):
 * the current mode as its value; a tap opens the modes from the row, the
 * current one ticked, as the chat's header menu lists them.
 */
@Composable
private fun PermissionGroup(permission: SessionInfoPermission, metadata: SessionMetadata?, onSelect: (AgentModeField, ModeOption) -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    val modes = permission.modes
    val current = (modes.permissionMode ?: modes.availableModes.firstOrNull { it.key == "default" })?.let(ModeOptions::hackMode)
    val title = composerPermissionTitle(metadata)
    ItemGroup {
        Box {
            Item(
                title = stringResource(R.string.conversation_details_permission_mode),
                icon = { SettingsTile(Ionicon.ShieldCheckmarkOutline, SettingsTiles.blue) },
                detail = current?.name,
                onClick = { open = true },
                showChevron = false,
                modifier = Modifier.testTag(SessionInfoTags.PERMISSION_MODE),
            )
            ConversationPopup(expanded = open, title = title, onDismiss = { open = false }, alignEnd = true, width = 280.dp, belowAnchor = true) {
                PermissionModeMenu(modes, metadata) { field, option ->
                    open = false
                    onSelect(field, option)
                }
            }
        }
    }
}

/** The permission modes as the chat's header menu listed them: under their heading, the current one ticked, a locked or retired one disabled. */
@Composable
internal fun PermissionModeMenu(modes: ComposerModes, metadata: SessionMetadata?, onSelect: (AgentModeField, ModeOption) -> Unit) {
    Column(Modifier.testTag(SessionInfoTags.PERMISSION_MENU).verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
        PickerSheetSection("permissions", composerPermissionTitle(metadata), separated = false)
        ComposerPermissionOptions(modes, metadata, onSelect)
    }
}

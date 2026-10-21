package com.slopus.happy.ui.machine

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.Machine
import com.slopus.happy.model.Session
import com.slopus.happy.model.displayName
import com.slopus.happy.model.displaySubtitle
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.OpResult
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
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.home.formatLocaleDateTime
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.ZoneId

@Serializable data class MachineRoute(val id: String)

object MachineTags {
    const val SCREEN = "machine.screen"
    const val RENAME = "machine.rename"
    const val STATUS = "machine.status"
    const val STOP_DAEMON = "machine.stopDaemon"
    const val SESSION = "machine.session"
    const val DELETE = "machine.delete"
    const val NOT_FOUND = "machine.notFound"
}

/** machine/[id].tsx's colours: iOS green, orange and red. */
object MachineSpec {
    val online = Color(0xFF34C759)
    val stop = Color(0xFFFF9500)
    val delete = Color(0xFFFF3B30)
    val chevron = Color(0xFFC7C7CC)
    val mono13 = happyTextStyle(fontSize = 13, lineHeight = 20, family = PlexMono)
    val mono12 = happyTextStyle(fontSize = 12, lineHeight = 20, family = PlexMono)
    val cliStatus = happyTextStyle(fontSize = 14)
    val rename = 24.dp
    const val RECENT_SESSIONS = 5
}

/** What the machine screen asks of a machine (ops.ts); tests use a fake. */
interface MachineControls {
    /** machineStopDaemon: the daemon's goodbye; throws when it could not be asked. */
    suspend fun stopDaemon(machineId: String): String?

    /** machineUpdateMetadata with the display name set, or cleared when null; throws on failure. */
    suspend fun rename(machine: Machine, displayName: String?)

    /** machineDelete */
    suspend fun delete(machineId: String): OpResult

    /** sync.refreshMachines */
    suspend fun refresh()
}

/** [MachineControls] over the signed-in account's ops. */
class LiveMachineControls(private val account: () -> AccountSync?) : MachineControls {
    private fun signedIn() = account() ?: error("Not signed in")

    override suspend fun stopDaemon(machineId: String): String? = signedIn().machineOps.stopDaemon(machineId)

    override suspend fun rename(machine: Machine, displayName: String?) {
        val metadata = machine.metadata?.raw ?: error("Machine metadata not found")
        val next = JsonObject(if (displayName != null) metadata + ("displayName" to JsonPrimitive(displayName)) else metadata - "displayName")
        signedIn().machineOps.updateMetadata(machine.id, next, machine.metadataVersion)
    }

    override suspend fun delete(machineId: String): OpResult = account()?.machineOps?.delete(machineId) ?: OpResult(false)

    override suspend fun refresh() {
        account()?.syncNow()
    }
}

/**
 * The recent sessions machine/[id].tsx lists: this machine's, last updated
 * first, five of them. Side chats aren't sessions there (useSessions skips them).
 */
fun recentMachineSessions(sessions: List<Session>, machineId: String): List<Session> =
    sessions.filter { it.metadata?.machineId == machineId && it.metadata.isSideChat != true }
        .sortedByDescending { it.updatedAt }
        .take(MachineSpec.RECENT_SESSIONS)

@Immutable
class MachineScreenActions(
    val onBack: () -> Unit,
    val onOpenSession: (String) -> Unit,
    /** After a delete went through: the screen's machine is gone. */
    val onDeleted: () -> Unit,
)

/**
 * machine/[id].tsx: the header names the machine (display name, else
 * host) with a pencil to rename it. Pull to refresh. Then the daemon (status
 * in green or grey, Stop Daemon in orange behind a confirm, the daemon's
 * last pid, port, start and CLI version when it reported them, the state
 * version), the CLI availability, up to five recent sessions, the machine's
 * facts, and the danger zone's Delete Machine behind a confirm.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MachineScreen(
    machine: Machine?,
    sessions: List<Session>,
    controls: MachineControls,
    actions: MachineScreenActions,
    modifier: Modifier = Modifier,
    zone: ZoneId = ZoneId.systemDefault(),
) {
    if (machine == null) {
        Screen(header = { Header(left = { HeaderBackButton(onClick = actions.onBack) }) }, modifier = modifier) {
            Box(modifier = Modifier.fillMaxSize().testTag(MachineTags.NOT_FOUND), contentAlignment = Alignment.Center) {
                Text(stringResource(R.string.machine_not_found), style = happyTextStyle(fontSize = 16), color = Color(0xFF666666))
            }
        }
        return
    }
    val colors = HappyTheme.colors
    val scope = rememberCoroutineScope()
    var alert by remember { mutableStateOf<Alert?>(null) }
    var prompt by remember { mutableStateOf<Prompt?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var stopping by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }

    val metadata = machine.metadata
    val name = metadata?.displayName?.ifEmpty { null } ?: metadata?.host?.ifEmpty { null } ?: stringResource(R.string.machine_unknown)
    val online = machine.isOnline
    val strings = MachineStrings(
        error = stringResource(R.string.common_error),
        ok = stringResource(R.string.common_ok),
        cancel = stringResource(R.string.common_cancel),
        success = stringResource(R.string.common_success),
        stopTitle = stringResource(R.string.machine_stop_daemon_confirm_title),
        stopMessage = stringResource(R.string.machine_stop_daemon_confirm_message),
        stop = stringResource(R.string.machine_stop_daemon),
        stopped = stringResource(R.string.machine_daemon_stopped),
        stopFailed = stringResource(R.string.machine_stop_daemon_failed),
        renameTitle = stringResource(R.string.machine_rename_title),
        renameMessage = stringResource(R.string.machine_rename_message),
        renamePlaceholder = stringResource(R.string.machine_rename_placeholder),
        rename = stringResource(R.string.common_rename),
        renamed = stringResource(R.string.machine_renamed),
        renameFailed = stringResource(R.string.machine_rename_failed),
        deleteTitle = stringResource(R.string.machine_delete_confirm_title),
        deleteMessage = stringResource(R.string.machine_delete_confirm_message),
        delete = stringResource(R.string.common_delete),
        deleteFailed = stringResource(R.string.machine_delete_failed),
    )
    fun show(title: String, message: String?) {
        alert = Alert(title, message, listOf(AlertButton(strings.ok)))
    }

    fun stopDaemon() {
        alert = Alert(
            strings.stopTitle,
            strings.stopMessage,
            listOf(
                AlertButton(strings.cancel),
                AlertButton(strings.stop, destructive = true) {
                    stopping = true
                    scope.launch {
                        try {
                            val message = controls.stopDaemon(machine.id)
                            show(strings.stopped, message)
                            controls.refresh()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            show(strings.error, strings.stopFailed)
                        } finally {
                            stopping = false
                        }
                    }
                },
            ),
        )
    }

    fun rename() {
        prompt = Prompt(
            title = strings.renameTitle,
            message = strings.renameMessage,
            defaultValue = metadata?.displayName.orEmpty(),
            placeholder = metadata?.host?.ifEmpty { null } ?: strings.renamePlaceholder,
            cancelText = strings.cancel,
            confirmText = strings.rename,
        ) { value ->
            if (value == null) return@Prompt
            renaming = true
            scope.launch {
                try {
                    controls.rename(machine, value.trim().ifEmpty { null })
                    show(strings.success, strings.renamed)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    show(strings.error, e.message ?: strings.renameFailed)
                    controls.refresh()
                } finally {
                    renaming = false
                }
            }
        }
    }

    fun delete() {
        alert = Alert(
            strings.deleteTitle,
            strings.deleteMessage,
            listOf(
                AlertButton(strings.cancel),
                AlertButton(strings.delete, destructive = true) {
                    deleting = true
                    scope.launch {
                        try {
                            val result = controls.delete(machine.id)
                            if (result.success) actions.onDeleted() else show(strings.error, result.message ?: strings.deleteFailed)
                        } finally {
                            deleting = false
                        }
                    }
                },
            ),
        )
    }

    Screen(
        modifier = modifier.testTag(MachineTags.SCREEN),
        header = {
            Header(
                title = name,
                left = { HeaderBackButton(onClick = actions.onBack) },
                right = {
                    Box(
                        modifier = Modifier
                            .size(48.dp)
                            .alpha(if (renaming) 0.5f else 1f)
                            .clickable(
                                enabled = !renaming,
                                interactionSource = remember { MutableInteractionSource() },
                                indication = ripple(bounded = false, radius = 24.dp, color = colors.text),
                                role = Role.Button,
                                onClick = ::rename,
                            )
                            .testTag(MachineTags.RENAME),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Octicon.Pencil, size = MachineSpec.rename, color = colors.text, contentDescription = strings.renameTitle)
                    }
                },
            )
        },
    ) {
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    try {
                        controls.refresh()
                    } finally {
                        refreshing = false
                    }
                }
            },
        ) {
            ItemList {
                ItemGroup {
                    Item(
                        title = stringResource(R.string.machine_status),
                        detail = stringResource(if (online) R.string.status_online else R.string.status_offline),
                        detailColor = if (online) MachineSpec.online else colors.textSecondary,
                        showChevron = false,
                        modifier = Modifier.testTag(MachineTags.STATUS),
                    )
                    val stopColor = if (online) MachineSpec.stop else colors.textSecondary
                    Item(
                        title = strings.stop,
                        titleColor = stopColor,
                        onClick = if (online) ::stopDaemon else null,
                        enabled = !stopping && online,
                        rightElement = {
                            if (stopping) {
                                CircularProgressIndicator(modifier = Modifier.size(20.dp), color = colors.textSecondary, strokeWidth = 2.dp)
                            } else {
                                Icon(Ionicon.StopCircle, size = 20.dp, color = stopColor)
                            }
                        },
                        modifier = Modifier.testTag(MachineTags.STOP_DAEMON),
                    )
                    machine.daemonState?.let { daemon ->
                        daemon.pid?.let { Item(stringResource(R.string.machine_last_known_pid), subtitle = it, subtitleStyle = MachineSpec.mono13) }
                        daemon.httpPort?.let { Item(stringResource(R.string.machine_last_known_http_port), subtitle = it, subtitleStyle = MachineSpec.mono13) }
                        daemon.startTime?.takeIf { it != 0.0 }?.let {
                            Item(stringResource(R.string.machine_started_at), subtitle = formatLocaleDateTime(it.toLong(), zone))
                        }
                        daemon.startedWithCliVersion?.let { Item(stringResource(R.string.machine_cli_version), subtitle = it, subtitleStyle = MachineSpec.mono13) }
                    }
                    Item(stringResource(R.string.machine_daemon_state_version), subtitle = machine.daemonStateVersion.toString())
                }

                metadata?.cliAvailability?.let { cli ->
                    ItemGroup(title = stringResource(R.string.machine_cli_availability)) {
                        CliRow("Claude", cli.claude)
                        CliRow("Codex", cli.codex)
                        CliRow("Gemini", cli.gemini)
                        CliRow("OpenClaw", cli.openclaw)
                        cli.rig?.let { CliRow("Rig", it) }
                        Item(stringResource(R.string.machine_last_detected), subtitle = formatLocaleDateTime(cli.detectedAt, zone), showChevron = false)
                    }
                }

                if (sessions.isNotEmpty()) {
                    ItemGroup(title = stringResource(R.string.tabs_sessions)) {
                        val newChat = stringResource(R.string.session_new_chat)
                        val unknown = stringResource(R.string.status_unknown)
                        for (session in sessions) {
                            Item(
                                title = session.displayName() ?: newChat,
                                subtitle = session.displaySubtitle() ?: unknown,
                                onClick = { actions.onOpenSession(session.id) },
                                rightElement = { Icon(Ionicon.ChevronForward, size = 20.dp, color = MachineSpec.chevron) },
                                modifier = Modifier.testTag(MachineTags.SESSION),
                            )
                        }
                    }
                }

                ItemGroup(title = stringResource(R.string.machine_machine_group)) {
                    Item(stringResource(R.string.machine_host), subtitle = metadata?.host?.ifEmpty { null } ?: machine.id)
                    Item(stringResource(R.string.machine_machine_id), subtitle = machine.id, subtitleStyle = MachineSpec.mono12)
                    metadata?.username?.ifEmpty { null }?.let { Item(stringResource(R.string.machine_username), subtitle = it) }
                    metadata?.homeDir?.ifEmpty { null }?.let {
                        Item(stringResource(R.string.machine_home_directory), subtitle = it, subtitleStyle = MachineSpec.mono13)
                    }
                    metadata?.platform?.ifEmpty { null }?.let { Item(stringResource(R.string.machine_platform), subtitle = it) }
                    metadata?.arch?.ifEmpty { null }?.let { Item(stringResource(R.string.machine_architecture), subtitle = it) }
                    Item(
                        stringResource(R.string.machine_last_seen),
                        subtitle = if (machine.activeAt != 0L) formatLocaleDateTime(machine.activeAt, zone) else stringResource(R.string.machine_never),
                    )
                    Item(stringResource(R.string.machine_metadata_version), subtitle = machine.metadataVersion.toString())
                }

                ItemGroup(title = stringResource(R.string.machine_danger_zone), footer = stringResource(R.string.machine_delete_footer)) {
                    Item(
                        title = stringResource(R.string.machine_delete),
                        titleColor = MachineSpec.delete,
                        onClick = ::delete,
                        enabled = !deleting,
                        showChevron = false,
                        rightElement = {
                            if (deleting) {
                                CircularProgressIndicator(modifier = Modifier.size(20.dp), color = colors.textSecondary, strokeWidth = 2.dp)
                            } else {
                                Icon(Ionicon.TrashOutline, size = 20.dp, color = MachineSpec.delete)
                            }
                        },
                        modifier = Modifier.testTag(MachineTags.DELETE),
                    )
                }
            }
        }
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
    prompt?.let { PromptModal(it, onDismiss = { prompt = null }) }
}

@Composable
private fun CliRow(name: String, installed: Boolean) {
    val colors = HappyTheme.colors
    Item(
        title = name,
        showChevron = false,
        rightElement = {
            Text(
                text = stringResource(if (installed) R.string.machine_cli_installed else R.string.machine_cli_not_found),
                style = MachineSpec.cliStatus,
                color = if (installed) MachineSpec.online else colors.textSecondary,
            )
        },
    )
}

private class MachineStrings(
    val error: String,
    val ok: String,
    val cancel: String,
    val success: String,
    val stopTitle: String,
    val stopMessage: String,
    val stop: String,
    val stopped: String,
    val stopFailed: String,
    val renameTitle: String,
    val renameMessage: String,
    val renamePlaceholder: String,
    val rename: String,
    val renamed: String,
    val renameFailed: String,
    val deleteTitle: String,
    val deleteMessage: String,
    val delete: String,
    val deleteFailed: String,
)

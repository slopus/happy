package com.slopus.happy.ui.onboarding

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.config.LocalSettings
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.connect.ConnectFlow
import com.slopus.happy.ui.connect.rememberTerminalConnect
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay
import kotlin.time.Duration.Companion.seconds

/** The ticked boxes as localSettings' `linkComputerChecklist` (`{install?: boolean, open?: boolean}`) holds them. */
fun linkChecklistTicked(checklist: Map<String, Boolean>): Set<LinkChecklistStep> =
    LinkChecklistStep.entries.filter { checklist[it.key] == true }.toSet()

/** `setTicked({ ...ticked, [step]: !ticked[step] })` */
fun LocalSettings.toggleLinkChecklist(step: LinkChecklistStep) = change { values ->
    values.copy(linkComputerChecklist = values.linkComputerChecklist + (step.key to (values.linkComputerChecklist[step.key] != true)))
}

/**
 * How long a scan that went through keeps the button busy while the linked
 * machine syncs in (MACHINE_ARRIVAL_TIMEOUT_MS). The screen is replaced when
 * the machine arrives; this only bounds the wait if it never does.
 */
val MACHINE_ARRIVAL_TIMEOUT = 10.seconds

/**
 * The first-run screen in place of the session list (LinkComputer.tsx
 * OnboardingLinkComputer): Home shows it once the account exists and no
 * machine is linked. The [OnboardingScreen] template with the gear (to the
 * onboarding settings), the checklist, "Scan QR code" (enabled once both
 * boxes are ticked) and "paste link instead". A link in flight keeps the
 * button busy ("Linking…") until the machine arrives; a failed one says so
 * on the line above the button. Back does nothing here: the account
 * exists, and the only way on is a linked computer.
 */
@Composable
fun OnboardingLinkComputerScreen(
    customServerLabel: String?,
    ticked: Set<LinkChecklistStep>,
    onToggle: (LinkChecklistStep) -> Unit,
    busy: Boolean,
    error: String?,
    onScan: () -> Unit,
    onPasteLink: () -> Unit,
    onSettings: () -> Unit,
    onOpenDesktopSite: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ready = LinkChecklistStep.Install in ticked && LinkChecklistStep.Open in ticked
    BackHandler {}
    OnboardingScreen(
        modifier = modifier,
        header = {
            OnboardingHeader(
                customServerLabel = customServerLabel,
                onServer = onSettings,
                gearDescription = stringResource(R.string.onboarding_settings_title),
            )
        },
        content = {
            LinkComputerContent(
                ticked = ticked,
                onToggle = onToggle,
                disabled = busy,
                error = error,
                onOpenDesktopSite = onOpenDesktopSite,
            )
        },
        primary = {
            RoundButton(
                title = stringResource(R.string.onboarding_scan_button),
                loadingTitle = stringResource(R.string.onboarding_linking),
                onClick = onScan,
                loading = busy,
                enabled = !busy && ready,
            )
        },
        secondary = SecondaryAction(
            title = stringResource(R.string.onboarding_paste_link),
            onClick = onPasteLink,
            enabled = !busy,
        ),
    )
}

/**
 * [OnboardingLinkComputerScreen] wired up: the checklist persists, Scan and
 * Paste link run the terminal connect flow, and a failure shows under the
 * checklist instead of an alert. Home calls this for its "link" state.
 */
@Composable
fun OnboardingLinkComputer(graph: AppGraph, onSettings: () -> Unit) {
    val uriHandler = LocalUriHandler.current
    val localSettings by graph.localSettings.values.collectAsStateWithLifecycle()
    val ticked = remember(localSettings.linkComputerChecklist) { linkChecklistTicked(localSettings.linkComputerChecklist) }
    val serverUrl by graph.serverConfig.url.collectAsStateWithLifecycle()
    val customServerLabel = remember(serverUrl) { graph.serverConfig.customHostLabel }
    var approved by rememberApproved()
    var error by remember { mutableStateOf<String?>(null) }
    var pasting by remember { mutableStateOf(false) }
    val linkFailed = stringResource(R.string.onboarding_link_failed)
    val connect = rememberTerminalConnect(graph, onSuccess = { approved = true }, onError = { error = linkFailed })

    OnboardingLinkComputerScreen(
        customServerLabel = customServerLabel,
        ticked = ticked,
        onToggle = graph.localSettings::toggleLinkChecklist,
        busy = connect.isLoading || approved,
        error = error,
        onScan = {
            error = null
            connect.scan()
        },
        onPasteLink = {
            error = null
            pasting = true
        },
        onSettings = onSettings,
        onOpenDesktopSite = { uriHandler.openUri(DESKTOP_URL) },
    )
    if (pasting) PasteLinkPrompt(connect, onDone = { pasting = false })
}

/** pasteLink: "Paste link", then connect with whatever was pasted. */
@Composable
private fun PasteLinkPrompt(connect: ConnectFlow, onDone: () -> Unit) {
    PromptModal(
        prompt = Prompt(
            title = stringResource(R.string.onboarding_paste_link_title),
            message = stringResource(R.string.onboarding_paste_link_message),
            placeholder = "happy://terminal?...",
            cancelText = stringResource(R.string.common_cancel),
            confirmText = stringResource(R.string.onboarding_paste_link_confirm),
            onResult = { url -> url?.trim()?.takeIf { it.isNotEmpty() }?.let(connect::connectWithUrl) },
        ),
        onDismiss = onDone,
    )
}

/** useApproved: true after a successful scan, false again after [MACHINE_ARRIVAL_TIMEOUT]. */
@Composable
private fun rememberApproved(): MutableState<Boolean> {
    val approved = remember { mutableStateOf(false) }
    LaunchedEffect(approved.value) {
        if (approved.value) {
            delay(MACHINE_ARRIVAL_TIMEOUT)
            approved.value = false
        }
    }
    return approved
}

object LinkComputerChecklistTags {
    const val TITLE = "linkChecklist.title"
    const val CONTENT = "linkChecklist.content"
    const val TERMINAL = "linkChecklist.terminal"
    const val TROUBLESHOOT = "linkChecklist.troubleshoot"
    const val LINK_ANOTHER = "linkChecklist.linkAnother"
    const val SHOW_ARCHIVED = "linkChecklist.showArchived"
}

/** LinkComputer.tsx LinkComputerChecklist styles. */
object LinkComputerChecklistSpec {
    val paddingTop = 16.dp
    val paddingBottom = 48.dp
    val maxWidth = 480.dp
    val paddingHorizontal = 24.dp
    val titleGap = 16.dp
    val titlePaddingHorizontal = 4.dp
    val terminalGap = 12.dp
    val actionsGap = 6.dp
    val buttonWidth = 260.dp
    val buttonGap = 8.dp
    val title = happyTextStyle(fontSize = 24, lineHeight = 30, weight = FontWeight.SemiBold)
}

/**
 * The checklist once a computer is linked but none can be reached
 * (LinkComputerChecklist): the linked box is ticked and the job is to get
 * Happy running again. Scrolls; content up to 480 wide with 24 side padding,
 * 16 from the top and 48 of bottom padding. Title 24/30 semibold (4 side
 * padding, 16 above the rows): "<name> is offline" for one computer, "Your
 * computers are offline" otherwise. The second row's body has the
 * `happy` command in a [TerminalBlock] 12 below its text. Then, 6 below and
 * left-aligned, 260 wide buttons 8 apart: Troubleshoot, "Link another
 * computer" (quiet; busy and "Linking…" after a scan) and, for an
 * archive-only account, "Show archived".
 *
 * [computers] are the linked computers' names (Home's machine choices).
 */
@Composable
fun LinkComputerChecklistScreen(
    computers: List<String>,
    busy: Boolean,
    approved: Boolean,
    onTroubleshoot: () -> Unit,
    onLinkAnother: () -> Unit,
    modifier: Modifier = Modifier,
    onShowArchived: (() -> Unit)? = null,
) {
    val colors = HappyTheme.colors
    val single = computers.singleOrNull()
    val title = if (single != null) {
        stringResource(R.string.onboarding_offline_title_one, single)
    } else {
        stringResource(R.string.onboarding_offline_title_many)
    }
    val linked = if (single != null) {
        stringResource(R.string.onboarding_offline_linked_step, single)
    } else {
        stringResource(R.string.onboarding_offline_linked_step_many, computers.size)
    }
    Box(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(top = LinkComputerChecklistSpec.paddingTop, bottom = LinkComputerChecklistSpec.paddingBottom),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = LinkComputerChecklistSpec.maxWidth)
                .fillMaxWidth()
                .testTag(LinkComputerChecklistTags.CONTENT)
                .padding(horizontal = LinkComputerChecklistSpec.paddingHorizontal),
        ) {
            Text(
                text = title,
                style = LinkComputerChecklistSpec.title,
                color = colors.text,
                modifier = Modifier
                    .padding(bottom = LinkComputerChecklistSpec.titleGap)
                    .fillMaxWidth()
                    .testTag(LinkComputerChecklistTags.TITLE)
                    .padding(horizontal = LinkComputerChecklistSpec.titlePaddingHorizontal)
                    .semantics { heading() },
            )
            ChecklistRow(checked = true, title = linked)
            ChecklistRow(checked = false, title = stringResource(R.string.onboarding_offline_open_step)) {
                Column {
                    Text(
                        text = stringResource(R.string.onboarding_offline_open_body),
                        style = OnboardingContentSpec.body,
                        color = colors.textSecondary,
                    )
                    TerminalBlock(
                        lines = listOf(TerminalLine.Command(stringResource(R.string.onboarding_terminal_run))),
                        modifier = Modifier
                            .padding(top = LinkComputerChecklistSpec.terminalGap)
                            .testTag(LinkComputerChecklistTags.TERMINAL),
                    )
                }
            }
            Column(modifier = Modifier.padding(top = LinkComputerChecklistSpec.actionsGap)) {
                ChecklistButton(LinkComputerChecklistTags.TROUBLESHOOT) {
                    RoundButton(title = stringResource(R.string.onboarding_offline_troubleshoot), onClick = onTroubleshoot)
                }
                ChecklistButton(LinkComputerChecklistTags.LINK_ANOTHER) {
                    RoundButton(
                        title = stringResource(if (approved) R.string.onboarding_linking else R.string.onboarding_link_another),
                        onClick = onLinkAnother,
                        size = RoundButtonSize.Normal,
                        display = RoundButtonDisplay.Inverted,
                        loading = busy,
                    )
                }
                if (onShowArchived != null) {
                    ChecklistButton(LinkComputerChecklistTags.SHOW_ARCHIVED) {
                        RoundButton(
                            title = stringResource(R.string.sidebar_show_archived),
                            onClick = onShowArchived,
                            size = RoundButtonSize.Normal,
                            display = RoundButtonDisplay.Inverted,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ChecklistButton(tag: String, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .padding(bottom = LinkComputerChecklistSpec.buttonGap)
            .widthIn(max = LinkComputerChecklistSpec.buttonWidth)
            .fillMaxWidth()
            .testTag(tag),
    ) { content() }
}

/**
 * [LinkComputerChecklistScreen] wired up: "Link another computer" scans,
 * and a scan that went through stays busy until a computer comes online.
 * Home calls this for its "offline" state.
 */
@Composable
fun LinkComputerChecklist(
    graph: AppGraph,
    computers: List<String>,
    onTroubleshoot: () -> Unit,
    onShowArchived: (() -> Unit)? = null,
) {
    var approved by rememberApproved()
    val connect = rememberTerminalConnect(graph, onSuccess = { approved = true })
    LinkComputerChecklistScreen(
        computers = computers,
        busy = connect.isLoading || approved,
        approved = approved,
        onTroubleshoot = onTroubleshoot,
        onLinkAnother = connect::scan,
        onShowArchived = onShowArchived,
    )
}

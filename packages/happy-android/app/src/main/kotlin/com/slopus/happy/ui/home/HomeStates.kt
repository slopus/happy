package com.slopus.happy.ui.home

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle

object HomeStateTags {
    const val NO_SESSIONS = "homeState.noSessions"
    const val NEW_SESSION = "homeState.newSession"
    const val LINK = "homeState.link"
    const val OPEN_CAMERA = "homeState.openCamera"
    const val ENTER_URL = "homeState.enterUrl"
    const val TERMINAL_TOGGLE = "homeState.terminalToggle"
    const val TERMINAL_BLOCK = "homeState.terminalBlock"
    const val OFFLINE_BANNER = "homeState.offlineBanner"
    const val UPDATE_BANNER = "homeState.updateBanner"
}

/** EmptyMainScreen.tsx */
object EmptyStateSpec {
    val stateIcon = 56.dp
    val stateIconGap = 20.dp
    val stateTitle = happyTextStyle(fontSize = 24, weight = FontWeight.SemiBold)
    val description = happyTextStyle(fontSize = 16)
    val descriptionMaxWidth = 360.dp
    val sidePadding = 24.dp
    val secondaryAction = happyTextStyle(fontSize = 15, weight = FontWeight.SemiBold)
    val secondaryMinHeight = 40.dp
    val terminal = happyTextStyle(fontSize = 16, family = PlexMono)
    val stepNumber = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold)
    val stepText = happyTextStyle(fontSize = 18)
    val buttonWidth = 240.dp
}

private const val DESKTOP_URL = "https://happy.engineering"

/**
 * A linked computer with nothing on it yet: terminal glyph (56), "No
 * sessions yet", a line of help, Start New Session, and Show archived when
 * there is an archive to show.
 */
@Composable
fun NoSessionsState(onNewSession: () -> Unit, onShowArchived: (() -> Unit)?) {
    val colors = HappyTheme.colors
    Column(
        modifier = Modifier.fillMaxSize().padding(top = HomeSpec.contentTop, bottom = 32.dp).testTag(HomeStateTags.NO_SESSIONS),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Ionicon.TerminalOutline, size = EmptyStateSpec.stateIcon, color = colors.textSecondary)
        Text(
            text = stringResource(R.string.home_no_sessions_title),
            style = EmptyStateSpec.stateTitle,
            color = colors.text,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = EmptyStateSpec.stateIconGap, bottom = 8.dp).padding(horizontal = EmptyStateSpec.sidePadding),
        )
        Text(
            text = stringResource(R.string.home_no_sessions_description),
            style = EmptyStateSpec.description,
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = EmptyStateSpec.descriptionMaxWidth).padding(horizontal = EmptyStateSpec.sidePadding).padding(bottom = 24.dp),
        )
        RoundButton(
            title = stringResource(R.string.home_start_new_session),
            onClick = onNewSession,
            modifier = Modifier.width(IntrinsicSize.Max).testTag(HomeStateTags.NEW_SESSION),
        )
        onShowArchived?.let { ShowArchivedAction(it) }
    }
}

/**
 * No computer linked: get Happy Desktop, or set up the CLI (the commands
 * and three steps fold out), then scan the computer's code or paste its URL.
 */
@Composable
fun LinkComputerState(actions: HomeScreenActions, onShowArchived: (() -> Unit)?) {
    val colors = HappyTheme.colors
    var manual by rememberSaveable { mutableStateOf(false) }
    var prompt by remember { mutableStateOf<Prompt?>(null) }
    val promptTitle = stringResource(R.string.modals_authenticate_terminal)
    val promptMessage = stringResource(R.string.modals_paste_url_from_terminal)
    val cancel = stringResource(R.string.common_cancel)
    val authenticate = stringResource(R.string.common_authenticate)
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(top = HomeSpec.contentTop + 24.dp, bottom = 24.dp + 32.dp)
            .testTag(HomeStateTags.LINK),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = stringResource(R.string.components_empty_main_screen_connect_computer),
            style = EmptyStateSpec.stateTitle,
            color = colors.text,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(bottom = 16.dp),
        )
        Text(
            text = stringResource(R.string.components_empty_main_screen_desktop_setup_instructions) + "\n\n" +
                stringResource(R.string.components_empty_main_screen_harness_description),
            style = EmptyStateSpec.description,
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = EmptyStateSpec.descriptionMaxWidth).padding(horizontal = EmptyStateSpec.sidePadding).padding(bottom = 24.dp),
        )
        RoundButton(
            title = stringResource(R.string.components_empty_main_screen_get_desktop),
            onClick = { actions.onOpenUrl(DESKTOP_URL) },
            modifier = Modifier.width(IntrinsicSize.Max),
        )
        SecondaryAction(
            text = stringResource(R.string.components_empty_main_screen_terminal_alternative),
            onClick = { manual = !manual },
            modifier = Modifier.testTag(HomeStateTags.TERMINAL_TOGGLE),
        )
        if (manual) {
            Column(
                modifier = Modifier
                    .padding(horizontal = EmptyStateSpec.sidePadding)
                    .padding(bottom = 20.dp)
                    .testTag(HomeStateTags.TERMINAL_BLOCK)
                    .clip(RoundedCornerShape(12.dp))
                    .background(colors.surfaceHigh)
                    .border(BorderStroke(1.dp, colors.divider), RoundedCornerShape(12.dp))
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (line in listOf("$ npm i -g happy", "$ happy claude", "$ happy codex")) {
                    Text(text = line, style = EmptyStateSpec.terminal, color = colors.status.connected)
                }
            }
            Column(
                modifier = Modifier.padding(top = 12.dp, bottom = 48.dp).padding(horizontal = EmptyStateSpec.sidePadding).width(250.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Step(1, stringResource(R.string.components_empty_main_screen_install_cli))
                Step(2, stringResource(R.string.components_empty_main_screen_run_it))
                Step(3, stringResource(R.string.components_empty_main_screen_scan_qr_code))
            }
        }
        RoundButton(
            title = stringResource(R.string.components_empty_main_screen_open_camera),
            onClick = actions.onLinkComputer,
            modifier = Modifier.padding(bottom = 12.dp).width(EmptyStateSpec.buttonWidth).testTag(HomeStateTags.OPEN_CAMERA),
        )
        Row(
            modifier = Modifier
                .heightIn(min = EmptyStateSpec.secondaryMinHeight)
                .testTag(HomeStateTags.ENTER_URL)
                .clip(RoundedCornerShape(20.dp))
                .clickable {
                    prompt = Prompt(
                        title = promptTitle,
                        message = promptMessage,
                        placeholder = "happy://terminal?...",
                        cancelText = cancel,
                        confirmText = authenticate,
                        onResult = { url -> url?.trim()?.takeIf { it.isNotEmpty() }?.let(actions.onConnectUrl) },
                    )
                }
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Icon(Ionicon.LinkOutline, size = 17.dp, color = colors.textSecondary)
            Text(text = stringResource(R.string.connect_enter_url_manually), style = EmptyStateSpec.secondaryAction, color = colors.textSecondary)
        }
        onShowArchived?.let { ShowArchivedAction(it) }
    }
    prompt?.let { PromptModal(it, onDismiss = { prompt = null }) }
}

@Composable
private fun Step(number: Int, text: String) {
    val colors = HappyTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .padding(end = 12.dp)
                .size(24.dp)
                .clip(CircleShape)
                .background(colors.surfaceHighest)
                .border(1.dp, colors.divider, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(text = number.toString(), style = EmptyStateSpec.stepNumber, color = colors.text)
        }
        Text(text = text, style = EmptyStateSpec.stepText, color = colors.textSecondary)
    }
}

@Composable
private fun SecondaryAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Box(
        modifier = modifier
            .padding(top = 4.dp)
            .heightIn(min = EmptyStateSpec.secondaryMinHeight)
            .clip(RoundedCornerShape(20.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = text, style = EmptyStateSpec.secondaryAction, color = colors.textSecondary, textAlign = TextAlign.Center)
    }
}

@Composable
private fun ShowArchivedAction(onClick: () -> Unit) {
    SecondaryAction(
        text = stringResource(R.string.sidebar_show_archived),
        onClick = onClick,
        modifier = Modifier.testTag(HomeTags.SHOW_ARCHIVED),
    )
}

/**
 * Every linked computer offline and nothing to list. happy-app shows the
 * onboarding's LinkComputerChecklist here; until that is wired in, the same
 * plaque the list shows, and Show archived.
 */
@Composable
fun DefaultOfflineContent(state: HomeListState?, actions: HomeScreenActions, onShowArchived: (() -> Unit)?) {
    Column(modifier = Modifier.fillMaxSize().padding(top = HomeSpec.contentTop), horizontalAlignment = Alignment.CenterHorizontally) {
        state?.offlineBanner?.let { OfflineMachinesBanner(it, actions.onTroubleshoot) }
        onShowArchived?.let { ShowArchivedAction(it) }
    }
}

/** HomeListHeader: the offline plaque first (it's about right now), then the update. */
@Composable
fun HomeBanners(offline: OfflineBanner?, updateUrl: String?, actions: HomeScreenActions) {
    Column(modifier = Modifier.fillMaxWidth()) {
        offline?.let { OfflineMachinesBanner(it, actions.onTroubleshoot) }
        updateUrl?.let { url -> UpdateBanner(onClick = { actions.onOpenUrl(url) }) }
    }
}

/** OfflineMachinesBanner: a quiet plaque, warning glyph (28, warning text) and a chevron to troubleshooting. */
@Composable
fun OfflineMachinesBanner(banner: OfflineBanner, onTroubleshoot: () -> Unit) {
    val colors = HappyTheme.colors
    BannerGroup(Modifier.testTag(HomeStateTags.OFFLINE_BANNER)) {
        Item(
            title = banner.machineName?.let { stringResource(R.string.troubleshoot_banner_title_one, it) }
                ?: stringResource(R.string.troubleshoot_banner_title_many),
            subtitle = stringResource(R.string.troubleshoot_banner_subtitle),
            icon = { Icon(Ionicon.WarningOutline, size = 28.dp, color = colors.boxWarning.text) },
            showChevron = true,
            onClick = onTroubleshoot,
        )
    }
}

/** UpdateBanner's native case: the store has a required update (POST /v1/version). */
@Composable
fun UpdateBanner(onClick: () -> Unit) {
    val colors = HappyTheme.colors
    BannerGroup(Modifier.testTag(HomeStateTags.UPDATE_BANNER)) {
        Item(
            title = stringResource(R.string.update_banner_native_update_available),
            subtitle = stringResource(R.string.update_banner_tap_to_update_play_store),
            icon = { Icon(Ionicon.DownloadOutline, size = 28.dp, color = colors.success) },
            showChevron = true,
            onClick = onClick,
        )
    }
}

/** The phone list's banner slot: 4 above the card, 16 below. */
@Composable
private fun BannerGroup(modifier: Modifier, content: @Composable () -> Unit) {
    ItemGroup(modifier = modifier.padding(bottom = 16.dp), noTitleSpacer = 4.dp) { content() }
}

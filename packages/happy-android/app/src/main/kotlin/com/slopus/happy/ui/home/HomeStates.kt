package com.slopus.happy.ui.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object HomeStateTags {
    const val NO_SESSIONS = "homeState.noSessions"
    const val NEW_SESSION = "homeState.newSession"
    const val OFFLINE_BANNER = "homeState.offlineBanner"
    const val UPDATE_BANNER = "homeState.updateBanner"
    const val CHANGELOG_BANNER = "homeState.changelogBanner"
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
}

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

@Composable
private fun SecondaryAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Box(
        modifier = modifier
            .padding(top = 4.dp)
            .heightIn(min = EmptyStateSpec.secondaryMinHeight)
            .clip(RoundedCornerShape(20.dp))
            .clickable(role = Role.Button, onClick = onClick)
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
 * UpdateBanner's cases on Android, highest priority first: a required store
 * update, then unread What's New. (No OTA updates in a native build.)
 */
sealed interface HomeUpdate {
    data class Native(val url: String) : HomeUpdate
    data object Changelog : HomeUpdate

    companion object {
        fun resolve(nativeUrl: String?, changelogUnread: Boolean): HomeUpdate? = when {
            nativeUrl != null -> Native(nativeUrl)
            changelogUnread -> Changelog
            else -> null
        }
    }
}

/** HomeListHeader: the offline plaque first (it's about right now), then the update. */
@Composable
fun HomeBanners(offline: OfflineBanner?, update: HomeUpdate?, actions: HomeScreenActions) {
    Column(modifier = Modifier.fillMaxWidth()) {
        offline?.let { OfflineMachinesBanner(it, actions.onTroubleshoot) }
        when (update) {
            is HomeUpdate.Native -> UpdateBanner(onClick = { actions.onOpenUrl(update.url) })
            HomeUpdate.Changelog -> ChangelogBanner(onClick = actions.onWhatsNew)
            null -> Unit
        }
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

/** UpdateBanner's changelog case: sparkles (28, text colour), "What's new", a chevron to What's New. */
@Composable
fun ChangelogBanner(onClick: () -> Unit) {
    val colors = HappyTheme.colors
    BannerGroup(Modifier.testTag(HomeStateTags.CHANGELOG_BANNER)) {
        Item(
            title = stringResource(R.string.update_banner_whats_new),
            subtitle = stringResource(R.string.update_banner_see_latest),
            icon = { Icon(Ionicon.SparklesOutline, size = 28.dp, color = colors.text) },
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

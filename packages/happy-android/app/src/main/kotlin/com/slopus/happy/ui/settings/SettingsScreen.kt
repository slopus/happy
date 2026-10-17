package com.slopus.happy.ui.settings

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.Profile
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

object SettingsTags {
    const val APP_CARD = "settings.appCard"
    const val LOGOTYPE = "settings.logotype"
    const val AVATAR = "settings.avatar"
    const val NAME = "settings.name"
    const val BIO = "settings.bio"
    const val VERSION = "settings.version"
    const val SUPPORT = "settings.support"
}

/** SettingsView.tsx, Android */
object SettingsSpec {
    val cardMarginHorizontal = 16.dp
    val cardMarginTop = 16.dp
    val cardPaddingVertical = 24.dp
    val cardRadius = 16.dp
    val cardBorder = 0.5.dp
    val logotypeWidth = 300.dp
    val logotypeHeight = 90.dp
    val logotypeGap = 12.dp
    val avatarSize = 90.dp
    val avatarGap = 12.dp
    val name = happyTextStyle(fontSize = 20, weight = FontWeight.SemiBold)
    val nameGapWithBio = 4.dp
    val nameGap = 8.dp
    val bio = happyTextStyle(fontSize = 14)
    val bioGap = 8.dp
    val bioPaddingHorizontal = 16.dp

    /** Item icons are 29 Ionicons in the 32 icon slot. */
    val itemIcon = 29.dp

    val blue = Color(0xFF007AFF)
    val indigo = Color(0xFF5856D6)
    val red = Color(0xFFFF3B30)
    val orange = Color(0xFFFF9500)
    val teal = Color(0xFF5AC8FA)

    const val GITHUB_URL = "https://github.com/slopus/happy"
    const val ISSUES_URL = "https://github.com/slopus/happy/issues"
    const val PRIVACY_URL = "https://happy.engineering/privacy/"
    const val TERMS_URL = "https://happy.engineering/terms/"
}

/** A settings row icon: a 29 Ionicon in [color]. */
@Composable
fun ItemIcon(icon: Ionicon, color: Color) {
    Icon(icon = icon, size = SettingsSpec.itemIcon, color = color)
}

/** The profile avatar: the uploaded or GitHub picture when there is one, else generated from the account id. */
@Composable
fun ProfileAvatar(profile: Profile, size: Dp) {
    Avatar(id = profile.id, size = size, imageUri = profile.avatarUrl, thumbhash = profile.avatar?.thumbhash)
}

/**
 * formatBuildSubtitle: "Commit 2026-10-16 03:12 UTC / abc1234" from the
 * build's commit, either part optional; null without both.
 */
fun buildSubtitle(commitSha: String?, commitTimestamp: String?): String? {
    val time = commitTimestamp?.takeIf { it.isNotEmpty() }?.let { value ->
        try {
            OffsetDateTime.parse(value).withOffsetSameInstant(ZoneOffset.UTC).format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm 'UTC'"))
        } catch (_: DateTimeParseException) {
            value
        }
    }
    val sha = commitSha?.takeIf { it.isNotEmpty() }?.take(7)
    if (time == null && sha == null) return null
    return listOfNotNull(if (time != null) "Commit $time" else "Commit", sha).joinToString(" / ")
}

/** What the connected-accounts rows show and whether they're busy. */
data class ConnectedAccounts(
    val claudeConnected: Boolean = false,
    val claudeBusy: Boolean = false,
    val gitHubLogin: String? = null,
    val gitHubBusy: Boolean = false,
)

/**
 * Settings (SettingsView.tsx, native rows), including Support us and Voice
 * Assistant. The experimental Usage screen and developer group are excluded.
 *
 * Spec: the app card is inset 16 at the sides and 16 from the top, radius
 * 16, 0.5 divider border, surface colour, 24 vertical padding. With a
 * profile name it holds the 90 avatar (12 under it), the name (20
 * semibold; 4 under it with a bio, else 8) and the bio (14, secondary,
 * centred, 16 side padding, 8 under it); without one, the 300x90 logotype
 * with 12 under it. Then standard [ItemGroup]s of [Item]s with 29 icons:
 * connect terminal (Scan QR, Enter URL; no chevrons), Support us (29 red
 * heart, no chevron; Pro gets the thanks subtitle and no action), Connected Accounts
 * (Claude Code, GitHub; no chevrons), Features (Account, Appearance,
 * Voice Assistant, Agents), About (What's New, GitHub, Report an Issue, Privacy Policy,
 * Terms of Service, Version with the commit as a two-line subtitle).
 *
 * The Version detail is "versionName (versionCode)": happy-app shows
 * "version / runtime N", its OTA runtime, and a native build has none; the
 * version code is what identifies this build instead.
 */
@Composable
fun SettingsScreen(
    versionName: String,
    onBack: () -> Unit,
    onAccount: () -> Unit,
    onAppearance: () -> Unit,
    onOpenUrl: (String) -> Unit,
    profile: Profile = Profile.Defaults,
    versionSubtitle: String? = null,
    connectingTerminal: Boolean = false,
    onScanQr: () -> Unit = {},
    onEnterUrl: () -> Unit = {},
    accounts: ConnectedAccounts = ConnectedAccounts(),
    onClaude: () -> Unit = {},
    onGitHub: () -> Unit = {},
    onAgents: () -> Unit = {},
    onVoice: () -> Unit = {},
    onWhatsNew: () -> Unit = {},
    isPro: Boolean = false,
    onSupport: () -> Unit = {},
    /** A tap on Version; ten in a row toggle developer mode (useMultiClick). */
    onVersion: () -> Unit = {},
    avatar: @Composable (Profile, Dp) -> Unit = { p, size -> ProfileAvatar(p, size) },
) {
    val colors = HappyTheme.colors
    val cardShape = RoundedCornerShape(SettingsSpec.cardRadius)
    Screen(header = { StackHeader(stringResource(R.string.settings_title), onBack) }) {
        ItemList {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = SettingsSpec.cardMarginHorizontal, end = SettingsSpec.cardMarginHorizontal, top = SettingsSpec.cardMarginTop)
                    .clip(cardShape)
                    .background(colors.surface)
                    .border(SettingsSpec.cardBorder, colors.divider, cardShape)
                    .testTag(SettingsTags.APP_CARD)
                    .padding(vertical = SettingsSpec.cardPaddingVertical),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (!profile.firstName.isNullOrEmpty()) {
                    val bio = profile.bio
                    Box(Modifier.padding(bottom = SettingsSpec.avatarGap).size(SettingsSpec.avatarSize).testTag(SettingsTags.AVATAR)) {
                        avatar(profile, SettingsSpec.avatarSize)
                    }
                    Text(
                        text = profile.displayName.orEmpty(),
                        style = SettingsSpec.name,
                        color = colors.text,
                        modifier = Modifier
                            .padding(bottom = if (bio != null) SettingsSpec.nameGapWithBio else SettingsSpec.nameGap)
                            .testTag(SettingsTags.NAME),
                    )
                    if (bio != null) {
                        Text(
                            text = bio,
                            style = SettingsSpec.bio,
                            color = colors.textSecondary,
                            textAlign = TextAlign.Center,
                            modifier = Modifier
                                .padding(bottom = SettingsSpec.bioGap)
                                .testTag(SettingsTags.BIO)
                                .padding(horizontal = SettingsSpec.bioPaddingHorizontal),
                        )
                    }
                } else {
                    Image(
                        painter = painterResource(if (colors.dark) R.drawable.logotype_light else R.drawable.logotype_dark),
                        contentDescription = "Happy",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .padding(bottom = SettingsSpec.logotypeGap)
                            .size(SettingsSpec.logotypeWidth, SettingsSpec.logotypeHeight)
                            .testTag(SettingsTags.LOGOTYPE),
                    )
                }
            }

            ItemGroup {
                Item(
                    title = stringResource(R.string.settings_scan_qr_code_to_authenticate),
                    icon = { ItemIcon(Ionicon.QrCodeOutline, SettingsSpec.blue) },
                    onClick = onScanQr,
                    loading = connectingTerminal,
                    showChevron = false,
                )
                Item(
                    title = stringResource(R.string.connect_enter_url_manually),
                    icon = { ItemIcon(Ionicon.LinkOutline, SettingsSpec.blue) },
                    onClick = onEnterUrl,
                    showChevron = false,
                )
            }

            ItemGroup {
                Item(
                    title = stringResource(R.string.settings_support_us),
                    subtitle = stringResource(if (isPro) R.string.settings_support_us_subtitle_pro else R.string.settings_support_us_subtitle),
                    icon = { ItemIcon(Ionicon.Heart, SettingsSpec.red) },
                    onClick = if (isPro) null else onSupport,
                    showChevron = false,
                    modifier = Modifier.testTag(SettingsTags.SUPPORT),
                )
            }

            ItemGroup(title = stringResource(R.string.settings_connected_accounts)) {
                Item(
                    title = "Claude Code",
                    subtitle = stringResource(if (accounts.claudeConnected) R.string.settings_account_status_active else R.string.settings_connect_account),
                    icon = {
                        Image(
                            painter = painterResource(R.drawable.icon_claude),
                            contentDescription = null,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.size(SettingsSpec.itemIcon),
                        )
                    },
                    onClick = onClaude,
                    loading = accounts.claudeBusy,
                    showChevron = false,
                )
                val login = accounts.gitHubLogin
                Item(
                    title = stringResource(R.string.settings_github),
                    subtitle = if (login != null) stringResource(R.string.settings_github_connected, login) else stringResource(R.string.settings_connect_github_account),
                    icon = { ItemIcon(Ionicon.LogoGithub, if (login != null) colors.status.connected else colors.textSecondary) },
                    onClick = onGitHub,
                    loading = accounts.gitHubBusy,
                    showChevron = false,
                )
            }

            ItemGroup(title = stringResource(R.string.settings_features)) {
                Item(
                    title = stringResource(R.string.settings_account),
                    subtitle = stringResource(R.string.settings_account_subtitle),
                    icon = { ItemIcon(Ionicon.PersonCircleOutline, SettingsSpec.blue) },
                    onClick = onAccount,
                )
                Item(
                    title = stringResource(R.string.settings_appearance),
                    subtitle = stringResource(R.string.settings_appearance_subtitle),
                    icon = { ItemIcon(Ionicon.ColorPaletteOutline, SettingsSpec.indigo) },
                    onClick = onAppearance,
                )
                Item(
                    title = stringResource(R.string.settings_voice_assistant),
                    subtitle = stringResource(R.string.settings_voice_assistant_subtitle),
                    icon = { ItemIcon(Ionicon.MicOutline, Color(0xFF34C759)) },
                    onClick = onVoice,
                )
                Item(
                    title = stringResource(R.string.settings_agents),
                    subtitle = stringResource(R.string.settings_agents_subtitle),
                    icon = { ItemIcon(Ionicon.OptionsOutline, SettingsSpec.teal) },
                    onClick = onAgents,
                )
            }

            ItemGroup(title = stringResource(R.string.settings_about), footer = stringResource(R.string.settings_about_footer)) {
                Item(
                    title = stringResource(R.string.settings_whats_new),
                    subtitle = stringResource(R.string.settings_whats_new_subtitle),
                    icon = { ItemIcon(Ionicon.SparklesOutline, SettingsSpec.orange) },
                    onClick = onWhatsNew,
                )
                Item(
                    title = stringResource(R.string.settings_github),
                    icon = { ItemIcon(Ionicon.LogoGithub, colors.text) },
                    detail = "slopus/happy",
                    onClick = { onOpenUrl(SettingsSpec.GITHUB_URL) },
                )
                Item(
                    title = stringResource(R.string.settings_report_issue),
                    icon = { ItemIcon(Ionicon.BugOutline, SettingsSpec.red) },
                    onClick = { onOpenUrl(SettingsSpec.ISSUES_URL) },
                )
                Item(
                    title = stringResource(R.string.settings_privacy_policy),
                    icon = { ItemIcon(Ionicon.ShieldCheckmarkOutline, SettingsSpec.blue) },
                    onClick = { onOpenUrl(SettingsSpec.PRIVACY_URL) },
                )
                Item(
                    title = stringResource(R.string.settings_terms_of_service),
                    icon = { ItemIcon(Ionicon.DocumentTextOutline, SettingsSpec.blue) },
                    onClick = { onOpenUrl(SettingsSpec.TERMS_URL) },
                )
                Item(
                    title = stringResource(R.string.common_version),
                    subtitle = versionSubtitle,
                    subtitleLines = 2,
                    detail = versionName,
                    icon = { ItemIcon(Ionicon.InformationCircleOutline, colors.textSecondary) },
                    showChevron = false,
                    onClick = onVersion,
                    modifier = Modifier.testTag(SettingsTags.VERSION),
                )
            }
        }
    }
}

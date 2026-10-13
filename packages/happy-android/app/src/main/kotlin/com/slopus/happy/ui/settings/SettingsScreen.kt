package com.slopus.happy.ui.settings

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme

object SettingsTags {
    const val APP_CARD = "settings.appCard"
    const val LOGOTYPE = "settings.logotype"
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

    /** Item icons are 29 Ionicons in the 32 icon slot. */
    val itemIcon = 29.dp

    val blue = Color(0xFF007AFF)
    val indigo = Color(0xFF5856D6)
    val red = Color(0xFFFF3B30)
    val orange = Color(0xFFFF9500)

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

/**
 * Settings, with the sections of SettingsView.tsx this app has: the app
 * card (logotype view; the profile view needs avatars), Features (Account,
 * Appearance) and About. Terminal connect, support, connected accounts,
 * voice, agents and the changelog come with their features.
 *
 * Spec: card inset 16 at the sides, 16 from the top, radius 16, 0.5 divider
 * border, surface colour, 24 vertical padding around a 300x90 logotype with
 * 12 under it. Then standard [ItemGroup]s of [Item]s.
 */
@Composable
fun SettingsScreen(
    versionName: String,
    onBack: () -> Unit,
    onAccount: () -> Unit,
    onAppearance: () -> Unit,
    onOpenUrl: (String) -> Unit,
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
            }

            ItemGroup(title = stringResource(R.string.settings_about), footer = stringResource(R.string.settings_about_footer)) {
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
                    detail = versionName,
                    icon = { ItemIcon(Ionicon.InformationCircleOutline, colors.textSecondary) },
                    showChevron = false,
                )
            }
        }
    }
}

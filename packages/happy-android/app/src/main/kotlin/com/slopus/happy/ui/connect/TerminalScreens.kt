package com.slopus.happy.ui.connect

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object TerminalScreenTags {
    const val HERO = "terminal.hero"
    const val HERO_ICON = "terminal.heroIcon"
    const val ACTIONS = "terminal.actions"
    const val ACCEPT = "terminal.accept"
    const val REJECT = "terminal.reject"
}

/** terminal/index.tsx and terminal/connect.tsx */
object TerminalScreenSpec {
    val heroPaddingVertical = 24.dp
    val errorPaddingVertical = 32.dp
    val paddingHorizontal = 16.dp
    val heroIcon = 48.dp
    val webIcon = 64.dp
    val iconGap = 16.dp
    val titleGap = 12.dp
    val errorTitleGap = 8.dp
    val itemIcon = 29.dp
    val actionsPadding = 16.dp
    val actionsGap = 12.dp
    val title = happyTextStyle(fontSize = 20, weight = FontWeight.SemiBold)
    val errorTitle = happyTextStyle(fontSize = 16, weight = FontWeight.SemiBold)
    val webTitle = happyTextStyle(fontSize = 18, weight = FontWeight.SemiBold)
    val description = happyTextStyle(fontSize = 14, lineHeight = 20)

    /** theme.colors.radio.active */
    fun radioActive(dark: Boolean) = if (dark) Color(0xFF0A84FF) else Color(0xFF007AFF)
    val webIconColor = Color(0xFF8E8E93)
    val webDescription = Color(0xFF666666)
}

/**
 * Confirming a terminal that asked by link (terminal/index.tsx, reached by
 * `happy://terminal?<key>`). Spec: a hero group (48 terminal icon in
 * radio.active, 16 above the title 20 semibold, 12 above the description
 * 14/20 secondary; 24/16 padding, centred); "Connection Details" with the
 * key's first 12 characters and the encryption, 29 icons; Accept (large,
 * "Connecting..." while busy) and Reject (large, quiet) 12 apart in 16
 * padding; and the Security group with its footer. Without a key: a
 * warning group (48 warning icon, 16/8 gaps, 16 semibold title and 14/20
 * text, both destructive and secondary; 32/16 padding).
 */
@Composable
fun TerminalConfirmScreen(
    publicKey: String?,
    connecting: Boolean,
    onAccept: () -> Unit,
    onReject: () -> Unit,
) {
    val colors = HappyTheme.colors
    val blue = TerminalScreenSpec.radioActive(colors.dark)
    Screen(header = { StackHeader(stringResource(R.string.navigation_connect_terminal), onReject) }) {
        ItemList {
            if (publicKey == null) {
                ItemGroup {
                    Hero(
                        icon = Ionicon.WarningOutline,
                        iconColor = colors.textDestructive,
                        iconSize = TerminalScreenSpec.heroIcon,
                        title = stringResource(R.string.terminal_invalid_connection_link),
                        titleStyle = TerminalScreenSpec.errorTitle,
                        titleColor = colors.textDestructive,
                        titleGap = TerminalScreenSpec.errorTitleGap,
                        description = stringResource(R.string.terminal_invalid_connection_link_description),
                        descriptionColor = colors.textSecondary,
                        paddingVertical = TerminalScreenSpec.errorPaddingVertical,
                    )
                }
                return@ItemList
            }
            ItemGroup {
                Hero(
                    icon = Ionicon.TerminalOutline,
                    iconColor = blue,
                    iconSize = TerminalScreenSpec.heroIcon,
                    title = stringResource(R.string.terminal_connect_terminal),
                    titleStyle = TerminalScreenSpec.title,
                    titleColor = colors.text,
                    titleGap = TerminalScreenSpec.titleGap,
                    description = stringResource(R.string.terminal_terminal_request_description),
                    descriptionColor = colors.textSecondary,
                    paddingVertical = TerminalScreenSpec.heroPaddingVertical,
                )
            }
            ItemGroup(title = stringResource(R.string.terminal_connection_details)) {
                Item(
                    title = stringResource(R.string.terminal_public_key),
                    detail = "${publicKey.take(12)}...",
                    icon = { Icon(Ionicon.KeyOutline, TerminalScreenSpec.itemIcon, blue) },
                    showChevron = false,
                )
                Item(
                    title = stringResource(R.string.terminal_encryption),
                    detail = stringResource(R.string.terminal_end_to_end_encrypted),
                    icon = { Icon(Ionicon.LockClosedOutline, TerminalScreenSpec.itemIcon, colors.success) },
                    showChevron = false,
                )
            }
            ItemGroup {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag(TerminalScreenTags.ACTIONS)
                        .padding(TerminalScreenSpec.actionsPadding),
                    verticalArrangement = Arrangement.spacedBy(TerminalScreenSpec.actionsGap),
                ) {
                    RoundButton(
                        title = stringResource(if (connecting) R.string.terminal_connecting else R.string.terminal_accept_connection),
                        onClick = onAccept,
                        enabled = !connecting,
                        loading = connecting,
                        modifier = Modifier.testTag(TerminalScreenTags.ACCEPT),
                    )
                    RoundButton(
                        title = stringResource(R.string.terminal_reject),
                        onClick = onReject,
                        display = RoundButtonDisplay.Inverted,
                        enabled = !connecting,
                        modifier = Modifier.testTag(TerminalScreenTags.REJECT),
                    )
                }
            }
            ItemGroup(
                title = stringResource(R.string.terminal_security),
                footer = stringResource(R.string.terminal_security_footer_device),
            ) {
                Item(
                    title = stringResource(R.string.terminal_client_side_processing),
                    subtitle = stringResource(R.string.terminal_link_processed_on_device),
                    icon = { Icon(Ionicon.ShieldCheckmarkOutline, TerminalScreenSpec.itemIcon, colors.success) },
                    showChevron = false,
                )
            }
        }
    }
}

/**
 * terminal/connect.tsx outside a browser: the CLI's web link opened in the
 * app. It only explains: 64 laptop icon (#8E8E93), 16 above the title 18
 * semibold, 12 above the text 14/20 (#666); 32/16 padding, centred.
 */
@Composable
fun TerminalWebScreen(onBack: () -> Unit) {
    val colors = HappyTheme.colors
    Screen(header = { StackHeader(stringResource(R.string.navigation_connect_terminal), onBack) }) {
        ItemList {
            ItemGroup {
                Hero(
                    icon = Ionicon.LaptopOutline,
                    iconColor = TerminalScreenSpec.webIconColor,
                    iconSize = TerminalScreenSpec.webIcon,
                    title = stringResource(R.string.terminal_web_browser_required),
                    titleStyle = TerminalScreenSpec.webTitle,
                    titleColor = colors.text,
                    titleGap = TerminalScreenSpec.titleGap,
                    description = stringResource(R.string.terminal_web_browser_required_description),
                    descriptionColor = TerminalScreenSpec.webDescription,
                    paddingVertical = TerminalScreenSpec.errorPaddingVertical,
                )
            }
        }
    }
}

@Composable
private fun Hero(
    icon: Ionicon,
    iconColor: Color,
    iconSize: androidx.compose.ui.unit.Dp,
    title: String,
    titleStyle: androidx.compose.ui.text.TextStyle,
    titleColor: Color,
    titleGap: androidx.compose.ui.unit.Dp,
    description: String,
    descriptionColor: Color,
    paddingVertical: androidx.compose.ui.unit.Dp,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(TerminalScreenTags.HERO)
            .padding(horizontal = TerminalScreenSpec.paddingHorizontal, vertical = paddingVertical),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            icon = icon,
            size = iconSize,
            color = iconColor,
            modifier = Modifier.padding(bottom = TerminalScreenSpec.iconGap).testTag(TerminalScreenTags.HERO_ICON),
        )
        Text(
            text = title,
            style = titleStyle,
            color = titleColor,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(bottom = titleGap),
        )
        Text(text = description, style = TerminalScreenSpec.description, color = descriptionColor, textAlign = TextAlign.Center)
    }
}

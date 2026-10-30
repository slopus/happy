package com.slopus.happy.ui.start

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object StartTags {
    const val BACKGROUND = "start.background"
    const val CONTENT = "start.content"
    const val LOGO = "start.logo"
    const val CONNECT = "start.connect"
    const val MORE = "start.more"
    const val MENU = "start.menu"
    const val ENTER_LINK = "start.enterLink"
    const val RESTORE = "start.restore"
    const val SERVER = "start.server"
}

/**
 * The first screen. Steve's palette: deep blue and violet over near-black
 * in dark mode, their pale tints over lavender white in light mode. No
 * green or orange. Every colour behind the text keeps it at WCAG AA or
 * better (white on the dark colours 5.7:1 at least, #14112E on the light
 * ones 6.1:1 at least).
 */
object StartSpec {
    val darkPalette = GrainPalette(
        back = Color(0xFF06050F),
        colors = listOf(Color(0xFF4338CA), Color(0xFF7C3AED), Color(0xFF1D4ED8), Color(0xFF2A00FF)),
    )
    val lightPalette = GrainPalette(
        back = Color(0xFFF4F2FF),
        colors = listOf(Color(0xFF818CF8), Color(0xFFC4B5FD), Color(0xFF93C5FD), Color(0xFFA78BFA)),
    )
    val darkText = Color(0xFFFFFFFF)
    val lightText = Color(0xFF14112E)

    /** logotype_*.png is 1200 × 319. */
    val logoWidth = 220.dp
    const val LOGO_ASPECT = 1200f / 319f
    val connectMinWidth = 200.dp
    val bottomPadding = 48.dp
    val controlsPadding = 4.dp
    val control = 48.dp
    val controlIcon = 24.dp
    val menuMinWidth = 220.dp
    val menuIcon = 22.dp
    val menuLabel = happyTextStyle(fontSize = 16)
    val menuDetail = happyTextStyle(fontSize = 13)
}

/**
 * The first screen, shown only while there is no Happy account and no
 * agent connection (once added, the account menu's Add takes over). No header (Steve's exception, AGENTS.md): the Grain
 * Gradient fills the window behind the system bars; everything else keeps
 * out of the bars and the cutout. It ignores the keyboard.
 *
 *   ⋮ (top right)  a drop-down: enter a link, restore a legacy account,
 *                  and the legacy server. A new Happy account is
 *                  only ever made by Start (a terminal code)
 *   logo           centred in the space above Start
 *   Start          centred across, as wide as its label (at least 200),
 *                  48 above the bottom inset: scan a code, routed by kind
 *
 * If it all outgrows the window (large text) it scrolls.
 */
@Composable
fun StartScreen(
    connecting: Boolean,
    customServerLabel: String?,
    onConnect: () -> Unit,
    onEnterLink: () -> Unit,
    onRestore: () -> Unit,
    onServer: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dark = HappyTheme.colors.dark
    val tint = if (dark) StartSpec.darkText else StartSpec.lightText
    Box(modifier = modifier.fillMaxSize()) {
        GrainGradient(
            palette = if (dark) StartSpec.darkPalette else StartSpec.lightPalette,
            modifier = Modifier.fillMaxSize().testTag(StartTags.BACKGROUND),
        )
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize()
                // Bars and cutout, never the keyboard: nothing here takes text, so a dialog's keyboard leaves it still.
                .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout))
                .testTag(StartTags.CONTENT),
        ) {
            val viewport = maxHeight
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = viewport)
                    .padding(bottom = StartSpec.bottomPadding),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.weight(1f))
                Image(
                    painter = painterResource(if (dark) R.drawable.logotype_light else R.drawable.logotype_dark),
                    contentDescription = stringResource(R.string.start_logo),
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.width(StartSpec.logoWidth).aspectRatio(StartSpec.LOGO_ASPECT).testTag(StartTags.LOGO),
                )
                Spacer(Modifier.weight(1f))
                RoundButton(
                    title = stringResource(R.string.start_button),
                    onClick = onConnect,
                    loading = connecting,
                    modifier = Modifier
                        .widthIn(min = StartSpec.connectMinWidth)
                        .width(IntrinsicSize.Max)
                        .testTag(StartTags.CONNECT),
                )
            }
            Row(modifier = Modifier.fillMaxWidth().padding(StartSpec.controlsPadding)) {
                Spacer(Modifier.weight(1f))
                Box {
                    var open by remember { mutableStateOf(false) }
                    StartControl(Ionicon.EllipsisVertical, stringResource(R.string.start_more), tint, { open = true }, Modifier.testTag(StartTags.MORE))
                    StartMenu(
                        open = open,
                        enabled = !connecting,
                        customServerLabel = customServerLabel,
                        onDismiss = { open = false },
                        onEnterLink = onEnterLink,
                        onRestore = onRestore,
                        onServer = onServer,
                    )
                }
            }
        }
    }
}

/** A 48 round touch target with a 24 glyph in the palette's text colour, straight on the gradient. */
@Composable
private fun StartControl(icon: Ionicon, description: String, tint: Color, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(StartSpec.control)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = ripple(bounded = false, radius = StartSpec.control / 2, color = tint),
                role = Role.Button,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon = icon, size = StartSpec.controlIcon, color = tint, contentDescription = description)
    }
}

/** The ⋮ drop-down: the ways in besides scanning. */
@Composable
private fun StartMenu(
    open: Boolean,
    enabled: Boolean,
    customServerLabel: String?,
    onDismiss: () -> Unit,
    onEnterLink: () -> Unit,
    onRestore: () -> Unit,
    onServer: () -> Unit,
) {
    val colors = HappyTheme.colors
    DropdownMenu(
        expanded = open,
        onDismissRequest = onDismiss,
        modifier = Modifier.widthIn(min = StartSpec.menuMinWidth).testTag(StartTags.MENU),
    ) {
        @Composable
        fun item(label: String, icon: Ionicon, tag: String, detail: String? = null, itemEnabled: Boolean = enabled, onClick: () -> Unit) {
            DropdownMenuItem(
                text = {
                    Column {
                        Text(label, style = StartSpec.menuLabel, color = colors.text)
                        if (detail != null) {
                            Text(detail, style = StartSpec.menuDetail, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                        }
                    }
                },
                leadingIcon = { Icon(icon, StartSpec.menuIcon, colors.text) },
                enabled = itemEnabled,
                onClick = {
                    onDismiss()
                    onClick()
                },
                modifier = Modifier.testTag(tag),
            )
        }
        item(stringResource(R.string.start_enter_link), Ionicon.LinkOutline, StartTags.ENTER_LINK, onClick = onEnterLink)
        HorizontalDivider(color = colors.divider)
        item(stringResource(R.string.start_restore_legacy), Ionicon.KeyOutline, StartTags.RESTORE, onClick = onRestore)
        item(
            stringResource(R.string.start_legacy_server),
            Ionicon.ServerOutline,
            StartTags.SERVER,
            detail = customServerLabel,
            onClick = onServer,
        )
    }
}

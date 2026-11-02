package com.slopus.happy.ui.start

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextDecoration
import com.slopus.happy.ui.components.LocalBarOnGlass
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.home.EmptyStateSpec
import com.slopus.happy.ui.theme.HappyTheme

object InstallDesktopTags {
    const val BACKGROUND = "installDesktop.background"
    const val CONTENT = "installDesktop.content"
    const val ICON = "installDesktop.icon"
    const val TITLE = "installDesktop.title"
    const val DESCRIPTION = "installDesktop.description"
    const val SCAN = "installDesktop.scan"
    const val SITE = "installDesktop.site"
    const val MORE = "installDesktop.more"
}

/**
 * After the first screen's Start: get Happy for the computer, whose setup
 * ends by offering this phone a code, then scan it. happy-app's Link Your
 * Computer checklist in its own words, laid out as iOS's
 * InstallDesktopViewController (InstallDesktopLayout), centred, on the
 * first screen's Grain Gradient so the two read as one flow:
 *
 *   desktop glyph      56
 *   title              "Install Happy on your computer", 20 under the glyph
 *   description        "Open Happy and choose Link Mobile App.", 8 under
 *   happy.engineering  4 under: a globe and the domain underlined, a 40
 *                      tall target opening the site; before Scan, since
 *                      getting Happy comes first
 *   Scan QR code       20 under, as wide as its label (at least 200): the
 *                      app's Add flow, the scanner as ever
 *
 * The standard bar, clear over the gradient, with back and the first
 * screen's ⋮ ([StartMenu]), so the other ways in are still a tap away. If
 * it outgrows the window it scrolls.
 */
@Composable
fun InstallDesktopScreen(
    scanning: Boolean,
    customServerLabel: String?,
    onBack: () -> Unit,
    onScan: () -> Unit,
    onOpenSite: () -> Unit,
    onEnterLink: () -> Unit,
    onRestore: () -> Unit,
    onServer: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dark = HappyTheme.colors.dark
    val text = if (dark) StartSpec.darkText else StartSpec.lightText
    val secondary = text.copy(alpha = StartSpec.SECONDARY_ALPHA)
    Box(modifier.fillMaxSize()) {
        GrainGradient(
            palette = if (dark) StartSpec.darkPalette else StartSpec.lightPalette,
            modifier = Modifier.fillMaxSize().testTag(InstallDesktopTags.BACKGROUND),
        )
        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal)))) {
            // Clear: the gradient shows through the bar.
            CompositionLocalProvider(LocalBarOnGlass provides true) {
                StackHeader(title = "", onBack = onBack) {
                    Box {
                        var open by remember { mutableStateOf(false) }
                        IconButton(onClick = { open = true }, modifier = Modifier.testTag(InstallDesktopTags.MORE)) {
                            Icon(Ionicon.EllipsisVertical, StartSpec.controlIcon, text, contentDescription = stringResource(R.string.start_more))
                        }
                        StartMenu(
                            open = open,
                            enabled = !scanning,
                            customServerLabel = customServerLabel,
                            onDismiss = { open = false },
                            onEnterLink = onEnterLink,
                            onRestore = onRestore,
                            onServer = onServer,
                        )
                    }
                }
            }
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val viewport = maxHeight
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .heightIn(min = viewport)
                        .padding(bottom = 32.dp)
                        .testTag(InstallDesktopTags.CONTENT),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Icon(Ionicon.DesktopOutline, EmptyStateSpec.stateIcon, secondary, Modifier.testTag(InstallDesktopTags.ICON))
                    Text(
                        text = stringResource(R.string.onboarding_install_step),
                        style = EmptyStateSpec.stateTitle,
                        color = text,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .padding(top = EmptyStateSpec.stateIconGap, bottom = 8.dp)
                            .padding(horizontal = EmptyStateSpec.sidePadding)
                            .semantics { heading() }
                            .testTag(InstallDesktopTags.TITLE),
                    )
                    // The checklist's second step: setup there offers this phone its code.
                    Text(
                        text = stringResource(R.string.onboarding_open_step) + ".",
                        style = EmptyStateSpec.description,
                        color = secondary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .widthIn(max = EmptyStateSpec.descriptionMaxWidth)
                            .padding(horizontal = EmptyStateSpec.sidePadding)
                            .testTag(InstallDesktopTags.DESCRIPTION),
                    )
                    SiteLink(text, onOpenSite, Modifier.padding(top = 4.dp))
                    Spacer(Modifier.height(20.dp))
                    RoundButton(
                        title = stringResource(R.string.onboarding_scan_button),
                        onClick = onScan,
                        loading = scanning,
                        modifier = Modifier
                            .widthIn(min = StartSpec.connectMinWidth)
                            .width(IntrinsicSize.Max)
                            .testTag(InstallDesktopTags.SCAN),
                    )
                }
            }
        }
    }
}

/**
 * happy.engineering underlined behind a globe, in the gradient's text
 * colour (the link colour is under AA on its light tints): a 40 tall
 * target read out as "Download Happy from happy.engineering".
 */
@Composable
private fun SiteLink(color: Color, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val site = stringResource(R.string.onboarding_install_body_prefix) + stringResource(R.string.onboarding_install_body_link)
    Row(
        modifier = modifier
            .testTag(InstallDesktopTags.SITE)
            .heightIn(min = EmptyStateSpec.secondaryMinHeight)
            .clip(RoundedCornerShape(20.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = site; role = Role.Button }
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Ionicon.GlobeOutline, 16.dp, color)
        Text(
            text = stringResource(R.string.onboarding_install_body_link),
            style = EmptyStateSpec.secondaryAction.copy(textDecoration = TextDecoration.Underline),
            color = color,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
}

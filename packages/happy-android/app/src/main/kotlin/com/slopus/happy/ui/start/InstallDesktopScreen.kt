package com.slopus.happy.ui.start

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.systemBars
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.LineBreak
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.SceneAnimation
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.home.EmptyStateSpec
import com.slopus.happy.ui.onboarding.OnboardingContentSpec
import com.slopus.happy.ui.onboarding.cappedScale
import com.slopus.happy.ui.theme.HappyTheme

object InstallDesktopTags {
    const val BACKGROUND = "installDesktop.background"
    const val CONTENT = "installDesktop.content"
    const val ART = "installDesktop.art"
    const val TITLE = "installDesktop.title"
    const val DESCRIPTION = "installDesktop.description"
    const val SCAN = "installDesktop.scan"
    const val SITE = "installDesktop.site"
    const val MORE = "installDesktop.more"
}

/**
 * After the first screen's Start: open Happy on the computer, which offers
 * this phone a code (in its onboarding, or later in its settings), or get
 * it first; then scan the code. Kirill's words, laid out as iOS's
 * InstallDesktopViewController (InstallDesktopLayout), on the first
 * screen's Grain Gradient and in its frame, so the two read as one: the
 * art in the slides' square at the slides' place, Scan QR code where Start
 * was, and the words where the slides' words and dots were (their room is
 * kept, unseen: [SlideWordsRoom]; words that need more move it all up, as
 * the first screen centres its slides):
 *
 *   TV scene           the slides' square: plays once on arrival,
 *                      a tap plays it again (res/raw/state_tv.json, the
 *                      📺 sticker Kirill supplied: happy-ios
 *                      Resources/Animations/PROVENANCE.md)
 *   title              "Open Happy on your computer", 24 under it, in a
 *                      slide's title type
 *   description        "Choose Link Mobile App during onboarding." and
 *                      "Or go to Settings › Mobile Access.", 8 under, in
 *                      a slide's line type
 *   the site           4 under: "Download from happy.engineering", the
 *                      domain underlined, a 40 tall target opening it
 *   Scan QR code       as wide as its label (at least 200), 48 above the
 *                      bottom inset: the app's Add flow, the scanner as ever
 *
 * The standard bar, clear over the gradient, with back and the first
 * screen's ⋮ ([StartMenu]), so the other ways in are still a tap away. If
 * it outgrows the window it scrolls, as the first screen does.
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
        // The first screen's frame (StartScreen): what is in it falls where that screen's is.
        BoxWithConstraints(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout)),
        ) {
            val viewport = maxHeight
            val art = StartGallerySpec.artFor(maxWidth, maxHeight)
            val compact = maxHeight < StartGallerySpec.compactHeight
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = viewport)
                    .padding(bottom = StartSpec.bottomPadding)
                    .testTag(InstallDesktopTags.CONTENT),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // Under the bar, as the first screen's logo row.
                Spacer(Modifier.height(StartSpec.controlsPadding + StartSpec.control))
                Spacer(Modifier.height(StartGallerySpec.margin))
                Spacer(Modifier.weight(1f))
                var plays by rememberSaveable { mutableIntStateOf(1) }
                Box(Modifier.testTag(InstallDesktopTags.ART)) {
                    SceneAnimation(R.raw.state_tv, plays, { plays = it + 1 }, size = art)
                }
                Spacer(Modifier.height(if (compact) StartGallerySpec.artGapCompact else StartGallerySpec.artGap))
                // The slides' words and dots, unseen, keep their room: these words take it.
                Box(contentAlignment = Alignment.TopCenter) {
                    Column(Modifier.fillMaxWidth()) {
                        SlideWordsRoom(StartSlides, own = null, textColor = text, secondaryColor = secondary)
                        Spacer(Modifier.height((if (compact) StartGallerySpec.dotsGapCompact else StartGallerySpec.dotsGap) + StartGallerySpec.dotTarget))
                    }
                    // A slide's title and line, in the slides' column.
                    Column(
                        Modifier
                            .padding(horizontal = StartGallerySpec.sidePadding)
                            .widthIn(max = StartGallerySpec.columnMaxWidth)
                            .fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            text = stringResource(R.string.onboarding_offline_open_step),
                            style = cappedScale(StartGallerySpec.title.copy(lineBreak = LineBreak.Heading), OnboardingContentSpec.TITLE_MAX_SCALE),
                            color = text,
                            textAlign = TextAlign.Center,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(bottom = StartGallerySpec.titleGap)
                                .semantics { heading() }
                                .testTag(InstallDesktopTags.TITLE),
                        )
                        Text(
                            text = stringResource(R.string.start_install_choose) + "\n" + stringResource(R.string.start_install_settings),
                            style = StartGallerySpec.body.copy(lineBreak = LineBreak.Paragraph),
                            color = secondary,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().testTag(InstallDesktopTags.DESCRIPTION),
                        )
                        SiteLink(text, onOpenSite, Modifier.padding(top = 4.dp))
                    }
                }
                Spacer(Modifier.weight(1f))
                Spacer(Modifier.height(StartGallerySpec.margin))
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
        // Clear: the gradient shows through the bar, over the first screen's top row, its ⋮ where that screen's is.
        Box(Modifier.windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))) {
            CompositionLocalProvider(LocalBarOnGlass provides true) {
                StackHeader(title = "", onBack = onBack, fullWidth = true) {
                    Box {
                        var open by remember { mutableStateOf(false) }
                        StartControl(Ionicon.EllipsisVertical, stringResource(R.string.start_more), text, { open = true }, Modifier.testTag(InstallDesktopTags.MORE))
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
        }
    }
}

/**
 * "Download from happy.engineering", the domain underlined, in the
 * gradient's text colour (the link colour is under AA on its light
 * tints): a 40 tall target read out as it reads.
 */
@Composable
private fun SiteLink(color: Color, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val domain = stringResource(R.string.onboarding_install_body_link)
    val site = stringResource(R.string.start_install_download, domain)
    val start = site.indexOf(domain)
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
        Text(
            text = buildAnnotatedString {
                append(site)
                if (start >= 0) addStyle(SpanStyle(textDecoration = TextDecoration.Underline), start, start + domain.length)
            },
            style = EmptyStateSpec.secondaryAction,
            color = color,
        )
    }
}

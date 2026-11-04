package com.slopus.happy.ui.migration

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.HeaderSpec
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ItemGroupSpec
import com.slopus.happy.ui.components.LineIcon
import com.slopus.happy.ui.components.LocalBarOnGlass
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.SceneAnimation
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.onboarding.OnboardingContentSpec
import com.slopus.happy.ui.onboarding.cappedScale
import com.slopus.happy.ui.start.GrainGradient
import com.slopus.happy.ui.start.SiteLink
import com.slopus.happy.ui.start.SiteLinkSpec
import com.slopus.happy.ui.start.StartGallerySpec
import com.slopus.happy.ui.start.StartSpec
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable

/** The Happy CLI home card's screen, for its path ([MigrationPath.wire]). */
@Serializable data class DesktopMigrationRoute(val path: String)

object DesktopMigrationTags {
    const val SCREEN = "desktopMigration"
    const val ART = "desktopMigration.art"
    const val TITLE = "desktopMigration.title"
    const val BODY = "desktopMigration.body"
    const val DIAGRAM = "desktopMigration.diagram"
    const val NUMBER = "desktopMigration.number"
    const val STEP = "desktopMigration.step"
    const val SITE = "desktopMigration.site"
    const val SCAN = "desktopMigration.scan"
    const val LEARN_MORE = "desktopMigration.learnMore"
    const val SERVER = "desktopMigration.server"
    const val SERVER_PARAGRAPHS = "desktopMigration.server.paragraphs"
}

/** iOS `MigrationScreenLayout.Metrics`, on the first screen's column. */
object DesktopMigrationSpec {
    val art = 72.dp
    val artGap = 16.dp
    val sectionGap = 20.dp
    val number = 22.dp
    /** Down from the step's top, so the dot sits level with its first line (24 tall). */
    val numberOffset = 1.dp
    val numberGap = 12.dp
    val stepGap = 12.dp
    val buttonGap = 20.dp
    val learnMoreGap = 4.dp
    val serverGap = 8.dp
    val numberText = happyTextStyle(fontSize = 13, lineHeight = 16, weight = FontWeight.SemiBold)
    val step = happyTextStyle(fontSize = 17, lineHeight = 24)
    val sectionTitle = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold)
    /** iOS DisclosureSectionLayout. */
    val chevron = 13.dp
    val chevronGap = 6.dp
    val paragraphsGap = 4.dp
    val paragraphGap = 8.dp
    const val TOGGLE_MILLIS = 250
    const val LEARN_MORE_URL = "https://happy.engineering/migrate"
}

/**
 * What the Happy CLI home's card opens (iOS DesktopMigrationViewController,
 * ea1a0902f), in the first screens' look ([com.slopus.happy.ui.start.InstallDesktopScreen]):
 * their Grain Gradient under a clear bar with back, in their column (24 in,
 * at most 440):
 *
 *     picture          72, under the bar: the TV scene (Happy Desktop) or
 *                      a zap line icon (a direct connection)
 *     16
 *     title, line      centred, a slide's type, 8 apart
 *     20
 *     before / after   the column's width, a direct connection only
 *     20
 *     ① step           a 22 dot, 12, the words; Happy Desktop's first
 *        Download from happy.engineering   step has the site under it
 *     12
 *     ② step
 *     20 at least
 *     Scan QR code     centred, as wide as its label (at least 200): the
 *                      app's Add flow, whose scanner reads desktop's code
 *     4
 *     Learn more       centred
 *     8
 *     Running Happy on a server? ⌄   closed, its foot on the window's safe
 *                      foot while everything fits; open, its paragraphs
 *                      grow under it and the page scrolls to them
 */
@Composable
fun DesktopMigrationScreen(
    path: MigrationPath,
    scanning: Boolean,
    onBack: () -> Unit,
    onScan: () -> Unit,
    onOpenSite: () -> Unit,
    onLearnMore: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dark = HappyTheme.colors.dark
    val text = if (dark) StartSpec.darkText else StartSpec.lightText
    val secondary = text.copy(alpha = StartSpec.SECONDARY_ALPHA)
    Box(modifier.fillMaxSize().testTag(DesktopMigrationTags.SCREEN)) {
        GrainGradient(palette = if (dark) StartSpec.darkPalette else StartSpec.lightPalette, modifier = Modifier.fillMaxSize())
        BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout))) {
            val viewport = maxHeight
            var open by rememberSaveable { mutableStateOf(false) }
            val paragraphs = remember { BringIntoViewRequester() }
            LaunchedEffect(open) {
                if (open) {
                    delay(DesktopMigrationSpec.TOGGLE_MILLIS.toLong())
                    paragraphs.bringIntoView()
                }
            }
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
                // While everything fits, the closed section's foot is on the safe area's.
                Column(Modifier.fillMaxWidth().heightIn(min = viewport), horizontalAlignment = Alignment.CenterHorizontally) {
                    Spacer(Modifier.height(HeaderSpec.height))
                    Column(column(), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.size(DesktopMigrationSpec.art).testTag(DesktopMigrationTags.ART), contentAlignment = Alignment.Center) {
                            when (path) {
                                MigrationPath.Desktop -> {
                                    var plays by rememberSaveable { mutableIntStateOf(1) }
                                    SceneAnimation(R.raw.state_tv, plays, { plays = it + 1 }, size = DesktopMigrationSpec.art)
                                }
                                MigrationPath.AgentConnection -> LineIcon(LineIcon.Zap, DesktopMigrationSpec.art, text, weight = 1f)
                            }
                        }
                        Spacer(Modifier.height(DesktopMigrationSpec.artGap))
                        Text(
                            stringResource(path.title),
                            style = cappedScale(StartGallerySpec.title.copy(lineBreak = LineBreak.Heading), OnboardingContentSpec.TITLE_MAX_SCALE),
                            color = text,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().semantics { heading() }.testTag(DesktopMigrationTags.TITLE),
                        )
                        Spacer(Modifier.height(StartGallerySpec.titleGap))
                        Text(
                            stringResource(path.body),
                            style = StartGallerySpec.body.copy(lineBreak = LineBreak.Paragraph),
                            color = secondary,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().testTag(DesktopMigrationTags.BODY),
                        )
                        Spacer(Modifier.height(DesktopMigrationSpec.sectionGap))
                        if (path == MigrationPath.AgentConnection) {
                            ConnectionDiagram(Modifier.testTag(DesktopMigrationTags.DIAGRAM))
                            Spacer(Modifier.height(DesktopMigrationSpec.sectionGap))
                        }
                        Steps(path, text, onOpenSite)
                    }
                    Spacer(Modifier.height(DesktopMigrationSpec.buttonGap))
                    Spacer(Modifier.weight(1f))
                    RoundButton(
                        title = stringResource(R.string.onboarding_scan_button),
                        onClick = onScan,
                        loading = scanning,
                        modifier = Modifier
                            .widthIn(min = StartSpec.connectMinWidth)
                            .width(IntrinsicSize.Max)
                            .testTag(DesktopMigrationTags.SCAN),
                    )
                    Spacer(Modifier.height(DesktopMigrationSpec.learnMoreGap))
                    val learnMore = stringResource(R.string.desktop_migration_learn_more)
                    SiteLink(learnMore, learnMore, text, onLearnMore, tag = DesktopMigrationTags.LEARN_MORE)
                    Spacer(Modifier.height(DesktopMigrationSpec.serverGap))
                    DisclosureHeader(
                        stringResource(R.string.desktop_migration_server_title),
                        open,
                        text,
                        { open = !open },
                        Modifier.testTag(DesktopMigrationTags.SERVER),
                    )
                }
                AnimatedVisibility(
                    open,
                    enter = expandVertically(tween(DesktopMigrationSpec.TOGGLE_MILLIS), expandFrom = Alignment.Top) + fadeIn(tween(DesktopMigrationSpec.TOGGLE_MILLIS)),
                    exit = shrinkVertically(tween(DesktopMigrationSpec.TOGGLE_MILLIS), shrinkTowards = Alignment.Top) + fadeOut(tween(DesktopMigrationSpec.TOGGLE_MILLIS)),
                    modifier = column().bringIntoViewRequester(paragraphs).testTag(DesktopMigrationTags.SERVER_PARAGRAPHS),
                ) {
                    Column(Modifier.padding(top = DesktopMigrationSpec.paragraphsGap), verticalArrangement = Arrangement.spacedBy(DesktopMigrationSpec.paragraphGap)) {
                        for (paragraph in listOf(R.string.desktop_migration_server_scan, R.string.desktop_migration_server_set_up)) {
                            Text(stringResource(paragraph), style = DesktopMigrationSpec.step, color = secondary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                        }
                    }
                }
            }
        }
        // Clear: the gradient shows through the bar, as on the first screens.
        Box(Modifier.windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))) {
            CompositionLocalProvider(LocalBarOnGlass provides true) {
                StackHeader(title = "", onBack = onBack, fullWidth = true)
            }
        }
    }
}

/** The first screens' column: 24 in from the safe area, at most 440 wide. */
private fun column() = Modifier
    .padding(horizontal = StartGallerySpec.sidePadding)
    .widthIn(max = StartGallerySpec.columnMaxWidth)
    .fillMaxWidth()

/** The path's steps, each after its number's dot, in the first screens' words. */
@Composable
private fun Steps(path: MigrationPath, color: Color, onOpenSite: () -> Unit) {
    val open = stringResource(R.string.onboarding_offline_open_step)
    val steps: List<Pair<String, Boolean>> = when (path) {
        MigrationPath.Desktop -> listOf(
            open to true,
            (stringResource(R.string.start_install_choose) + "\n" + stringResource(R.string.start_install_settings)) to false,
        )
        // Happy Desktop is set up already, so its onboarding is past: only its settings.
        MigrationPath.AgentConnection -> listOf(open to false, stringResource(R.string.desktop_migration_settings_step) to false)
    }
    val domain = stringResource(R.string.onboarding_install_body_link)
    val site = stringResource(R.string.start_install_download, domain)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(DesktopMigrationSpec.stepGap)) {
        steps.forEachIndexed { index, (words, linked) ->
            Row(Modifier.fillMaxWidth()) {
                Box(
                    Modifier
                        .padding(top = DesktopMigrationSpec.numberOffset)
                        .testTag("${DesktopMigrationTags.NUMBER}.$index")
                        .size(DesktopMigrationSpec.number)
                        .clip(CircleShape)
                        .background(color)
                        .clearAndSetSemantics { },
                    contentAlignment = Alignment.Center,
                ) {
                    Text("${index + 1}", style = DesktopMigrationSpec.numberText, color = HappyTheme.colors.surface)
                }
                Spacer(Modifier.width(DesktopMigrationSpec.numberGap))
                Column(Modifier.weight(1f)) {
                    Text(words, style = DesktopMigrationSpec.step, color = color, modifier = Modifier.fillMaxWidth().testTag("${DesktopMigrationTags.STEP}.$index"))
                    // The target's padding sits outside the words, so they start on the step's edge.
                    if (linked) SiteLink(site, domain, color, onOpenSite, Modifier.offset(x = -SiteLinkSpec.padding), tag = DesktopMigrationTags.SITE)
                }
            }
        }
    }
}

/**
 * A section's title that opens it in place (iOS DisclosureSectionView): the
 * title and a 13 chevron, 6 apart, in a text action's 40 tall target,
 * centred; the chevron turns over as it opens.
 */
@Composable
private fun DisclosureHeader(title: String, open: Boolean, color: Color, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val turn by animateFloatAsState(if (open) 180f else 0f, tween(DesktopMigrationSpec.TOGGLE_MILLIS), label = "chevron")
    Row(
        modifier
            .padding(horizontal = StartGallerySpec.sidePadding)
            .heightIn(min = 40.dp)
            .clip(RoundedCornerShape(20.dp))
            .clickable(role = Role.Button, onClick = onToggle)
            .clearAndSetSemantics { contentDescription = title; role = Role.Button }
            .padding(horizontal = SiteLinkSpec.padding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = DesktopMigrationSpec.sectionTitle, color = color, textAlign = TextAlign.Center, modifier = Modifier.weight(1f, fill = false))
        Spacer(Modifier.width(DesktopMigrationSpec.chevronGap))
        Icon(Ionicon.ChevronDown, DesktopMigrationSpec.chevron, color, Modifier.graphicsLayer { rotationZ = turn })
    }
}

/** iOS `ConnectionDiagramLayout.Metrics`. */
object ConnectionDiagramSpec {
    val padding = 12.dp
    val headingGap = 6.dp
    val icon = 28.dp
    val captionGap = 2.dp
    val rowGap = 12.dp
    /** Between an icon and the line that leaves or reaches it. */
    val lineInset = 8.dp
    /** The database on the cloud's lower end corner, on a patch of the card. */
    val badge = 14.dp
    val badgeGround = 1.dp
    val badgeGroundRadius = 2.dp
    /** An open arrowhead's two strokes, back and out from the tip. */
    val arrowhead = 4.dp
    val line = 1.5.dp
    /** A group header's size, in its words' own case. */
    val heading = happyTextStyle(fontSize = 13, lineHeight = 18, letterSpacing = -0.08f, weight = FontWeight.SemiBold)
    val caption = happyTextStyle(fontSize = 13, lineHeight = 18, letterSpacing = -0.08f)
}

/**
 * The current connection and the one after migration, in a card (iOS
 * ConnectionDiagramView): now the phone reaches the computer through the
 * Happy server (a cloud with a database on it), which stores the chats,
 * encrypted; after, through a relay (a router), which passes them on,
 * still encrypted. The past row is in the secondary colour.
 *
 *                    Current connection
 *     |12| phone ──→ server ──→ computer |12|
 *          Phone  Happy server  Computer
 *           Stores your chats, encrypted
 *     12
 *                     After migration
 *     |12| phone ──→ router ──→ computer |12|
 *          Phone      Relay     Computer
 *          Passes through, still encrypted
 *
 * A caption is centred under its icon; phone and computer come in from the
 * edges as far as the wider of their captions needs, the same on both
 * sides, so the middle stays in the middle. Read out as two sentences.
 */
@Composable
fun ConnectionDiagram(modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val spoken = stringResource(R.string.desktop_migration_diagram_spoken)
    val phone = stringResource(R.string.desktop_migration_phone)
    val computer = stringResource(R.string.desktop_migration_computer)
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val reach = remember(phone, computer, density) {
        with(density) {
            val widest = maxOf(measurer.measure(phone, ConnectionDiagramSpec.caption).size.width, measurer.measure(computer, ConnectionDiagramSpec.caption).size.width)
            maxOf(ConnectionDiagramSpec.icon, widest.toDp()) / 2
        }
    }
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(ItemGroupSpec.cardRadius))
            .background(colors.surface)
            .clearAndSetSemantics { contentDescription = spoken }
            .padding(vertical = ConnectionDiagramSpec.padding),
    ) {
        DiagramRow(
            stringResource(R.string.desktop_migration_current), phone, stringResource(R.string.desktop_migration_server), computer,
            stringResource(R.string.desktop_migration_server_detail), LineIcon.Cloud, server = true, colors.textSecondary, reach,
        )
        Spacer(Modifier.height(ConnectionDiagramSpec.rowGap))
        DiagramRow(
            stringResource(R.string.desktop_migration_after), phone, stringResource(R.string.desktop_migration_relay), computer,
            stringResource(R.string.desktop_migration_relay_detail), LineIcon.Router, server = false, colors.text, reach,
        )
    }
}

@Composable
private fun DiagramRow(heading: String, phone: String, middle: String, computer: String, detail: String, icon: LineIcon, server: Boolean, color: Color, reach: Dp) {
    val surface = HappyTheme.colors.surface
    val track = Modifier.fillMaxWidth().padding(horizontal = ConnectionDiagramSpec.padding)
    Column(Modifier.fillMaxWidth()) {
        Text(heading, style = ConnectionDiagramSpec.heading, color = color, textAlign = TextAlign.Center, maxLines = 1, modifier = track)
        Spacer(Modifier.height(ConnectionDiagramSpec.headingGap))
        // Phone, the middle and computer, at their centres, the lines and arrows between them.
        AtCentres(reach, Modifier.fillMaxWidth().drawBehind {
            val edge = (ConnectionDiagramSpec.padding + reach).toPx()
            val half = ConnectionDiagramSpec.icon.toPx() / 2
            val inset = ConnectionDiagramSpec.lineInset.toPx()
            val head = ConnectionDiagramSpec.arrowhead.toPx()
            val y = size.height / 2
            val stroke = ConnectionDiagramSpec.line.toPx()
            val centres = listOf(edge, size.width / 2, size.width - edge)
            for (i in 0 until 2) {
                val start = Offset(centres[i] + half + inset, y)
                val tip = Offset(centres[i + 1] - half - inset, y)
                drawLine(color, start, tip, stroke, StrokeCap.Round)
                drawLine(color, Offset(tip.x - head, y - head), tip, stroke, StrokeCap.Round)
                drawLine(color, Offset(tip.x - head, y + head), tip, stroke, StrokeCap.Round)
            }
        }) {
            LineIcon(LineIcon.Smartphone, ConnectionDiagramSpec.icon, color)
            Box(Modifier.size(ConnectionDiagramSpec.icon)) {
                LineIcon(icon, ConnectionDiagramSpec.icon, color)
                if (server) {
                    val badge = ConnectionDiagramSpec.badge
                    Box(
                        Modifier
                            .offset(x = ConnectionDiagramSpec.icon - badge + 3.dp, y = ConnectionDiagramSpec.icon - badge + 1.dp)
                            .size(badge)
                            .drawBehind {
                                val ground = ConnectionDiagramSpec.badgeGround.toPx()
                                drawRoundRect(
                                    surface,
                                    Offset(-ground, -ground),
                                    androidx.compose.ui.geometry.Size(size.width + ground * 2, size.height + ground * 2),
                                    CornerRadius(ConnectionDiagramSpec.badgeGroundRadius.toPx()),
                                )
                            },
                    ) {
                        LineIcon(LineIcon.Database, badge, color, weight = 2.5f)
                    }
                }
            }
            LineIcon(LineIcon.Monitor, ConnectionDiagramSpec.icon, color)
        }
        Spacer(Modifier.height(ConnectionDiagramSpec.captionGap))
        AtCentres(reach, Modifier.fillMaxWidth()) {
            for (caption in listOf(phone, middle, computer)) Text(caption, style = ConnectionDiagramSpec.caption, color = color, textAlign = TextAlign.Center)
        }
        Text(detail, style = ConnectionDiagramSpec.caption, color = color, textAlign = TextAlign.Center, modifier = track)
    }
}

/**
 * Three children centred on the phone's, the middle's and the computer's
 * centres: [reach] in from the track's edges, and the middle.
 */
@Composable
private fun AtCentres(reach: Dp, modifier: Modifier, content: @Composable () -> Unit) {
    Layout(content, modifier) { measurables, constraints ->
        val width = constraints.maxWidth
        val track = (width - ConnectionDiagramSpec.padding.roundToPx() * 2).coerceAtLeast(0)
        val placeables = measurables.map { it.measure(Constraints(maxWidth = track)) }
        val edge = (ConnectionDiagramSpec.padding + reach).toPx()
        val centres = listOf(edge, width / 2f, width - edge)
        val height = placeables.maxOf { it.height }
        layout(width, height) {
            placeables.forEachIndexed { index, placeable -> placeable.place((centres[index] - placeable.width / 2f).toInt(), 0) }
        }
    }
}

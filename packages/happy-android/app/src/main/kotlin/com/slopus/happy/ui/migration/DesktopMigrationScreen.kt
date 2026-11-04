package com.slopus.happy.ui.migration

import androidx.compose.foundation.background
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.approveTerminal
import com.slopus.happy.ui.components.confirm
import com.slopus.happy.ui.connect.ConnectFlow
import com.slopus.happy.ui.connect.rememberTerminalConnect
import com.slopus.happy.ui.components.HeaderSpec
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
import kotlinx.serialization.Serializable

/** The Happy CLI home card's screen, for its path ([MigrationPath.wire]). */
@Serializable data class DesktopMigrationRoute(val path: String)

object DesktopMigrationTags {
    const val SCREEN = "desktopMigration"
    const val ART = "desktopMigration.art"
    const val TITLE = "desktopMigration.title"
    const val BODY = "desktopMigration.body"
    const val NUMBER = "desktopMigration.number"
    const val STEP = "desktopMigration.step"
    const val SITE = "desktopMigration.site"
    const val DETAIL = "desktopMigration.detail"
    const val SCAN = "desktopMigration.scan"
    const val LEARN_MORE = "desktopMigration.learnMore"
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
    /** From what a step shows (its words, its site's words or its detail) to the next step (iOS 7c471796f). */
    val stepGap = 22.dp
    /**
     * The site's one line (20) sits this far down its 40 tall target, so a
     * detail starts this far under the step's words, and the next step
     * comes this much less than [stepGap] under the site's target.
     */
    val siteInset = 10.dp
    val buttonGap = 20.dp
    val learnMoreGap = 4.dp
    val numberText = happyTextStyle(fontSize = 13, lineHeight = 16, weight = FontWeight.SemiBold)
    val step = happyTextStyle(fontSize = 17, lineHeight = 24)
    /** A step's detail, in the site's type (iOS `TextStyles.secondaryAction`). */
    val detail = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.SemiBold)
    const val LEARN_MORE_URL = "https://happy.engineering/migrate"
}

/**
 * What the Happy CLI home's card opens (iOS DesktopMigrationViewController,
 * ea1a0902f, e601c6dc1, 7c471796f), in the first screens' look
 * ([com.slopus.happy.ui.start.InstallDesktopScreen]): their Grain Gradient
 * under a clear bar with back, in their column (24 in, at most 440):
 *
 *     picture          72, under the bar: the TV scene (Happy Desktop) or
 *                      a zap line icon (a direct connection)
 *     16
 *     title, line      centred, a slide's type, 8 apart
 *     20
 *     ① step           a 22 dot, 12, the words, "up to date" under
 *        Make sure Happy Desktop is up to date.   them; Happy Desktop's
 *        Download from happy.engineering          path adds the site
 *     22
 *     ② step
 *     22
 *     ③ Using Happy on a server?
 *        Select it in Happy Desktop…   its detail, where the site's words
 *                      would be, in their type
 *     20 at least
 *     Scan QR code     centred, as wide as its label (at least 200):
 *                      [rememberMigrationScan], a direct code or the
 *                      Happy server's
 *     4
 *     Learn more       centred, its foot on the window's safe foot while
 *                      everything fits; taller, the page scrolls
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
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
                // While everything fits, Learn more's foot is on the safe area's.
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

/** A step's words, then its detail and its site under them (iOS `Strings.DesktopMigration.Step`). */
private data class Step(val text: String, val linked: Boolean = false, val detail: String? = null)

/**
 * The path's steps, each after its number's dot, in the first screens'
 * words, then a server's case with its detail; 22 from what each shows to
 * the next.
 */
@Composable
private fun Steps(path: MigrationPath, color: Color, onOpenSite: () -> Unit) {
    val open = stringResource(R.string.onboarding_offline_open_step)
    val upToDate = stringResource(R.string.desktop_migration_up_to_date)
    val server = Step(stringResource(R.string.desktop_migration_server_step), detail = stringResource(R.string.desktop_migration_server_step_detail))
    val steps = when (path) {
        MigrationPath.Desktop -> listOf(
            Step(open, linked = true, detail = upToDate),
            Step(stringResource(R.string.start_install_choose) + "\n" + stringResource(R.string.start_install_settings)),
            server,
        )
        // Happy Desktop is set up already, so its onboarding is past: only its settings.
        MigrationPath.AgentConnection -> listOf(Step(open, detail = upToDate), Step(stringResource(R.string.desktop_migration_settings_step)), server)
    }
    val domain = stringResource(R.string.onboarding_install_body_link)
    val site = stringResource(R.string.start_install_download, domain)
    Column(Modifier.fillMaxWidth()) {
        steps.forEachIndexed { index, step ->
            if (index > 0) Spacer(Modifier.height(DesktopMigrationSpec.stepGap - if (steps[index - 1].linked) DesktopMigrationSpec.siteInset else 0.dp))
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
                    Text(step.text, style = DesktopMigrationSpec.step, color = color, modifier = Modifier.fillMaxWidth().testTag("${DesktopMigrationTags.STEP}.$index"))
                    step.detail?.let { detail ->
                        Text(
                            detail,
                            style = DesktopMigrationSpec.detail,
                            color = color,
                            modifier = Modifier.padding(top = DesktopMigrationSpec.siteInset).fillMaxWidth().testTag("${DesktopMigrationTags.DETAIL}.$index"),
                        )
                    }
                    // The target's padding sits outside the words, so they start on the step's edge.
                    if (step.linked) SiteLink(site, domain, color, onOpenSite, Modifier.offset(x = -SiteLinkSpec.padding), tag = DesktopMigrationTags.SITE)
                }
            }
        }
    }
}

/**
 * The screen's Scan QR code. A direct connection code pairs. A Happy server
 * code says first that it isn't direct; Link anyway approves it for the open
 * Happy account, as Settings' scan does, never making another account.
 */
@Composable
fun rememberMigrationScan(graph: AppGraph): ConnectFlow = rememberMigrationScan(
    approve = { url ->
        val account = graph.auth.state.value as? AuthState.SignedIn ?: error("Signed out")
        approveTerminal(graph.authApi, account.credentials, account.encryption, url)
    },
)

/** [rememberMigrationScan] with the approval passed in, for tests. */
@Composable
fun rememberMigrationScan(approve: suspend (url: String) -> Unit): ConnectFlow {
    val flow = rememberTerminalConnect(approve)
    val title = stringResource(R.string.desktop_migration_server_code_title)
    val message = stringResource(R.string.desktop_migration_server_code_body)
    val linkAnyway = stringResource(R.string.desktop_migration_link_anyway)
    val cancel = stringResource(R.string.common_cancel)
    flow.confirmTerminal = { confirm({ flow.alert = it }, title, message, confirmText = linkAnyway, cancelText = cancel) }
    return flow
}

package com.slopus.happy.ui.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderIconButton
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object OnboardingTags {
    const val BODY = "onboarding.body"
    const val BLOCK = "onboarding.block"
    const val CONTENT = "onboarding.content"
    const val PRIMARY = "onboarding.primary"
    const val SECONDARY = "onboarding.secondary"
    const val FOOTER = "onboarding.footer"
    const val GET_HELP = "onboarding.getHelp"
    const val HEADER_SUBTITLE = "onboarding.headerSubtitle"
}

/** OnboardingScreen.tsx */
object OnboardingSpec {
    val bodyPaddingVertical = 8.dp
    val blockMaxWidth = 480.dp
    val blockPaddingHorizontal = 24.dp
    val primaryGap = 12.dp
    val secondaryGap = 4.dp
    val footerPaddingHorizontal = 16.dp
    val footerPaddingBottom = 12.dp
    val getHelpMinHeight = 36.dp
    val getHelpPaddingHorizontal = 12.dp
    val getHelpGap = 6.dp
    val getHelpIcon = 17.dp
    val getHelp = happyTextStyle(fontSize = 15, weight = FontWeight.SemiBold)
    val headerSubtitle = happyTextStyle(fontSize = 11, lineHeight = 14, weight = FontWeight.Medium)

    const val HELP_DISCORD_URL = "https://discord.gg/fX9WBAhyfD"
    const val HELP_ISSUES_URL = "https://github.com/slopus/happy/issues"
}

/** The secondary action under the primary button: a quiet text button. */
data class SecondaryAction(val title: String, val onClick: () -> Unit, val enabled: Boolean = true)

/**
 * The first-run template (OnboardingScreen.tsx):
 *
 *   header   OnboardingHeader
 *   body     one block, centred in the space left: content, primary, secondary
 *   footer   Get help, bottom right, above the navigation bar
 *
 * The block's content slot reserves the height of both first-run contents
 * (welcome and link-your-computer) and its secondary slot the height of every
 * secondary label, so the actions sit at the same place whichever screen is
 * showing. Block: full width up to 480, 24 side padding; primary 12 below the
 * content; secondary 4 below the primary. If the block outgrows the screen
 * the body scrolls from the top and the spacers collapse.
 */
@Composable
fun OnboardingScreen(
    header: @Composable () -> Unit,
    content: @Composable () -> Unit,
    primary: @Composable () -> Unit,
    secondary: SecondaryAction,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().background(HappyTheme.colors.grouped.background)) {
        header()
        BoxWithConstraints(modifier = Modifier.weight(1f).fillMaxWidth().testTag(OnboardingTags.BODY)) {
            val viewport = maxHeight
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = viewport)
                    .padding(vertical = OnboardingSpec.bodyPaddingVertical),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(modifier = Modifier.weight(1f))
                Column(
                    modifier = Modifier
                        .widthIn(max = OnboardingSpec.blockMaxWidth)
                        .fillMaxWidth()
                        .testTag(OnboardingTags.BLOCK)
                        .padding(horizontal = OnboardingSpec.blockPaddingHorizontal),
                ) {
                    Layers(
                        reserve = listOf({ WelcomeContent() }, { LinkComputerContent() }),
                        modifier = Modifier.testTag(OnboardingTags.CONTENT),
                        content = content,
                    )
                    Box(modifier = Modifier.padding(top = OnboardingSpec.primaryGap).testTag(OnboardingTags.PRIMARY)) {
                        primary()
                    }
                    Layers(
                        reserve = secondaryTitles().map { title -> { SecondaryButton(title = title, onClick = {}, enabled = false) } },
                        modifier = Modifier.padding(top = OnboardingSpec.secondaryGap).testTag(OnboardingTags.SECONDARY),
                    ) {
                        SecondaryButton(title = secondary.title, onClick = secondary.onClick, enabled = secondary.enabled)
                    }
                }
                Spacer(modifier = Modifier.weight(1f))
            }
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = OnboardingSpec.footerPaddingHorizontal)
                .padding(
                    bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() +
                        OnboardingSpec.footerPaddingBottom,
                )
                .testTag(OnboardingTags.FOOTER),
            horizontalArrangement = Arrangement.End,
        ) {
            GetHelpButton()
        }
    }
}

/** Every secondary label the template can show. */
@Composable
private fun secondaryTitles(): List<String> = listOf(
    stringResource(R.string.onboarding_restore_existing),
    stringResource(R.string.welcome_create_account),
    stringResource(R.string.onboarding_paste_link),
)

/**
 * Lays [content] over invisible copies of everything that can stand in its
 * place and takes the height of the tallest. The copies are not drawn, read
 * out or tappable; the visible layer comes last, so it is on top.
 */
@Composable
private fun Layers(
    reserve: List<@Composable () -> Unit>,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Box(modifier = modifier.fillMaxWidth()) {
        reserve.forEach { layer ->
            Box(modifier = Modifier.fillMaxWidth().alpha(0f).clearAndSetSemantics {}) { layer() }
        }
        Box(modifier = Modifier.fillMaxWidth()) { content() }
    }
}

@Composable
private fun SecondaryButton(title: String, onClick: () -> Unit, enabled: Boolean) {
    RoundButton(
        title = title,
        onClick = onClick,
        size = RoundButtonSize.Normal,
        display = RoundButtonDisplay.Inverted,
        enabled = enabled,
    )
}

/**
 * Bottom-right "Get help": a 36 high pill (12 side padding, radius 18) with a
 * 17 help icon and a 15 semibold label 6 apart, both secondary colour. It
 * opens an alert with the two public places to ask, Android button order.
 */
@Composable
fun GetHelpButton() {
    val colors = HappyTheme.colors
    val uriHandler = LocalUriHandler.current
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    var showHelp by remember { mutableStateOf(false) }
    val label = stringResource(R.string.onboarding_get_help)

    Row(
        modifier = Modifier
            .defaultMinSize(minHeight = OnboardingSpec.getHelpMinHeight)
            .testTag(OnboardingTags.GET_HELP)
            .clip(RoundedCornerShape(percent = 50))
            .background(if (pressed) colors.surfacePressedOverlay else Color.Transparent)
            .clickable(interactionSource = interactionSource, indication = null, role = Role.Button) { showHelp = true }
            .semantics { contentDescription = label }
            .padding(horizontal = OnboardingSpec.getHelpPaddingHorizontal),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OnboardingSpec.getHelpGap),
    ) {
        Icon(icon = Ionicon.HelpCircleOutline, size = OnboardingSpec.getHelpIcon, color = colors.textSecondary)
        Text(text = label, style = OnboardingSpec.getHelp, color = colors.textSecondary)
    }

    if (showHelp) {
        HappyAlert(
            alert = Alert(
                title = label,
                message = stringResource(R.string.onboarding_help_message),
                buttons = listOf(
                    AlertButton(stringResource(R.string.onboarding_help_discord)) { uriHandler.openUri(OnboardingSpec.HELP_DISCORD_URL) },
                    AlertButton(stringResource(R.string.common_cancel)),
                    AlertButton(stringResource(R.string.onboarding_help_issues)) { uriHandler.openUri(OnboardingSpec.HELP_ISSUES_URL) },
                ),
            ),
            onDismiss = { showHelp = false },
        )
    }
}

/**
 * OnboardingHeader: no title, the gear on the right (Server on the welcome
 * screen, the onboarding settings on Link Your Computer), and for
 * self-hosters the server's host underneath (11/14, secondary colour).
 */
@Composable
fun OnboardingHeader(
    customServerLabel: String?,
    onServer: () -> Unit,
    gearDescription: String = stringResource(R.string.server_title),
) {
    val colors = HappyTheme.colors
    Header(
        alignment = TitleAlignment.Center,
        titleContent = {
            if (customServerLabel != null) {
                Text(
                    text = customServerLabel,
                    style = OnboardingSpec.headerSubtitle,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    overflow = TextOverflow.MiddleEllipsis,
                    modifier = Modifier.testTag(OnboardingTags.HEADER_SUBTITLE),
                )
            }
        },
        right = {
            HeaderIconButton(
                icon = Ionicon.SettingsOutline,
                contentDescription = gearDescription,
                onClick = onServer,
            )
        },
    )
}

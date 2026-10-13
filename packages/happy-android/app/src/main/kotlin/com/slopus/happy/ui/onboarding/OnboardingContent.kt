package com.slopus.happy.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.slopus.happy.R
import com.slopus.happy.ui.components.HappyEngineeringWordmark
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object OnboardingContentTags {
    const val WORDMARK = "onboarding.wordmark"
    const val HEADLINE = "onboarding.headline"
    const val PROPS = "onboarding.props"
}

/** OnboardingContent.tsx */
object OnboardingContentSpec {
    val wordmarkHeight = 84.dp
    val headlineGap = 28.dp
    val propsGap = 12.dp
    val propsPaddingBottom = 12.dp
    val checklistGap = 24.dp
    val rowGap = 20.dp
    val rowHeadMinHeight = 32.dp
    val rowHeadGap = 12.dp
    val checkbox = 26.dp
    val rowBodyIndent = 38.dp
    val rowBodyGap = 6.dp
    val errorGap = 16.dp

    /** The titles grow at most 1.2x with the system font size (maxFontSizeMultiplier). */
    const val TITLE_MAX_SCALE = 1.2f
    val title = happyTextStyle(fontSize = 28, lineHeight = 34, weight = FontWeight.SemiBold)
    val prop = happyTextStyle(fontSize = 17, lineHeight = 24)
    val rowTitle = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold)
    val body = happyTextStyle(fontSize = 15, lineHeight = 21)
    val error = happyTextStyle(fontSize = 15, lineHeight = 20)
}

/**
 * Caps the system font scaling of [style] at [maxScale] (RN's
 * maxFontSizeMultiplier), compared in dp after the platform's (possibly
 * non-linear) font scaling. A capped style keeps its line height as a
 * multiple of the font size, so lines stay in proportion.
 */
@Composable
private fun cappedScale(style: TextStyle, maxScale: Float): TextStyle {
    val density = LocalDensity.current
    val limit = (style.fontSize.value * maxScale).dp
    if (with(density) { style.fontSize.toDp() } <= limit) return style
    return style.copy(
        fontSize = with(density) { limit.toSp() },
        lineHeight = (style.lineHeight.value / style.fontSize.value).em,
    )
}

/**
 * Wordmark, headline and the three promises. Spec: 84 high wordmark at the
 * start, headline 28/34 semibold 28 below it, props 17/24 secondary 12 below
 * that with 12 of padding under them.
 */
@Composable
fun WelcomeContent(modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Column(modifier = modifier.fillMaxWidth()) {
        HappyEngineeringWordmark(
            height = OnboardingContentSpec.wordmarkHeight,
            modifier = Modifier.testTag(OnboardingContentTags.WORDMARK),
        )
        Text(
            text = stringResource(R.string.onboarding_headline),
            style = cappedScale(OnboardingContentSpec.title, OnboardingContentSpec.TITLE_MAX_SCALE),
            color = colors.text,
            modifier = Modifier
                .padding(top = OnboardingContentSpec.headlineGap)
                .testTag(OnboardingContentTags.HEADLINE)
                .semantics { heading() },
        )
        Column(
            modifier = Modifier
                .padding(top = OnboardingContentSpec.propsGap, bottom = OnboardingContentSpec.propsPaddingBottom)
                .testTag(OnboardingContentTags.PROPS),
        ) {
            listOf(R.string.onboarding_prop_encrypted, R.string.onboarding_prop_no_password, R.string.onboarding_prop_open_source)
                .forEach { Text(text = stringResource(it), style = OnboardingContentSpec.prop, color = colors.textSecondary) }
        }
    }
}

/**
 * The link checklist's layout, read-only and unticked. The Android app has
 * no link screen yet; [OnboardingScreen] only lays this under the welcome
 * content, invisibly, so the welcome actions sit where they do in happy-app.
 */
@Composable
fun LinkComputerContent(modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = stringResource(R.string.onboarding_link_title),
            style = cappedScale(OnboardingContentSpec.title, OnboardingContentSpec.TITLE_MAX_SCALE),
            color = colors.text,
        )
        Column(modifier = Modifier.padding(top = OnboardingContentSpec.checklistGap)) {
            ChecklistRow(title = stringResource(R.string.onboarding_install_step), last = false) {
                Text(
                    text = buildAnnotatedString {
                        append(stringResource(R.string.onboarding_install_body_prefix))
                        withStyle(SpanStyle(color = colors.text, textDecoration = TextDecoration.Underline)) {
                            append(stringResource(R.string.onboarding_install_body_link))
                        }
                        append(stringResource(R.string.onboarding_install_body_suffix))
                    },
                    style = OnboardingContentSpec.body,
                    color = colors.textSecondary,
                )
            }
            ChecklistRow(title = stringResource(R.string.onboarding_open_step), last = true) {
                Text(text = stringResource(R.string.onboarding_open_body), style = OnboardingContentSpec.body, color = colors.textSecondary)
            }
        }
        // A no-break space holds the error line's height.
        Text(
            text = "\u00a0",
            style = OnboardingContentSpec.error,
            color = colors.warningCritical,
            textAlign = TextAlign.Center,
            maxLines = 1,
            modifier = Modifier.fillMaxWidth().padding(top = OnboardingContentSpec.errorGap),
        )
    }
}

@Composable
private fun ChecklistRow(title: String, last: Boolean, body: @Composable () -> Unit) {
    val colors = HappyTheme.colors
    Column(modifier = if (last) Modifier else Modifier.padding(bottom = OnboardingContentSpec.rowGap)) {
        Row(
            modifier = Modifier.defaultMinSize(minHeight = OnboardingContentSpec.rowHeadMinHeight),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OnboardingContentSpec.rowHeadGap),
        ) {
            Box(modifier = Modifier.size(OnboardingContentSpec.checkbox), contentAlignment = Alignment.Center) {
                Icon(icon = Ionicon.EllipseOutline, size = OnboardingContentSpec.checkbox, color = colors.textSecondary)
            }
            Text(text = title, style = OnboardingContentSpec.rowTitle, color = colors.text, modifier = Modifier.weight(1f))
        }
        Box(modifier = Modifier.padding(start = OnboardingContentSpec.rowBodyIndent, top = OnboardingContentSpec.rowBodyGap)) {
            body()
        }
    }
}

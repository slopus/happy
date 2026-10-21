package com.slopus.happy.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.selection.toggleable
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
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
    const val LINK_TITLE = "onboarding.linkTitle"
    const val INSTALL_ROW = "onboarding.installRow"
    const val OPEN_ROW = "onboarding.openRow"
    const val ERROR = "onboarding.error"
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

/** The two boxes of the link checklist (localSettings `linkComputerChecklist`). */
enum class LinkChecklistStep(val key: String) { Install("install"), Open("open") }

/**
 * The link checklist and the line under it that reports a failed link
 * (OnboardingContent.tsx LinkComputerContent). Title 28/34 semibold; the
 * rows 24 below it; the error line 16 below the rows, 15/20 centred in
 * warningCritical, one line, holding its height when empty so an error
 * never moves the buttons. Without [onToggle] the rows are read-only and the
 * site link is plain text.
 */
@Composable
fun LinkComputerContent(
    modifier: Modifier = Modifier,
    ticked: Set<LinkChecklistStep> = emptySet(),
    onToggle: ((LinkChecklistStep) -> Unit)? = null,
    disabled: Boolean = false,
    error: String? = null,
    onOpenDesktopSite: () -> Unit = {},
) {
    val colors = HappyTheme.colors
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = stringResource(R.string.onboarding_link_title),
            style = cappedScale(OnboardingContentSpec.title, OnboardingContentSpec.TITLE_MAX_SCALE),
            color = colors.text,
            modifier = Modifier.testTag(OnboardingContentTags.LINK_TITLE).semantics { heading() },
        )
        Column(modifier = Modifier.padding(top = OnboardingContentSpec.checklistGap)) {
            ChecklistRow(
                checked = LinkChecklistStep.Install in ticked,
                title = stringResource(R.string.onboarding_install_step),
                onToggle = onToggle?.let { { it(LinkChecklistStep.Install) } },
                disabled = disabled,
                modifier = Modifier.testTag(OnboardingContentTags.INSTALL_ROW),
            ) {
                val linkText = stringResource(R.string.onboarding_install_body_link)
                val body = buildAnnotatedString {
                    append(stringResource(R.string.onboarding_install_body_prefix))
                    val style = TextLinkStyles(SpanStyle(color = colors.text, textDecoration = TextDecoration.Underline))
                    if (onToggle != null) {
                        withLink(LinkAnnotation.Clickable(DESKTOP_URL, style) { onOpenDesktopSite() }) { append(linkText) }
                    } else {
                        withStyle(style.style!!) { append(linkText) }
                    }
                    append(stringResource(R.string.onboarding_install_body_suffix))
                }
                Text(text = body, style = OnboardingContentSpec.body, color = colors.textSecondary)
            }
            ChecklistRow(
                checked = LinkChecklistStep.Open in ticked,
                title = stringResource(R.string.onboarding_open_step),
                onToggle = onToggle?.let { { it(LinkChecklistStep.Open) } },
                disabled = disabled,
                last = true,
                modifier = Modifier.testTag(OnboardingContentTags.OPEN_ROW),
            ) {
                Text(text = stringResource(R.string.onboarding_open_body), style = OnboardingContentSpec.body, color = colors.textSecondary)
            }
        }
        // A no-break space holds one line of height while there is no error.
        Text(
            text = error ?: "\u00a0",
            style = OnboardingContentSpec.error,
            color = colors.warningCritical,
            textAlign = TextAlign.Center,
            maxLines = 1,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = OnboardingContentSpec.errorGap)
                .testTag(OnboardingContentTags.ERROR)
                .then(if (error != null) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier.clearAndSetSemantics {}),
        )
    }
}

/** happy.engineering, where the desktop app is downloaded. */
const val DESKTOP_URL = "https://happy.engineering"

/**
 * One checklist row (ChecklistRow): a 26 checkbox (checkmark-circle in
 * success when ticked, ellipse-outline in secondary otherwise) 12 before the
 * title 17/22 semibold, at least 32 high; the body 38 in and 6 below; 20
 * below the row unless it is the [last]. Ticking changes only the box.
 * With [onToggle] the head is a checkbox; without it, read-only.
 */
@Composable
fun ChecklistRow(
    checked: Boolean,
    title: String,
    modifier: Modifier = Modifier,
    onToggle: (() -> Unit)? = null,
    disabled: Boolean = false,
    last: Boolean = false,
    body: (@Composable () -> Unit)? = null,
) {
    val colors = HappyTheme.colors
    Column(modifier = modifier.then(if (last) Modifier else Modifier.padding(bottom = OnboardingContentSpec.rowGap))) {
        Row(
            modifier = Modifier
                .defaultMinSize(minHeight = OnboardingContentSpec.rowHeadMinHeight)
                .then(
                    if (onToggle != null) {
                        Modifier.toggleable(
                            value = checked,
                            enabled = !disabled,
                            role = Role.Checkbox,
                            interactionSource = null,
                            indication = null,
                            onValueChange = { onToggle() },
                        )
                    } else {
                        Modifier
                    },
                ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OnboardingContentSpec.rowHeadGap),
        ) {
            Box(modifier = Modifier.size(OnboardingContentSpec.checkbox), contentAlignment = Alignment.Center) {
                Icon(
                    icon = if (checked) Ionicon.CheckmarkCircle else Ionicon.EllipseOutline,
                    size = OnboardingContentSpec.checkbox,
                    color = if (checked) colors.success else colors.textSecondary,
                )
            }
            Text(text = title, style = OnboardingContentSpec.rowTitle, color = colors.text, modifier = Modifier.weight(1f))
        }
        if (body != null) {
            Box(modifier = Modifier.padding(start = OnboardingContentSpec.rowBodyIndent, top = OnboardingContentSpec.rowBodyGap)) {
                body()
            }
        }
    }
}

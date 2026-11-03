package com.slopus.happy.ui.components

import com.slopus.happy.ui.tablet.BackOrSidebarToggle
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import com.slopus.happy.ui.layout.ContentTokens
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object HeaderTags {
    const val BAR = "header.bar"
    const val LEFT = "header.left"
    const val RIGHT = "header.right"
    const val TITLE_BOX = "header.titleBox"
    const val TITLE = "header.title"
    const val SUBTITLE = "header.subtitle"
}

/** navigation/Header.tsx on an Android phone. */
object HeaderSpec {
    /** React Navigation's default Android header height. */
    val height = 64.dp
    /**
     * In from the content column's edges: a 24 glyph centred in its 48 slot
     * then lies on the content's keyline ([ContentTokens.inset]), as a
     * Material top app bar's do, rather than navigation/Header.tsx's 16 plus
     * the slot's 12, out of line with everything under it.
     */
    val paddingHorizontal = ContentTokens.inset - (48.dp - 24.dp) / 2
    val gap = 8.dp
    val controlSlot = 48.dp
    val centeredTitleInset = 64.dp
    val title = happyTextStyle(fontSize = 16, lineHeight = 20, weight = FontWeight.SemiBold)
    val subtitle = happyTextStyle(fontSize = 12, lineHeight = 16)
}

enum class TitleAlignment { Start, Center }

/**
 * Spec: status-bar inset, then a 64 bar on the content column
 * ([contentMaxWidth]) with 4 side padding and 8 gaps. Left and right
 * controls sit in 48x48 slots (wider if the control is), so a 24 glyph
 * lies on the content's 16 keyline at every width, over the cards and text
 * under it. A start-aligned title fills the space between them; a centred
 * title is laid out 64 in from both edges of the column, independent of the controls.
 * Title 16 semibold, subtitle 12, both in the header tint. The bar is the
 * header colour, or surfaceHigh once content has scrolled under it; inside a
 * [GlassBarLayout] it has none, the glass is its ground. No shadow.
 */
@Composable
fun Header(
    modifier: Modifier = Modifier,
    title: String? = null,
    subtitle: String? = null,
    alignment: TitleAlignment = TitleAlignment.Start,
    scrolled: Boolean = false,
    left: (@Composable () -> Unit)? = null,
    right: (@Composable () -> Unit)? = null,
    titleContent: (@Composable () -> Unit)? = null,
    /** The bar's colour; a screen passes its own background so bar and content are one surface. */
    background: Color? = null,
) {
    val colors = HappyTheme.colors
    val window = LocalWindowLayout.current
    // `isAndroidHeader` is a phone's: a tablet's bar keeps the header colour when content scrolls under it.
    val phone = !window.isTablet
    val titleBlock: @Composable () -> Unit = titleContent ?: {
        // The bar stays 64 at any font scale, as in RN; large text overflows it, centred, rather than clipping.
        Column(
            modifier = Modifier.wrapContentHeight(unbounded = true),
            horizontalAlignment = if (alignment == TitleAlignment.Center) Alignment.CenterHorizontally else Alignment.Start,
        ) {
            if (title != null) {
                Text(
                    text = title,
                    style = HeaderSpec.title,
                    color = colors.header.tint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = if (alignment == TitleAlignment.Center) TextAlign.Center else TextAlign.Start,
                    modifier = Modifier.testTag(HeaderTags.TITLE).semantics { heading() },
                )
            }
            if (subtitle != null) {
                Text(
                    text = subtitle,
                    style = HeaderSpec.subtitle,
                    color = colors.header.tint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 1.dp).testTag(HeaderTags.SUBTITLE),
                )
            }
        }
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .then(
                when {
                    // On glass the glass is the ground ([GlassBarLayout]).
                    LocalBarOnGlass.current -> Modifier
                    else -> Modifier.background(if (scrolled && phone) colors.surfaceHigh else background ?: colors.header.background)
                },
            )
            .windowInsetsPadding(WindowInsets.statusBars),
    ) {
        // navigation/Header.tsx `content`: on the content column, so its glyphs share the content's keyline.
        Layout(
            contents = listOf(
                { if (left != null) ControlSlot(Modifier.testTag(HeaderTags.LEFT), left) },
                {
                    Box(
                        modifier = Modifier.then(if (alignment == TitleAlignment.Start) Modifier.testTag(HeaderTags.TITLE_BOX) else Modifier),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        if (alignment == TitleAlignment.Start) titleBlock()
                    }
                },
                { if (right != null) ControlSlot(Modifier.testTag(HeaderTags.RIGHT), right) },
            ),
            modifier = Modifier
                .align(Alignment.TopCenter)
                .contentMaxWidth(window)
                .height(HeaderSpec.height)
                .testTag(HeaderTags.BAR)
                .padding(horizontal = HeaderSpec.paddingHorizontal),
        ) { (lefts, titles, rights), constraints ->
            // A row with 8 between its parts. A slot whose control renders nothing takes no room and
            // no gap, and the title then starts (or ends) on the keyline itself, as the text under it does.
            val gap = HeaderSpec.gap.roundToPx()
            val bare = (ContentTokens.inset - HeaderSpec.paddingHorizontal).roundToPx()
            val loose = constraints.copy(minWidth = 0, minHeight = 0)
            val leftSlot = lefts.firstOrNull()?.measure(loose)
            val rightSlot = rights.firstOrNull()?.measure(loose)
            val leftRoom = leftSlot?.width?.takeIf { it > 0 }?.plus(gap) ?: bare
            val rightRoom = rightSlot?.width?.takeIf { it > 0 }?.plus(gap) ?: bare
            val width = constraints.maxWidth
            val height = constraints.maxHeight
            val title = titles.first().measure(Constraints.fixed((width - leftRoom - rightRoom).coerceAtLeast(0), height))
            layout(width, height) {
                leftSlot?.place(0, (height - leftSlot.height) / 2)
                title.place(leftRoom, 0)
                rightSlot?.place(width - rightSlot.width, (height - rightSlot.height) / 2)
            }
        }
        if (alignment == TitleAlignment.Center) {
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .contentMaxWidth(window)
                    .height(HeaderSpec.height)
                    .padding(horizontal = HeaderSpec.centeredTitleInset)
                    .testTag(HeaderTags.TITLE_BOX),
                contentAlignment = Alignment.Center,
            ) { titleBlock() }
        }
    }
}

/**
 * A 48x48 slot (wider if the control is) centring its control, on a phone
 * and a tablet alike, so its glyph lands on the keyline whatever the
 * control's own box. Nothing at all when the control renders nothing.
 */
@Composable
private fun ControlSlot(modifier: Modifier, content: @Composable () -> Unit) {
    Layout(content, modifier) { measurables, constraints ->
        if (measurables.isEmpty()) return@Layout layout(0, 0) {}
        val slot = HeaderSpec.controlSlot.roundToPx()
        val controls = measurables.map { it.measure(Constraints(maxWidth = constraints.maxWidth, maxHeight = slot)) }
        val width = maxOf(slot, controls.maxOf { it.width }).coerceAtMost(constraints.maxWidth)
        val height = slot
        layout(width, height) { controls.forEach { it.place((width - it.width) / 2, (height - it.height) / 2) } }
    }
}

/**
 * The Android back control: a 48x48 target around a 24 arrow. On the
 * tablet main panel's root it is the sidebar's toggle instead
 * ([BackOrSidebarToggle]).
 */
@Composable
fun HeaderBackButton(onClick: () -> Unit) {
    BackOrSidebarToggle(HappyTheme.colors.header.tint) {
        HeaderIconButton(
            icon = Ionicon.ArrowBack,
            iconSize = 24.dp,
            buttonSize = 48.dp,
            contentDescription = stringResource(R.string.common_back),
            onClick = onClick,
        )
    }
}

/** HomeHeader's 32x32 header buttons (settings gear: 22). */
@Composable
fun HeaderIconButton(
    icon: Ionicon,
    contentDescription: String,
    onClick: () -> Unit,
    iconSize: androidx.compose.ui.unit.Dp = 22.dp,
    buttonSize: androidx.compose.ui.unit.Dp = 32.dp,
) {
    val colors = HappyTheme.colors
    Box(
        modifier = Modifier
            .size(buttonSize)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = ripple(bounded = false, radius = 24.dp, color = colors.text),
                role = Role.Button,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon = icon, size = iconSize, color = colors.header.tint, contentDescription = contentDescription)
    }
}

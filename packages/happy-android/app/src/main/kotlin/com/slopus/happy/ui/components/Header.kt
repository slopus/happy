package com.slopus.happy.ui.components

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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import com.slopus.happy.ui.layout.LocalTabletShell
import com.slopus.happy.ui.layout.LocalWindowLayout
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
    val paddingHorizontal = 16.dp
    val gap = 8.dp
    val controlSlot = 48.dp
    val centeredTitleInset = 64.dp
    val title = happyTextStyle(fontSize = 16, lineHeight = 20, weight = FontWeight.SemiBold)
    val subtitle = happyTextStyle(fontSize = 12, lineHeight = 16)
}

enum class TitleAlignment { Start, Center }

/**
 * Spec: status-bar inset, then a 64 bar with 16 side padding and 8 gaps.
 * Left and right controls sit in 48x48 slots (wider if the control is).
 * A start-aligned title fills the space between them; a centred title is
 * laid out 64 in from both edges of the bar, independent of the controls.
 * Title 16 semibold, subtitle 12, both in the header tint. The bar is the
 * header colour, or surfaceHigh once content has scrolled under it. No shadow.
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
) {
    val colors = HappyTheme.colors
    val window = LocalWindowLayout.current
    val maxWidth = window.headerMaxWidth
    // `isAndroidHeader` is a phone's: a tablet's controls sit bare, without the 48 slot,
    // and its bar keeps the header colour when content scrolls under it.
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
            .background(if (scrolled && phone) colors.surfaceHigh else colors.header.background)
            .windowInsetsPadding(WindowInsets.statusBars),
    ) {
        // navigation/Header.tsx `content`: held to layout.headerMaxWidth and centred.
        Layout(
            contents = listOf(
                { if (left != null) ControlSlot(Modifier.testTag(HeaderTags.LEFT), phone, left) },
                {
                    Box(
                        modifier = Modifier.then(if (alignment == TitleAlignment.Start) Modifier.testTag(HeaderTags.TITLE_BOX) else Modifier),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        if (alignment == TitleAlignment.Start) titleBlock()
                    }
                },
                { if (right != null) ControlSlot(Modifier.testTag(HeaderTags.RIGHT), phone, right) },
            ),
            modifier = Modifier
                .align(Alignment.TopCenter)
                .widthIn(max = maxWidth)
                .fillMaxWidth()
                .height(HeaderSpec.height)
                .testTag(HeaderTags.BAR)
                .padding(horizontal = HeaderSpec.paddingHorizontal),
        ) { (lefts, titles, rights), constraints ->
            // A row with 8 between its parts; a slot whose control renders nothing takes no room and no gap.
            val gap = HeaderSpec.gap.roundToPx()
            val loose = constraints.copy(minWidth = 0, minHeight = 0)
            val leftSlot = lefts.firstOrNull()?.measure(loose)
            val rightSlot = rights.firstOrNull()?.measure(loose)
            val leftRoom = leftSlot?.width?.takeIf { it > 0 }?.plus(gap) ?: 0
            val rightRoom = rightSlot?.width?.takeIf { it > 0 }?.plus(gap) ?: 0
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
                    .widthIn(max = maxWidth)
                    .fillMaxWidth()
                    .height(HeaderSpec.height)
                    .padding(horizontal = HeaderSpec.centeredTitleInset)
                    .testTag(HeaderTags.TITLE_BOX),
                contentAlignment = Alignment.Center,
            ) { titleBlock() }
        }
    }
}

/**
 * A 48x48 slot (wider if the control is) centring its control; on a tablet
 * just the control. Nothing at all when the control renders nothing.
 */
@Composable
private fun ControlSlot(modifier: Modifier, slotted: Boolean, content: @Composable () -> Unit) {
    Layout(content, modifier) { measurables, constraints ->
        if (measurables.isEmpty()) return@Layout layout(0, 0) {}
        val slot = HeaderSpec.controlSlot.roundToPx()
        val controls = measurables.map { it.measure(Constraints(maxWidth = constraints.maxWidth, maxHeight = if (slotted) slot else constraints.maxHeight)) }
        val width = (if (slotted) maxOf(slot, controls.maxOf { it.width }) else controls.maxOf { it.width }).coerceAtMost(constraints.maxWidth)
        val height = if (slotted) slot else controls.maxOf { it.height }
        layout(width, height) { controls.forEach { it.place((width - it.width) / 2, (height - it.height) / 2) } }
    }
}

/**
 * The Android back control: a 48x48 target around a 24 arrow. Under the
 * tablet shell it renders nothing and its slot closes: the persistent
 * header's back serves every screen (navigation/Header.tsx
 * `shouldHideBackButton`, ChatHeaderView.tsx `showBackButton`).
 */
@Composable
fun HeaderBackButton(onClick: () -> Unit) {
    if (LocalTabletShell.current) return
    HeaderIconButton(
        icon = Ionicon.ArrowBack,
        iconSize = 24.dp,
        buttonSize = 48.dp,
        contentDescription = stringResource(R.string.common_back),
        onClick = onClick,
    )
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

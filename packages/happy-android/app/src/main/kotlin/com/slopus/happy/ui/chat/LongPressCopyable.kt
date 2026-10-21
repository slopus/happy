package com.slopus.happy.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object CopyMenuTags {
    const val MENU = "copyMenu"
    const val COPY = "copyMenu.copy"
}

/** LongPressCopyable.tsx */
object CopyMenuSpec {
    val width = 152.dp
    val height = 44.dp
    val gap = 8.dp
    val screenMargin = 12.dp
    val radius = 14.dp
    val elevation = 8.dp
    val paddingHorizontal = 14.dp
    val iconGap = 10.dp
    val icon = 17.dp
    val label = happyTextStyle(fontSize = 15, lineHeight = 20)
    /** AnimatedOverlay.tsx AnimatedPopup: in over 190 ms from 0.96 and 8 lower, out over 140 ms. */
    const val ENTER_MS = 190
    const val EXIT_MS = 140
    const val ENTER_SCALE = 0.96f
    val enterOffset = 8.dp
}

// AnimatedOverlay.tsx: Easing.out(Easing.cubic) and Easing.in(Easing.cubic).
private val enterEasing = CubicBezierEasing(0.33f, 1f, 0.68f, 1f)
private val exitEasing = CubicBezierEasing(0.32f, 0f, 0.67f, 0f)

/**
 * LongPressCopyable.tsx's placement, in window pixels: above [anchor] when
 * the menu fits 12 below the window's top, else below it (kept 12 above the
 * window's bottom); its right edge on the anchor's, at least 12 from either
 * side.
 */
fun copyMenuPosition(anchor: IntRect, window: IntSize, density: Density): IntOffset = with(density) {
    val width = CopyMenuSpec.width.roundToPx()
    val height = CopyMenuSpec.height.roundToPx()
    val gap = CopyMenuSpec.gap.roundToPx()
    val margin = CopyMenuSpec.screenMargin.roundToPx()
    val above = anchor.top - height - gap
    val top = if (above >= margin) above else minOf(anchor.bottom + gap, window.height - height - margin)
    val left = maxOf(margin, minOf(window.width - width - margin, anchor.right - width))
    IntOffset(left, top)
}

/**
 * LongPressCopyable.tsx: a long press (400ms, the platform's) on the
 * content opens a small menu anchored to it instead of copying at once. The
 * menu: 152 wide, radius 14, the surface with a hairline divider border and
 * elevation 8; one 44-high row, 14 in, copy-outline 17 in text 10 before
 * "Copy" 15/20, surfaceSelected while pressed. Tapping outside or Back
 * closes it; Copy puts [text] on the clipboard and closes it. Opening is a
 * light haptic; the menu fades in over 190 ms from 0.96 scale and 8 lower,
 * and fades out over 140 ms (AnimatedPopup).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LongPressCopyable(
    text: String,
    modifier: Modifier = Modifier,
    horizontalAlignment: Alignment.Horizontal = Alignment.Start,
    content: @Composable ColumnScope.() -> Unit,
) {
    val menu = remember { MutableTransitionState(false) }
    val haptics = LocalHapticFeedback.current
    // Held here, not in the menu: closing the menu would cancel the copy.
    val copy = rememberCopyText()
    Column(
        modifier = modifier.combinedClickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
            hapticFeedbackEnabled = false,
            onClick = {},
            onLongClick = {
                haptics.light()
                menu.targetState = true
            },
        ),
        horizontalAlignment = horizontalAlignment,
    ) {
        content()
        if (menu.currentState || menu.targetState) CopyMenu(menu, onCopy = { copy(text) }, onClose = { menu.targetState = false })
    }
}

@Composable
private fun CopyMenu(menu: MutableTransitionState<Boolean>, onCopy: () -> Unit, onClose: () -> Unit) {
    val density = LocalDensity.current
    val position = remember(density) {
        object : PopupPositionProvider {
            override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize) =
                copyMenuPosition(anchorBounds, windowSize, density)
        }
    }
    // Only the open menu takes focus and Back; a closing one just fades.
    Popup(popupPositionProvider = position, onDismissRequest = onClose, properties = PopupProperties(focusable = menu.targetState)) {
        AnimatedVisibility(
            visibleState = menu,
            enter = fadeIn(tween(CopyMenuSpec.ENTER_MS, easing = enterEasing)) +
                scaleIn(tween(CopyMenuSpec.ENTER_MS, easing = enterEasing), initialScale = CopyMenuSpec.ENTER_SCALE) +
                slideInVertically(tween(CopyMenuSpec.ENTER_MS, easing = enterEasing)) { with(density) { CopyMenuSpec.enterOffset.roundToPx() } },
            exit = fadeOut(tween(CopyMenuSpec.EXIT_MS, easing = exitEasing)),
        ) {
            CopyMenuContent(onCopy, onClose)
        }
    }
}

/** The menu itself, without the popup, for layout tests. */
@Composable
fun CopyMenuContent(onCopy: () -> Unit, onClose: () -> Unit) {
    val colors = HappyTheme.colors
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    val shape = RoundedCornerShape(CopyMenuSpec.radius)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Column(
        modifier = Modifier
            .testTag(CopyMenuTags.MENU)
            .width(CopyMenuSpec.width)
            .shadow(CopyMenuSpec.elevation, shape)
            .clip(shape)
            .background(colors.surface)
            .border(hairline, colors.divider, shape),
    ) {
        Row(
            modifier = Modifier
                .testTag(CopyMenuTags.COPY)
                .width(CopyMenuSpec.width)
                .height(CopyMenuSpec.height)
                .background(if (pressed) colors.surfaceSelected else colors.surface)
                .clickable(interactionSource = interaction, indication = null, role = Role.Button) {
                    onCopy()
                    onClose()
                }
                .padding(horizontal = CopyMenuSpec.paddingHorizontal),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(CopyMenuSpec.iconGap),
        ) {
            Icon(Ionicon.CopyOutline, CopyMenuSpec.icon, colors.text)
            Text(stringResource(R.string.common_copy), style = CopyMenuSpec.label, color = colors.text)
        }
    }
}

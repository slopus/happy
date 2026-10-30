package com.slopus.happy.ui.conversation

import android.view.WindowManager
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.slopus.happy.ui.theme.HappyTheme

/**
 * ChatGPT's floating menu: vertically centred on its trigger, overlapping
 * the composer and keyboard, with 8 dp clear of system bars/window edges.
 * Long lists scroll within 480 dp or the available window height. ALT_FOCUSABLE_IM
 * keeps the editor as the IME target while this non-editing window receives
 * Back, Escape and keyboard navigation. The popup never requests or clears
 * editor focus, and outside taps dismiss without changing the draft.
 * Header menus use [belowAnchor] to open below their button instead.
 */
@Composable
internal fun ConversationPopup(
    title: String,
    onDismiss: () -> Unit,
    anchorCenterY: Int = 0,
    alignEnd: Boolean,
    width: Dp,
    modifier: Modifier = Modifier,
    belowAnchor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val density = LocalDensity.current
    val window = LocalWindowInfo.current.containerSize
    val margin = with(density) { 8.dp.roundToPx() }
    val top = WindowInsets.statusBars.getTop(density)
    val bottom = WindowInsets.navigationBars.getBottom(density)
    val availableWidth = with(density) { window.width.toDp() - 16.dp }
    val maxHeight = with(density) { (window.height - top - bottom).toDp() - 16.dp }.coerceIn(1.dp, 480.dp)
    val position = remember(margin, alignEnd, anchorCenterY, top, bottom, belowAnchor) { ConversationPopupPosition(margin, alignEnd, anchorCenterY, top, bottom, belowAnchor) }
    Popup(
        popupPositionProvider = position,
        onDismissRequest = onDismiss,
        properties = PopupProperties(
            flags = WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or
                // Use the whole window's bounds, including the area occupied by the IME.
                // The position provider applies the system-bar and edge limits itself.
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            inheritSecurePolicy = true,
            excludeFromSystemGesture = false,
        ),
    ) {
        Surface(
            modifier = modifier.width(width.coerceAtMost(availableWidth.coerceAtLeast(1.dp))).heightIn(max = maxHeight).semantics { paneTitle = title },
            shape = RoundedCornerShape(24.dp),
            color = HappyTheme.colors.surface,
            shadowElevation = 8.dp,
        ) { content() }
    }
}

internal class ConversationPopupPosition(
    private val margin: Int,
    private val alignEnd: Boolean,
    private val anchorCenterY: Int,
    private val topInset: Int = 0,
    private val bottomInset: Int = 0,
    private val belowAnchor: Boolean = false,
) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val atRight = alignEnd == (layoutDirection == LayoutDirection.Ltr)
        val x = if (atRight) anchorBounds.right - popupContentSize.width else anchorBounds.left
        return IntOffset(
            x.coerceIn(margin, (windowSize.width - popupContentSize.width - margin).coerceAtLeast(margin)),
            (if (belowAnchor) anchorBounds.bottom + margin else anchorCenterY - popupContentSize.height / 2)
                .coerceIn(topInset + margin, (windowSize.height - bottomInset - popupContentSize.height - margin).coerceAtLeast(topInset + margin)),
        )
    }
}
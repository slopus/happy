package engineering.happy.scroll

import android.content.Context
import android.graphics.Rect
import android.graphics.RectF
import android.view.View
import com.facebook.react.views.scroll.ReactScrollView

/**
 * A ReactScrollView that accounts for view transforms when it scrolls a focused
 * descendant into view.
 *
 * Android works out where a descendant sits from layout positions alone. Both
 * ReactScrollView.scrollToChild (offsetDescendantRectToMyCoords) and
 * View.requestRectangleOnScreen add up each view's left/top and skip its
 * rotation and scale. An inverted FlashList rotates every row by 180 degrees, so
 * inside a row that math mirrors the descendant across the row's middle.
 * Selectable text takes focus on a tap and on a long-press, and in a message
 * taller than the screen the mirrored position is off screen: the list jumps to
 * the far end of the message, taking the text out from under the finger.
 *
 * When a transform sits between the focused view and this scroll view:
 * - Rectangle requests from the focused view (a selection handle being dragged,
 *   a text cursor) are mapped through every view's matrix, so the scroll aims at
 *   where the text is actually drawn.
 * - A focus change scrolls nothing in touch mode. There, focus arrives either
 *   under the finger, already on screen, or by the framework's own choice: when
 *   a recycled row takes the focused text with it, ViewGroup.removeViewInternal
 *   hands focus to the first focusable view it finds, which in a long chat is
 *   usually nowhere near the reader. Keyboard and D-pad navigation, outside
 *   touch mode, still bring the newly focused view into view, mapped the same way.
 * With no transform in the way, every override defers to ReactScrollView unchanged.
 */
class TransformAwareScrollView(context: Context) : ReactScrollView(context) {

    private var hideFocusFromResize = false

    override fun requestChildFocus(child: View, focused: View) {
        if (!hasTransformBetween(focused)) {
            super.requestChildFocus(child, focused)
            return
        }
        if (!isInTouchMode) scrollFocusedIntoView(focused)
        requestChildFocusWithoutScroll(child, focused)
    }

    override fun requestChildRectangleOnScreen(child: View, rectangle: Rect, immediate: Boolean): Boolean {
        val focused = super.findFocus()
        val drawn = if (focused != null && focused !== this && hasTransformBetween(focused)) {
            drawnRectOfFocusedRequest(focused, child, rectangle)
        } else {
            null
        }
        if (drawn == null) {
            return super.requestChildRectangleOnScreen(child, rectangle, immediate)
        }
        val delta = computeScrollDeltaToGetChildRectOnScreen(drawn)
        if (delta != 0) {
            if (immediate) scrollBy(0, delta) else smoothScrollBy(0, delta)
        }
        return delta != 0
    }

    override fun findFocus(): View? = if (hideFocusFromResize) null else super.findFocus()

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val focused = super.findFocus()
        if (focused == null || focused === this || !hasTransformBetween(focused)) {
            super.onSizeChanged(w, h, oldw, oldh)
            return
        }
        // ScrollView keeps a focused descendant visible across a resize with the
        // same layout-only math, so it would aim at the mirrored position. Hide
        // the focus from that one pass; everything else in the resize still runs.
        hideFocusFromResize = true
        try {
            super.onSizeChanged(w, h, oldw, oldh)
        } finally {
            hideFocusFromResize = false
        }
    }

    /** ReactScrollView.scrollToChild, with the rectangle mapped through transforms. */
    private fun scrollFocusedIntoView(focused: View) {
        // Like ReactScrollView, bring the outermost nested scroll view into view
        // rather than the focused view itself; that one scrolls its own content.
        var target = focused
        var parent = focused.parent
        while (parent is View && parent !== this) {
            if (parent is ReactScrollView) target = parent
            parent = parent.parent
        }
        val rect = RectF(0f, 0f, target.width.toFloat(), target.height.toFloat())
        if (!mapToContent(target, rect)) return
        val delta = computeScrollDeltaToGetChildRectOnScreen(rect.toOuterRect())
        if (delta != 0) scrollBy(0, delta)
    }

    /**
     * [rectangle] arrives in [child]'s content coordinates, placed there by
     * View.requestRectangleOnScreen adding layout offsets only. When it came from
     * [focused], undo those offsets and redo the walk through each view's matrix.
     * Returns null when the rectangle is not inside [focused], so another view
     * made the request and the caller keeps the default behavior.
     */
    private fun drawnRectOfFocusedRequest(focused: View, child: View, rectangle: Rect): Rect? {
        var dx = 0f
        var dy = 0f
        var current: View = focused
        while (current !== child) {
            dx += (current.left - current.scrollX).toFloat()
            dy += (current.top - current.scrollY).toFloat()
            current = current.parent as? View ?: return null
        }
        // Back in the focused view's own, untransformed coordinates.
        val local = RectF(rectangle)
        local.offset(-dx - focused.scrollX, -dy - focused.scrollY)
        val bounds = RectF(-REQUEST_SLOP, -REQUEST_SLOP, focused.width + REQUEST_SLOP, focused.height + REQUEST_SLOP)
        if (!RectF.intersects(local, bounds)) return null
        if (!mapToContent(focused, local)) return null
        return local.toOuterRect()
    }

    /**
     * Maps [rect] from [view]'s local coordinates into this scroll view's content
     * coordinates, applying every transform on the way. False if [view] is not
     * inside this scroll view.
     */
    private fun mapToContent(view: View, rect: RectF): Boolean {
        var current = view
        while (true) {
            val matrix = current.matrix
            if (!matrix.isIdentity) matrix.mapRect(rect)
            rect.offset(current.left.toFloat(), current.top.toFloat())
            val parent = current.parent as? View ?: return false
            if (parent === this) return true
            rect.offset(-parent.scrollX.toFloat(), -parent.scrollY.toFloat())
            current = parent
        }
    }

    private fun hasTransformBetween(view: View): Boolean {
        var current = view
        while (true) {
            if (!current.matrix.isIdentity) return true
            val parent = current.parent as? View ?: return false
            if (parent === this) return false
            current = parent
        }
    }

    private fun RectF.toOuterRect(): Rect = Rect().also { roundOut(it) }

    private companion object {
        // TextView.bringPointIntoView pads its cursor rectangle a few pixels past
        // the text, so a request from the focused view can touch its edges.
        const val REQUEST_SLOP = 8f
    }
}

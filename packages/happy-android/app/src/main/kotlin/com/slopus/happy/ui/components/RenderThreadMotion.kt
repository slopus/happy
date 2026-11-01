package com.slopus.happy.ui.components

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.drawable.AnimatedVectorDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.view.View
import androidx.annotation.RequiresApi
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.viewinterop.AndroidView
import com.slopus.happy.R

/**
 * The shimmer and the pulse run by the RenderThread alone, as the platform's
 * indeterminate spinner does: each is an AnimatedVectorDrawable
 * (`res/drawable/shimmer_sweep.xml`, `status_dot_pulse.xml`, ShimmerSpec's
 * and StatusDot.tsx's numbers) drawn in a View of its own, which the
 * RenderThread animates frame by frame with no main-thread frame at all: no
 * Choreographer callback, no Compose frame, no traversal. A working bar on
 * the main thread's clock ([ShimmerClock]) costs a whole frame of it every
 * tick, however little it draws, about 2 ms on the Fold.
 *
 * The drawable has to be drawn in a View's own display list: the
 * RenderThread runs a vector animation on the RenderNode it is recorded in,
 * and only a View's has the window's animation host. So the text is laid out
 * and recorded by Compose as usual, and the View draws that recording, then
 * the band over it (SrcAtop, in a layer of its own, as [shimmer] does).
 *
 * Only where a hardware canvas draws it (not in Robolectric, which takes the
 * clock's path), and not with animations off.
 */
@Composable
internal fun renderThreadMotion(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && LocalView.current.isHardwareAccelerated && !rememberReduceMotion()

/** [ShimmerText]'s sweep on the RenderThread ([renderThreadMotion]): the same text, the same band. */
@RequiresApi(Build.VERSION_CODES.Q)
@Composable
internal fun RenderThreadShimmerText(text: String, style: TextStyle, baseColor: Color, highlightColor: Color, modifier: Modifier) {
    val recorded = rememberGraphicsLayer()
    Box {
        Text(
            text = text,
            style = style,
            color = baseColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            // Recorded for the View to draw, under its band; not drawn here.
            modifier = Modifier.drawWithContent { recorded.record { this@drawWithContent.drawContent() } }.then(modifier),
        )
        AndroidView(::SweepView, Modifier.matchParentSize(), update = { it.show(recorded, highlightColor.toArgb()) })
    }
}

/** [StatusDot]'s pulse on the RenderThread ([renderThreadMotion]). */
@Composable
internal fun RenderThreadPulse(color: Color, modifier: Modifier, size: Dp) {
    AndroidView(::PulseView, modifier.size(size), update = { it.tint(color.toArgb()) })
}

/** An AnimatedVectorDrawable of [id], tinted SRC_IN, running from when its View is attached until it is detached. */
private abstract class VectorMotionView(context: Context, id: Int) : View(context) {
    protected val motion = (context.getDrawable(id)!!.mutate() as AnimatedVectorDrawable).apply {
        setTintMode(PorterDuff.Mode.SRC_IN)
        callback = this@VectorMotionView
    }

    fun tint(color: Int) {
        motion.setTint(color)
        invalidate()
    }

    override fun verifyDrawable(who: Drawable) = who === motion || super.verifyDrawable(who)

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) = motion.setBounds(0, 0, w, h)

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        // Started before its first draw, it starts on the RenderThread once drawn.
        motion.start()
    }

    override fun onDetachedFromWindow() {
        motion.stop()
        super.onDetachedFromWindow()
    }
}

/** The text Compose recorded, then the band swept over its glyphs. */
@RequiresApi(Build.VERSION_CODES.Q)
private class SweepView(context: Context) : VectorMotionView(context, R.drawable.shimmer_sweep) {
    private val atop = Paint().apply { blendMode = android.graphics.BlendMode.SRC_ATOP }
    private val scope = CanvasDrawScope()
    private var text: GraphicsLayer? = null

    fun show(text: GraphicsLayer, highlight: Int) {
        this.text = text
        tint(highlight)
    }

    override fun onDraw(canvas: Canvas) {
        val text = text ?: return
        val size = Size(width.toFloat(), height.toFloat())
        // The text in a layer of its own, so the band lands on its glyphs alone and not on the window under it.
        val saved = canvas.saveLayer(0f, 0f, size.width, size.height, null)
        scope.draw(Density(resources.displayMetrics.density), LayoutDirection.Ltr, androidx.compose.ui.graphics.Canvas(canvas), size) { drawLayer(text) }
        canvas.saveLayer(0f, 0f, size.width, size.height, atop)
        motion.draw(canvas)
        canvas.restoreToCount(saved)
    }
}

private class PulseView(context: Context) : VectorMotionView(context, R.drawable.status_dot_pulse) {
    override fun onDraw(canvas: Canvas) = motion.draw(canvas)
}

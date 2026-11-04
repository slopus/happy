package com.slopus.happy.ui.camera

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.EaseIn
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.lerp
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min

internal object PhotoTags {
    const val TILE = "camera.tile"
    const val PREVIEW = "camera.preview"
    const val SHUTTER = "camera.shutter"
    const val RING = "camera.shutter.ring"
    const val DISC = "camera.shutter.disc"
    const val REVIEW = "camera.review"
    const val REVIEW_BAR = "camera.review.bar"
    const val RETAKE = "camera.retake"
    const val USE = "camera.use"
    const val MESSAGE = "camera.message"
}

/** CameraScreenLayout.swift: the photo frame, 96 shutter target, 120 tablet column and 96 review bar. */
internal data class PhotoFrames(val preview: Rect, val shutter: Rect, val mode: Rect, val review: Rect) {
    companion object {
        fun of(size: Size, top: Float, bottom: Float, tablet: Boolean, unit: Float): PhotoFrames {
            val column = if (tablet) 120 * unit else 0f
            val area = Rect(0f, top, (size.width - column).coerceAtLeast(0f), (size.height - bottom).coerceAtLeast(top))
            val preview = if (!tablet && size.width * 4 / 3 <= area.height) {
                Rect(0f, top, size.width, top + size.width * 4 / 3)
            } else fitPhoto(Size(4f, 3f), area, portrait = area.height >= area.width)
            val side = 96 * unit
            val shutter = if (tablet) {
                Rect(size.width - column / 2 - side / 2, area.center.y - side / 2, size.width - column / 2 + side / 2, area.center.y + side / 2)
            } else {
                Rect((size.width - side) / 2, size.height - bottom - 16 * unit - side, (size.width + side) / 2, size.height - bottom - 16 * unit)
            }
            val mode = if (tablet) {
                Rect(size.width - column, shutter.top - 24 * unit - 28 * unit, size.width, shutter.top - 24 * unit)
            } else Rect(0f, shutter.top - 4 * unit - 28 * unit, size.width, shutter.top - 4 * unit)
            return PhotoFrames(preview, shutter, mode, Rect(0f, size.height - bottom - 96 * unit, size.width, size.height))
        }
    }
}

internal fun fitPhoto(pixels: Size, area: Rect, portrait: Boolean = pixels.height >= pixels.width): Rect {
    if (pixels.width <= 0 || pixels.height <= 0 || area.width <= 0 || area.height <= 0) return Rect(area.center, Size.Zero)
    val ratio = max(pixels.width, pixels.height) / min(pixels.width, pixels.height)
    val shape = if (portrait) Size(1f, ratio) else Size(ratio, 1f)
    val scale = min(area.width / shape.width, area.height / shape.height)
    val fitted = Size(shape.width * scale, shape.height * scale)
    return Rect(area.center - Offset(fitted.width / 2, fitted.height / 2), fitted)
}

internal data class PreviewTransform(val scale: Float, val shift: Offset, val clip: Rect)

/** One retained aspect-fill preview, transformed in drawing rather than remeasured while opening. */
internal fun previewTransform(full: Rect, tile: Rect, progress: Float): PreviewTransform {
    val fill = if (full.width > 0 && full.height > 0) max(tile.width / full.width, tile.height / full.height) else 1f
    return PreviewTransform(fill + (1 - fill) * progress, (tile.center - full.center) * (1 - progress), lerp(tile, full, progress))
}

/**
 * CameraViewController.swift:371–420: open 0.4s, damping0.86 from a tile (1 without),
 * controls after the first quarter; return0.35s/damping1, controls0.15s; no-tile/review
 * close slides down0.3s easeIn, Use Photo fades0.25s. Telegram's retained-view technique
 * is ChatAttachAlertPhotoLayout.java:2447–2521; iOS's durations take precedence.
 */
@Stable
internal class PhotoMotion(settled: Boolean = false) {
    val progress = Animatable(if (settled) 1f else 0f)
    val controls = Animatable(if (settled) 1f else 0f)
    val fade = Animatable(1f)
    var morphs by mutableStateOf(true)
        private set
    var closing by mutableStateOf(false)
        private set

    suspend fun open(tile: Boolean, reduce: Boolean) = coroutineScope {
        closing = false
        morphs = tile
        fade.snapTo(1f)
        launch { progress.animateTo(1f, if (reduce) snap() else spring(if (tile) 0.86f else 1f, stiffness(if (tile) 0.86f else 1f, 0.4f))) }
        launch { controls.animateTo(1f, if (reduce) snap() else tween(300, 100, LinearEasing)) }
    }

    suspend fun close(tile: Boolean, review: Boolean, reduce: Boolean) = coroutineScope {
        closing = true
        morphs = tile && !review
        launch {
            progress.animateTo(0f, when {
                reduce -> snap()
                morphs -> spring(1f, stiffness(1f, 0.35f))
                else -> tween(300, easing = EaseIn)
            })
        }
        launch { controls.animateTo(0f, if (reduce) snap() else tween(150, easing = LinearEasing)) }
    }

    suspend fun use(reduce: Boolean) {
        closing = true
        fade.animateTo(0f, if (reduce) snap() else tween(250, easing = EaseInOut))
    }

    /** Review leaves downward; once it has gone the retained tile resumes in its own frame. */
    fun collapsed() { morphs = true }

    private fun stiffness(damping: Float, seconds: Float): Float {
        val frequency = 4 / (damping * seconds)
        return frequency * frequency
    }
}

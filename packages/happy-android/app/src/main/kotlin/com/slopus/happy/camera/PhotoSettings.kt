package com.slopus.happy.camera

import android.os.Build
import android.util.Range
import androidx.camera.core.ExperimentalZeroShutterLag
import androidx.camera.core.ImageCapture
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.roundToInt

/** CameraSettings.swift: these three choices last for the process, never sync. */
internal object PhotoPreferences {
    var flash by mutableStateOf(PhotoFlash.Auto)
    var shape by mutableStateOf(PhotoShape.Standard)
    var grid by mutableStateOf(false)
}

internal enum class PhotoFlash {
    Auto, On, Off;
    fun next() = entries[(ordinal + 1) % entries.size]
}

internal enum class PhotoShape(val ratio: Double, val label: String) {
    Standard(4.0 / 3, "4:3"), Wide(16.0 / 9, "16:9"), Square(1.0, "1:1");
    fun next() = entries[(ordinal + 1) % entries.size]
}

/** Only real CameraX zoom limits are offered; numbers denote zoom, not physical lenses. */
internal data class PhotoZoom(val min: Float = 1f, val max: Float = 1f) {
    val stops: List<Float> = (listOf(min) + listOf(1f, 2f, 3f, 5f))
        .filter { it in min..max }.distinct().sorted()

    fun clamp(ratio: Float): Float = if (ratio.isFinite()) ratio.coerceIn(min, max) else min
    fun selected(ratio: Float): Int = stops.indexOfLast { it <= ratio * 1.001f }.coerceAtLeast(0)

    companion object {
        fun label(ratio: Float, selected: Boolean): String {
            val tenth = (ratio * 10).roundToInt()
            val text = if (tenth % 10 == 0) (tenth / 10).toString() else "${tenth / 10}.${abs(tenth % 10)}".removePrefix("0")
            return if (selected) "$text×" else text
        }
    }
}

/**
 * Zero shutter lag, except on Samsung. There a ZSL session's preview freezes
 * once a zoom moves the logical camera onto another lens (an S22 froze at 2x).
 * CameraX's own ZslDisablerQuirk lists only the US models (SM-S901U, SM-S908U…),
 * so the S22s sold elsewhere (SM-S901B, …) keep ZSL unless we drop it.
 */
@androidx.annotation.OptIn(ExperimentalZeroShutterLag::class)
internal fun photoCaptureMode(manufacturer: String = Build.MANUFACTURER): Int =
    if (manufacturer.equals("samsung", ignoreCase = true)) ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY
    else ImageCapture.CAPTURE_MODE_ZERO_SHUTTER_LAG

/** CameraExposure.swift's ±2EV and dim-room threshold, restricted by the actual device. */
internal fun exposureIndex(slider: Float, step: Float, range: Range<Int>): Int {
    if (!slider.isFinite() || step <= 0 || !step.isFinite()) return 0.coerceIn(range.lower, range.upper)
    return (slider.coerceIn(-1f, 1f) * 2 / step).roundToInt().coerceIn(range.lower, range.upper)
}

internal fun darkPhotoScene(aperture: Float?, nanos: Long?, iso: Int?): Boolean? {
    if (aperture == null || nanos == null || iso == null || !aperture.isFinite() || aperture <= 0 || nanos <= 0 || iso <= 0) return null
    val ev = ln(aperture.toDouble() * aperture / (nanos / 1e9)) / ln(2.0) - ln(iso / 100.0) / ln(2.0)
    return ev < 4.5
}

/** Choose an advertised AE range; critical heat asks for at most24, serious at most30. */
internal fun photoFrameRate(supported: List<Range<Int>>, cap: Int): Range<Int>? {
    val eligible = supported.filter { it.upper <= cap }
    return eligible.maxWithOrNull(compareBy<Range<Int>> { it.upper }.thenBy { it.lower })
        // Some cameras cannot go below30. Keep their lowest real range rather than invent24.
        ?: supported.minWithOrNull(compareBy<Range<Int>> { it.upper }.thenByDescending { it.lower })
}
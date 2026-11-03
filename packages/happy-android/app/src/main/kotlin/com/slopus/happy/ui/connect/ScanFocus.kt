package com.slopus.happy.ui.connect

import kotlin.math.atan
import kotlin.math.min
import kotlin.math.tan

/**
 * The zoom that lets a code as small as Happy shows one (30 mm, the CLI's
 * and desktop's) fill the viewfinder while still in focus, as iOS's
 * `QRScannerLayout.focusZoom` (ff88dfcd6, after Apple's AVCamBarcode). A
 * camera that can't focus close (many main cameras focus no nearer than
 * 10 to 20 cm) would otherwise need the code held where it is a blur.
 */
object ScanFocus {
    const val CODE_MM = 30f
    const val MAX_ZOOM = 3f

    /**
     * [minimumFocusMm] the camera's nearest focus, ≤ 0 when unknown or
     * fixed; [fieldOfView] degrees across the picture's long side; [fill]
     * the viewfinder's share of that side. 1 when the camera focuses near
     * enough, else the zoom that moves the code out to where it does, at
     * most [MAX_ZOOM].
     */
    fun zoom(minimumFocusMm: Float, fieldOfView: Float, fill: Float): Float {
        if (minimumFocusMm <= 0f || fieldOfView <= 0f || fieldOfView >= 180f || fill <= 0f || fill > 1f) return 1f
        val halfAngle = Math.toRadians(fieldOfView / 2.0)
        val distance = CODE_MM / (2 * fill * tan(halfAngle)).toFloat()
        if (distance >= minimumFocusMm) return 1f
        return min(minimumFocusMm / distance, MAX_ZOOM)
    }

    /** Camera2's nearest focus, in diopters (0: fixed focus), as millimetres; ≤ 0 when unknown. */
    fun minimumFocusMm(diopters: Float?): Float = if (diopters == null || diopters <= 0f) -1f else 1000f / diopters

    /** Degrees across the sensor's long side for a lens of [focalLengthMm]. */
    fun fieldOfView(sensorLongSideMm: Float, focalLengthMm: Float): Float =
        if (sensorLongSideMm <= 0f || focalLengthMm <= 0f) 0f else Math.toDegrees(2 * atan(sensorLongSideMm / (2.0 * focalLengthMm))).toFloat()

    /**
     * The viewfinder's share of the picture's long side. The preview fills
     * the window, so the picture's long side spans the window's long side
     * whenever the window is at least as elongated as the picture, which
     * every phone and tablet is against a 4:3 or 16:9 sensor.
     */
    fun fill(viewfinderSide: Float, windowWidth: Float, windowHeight: Float): Float {
        val long = maxOf(windowWidth, windowHeight)
        return if (long <= 0f) 0f else viewfinderSide / long
    }
}

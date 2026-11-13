package com.slopus.happy.ui.photoedit

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** Independently drawn outlines, using Telegram-Android's media_* and photo_* icons as visual references. */
internal object PhotoEditIcons {
    val Crop by lazy { outline("Crop", "M7,7H18V18H7ZM7,4V20M4,18H20M3,10C3,5 6,2 11,2H14M11,0.8L14,2 12,5") }
    val Draw by lazy { outline("Draw", "M10,12L17,3C19,0.5 23.5,4 21,6.5L12.5,14M10,12C6,10 4,14 4,17C4,19 2,19 1.5,19C6,24 14,21 13,16C13,14 12,13 10,12Z") }
    val Undo by lazy { outline("Undo", "M8,5L4,9 8,13M4,9H14C22,9 22,20 14,20H7") }
    val RotateLeft by lazy { outline("RotateLeft", "M8,2L4,6 8,10M4,6H12C18,6 21,10 21,15C21,20 17,23 12,23M4,14V20H10V14Z") }
    val Mirror by lazy { outline("Mirror", "M12,2V22M8,5L2,19H8ZM16,5L22,19H16Z") }
    val Aspect by lazy { outline("Aspect", "M4,4H20V20H4ZM8,8H16V16H8Z") }
    val Eyedropper by lazy { outline("Eyedropper", "M14,4L20,10M15,5L18,2C20,0 24,4 22,6L19,9M15,6L3,18V22H7L19,10M6,16L9,19") }

    private const val ring = "M12,1.5A10.5,10.5 0,1 1,12,22.5A10.5,10.5 0,1 1,12,1.5Z"
    val Pen by lazy { outline("Pen", ring + "M8,22L9.5,12H14.5L16,22M10,12L12,6 14,12") }
    val Arrow by lazy { outline("Arrow", ring + "M12,21V7M7.5,11.5L12,7 16.5,11.5") }
    val Marker by lazy { outline("Marker", ring + "M8.5,22L9,13H15L15.5,22M9,17H15M10,13V7L14,6V13") }
    val Neon by lazy { outline("Neon", ring + "M8.5,22V12Q8.5,10 10.5,10H13.5Q15.5,10 15.5,12V22M9,16H15M12,5V6M5.5,12H6M18,12H18.5") }
    val Blur by lazy { outline("Blur", ring + "M8,7h0.01M12,7h0.01M16,7h0.01M6,11h0.01M10,11h0.01M14,11h0.01M18,11h0.01M6,15h0.01M10,15h0.01M14,15h0.01M18,15h0.01M9,19h0.01M15,19h0.01", 1.8f) }
    val Eraser by lazy { outline("Eraser", ring + "M9,22V17H15V22M9,14H15M9,11V8Q9,7 10,7H14Q15,7 15,8V11Z") }

    fun of(tool: PaintTool): ImageVector = when (tool) {
        PaintTool.Pen -> Pen
        PaintTool.Arrow -> Arrow
        PaintTool.Marker -> Marker
        PaintTool.Neon -> Neon
        PaintTool.Blur -> Blur
        PaintTool.Eraser -> Eraser
    }

    private fun outline(name: String, path: String, weight: Float = 1.65f): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).addPath(
            addPathNodes(path), fill = null, stroke = SolidColor(Color.White), strokeLineWidth = weight,
            strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
        ).build()
}
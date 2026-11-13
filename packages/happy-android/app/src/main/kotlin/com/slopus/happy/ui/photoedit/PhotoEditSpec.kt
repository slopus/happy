package com.slopus.happy.ui.photoedit

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** The editor's measures, Telegram-Android's where it has them (`Crop/`, `Paint/`). */
object PhotoEditSpec {
    /** What an edit applied tints its button in, in the viewer and the crop's wheel. */
    val edited = Color(0xFFFFD300)

    /** `CropAreaView`: the dim round the frame, its line, its handles. */
    const val CROP_DIM = 0x7f000000
    const val CROP_LINE = 0xb2ffffff.toInt()
    const val CROP_GRID = 0x66ffffff
    val handleLength = 16.dp
    val handleThickness = 3.dp
    /** How far from a side or corner a finger still takes it. */
    val handleReach = 24.dp
    /** `CropAreaView`'s least frame, either way. */
    val minFrame = 64.dp
    /** The frame's room inside its area. */
    val cropInset = 16.dp

    /** `CropRotationWheel`: 64 tall, its buttons 70 wide. */
    val wheelHeight = 64.dp
    val wheelButtonWidth = 70.dp

    /** The editor's foot: ✕, ✓. */
    val barHeight = 56.dp

    /** A resized frame waits this long before it grows back to fill the area. */
    const val SETTLE_DELAY_MS = 800L
    const val SETTLE_MS = 300
    val easing = CubicBezierEasing(0.25f, 0.1f, 0.25f, 1f)

    /** `ColorPickerBottomSheet`'s ground. */
    const val SHEET = 0xff252525.toInt()

    /** The draw screen's size wedge (`PaintWeightChooserView`), on the left. */
    val wedgeWidth = 30.dp
    val wedgeHeight = 240.dp

    /** The tools under the photo: 44 apart, the chosen one 12 up. */
    val toolSpacing = 44.dp
    val toolRise = 12.dp

    /** The eyedropper's loupe, its ring the colour under it. */
    val loupe = 120.dp
    const val LOUPE_ZOOM = 6f
}

object PhotoEditTags {
    const val EDITOR = "photoedit.editor"
    const val CROP = "photoedit.crop"
    const val CROP_AREA = "photoedit.crop.area"
    const val CROP_WHEEL = "photoedit.crop.wheel"
    const val CROP_MIRROR = "photoedit.crop.mirror"
    const val CROP_ASPECT = "photoedit.crop.aspect"
    const val CROP_ASPECTS = "photoedit.crop.aspects"
    const val CROP_ROTATE = "photoedit.crop.rotate"
    const val CROP_RESET = "photoedit.crop.reset"
    const val DRAW = "photoedit.draw"
    const val DRAW_AREA = "photoedit.draw.area"
    const val UNDO = "photoedit.draw.undo"
    const val CLEAR = "photoedit.draw.clear"
    const val SIZE = "photoedit.draw.size"
    const val TOOL = "photoedit.draw.tool."
    const val SWATCH = "photoedit.draw.swatch"
    const val COLOR = "photoedit.draw.color"
    const val COLOR_SHEET = "photoedit.colors"
    const val COLOR_GRID = "photoedit.colors.grid"
    const val COLOR_SPECTRUM = "photoedit.colors.spectrum"
    const val COLOR_OPACITY = "photoedit.colors.opacity"
    const val COLOR_TAB = "photoedit.colors.tab."
    const val EYEDROPPER = "photoedit.colors.eyedropper"
    const val COLOR_DONE = "photoedit.colors.done"
    const val PIPETTE = "photoedit.pipette"
    const val CANCEL = "photoedit.cancel"
    const val DONE = "photoedit.done"
}

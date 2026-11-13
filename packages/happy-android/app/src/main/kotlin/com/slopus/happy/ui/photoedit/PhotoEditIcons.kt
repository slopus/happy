package com.slopus.happy.ui.photoedit

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** The editor's glyphs: Google's Material Icons (Apache 2.0), as `MaterialSymbols` draws them. */
internal object PhotoEditIcons {
    val Crop: ImageVector by lazy { icon("Crop", "M17,15h2V7c0,-1.1 -0.9,-2 -2,-2H9v2h8v8zM7,17V1H5v4H1v2h4v10c0,1.1 0.9,2 2,2h10v4h2v-4h4v-2H7z") }
    val Draw: ImageVector by lazy {
        icon("Draw", "M7,14c-1.66,0 -3,1.34 -3,3 0,1.31 -1.16,2 -2,2 0.92,1.22 2.49,2 4,2 2.21,0 4,-1.79 4,-4 0,-1.66 -1.34,-3 -3,-3zM20.71,4.63l-1.34,-1.34c-0.39,-0.39 -1.02,-0.39 -1.41,0L9,12.25 11.75,15l8.96,-8.96c0.39,-0.39 0.39,-1.02 0,-1.41z")
    }
    val Undo: ImageVector by lazy {
        icon("Undo", "M12.5,8c-2.65,0 -5.05,0.99 -6.9,2.6L2,7v9h9l-3.62,-3.62c1.39,-1.16 3.16,-1.88 5.12,-1.88 3.54,0 6.55,2.31 7.6,5.5l2.37,-0.78C21.08,11.03 17.15,8 12.5,8z")
    }
    val RotateLeft: ImageVector by lazy {
        icon("RotateLeft", "M7.11,8.53L5.7,7.11C4.8,8.27 4.24,9.61 4.07,11h2.02c0.14,-0.87 0.49,-1.72 1.02,-2.47zM6.09,13H4.07c0.17,1.39 0.72,2.73 1.62,3.89l1.41,-1.42c-0.52,-0.75 -0.87,-1.59 -1.01,-2.47zM7.1,18.32c1.16,0.9 2.51,1.44 3.9,1.61V17.9c-0.87,-0.15 -1.71,-0.49 -2.46,-1.03L7.1,18.32zM13,4.07V1L8.45,5.55 13,10V6.09c2.84,0.48 5,2.94 5,5.91s-2.16,5.43 -5,5.91v2.02c3.95,-0.49 7,-3.85 7,-7.93s-3.05,-7.44 -7,-7.93z")
    }
    val Mirror: ImageVector by lazy {
        icon("Mirror", "M15,21h2v-2h-2v2zM19,9h2V7h-2v2zM3,5v14c0,1.1 0.9,2 2,2h4v-2H5V5h4V3H5c-1.1,0 -2,0.9 -2,2zM19,3v2h2c0,-1.1 -0.9,-2 -2,-2zM11,23h2V1h-2v22zM19,17h2v-2h-2v2zM15,5h2V3h-2v2zM19,13h2v-2h-2v2zM19,21c1.1,0 2,-0.9 2,-2h-2v2z")
    }
    val Aspect: ImageVector by lazy {
        icon("Aspect", "M19,12h-2v3h-3v2h5v-5zM7,9h3V7H5v5h2V9zM21,3H3c-1.1,0 -2,0.9 -2,2v14c0,1.1 0.9,2 2,2h18c1.1,0 2,-0.9 2,-2V5c0,-1.1 -0.9,-2 -2,-2zM21,19.01H3V4.99h18v14.02z")
    }
    val Eyedropper: ImageVector by lazy {
        icon("Eyedropper", "M20.71,5.63l-2.34,-2.34c-0.39,-0.39 -1.02,-0.39 -1.41,0l-3.12,3.12 -1.93,-1.91 -1.41,1.41 1.42,1.42L3,16.25V21h4.75l8.92,-8.92 1.42,1.42 1.41,-1.41 -1.92,-1.92 3.12,-3.12c0.4,-0.4 0.4,-1.03 0.01,-1.42zM6.92,19L5,17.08l8.06,-8.06 1.92,1.92L6.92,19z")
    }

    val Pen: ImageVector by lazy {
        icon("Pen", "M3,17.25V21h3.75L17.81,9.94l-3.75,-3.75L3,17.25zM20.71,7.04c0.39,-0.39 0.39,-1.02 0,-1.41l-2.34,-2.34c-0.39,-0.39 -1.02,-0.39 -1.41,0l-1.83,1.83 3.75,3.75 1.83,-1.83z")
    }
    val Arrow: ImageVector by lazy { icon("Arrow", "M9,5v2h6.59L4,18.59 5.41,20 17,8.41V15h2V5H9z") }
    val Marker: ImageVector by lazy {
        icon("Marker", "M16.81,8.94l-3.75,-3.75L4,14.25V18h3.75l9.06,-9.06zM6,16v-0.92l7.06,-7.06 0.92,0.92L6.92,16H6zM19.71,6.04c0.39,-0.39 0.39,-1.02 0,-1.41L17.37,2.29c-0.39,-0.39 -1.02,-0.39 -1.41,0l-1.83,1.83 3.75,3.75 1.83,-1.83zM2,20h20v4H2z")
    }
    val Neon: ImageVector by lazy {
        icon("Neon", "M19,9l1.25,-2.75L23,5l-2.75,-1.25L19,1l-1.25,2.75L15,5l2.75,1.25L19,9zM11.5,9.5L9,4L6.5,9.5L1,12l5.5,2.5L9,20l2.5,-5.5L17,12L11.5,9.5zM19,15l-1.25,2.75L15,19l2.75,1.25L19,23l1.25,-2.75L23,19l-2.75,-1.25L19,15z")
    }
    val Blur: ImageVector by lazy { icon("Blur", "M5,6a1,1 0,1 0,2,0a1,1 0,1 0,-2,0zM8.5,6a1.5,1.5 0,1 0,3.0,0a1.5,1.5 0,1 0,-3.0,0zM12.5,6a1.5,1.5 0,1 0,3.0,0a1.5,1.5 0,1 0,-3.0,0zM17,6a1,1 0,1 0,2,0a1,1 0,1 0,-2,0zM4.5,10a1.5,1.5 0,1 0,3.0,0a1.5,1.5 0,1 0,-3.0,0zM8,10a2,2 0,1 0,4,0a2,2 0,1 0,-4,0zM12,10a2,2 0,1 0,4,0a2,2 0,1 0,-4,0zM16.5,10a1.5,1.5 0,1 0,3.0,0a1.5,1.5 0,1 0,-3.0,0zM4.5,14a1.5,1.5 0,1 0,3.0,0a1.5,1.5 0,1 0,-3.0,0zM8,14a2,2 0,1 0,4,0a2,2 0,1 0,-4,0zM12,14a2,2 0,1 0,4,0a2,2 0,1 0,-4,0zM16.5,14a1.5,1.5 0,1 0,3.0,0a1.5,1.5 0,1 0,-3.0,0zM5,18a1,1 0,1 0,2,0a1,1 0,1 0,-2,0zM8.5,18a1.5,1.5 0,1 0,3.0,0a1.5,1.5 0,1 0,-3.0,0zM12.5,18a1.5,1.5 0,1 0,3.0,0a1.5,1.5 0,1 0,-3.0,0zM17,18a1,1 0,1 0,2,0a1,1 0,1 0,-2,0zM2.5,10a0.5,0.5 0,1 0,1.0,0a0.5,0.5 0,1 0,-1.0,0zM2.5,14a0.5,0.5 0,1 0,1.0,0a0.5,0.5 0,1 0,-1.0,0zM20.5,10a0.5,0.5 0,1 0,1.0,0a0.5,0.5 0,1 0,-1.0,0zM20.5,14a0.5,0.5 0,1 0,1.0,0a0.5,0.5 0,1 0,-1.0,0zM9.5,3a0.5,0.5 0,1 0,1.0,0a0.5,0.5 0,1 0,-1.0,0zM13.5,3a0.5,0.5 0,1 0,1.0,0a0.5,0.5 0,1 0,-1.0,0zM9.5,21a0.5,0.5 0,1 0,1.0,0a0.5,0.5 0,1 0,-1.0,0zM13.5,21a0.5,0.5 0,1 0,1.0,0a0.5,0.5 0,1 0,-1.0,0z") }
    val Eraser: ImageVector by lazy {
        icon("Eraser", "M16.24,3.56l4.95,4.94c0.78,0.79 0.78,2.05 0,2.84L12,20.53c-1.56,1.56 -4.09,1.56 -5.66,0L2.81,17c-0.78,-0.79 -0.78,-2.05 0,-2.84l10.6,-10.6c0.79,-0.78 2.05,-0.78 2.83,0zM4.22,15.58l3.54,3.53c0.78,0.79 2.04,0.79 2.83,0l3.53,-3.53 -4.95,-4.95 -4.95,4.95z")
    }

    fun of(tool: PaintTool): ImageVector = when (tool) {
        PaintTool.Pen -> Pen
        PaintTool.Arrow -> Arrow
        PaintTool.Marker -> Marker
        PaintTool.Neon -> Neon
        PaintTool.Blur -> Blur
        PaintTool.Eraser -> Eraser
    }

    private fun icon(name: String, path: String): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).addPath(addPathNodes(path), fill = SolidColor(Color.Black)).build()
}

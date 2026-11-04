package com.slopus.happy.ui.documents

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The formatting bar's and the document menu's glyphs: Google's Material
 * Icons (Apache 2.0), the paths react-icons 5.7's `md` set ships (the same
 * set desktop depends on), in place of iOS's SF Symbols for [DocumentTool].
 * Kept here rather than in the shared `MaterialSymbols`, which only the
 * document screen would use them from.
 */
object DocumentSymbols {
    /** `textformat.size`. */
    val TextStyle: ImageVector by lazy { icon("TextFields", "M2.5 4v3h5v12h3V7h5V4zm19 5h-9v3h3v7h3v-7h3z") }
    val Bold: ImageVector by lazy {
        icon("FormatBold", "M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42M10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5")
    }
    val Italic: ImageVector by lazy { icon("FormatItalic", "M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z") }
    val Strike: ImageVector by lazy {
        icon("StrikethroughS", "M6.85 7.08C6.85 4.37 9.45 3 12.24 3c1.64 0 3 .49 3.9 1.28.77.65 1.46 1.73 1.46 3.24h-3.01c0-.31-.05-.59-.15-.85-.29-.86-1.2-1.28-2.25-1.28-1.86 0-2.34 1.02-2.34 1.7 0 .48.25.88.74 1.21.38.25.77.48 1.41.7H7.39c-.21-.34-.54-.89-.54-1.92M21 12v-2H3v2h9.62c1.15.45 1.96.75 1.96 1.97 0 1-.81 1.67-2.28 1.67-1.54 0-2.93-.54-2.93-2.51H6.4c0 .55.08 1.13.24 1.58.81 2.29 3.29 3.3 5.67 3.3 2.27 0 5.3-.89 5.3-4.05 0-.3-.01-1.16-.48-1.94H21z")
    }
    val Code: ImageVector by lazy { icon("Code", "M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6z") }
    val Link: ImageVector by lazy {
        icon("Link", "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1M8 13h8v-2H8zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5")
    }
    val Bullets: ImageVector by lazy {
        icon("FormatListBulleted", "M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5m0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5m0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5M7 19h14v-2H7zm0-6h14v-2H7zm0-8v2h14V5z", mirrored = true)
    }
    val Numbers: ImageVector by lazy {
        icon("FormatListNumbered", "M2 17h2v.5H3v1h1v.5H2v1h3v-4H2zm1-9h1V4H2v1h1zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2zm5-6v2h14V5zm0 14h14v-2H7zm0-6h14v-2H7z", mirrored = true)
    }
    val Checklist: ImageVector by lazy {
        icon("Checklist", "M22 7h-9v2h9zm0 8h-9v2h9zM5.54 11 2 7.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41zm0 8L2 15.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41z", mirrored = true)
    }
    val Quote: ImageVector by lazy { icon("FormatQuote", "M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z") }
    /** `curlybraces`. */
    val CodeBlock: ImageVector by lazy {
        icon("DataObject", "M4 7v2c0 .55-.45 1-1 1H2v4h1c.55 0 1 .45 1 1v2c0 1.65 1.35 3 3 3h3v-2H7c-.55 0-1-.45-1-1v-2c0-1.3-.84-2.42-2-2.83v-.34C5.16 11.42 6 10.3 6 9V7c0-.55.45-1 1-1h3V4H7C5.35 4 4 5.35 4 7M21 10c-.55 0-1-.45-1-1V7c0-1.65-1.35-3-3-3h-3v2h3c.55 0 1 .45 1 1v2c0 1.3.84 2.42 2 2.83v.34c-1.16.41-2 1.52-2 2.83v2c0 .55-.45 1-1 1h-3v2h3c1.65 0 3-1.35 3-3v-2c0-.55.45-1 1-1h1v-4z")
    }
    val Outdent: ImageVector by lazy { icon("FormatIndentDecrease", "M11 17h10v-2H11zm-8-5 4 4V8zm0 9h18v-2H3zM3 3v2h18V3zm8 6h10V7H11zm0 4h10v-2H11z", mirrored = true) }
    val Indent: ImageVector by lazy { icon("FormatIndentIncrease", "M3 21h18v-2H3zM3 8v8l4-4zm8 9h10v-2H11zM3 3v2h18V3zm8 6h10V7H11zm0 4h10v-2H11z", mirrored = true) }
    val Divider: ImageVector by lazy { icon("HorizontalRule", "M4 11h16v2H4z") }
    /** `keyboard.chevron.compact.down`. */
    val HideKeyboard: ImageVector by lazy {
        icon("KeyboardHide", "M20 3H4c-1.1 0-1.99.9-1.99 2L2 15c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m-9 3h2v2h-2zm0 3h2v2h-2zM8 6h2v2H8zm0 3h2v2H8zm-1 2H5V9h2zm0-3H5V6h2zm9 7H8v-2h8zm0-4h-2V9h2zm0-3h-2V6h2zm3 3h-2V9h2zm0-3h-2V6h2zm-7 15 4-4H8z")
    }

    private fun icon(name: String, path: String, mirrored: Boolean = false): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f, autoMirror = mirrored)
            .addPath(addPathNodes(path), fill = SolidColor(Color.Black))
            .build()
}

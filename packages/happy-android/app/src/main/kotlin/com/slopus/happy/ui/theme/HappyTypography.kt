package com.slopus.happy.ui.theme

import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp

// The system's own faces, as an Android app reads: the system sans for text
// and the system monospace for code and keys (Typography.ts's IBM Plex is
// happy-app's). The logotype is artwork and keeps its own lettering.

val AppSans: FontFamily = FontFamily.Default

val AppMono: FontFamily = FontFamily.Monospace

/**
 * React Native on Android gives every line exactly `lineHeight`, with the
 * glyphs centred in it. Compose's default trims the extra space above the
 * first and below the last line, so it is switched off for every style here;
 * otherwise a 16/24 single line would measure shorter than 24.
 */
val RnLineHeightStyle = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None,
)

/**
 * When the line height is less than the font's own (16/20, 28/34), Compose
 * grows the first and last lines so no glyph overflows; RN keeps the box at
 * exactly lines x lineHeight and lets glyphs overflow. Tight + trim matches RN.
 */
private val RnTightLineHeightStyle = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.Both,
    mode = LineHeightStyle.Mode.Tight,
)

/** Roboto's (ascender 1900 + descender 500) / 2048 units per em: below it a line height is tight. */
private const val FONT_LINE_HEIGHT_RATIO = 1.17f

/**
 * A text style built the way the RN stylesheets declare them: family, size,
 * line height, tracking. Without a line height, RN Android lays text out
 * with the font's padding included, so that is kept too.
 */
fun happyTextStyle(
    fontSize: Int,
    lineHeight: Int? = null,
    letterSpacing: Float = 0f,
    weight: FontWeight = FontWeight.Normal,
    family: FontFamily = AppSans,
): TextStyle = TextStyle(
    fontFamily = family,
    fontWeight = weight,
    fontSize = fontSize.sp,
    lineHeight = lineHeight?.sp ?: TextUnit.Unspecified,
    letterSpacing = letterSpacing.sp,
    lineHeightStyle = if (lineHeight != null && lineHeight < fontSize * FONT_LINE_HEIGHT_RATIO) RnTightLineHeightStyle else RnLineHeightStyle,
    platformStyle = if (lineHeight == null) RnFontPadding else null,
)

private val RnFontPadding = PlatformTextStyle(includeFontPadding = true)

package com.slopus.happy.ui.theme

import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import com.slopus.happy.R

// Ported from packages/happy-app/sources/constants/Typography.ts:
// IBM Plex Sans for text, IBM Plex Mono for code and keys.

val PlexSans = FontFamily(
    Font(R.font.ibm_plex_sans_regular, FontWeight.Normal),
    Font(R.font.ibm_plex_sans_italic, FontWeight.Normal, FontStyle.Italic),
    Font(R.font.ibm_plex_sans_semibold, FontWeight.SemiBold),
)

val PlexMono = FontFamily(
    Font(R.font.ibm_plex_mono_regular, FontWeight.Normal),
    Font(R.font.ibm_plex_mono_semibold, FontWeight.SemiBold),
)

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

/** (ascender 1025 + descender 275) / 1000 units per em, in every IBM Plex face bundled here. */
private const val PLEX_LINE_HEIGHT_RATIO = 1.3f

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
    family: FontFamily = PlexSans,
): TextStyle = TextStyle(
    fontFamily = family,
    fontWeight = weight,
    fontSize = fontSize.sp,
    lineHeight = lineHeight?.sp ?: TextUnit.Unspecified,
    letterSpacing = letterSpacing.sp,
    lineHeightStyle = if (lineHeight != null && lineHeight < fontSize * PLEX_LINE_HEIGHT_RATIO) RnTightLineHeightStyle else RnLineHeightStyle,
    platformStyle = if (lineHeight == null) RnFontPadding else null,
)

private val RnFontPadding = PlatformTextStyle(includeFontPadding = true)

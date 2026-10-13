package com.slopus.happy.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import kotlin.math.roundToInt

// Ported from packages/happy-app/sources/theme.ts. Where theme.ts uses
// Platform.select, the Android (`default`) branch is taken. Groups that only
// the chat UI uses (diff, syntax, terminal, message bubbles) are ported with
// that UI.

/** rgba() as React Native resolves it: alpha rounded to the nearest 1/255. */
internal fun rgba(red: Int, green: Int, blue: Int, alpha: Float): Color =
    Color(red, green, blue, (alpha * 255).roundToInt())

@Immutable
data class GroupedColors(val background: Color, val chevron: Color, val sectionTitle: Color)

@Immutable
data class HeaderColors(val background: Color, val tint: Color)

@Immutable
data class SwitchColors(
    val trackActive: Color,
    val trackInactive: Color,
    val thumbActive: Color,
    val thumbInactive: Color,
)

@Immutable
data class ButtonColors(
    val primaryBackground: Color,
    val primaryTint: Color,
    val primaryDisabled: Color,
    val secondaryTint: Color,
)

@Immutable
data class InputColors(val background: Color, val text: Color, val placeholder: Color)

@Immutable
data class BoxColors(val background: Color, val border: Color, val text: Color)

@Immutable
data class StatusColors(
    val connected: Color,
    val connecting: Color,
    val disconnected: Color,
    val error: Color,
    val default: Color,
)

@Immutable
data class GlassColors(
    val background: Color,
    val backgroundStrong: Color,
    val backgroundSubtle: Color,
    val divider: Color,
)

@Immutable
data class HappyColors(
    val dark: Boolean,
    val text: Color,
    val textDestructive: Color,
    val textSecondary: Color,
    val textLink: Color,
    val deleteAction: Color,
    val warningCritical: Color,
    val warning: Color,
    val success: Color,
    val surface: Color,
    val surfaceRipple: Color,
    val surfacePressed: Color,
    val surfaceSelected: Color,
    val surfacePressedOverlay: Color,
    val surfaceHigh: Color,
    val surfaceHighest: Color,
    val divider: Color,
    val glass: GlassColors,
    val grouped: GroupedColors,
    val header: HeaderColors,
    val switch: SwitchColors,
    val button: ButtonColors,
    val input: InputColors,
    val boxWarning: BoxColors,
    val boxError: BoxColors,
    val status: StatusColors,
)

val LightColors = HappyColors(
    dark = false,
    text = Color(0xFF000000),
    textDestructive = Color(0xFFF44336),
    textSecondary = Color(0xFF49454F),
    textLink = Color(0xFF2BACCC),
    deleteAction = Color(0xFFFF6B6B),
    warningCritical = Color(0xFFFF3B30),
    warning = Color(0xFF8E8E93),
    success = Color(0xFF34C759),
    surface = Color(0xFFFFFFFF),
    surfaceRipple = rgba(0, 0, 0, 0.08f),
    surfacePressed = Color(0xFFF0F0F2),
    surfaceSelected = Color(0xFFEAEAEA),
    surfacePressedOverlay = Color.Transparent,
    surfaceHigh = Color(0xFFF8F8F8),
    surfaceHighest = Color(0xFFF0F0F0),
    divider = Color(0xFFEAEAEA),
    glass = GlassColors(
        background = rgba(255, 255, 255, 0.68f),
        backgroundStrong = rgba(255, 255, 255, 0.84f),
        backgroundSubtle = rgba(255, 255, 255, 0.42f),
        divider = rgba(60, 60, 67, 0.12f),
    ),
    grouped = GroupedColors(
        background = Color(0xFFF5F5F5),
        chevron = Color(0xFF49454F),
        sectionTitle = Color(0xFF49454F),
    ),
    header = HeaderColors(background = Color(0xFFFFFFFF), tint = Color(0xFF18171C)),
    switch = SwitchColors(
        trackActive = Color(0xFF1976D2),
        trackInactive = Color(0xFFDDDDDD),
        thumbActive = Color(0xFFFFFFFF),
        thumbInactive = Color(0xFF767577),
    ),
    button = ButtonColors(
        primaryBackground = Color(0xFF000000),
        primaryTint = Color(0xFFFFFFFF),
        primaryDisabled = Color(0xFFC0C0C0),
        secondaryTint = Color(0xFF666666),
    ),
    input = InputColors(background = Color(0xFFF5F5F5), text = Color(0xFF000000), placeholder = Color(0xFF999999)),
    boxWarning = BoxColors(background = Color(0xFFFFF8F0), border = Color(0xFFFF9500), text = Color(0xFFFF9500)),
    boxError = BoxColors(background = Color(0xFFFFF0F0), border = Color(0xFFFF3B30), text = Color(0xFFFF3B30)),
    status = StatusColors(
        connected = Color(0xFF34C759),
        connecting = Color(0xFF007AFF),
        disconnected = Color(0xFF999999),
        error = Color(0xFFFF3B30),
        default = Color(0xFF8E8E93),
    ),
)

val DarkColors = HappyColors(
    dark = true,
    text = Color(0xFFFFFFFF),
    textDestructive = Color(0xFFF48FB1),
    textSecondary = Color(0xFFCAC4D0),
    textLink = Color(0xFF2BACCC),
    deleteAction = Color(0xFFFF6B6B),
    warningCritical = Color(0xFFFF453A),
    warning = Color(0xFF8E8E93),
    success = Color(0xFF32D74B),
    surface = Color(0xFF161616),
    surfaceRipple = rgba(255, 255, 255, 0.07f),
    surfacePressed = Color(0xFF242424),
    surfaceSelected = Color(0xFF242424),
    surfacePressedOverlay = Color(0xFF242424),
    surfaceHigh = Color(0xFF1E1E1E),
    surfaceHighest = Color(0xFF282828),
    divider = Color(0xFF2A2A2A),
    glass = GlassColors(
        background = rgba(22, 22, 22, 0.44f),
        backgroundStrong = rgba(28, 28, 28, 0.68f),
        backgroundSubtle = rgba(255, 255, 255, 0.07f),
        divider = rgba(255, 255, 255, 0.08f),
    ),
    grouped = GroupedColors(
        background = Color(0xFF000000),
        chevron = Color(0xFFCAC4D0),
        sectionTitle = Color(0xFFCAC4D0),
    ),
    header = HeaderColors(background = Color(0xFF000000), tint = Color(0xFFFFFFFF)),
    switch = SwitchColors(
        trackActive = Color(0xFF1976D2),
        trackInactive = Color(0xFF363636),
        thumbActive = Color(0xFFFFFFFF),
        thumbInactive = Color(0xFF767577),
    ),
    button = ButtonColors(
        primaryBackground = Color(0xFF000000),
        primaryTint = Color(0xFFFFFFFF),
        primaryDisabled = Color(0xFFC0C0C0),
        secondaryTint = Color(0xFF8E8E93),
    ),
    input = InputColors(background = Color(0xFF1E1E1E), text = Color(0xFFFFFFFF), placeholder = Color(0xFF8E8E93)),
    boxWarning = BoxColors(background = rgba(255, 159, 10, 0.15f), border = Color(0xFFFF9F0A), text = Color(0xFFFFAB00)),
    boxError = BoxColors(background = rgba(255, 69, 58, 0.15f), border = Color(0xFFFF453A), text = Color(0xFFFF6B6B)),
    status = StatusColors(
        connected = Color(0xFF34C759),
        connecting = Color(0xFFFFFFFF),
        disconnected = Color(0xFF8E8E93),
        error = Color(0xFFFF453A),
        default = Color(0xFF8E8E93),
    ),
)

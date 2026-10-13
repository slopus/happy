package com.slopus.happy.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Spacing, radius and icon scales shared by both themes (theme.ts `sharedSpacing`). */
@Immutable
object HappySpacing {
    val xs: Dp = 4.dp
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 16.dp
    val xl: Dp = 20.dp
    val xxl: Dp = 24.dp
}

@Immutable
object HappyRadius {
    val sm: Dp = 4.dp
    val md: Dp = 8.dp
    val lg: Dp = 10.dp
    val xl: Dp = 12.dp
    val xxl: Dp = 16.dp
}

@Immutable
object HappyIconSize {
    val small: Dp = 12.dp
    val medium: Dp = 16.dp
    val large: Dp = 20.dp
    val xlarge: Dp = 24.dp
}

/** localSettings.themePreference */
enum class ThemePreference { Adaptive, Light, Dark }

private val LocalHappyColors = staticCompositionLocalOf { LightColors }

object HappyTheme {
    val colors: HappyColors
        @Composable @ReadOnlyComposable get() = LocalHappyColors.current
}

/**
 * Happy's tokens are the source of truth; the Material 3 scheme is derived
 * from them only so stock Material components (dialogs, text fields) do not
 * pull in Material's default purple.
 */
@Composable
fun HappyTheme(
    preference: ThemePreference = ThemePreference.Adaptive,
    content: @Composable () -> Unit,
) {
    val dark = when (preference) {
        ThemePreference.Adaptive -> isSystemInDarkTheme()
        ThemePreference.Light -> false
        ThemePreference.Dark -> true
    }
    val colors = if (dark) DarkColors else LightColors
    val scheme = if (dark) {
        darkColorScheme(
            primary = colors.text,
            onPrimary = colors.grouped.background,
            background = colors.grouped.background,
            onBackground = colors.text,
            surface = colors.surface,
            onSurface = colors.text,
            onSurfaceVariant = colors.textSecondary,
            surfaceContainerHigh = colors.surfaceHigh,
            surfaceContainerHighest = colors.surfaceHighest,
            outlineVariant = colors.divider,
            error = colors.textDestructive,
        )
    } else {
        lightColorScheme(
            primary = colors.text,
            onPrimary = colors.grouped.background,
            background = colors.grouped.background,
            onBackground = colors.text,
            surface = colors.surface,
            onSurface = colors.text,
            onSurfaceVariant = colors.textSecondary,
            surfaceContainerHigh = colors.surfaceHigh,
            surfaceContainerHighest = colors.surfaceHighest,
            outlineVariant = colors.divider,
            error = colors.textDestructive,
        )
    }
    CompositionLocalProvider(LocalHappyColors provides colors) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

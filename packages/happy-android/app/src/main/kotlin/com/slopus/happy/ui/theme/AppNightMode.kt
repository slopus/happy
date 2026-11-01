package com.slopus.happy.ui.theme

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.view.ContextThemeWrapper
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.graphics.toArgb
import com.slopus.happy.R

/**
 * The platform's side of the app's theme (happy-app's
 * Appearance.setColorScheme). Compose follows [ThemePreference] by itself,
 * but whatever the platform draws follows the configuration's night mode:
 * the system's splash, the window's background (`res/values-night`), Dialog
 * and Popup windows' own chrome (the text selection toolbar, handles), and
 * a WebView's `prefers-color-scheme`. With the app dark on a light phone all
 * of those were light, and flashed white before Compose drew over them.
 *
 * On API 31+ [apply] makes the app's configuration the setting's
 * ([UiModeManager.setApplicationNightMode]). The system keeps it for the
 * package, so the next cold start's splash and window are right before any
 * of our code runs, and the change reaches the running activity as a
 * configuration change (MainActivity handles uiMode itself). On every API
 * MainActivity also paints its window in the theme's [windowBackground] and
 * WebViews take [withNightMode]'s context, which covers older Android (no
 * such call; its splash and platform chrome stay the system's) and the
 * moment before a change lands.
 */
object AppNightMode {
    /** [UiModeManager]'s mode for [preference]: Adaptive follows the system. */
    fun mode(preference: ThemePreference): Int = when (preference) {
        ThemePreference.Adaptive -> UiModeManager.MODE_NIGHT_AUTO
        ThemePreference.Light -> UiModeManager.MODE_NIGHT_NO
        ThemePreference.Dark -> UiModeManager.MODE_NIGHT_YES
    }

    /**
     * Sets the package's night mode to [preference]'s. A binder call: call it
     * off the main thread. The system does nothing when the mode is already
     * set, so calling it on every start costs no configuration change.
     */
    fun apply(context: Context, preference: ThemePreference) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        context.getSystemService(UiModeManager::class.java)?.setApplicationNightMode(mode(preference))
    }

    /** The window's colour under everything: theme.ts's grouped background, as `@color/window_background`. */
    fun windowBackground(dark: Boolean): Int = (if (dark) DarkColors else LightColors).grouped.background.toArgb()
}

/**
 * The window's colour and the system bar icons for the app's theme, which
 * can differ from the system's. The window shows wherever Compose hasn't
 * drawn: a frame before the content, a resize, the keyboard's gap.
 */
fun ComponentActivity.paintWindow(dark: Boolean) {
    window.setBackgroundDrawable(ColorDrawable(AppNightMode.windowBackground(dark)))
    val style = if (dark) {
        SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
    } else {
        SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
    }
    enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
}

/** Whether this context's configuration is in night mode. */
val Context.isNight: Boolean
    get() = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

/**
 * This context with the app's night mode, [dark], for a view the platform
 * themes itself: a WebView takes `prefers-color-scheme` from its theme's
 * `isLightTheme` (target 33+). The same context when the configuration
 * already agrees, as it does on API 31+ once [AppNightMode.apply] has run.
 */
fun Context.withNightMode(dark: Boolean): Context {
    if (isNight == dark) return this
    val night = if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
    val override = Configuration(resources.configuration).apply {
        uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or night
    }
    return ContextThemeWrapper(this, R.style.Theme_Happy).apply { applyOverrideConfiguration(override) }
}

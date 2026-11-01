package com.slopus.happy.ui.theme

import android.app.UiModeManager
import android.content.Context
import android.graphics.drawable.ColorDrawable
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.core.graphics.ColorUtils
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.LocalMermaidWebView
import com.slopus.happy.ui.components.MermaidView
import com.slopus.happy.ui.components.themedWebView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The app's theme, not the system's, for everything the platform draws:
 * with the app dark on a light phone (and light on a dark one) the window,
 * the platform's night mode, dialog windows and WebViews all follow the
 * app. Before AppNightMode the window and WebViews were the system's, and
 * flashed white under a dark app.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AppNightModeTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun aDarkAppOnALightPhoneIsDarkEverywhere() {
        assertEquals(false, rule.activity.isNight)
        everywhere(ThemePreference.Dark, dark = true)
    }

    @Test
    @Config(qualifiers = "+night")
    fun aLightAppOnADarkPhoneIsLightEverywhere() {
        assertEquals(true, rule.activity.isNight)
        everywhere(ThemePreference.Light, dark = false)
    }

    @Test
    fun adaptiveLeavesThePlatformToTheSystem() {
        AppNightMode.apply(context, ThemePreference.Dark)
        AppNightMode.apply(context, ThemePreference.Adaptive)
        assertEquals(UiModeManager.MODE_NIGHT_AUTO, shadowOf(context.getSystemService(UiModeManager::class.java)).applicationNightMode)
    }

    @Test
    fun aContextThatAgreesIsLeftAlone() {
        assertTrue(rule.activity.withNightMode(dark = false) === rule.activity)
    }

    private fun everywhere(preference: ThemePreference, dark: Boolean) {
        val expected = if (dark) DarkColors else LightColors

        // The platform's night mode is the setting's, kept by the system for the next start's splash.
        AppNightMode.apply(context, preference)
        val modes = shadowOf(context.getSystemService(UiModeManager::class.java))
        assertEquals(if (dark) UiModeManager.MODE_NIGHT_YES else UiModeManager.MODE_NIGHT_NO, modes.applicationNightMode)

        // HappyApp reports its theme, and the window takes its colour, before the first frame is drawn.
        val graph = AppGraph(context, "android/test", "http://127.0.0.1:9", SoftwareKeys(), databaseName = null)
        graph.localSettings.setThemePreference(preference)
        val activity = rule.activity
        val reported = mutableListOf<Boolean>()
        var root: View? = null
        rule.setContent {
            HappyApp(graph, onDarkThemeChange = { reported += it; activity.paintWindow(it) })
            HappyTheme(preference) {
                CompositionLocalProvider(LocalMermaidWebView provides true) {
                    root = LocalView.current
                    MermaidView("graph TD\n  A-->B", Modifier.fillMaxWidth()) {}
                }
                HappyAlert(Alert("Title", "Message", listOf(AlertButton("OK"))), onDismiss = {})
            }
        }
        rule.waitForIdle()
        assertEquals(listOf(dark), reported.distinct())
        val window = activity.window.decorView.background as ColorDrawable
        assertEquals(expected.grouped.background.toArgb(), window.color)

        // A dialog's window draws nothing of its own; what shows is its content, in the theme.
        val dialog = rule.onNode(isDialog())
        dialog.assertExists()
        val shot = dialog.captureToImage().asAndroidBitmap()
        val centre = shot.getPixel(shot.width / 2, shot.height / 2)
        val luminance = ColorUtils.calculateLuminance(centre)
        assertTrue("dialog is ${if (dark) "dark" else "light"} (luminance $luminance)", if (dark) luminance < 0.2 else luminance > 0.6)

        // WebViews: the theme's colour until their page paints, and the app's night mode for prefers-color-scheme.
        val web = findWebView(root!!.rootView)
        assertNotNull("a WebView", web)
        assertEquals(expected.surfaceHighest.toArgb(), shadowOf(web!!).backgroundColor)
        assertEquals(dark, web.context.isNight)
        assertEquals(!dark, web.context.isLightTheme())

        val browser = themedWebView(activity, expected.surface, dark)
        assertEquals(expected.surface.toArgb(), shadowOf(browser).backgroundColor)
        assertEquals(!dark, browser.context.isLightTheme())
        browser.destroy()
    }

    private fun Context.isLightTheme(): Boolean {
        val values = theme.obtainStyledAttributes(intArrayOf(android.R.attr.isLightTheme))
        return try {
            values.getBoolean(0, true)
        } finally {
            values.recycle()
        }
    }

    private fun findWebView(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
        else -> null
    }
}

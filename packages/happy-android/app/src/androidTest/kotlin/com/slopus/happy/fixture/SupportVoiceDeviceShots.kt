package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.core.view.WindowCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.call.CallAllowance
import com.slopus.happy.ui.connection.AgentConnectionSettingsScreen
import com.slopus.happy.ui.connection.AgentPerson
import com.slopus.happy.ui.connection.AgentSettingsActions
import com.slopus.happy.ui.connection.AgentSettingsTags
import com.slopus.happy.ui.connection.AgentVoiceScreen
import com.slopus.happy.ui.connection.AgentVoiceSummary
import com.slopus.happy.ui.connection.AgentVoiceTags
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.settings.AboutInfo
import com.slopus.happy.ui.settings.SettingsProfile
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * An agent connection's Settings on a device: Support Happy under Profile
 * (the boba playing), the Voice row and the Voice page, light and dark, at
 * a narrow width and the largest font scale. Every row is synthetic; the
 * free time is a fixture, never this phone's. A narrow width and large
 * font come from the device's own settings ([settingsUnderProfile]). Shots
 * go to the app's external files under `support-voice/`; `hold` keeps
 * Support Happy's sheet up for a screen recording of the boba. Run on an
 * assigned emulator.
 */
@RunWith(AndroidJUnit4::class)
class SupportVoiceDeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val dir = File(app.getExternalFilesDir(null), "support-voice").apply { mkdirs() }

    private val some = AgentVoiceSummary(12 * 60_000L + 20_000L)

    private fun show(dark: Boolean, content: @Composable () -> Unit) {
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            WindowCompat.getInsetsController(rule.activity.window, rule.activity.window.decorView).isAppearanceLightStatusBars = !dark
        }
        rule.setContent { HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) { content() } }
        rule.waitForIdle()
    }

    private fun capture(name: String, wait: Long = 2_600) {
        SystemClock.sleep(wait)
        device.takeScreenshot(File(dir, "$name.png"))
    }

    @Composable
    private fun settings(voice: AgentVoiceSummary = some) {
        AgentConnectionSettingsScreen(
            SettingsProfile("agent-connection-1", "Studio Mac", "Happy Agent · Connected"),
            AccountMenu(listOf(AccountMenuEntry("agent-connection-1", "Studio Mac", agent = true, active = true))),
            AgentSettingsActions(onDataStorage = {}),
            AboutInfo("1.8.0 (412)"),
            person = AgentPerson("Alex Rivera"),
            voice = voice,
        )
    }

    @Test fun settingsLight() { show(false) { settings() }; capture("settings-light") }
    @Test fun settingsDark() { show(true) { settings() }; capture("settings-dark") }

    /**
     * Under Profile, at whatever display size and font scale the device is
     * set to (`adb shell wm density`, `settings put system font_scale`),
     * named with `-e suffix`.
     */
    @Test fun settingsUnderProfile() {
        val suffix = InstrumentationRegistry.getArguments().getString("suffix") ?: return
        show(false) { settings() }
        rule.onNodeWithTag(AgentSettingsTags.PROFILE).performScrollTo()
        rule.onNodeWithTag(AgentVoiceTags.SUPPORT).performScrollTo()
        capture("settings-$suffix-light")
    }

    /** The row's tap: Support Happy's sheet, the boba playing; `-e hold true` keeps it up for a recording. */
    private fun supportSheet(dark: Boolean) {
        show(dark) { settings() }
        rule.onNodeWithTag(AgentVoiceTags.SUPPORT).performScrollTo().performClick()
        rule.waitForIdle()
        rule.onNodeWithTag(AgentVoiceTags.SHEET).assertExists()
        capture("support-sheet-${if (dark) "dark" else "light"}", 1_500)
        if (InstrumentationRegistry.getArguments().getString("hold") == "true") SystemClock.sleep(6_000)
    }

    @Test fun supportSheetLight() = supportSheet(false)
    @Test fun supportSheetDark() = supportSheet(true)

    @Test fun voicePageLight() { show(false) { AgentVoiceScreen(some) {} }; capture("voice-page-light", 800) }
    @Test fun voicePageDark() { show(true) { AgentVoiceScreen(some) {} }; capture("voice-page-dark", 800) }
    @Test fun voicePageUsed() {
        show(false) { AgentVoiceScreen(AgentVoiceSummary(0, System.currentTimeMillis() + 5 * 86_400_000L)) {} }
        capture("voice-page-used-light", 800)
    }
    @Test fun voicePageFresh() { show(false) { AgentVoiceScreen(AgentVoiceSummary(CallAllowance.FREE_MILLIS)) {} }; capture("voice-page-fresh-light", 800) }
}

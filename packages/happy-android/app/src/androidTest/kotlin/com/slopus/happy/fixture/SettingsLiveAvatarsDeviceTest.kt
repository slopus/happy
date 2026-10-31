package com.slopus.happy.fixture

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.slopus.happy.ui.components.avatar.LocalAnimatedAvatars
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuButton
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.settings.AccountsCard
import com.slopus.happy.ui.settings.AccountsCardActions
import com.slopus.happy.ui.settings.SettingsHeader
import com.slopus.happy.ui.settings.SettingsProfile
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs

/**
 * happy-ios 00b47cb84 on a device's GPU: with Animated Avatars on, Settings'
 * picture, its accounts card and the account menu's button move for accounts
 * without a picture of their own, light and dark. Captured to the test
 * app's files under `device-evidence/`. Every account is synthetic.
 */
@RunWith(AndroidJUnit4::class)
class SettingsLiveAvatarsDeviceTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext
    private val evidence = File(app.filesDir, "device-evidence").apply { mkdirs() }
    private val density get() = app.resources.displayMetrics.density

    private fun screenshot(name: String): Bitmap {
        rule.waitForIdle()
        val shot = instrumentation.uiAutomation.takeScreenshot()
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return shot
    }

    /** The mean channel difference between two shots over rows [top] to [bottom]. */
    private fun difference(a: Bitmap, b: Bitmap, top: Int, bottom: Int): Double {
        var sum = 0L
        var count = 0
        for (y in top until bottom step 2) for (x in 0 until a.width step 2) {
            val p = a.getPixel(x, y)
            val q = b.getPixel(x, y)
            sum += abs((p shr 16 and 0xFF) - (q shr 16 and 0xFF)) + abs((p shr 8 and 0xFF) - (q shr 8 and 0xFF)) + abs((p and 0xFF) - (q and 0xFF))
            count += 3
        }
        return sum.toDouble() / count
    }

    @Test fun light() = moves(dark = false, "settings-live-light")

    @Test fun dark() = moves(dark = true, "settings-live-dark")

    private fun moves(dark: Boolean, name: String) {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        val accounts = AccountMenu(
            listOf(
                AccountMenuEntry("fx-me", "Steve", active = true),
                AccountMenuEntry("fx-agent", "Studio", agent = true, seed = "agent:10.0.0.2"),
            ),
        )
        rule.setContent {
            CompositionLocalProvider(LocalAnimatedAvatars provides true) {
                HappyTheme(preference = if (dark) ThemePreference.Dark else ThemePreference.Light) {
                    Column(Modifier.fillMaxSize().background(HappyTheme.colors.grouped.background).windowInsetsPadding(WindowInsets.statusBars)) {
                        AccountMenuButton(accounts, onSwitch = {}, onAdd = {})
                        SettingsHeader(SettingsProfile("fx-me", "Steve", "Happy account"))
                        AccountsCard(accounts, AccountsCardActions(onSwitch = {}, onAdd = {}))
                    }
                }
            }
        }
        SystemClock.sleep(600)
        val first = screenshot(name)
        SystemClock.sleep(1500)
        val later = screenshot("$name-later")
        val moved = difference(first, later, 0, (400 * density).toInt().coerceAtMost(first.height))
        println("$name: moved by $moved/255 a channel over 1.5 s")
        assertTrue("Settings' avatars don't move ($moved)", moved > 0.3)
    }
}

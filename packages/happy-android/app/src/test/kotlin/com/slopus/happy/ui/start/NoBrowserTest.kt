package com.slopus.happy.ui.start

import android.app.Application
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.ProvideLinks
import com.slopus.happy.ui.node
import com.slopus.happy.ui.onboarding.DESKTOP_URL
import com.slopus.happy.ui.onboarding.GetHelpAlert
import com.slopus.happy.ui.setHappyContent
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A phone with nothing that opens a web page (no browser, or it is
 * disabled): the first screens' links do nothing rather than end the app.
 * Compose's own handler throws IllegalArgumentException("Can't open …")
 * there, which on 2026.11.1 killed the app from InstallDesktop's site link
 * and the Get help alert (reproduced on an Android 13 emulator with Chrome
 * disabled).
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NoBrowserTest {
    @get:Rule
    val rule = createComposeRule()

    @Before
    fun noBrowser() {
        // Robolectric resolves no activity for a web link; with this, starting one throws as a phone does.
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).checkActivities(true)
    }

    @Test
    fun installDesktopsSiteLinkWithNoBrowserIsNotACrash() {
        rule.setHappyContent {
            // As HappyApp with no account open: the legacy opener over the system's handler.
            val context = LocalContext.current
            val system = LocalUriHandler.current
            ProvideLinks(remember { LinkOpener.legacy(context, system) }) {
                val uriHandler = LocalUriHandler.current
                InstallDesktopScreen(
                    scanning = false,
                    customServerLabel = null,
                    onBack = {},
                    onScan = {},
                    onOpenSite = { uriHandler.openUri(DESKTOP_URL) },
                    onEnterLink = {},
                    onRestore = {},
                    onServer = {},
                )
            }
        }
        rule.node(InstallDesktopTags.SITE).performClick()
        rule.waitForIdle()
    }

    @Test
    fun getHelpWithNoBrowserIsNotACrash() {
        // The scanner shows it outside ProvideLinks, over the system's handler itself.
        rule.setHappyContent { GetHelpAlert(onDismiss = {}) }
        rule.onNodeWithText("Ask on Discord").performClick()
        rule.waitForIdle()
    }
}

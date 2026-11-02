package com.slopus.happy.ui.start

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private const val PHONE_HEIGHT = 891

/** The screen after Start: the TV and its words, Scan QR code at the bottom, the site, and the first screen's ⋮ under the standard bar. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class InstallDesktopScreenTest {
    @get:Rule
    val rule = createComposeRule()

    private val taps = mutableListOf<String>()

    private fun show(dark: Boolean = false) {
        rule.setHappyContent(dark = dark) {
            InstallDesktopScreen(
                scanning = false,
                customServerLabel = null,
                onBack = { taps += "back" },
                onScan = { taps += "scan" },
                onOpenSite = { taps += "site" },
                onEnterLink = { taps += "link" },
                onRestore = { taps += "restore" },
                onServer = { taps += "server" },
            )
        }
    }

    @Test
    fun phoneLayout() {
        show()
        rule.node(HeaderTags.BAR).assertExists()
        rule.onNodeWithText("Open Happy on your computer").assertExists()
        rule.onNodeWithText("Choose Link\u00A0Mobile\u00A0App during onboarding.\nOr go to Settings\u00A0›\u00A0Mobile\u00A0Access.").assertExists()
        rule.onNodeWithContentDescription("Download from happy.engineering").assertExists()
        rule.node(InstallDesktopTags.BACKGROUND).assertExists()

        // The TV 96, the title 24 under it, the two lines 8 under that, the site 4 under; Scan 48 above the bottom.
        val art = rule.node(InstallDesktopTags.ART).bounds
        val title = rule.node(InstallDesktopTags.TITLE).bounds
        val description = rule.node(InstallDesktopTags.DESCRIPTION).bounds
        val scan = rule.node(InstallDesktopTags.SCAN).bounds
        val site = rule.node(InstallDesktopTags.SITE).bounds
        assertDp("art", 96, art.width)
        assertDp("art square", 96, art.height)
        assertDp("title 24 under the art", art.bottom + 24.dp, title.top)
        assertDp("description 8 under the title", title.bottom + 8.dp, description.top)
        assertDp("site 4 under the description", description.bottom + 4.dp, site.top)
        assertDp("site a 40 target", 40, site.height)
        assertDp("scan 48 above the bottom", PHONE_HEIGHT.dp - 48.dp, scan.bottom)
        assertTrue("scan at least 200 wide", scan.width >= 200.dp - 0.34.dp)
        for ((name, box) in listOf("art" to art, "title" to title, "scan" to scan, "site" to site)) {
            assertDp("$name centred", (PHONE_WIDTH / 2f).dp, (box.left + box.right) / 2)
        }
        rule.assertActionsLabelled()
    }

    /** The TV is where the first screen's slides have their art, and Scan where Start is. */
    @Test
    fun theArtAndTheButtonAreWhereTheFirstScreensAre() {
        var install by mutableStateOf(false)
        rule.setHappyContent {
            if (install) {
                InstallDesktopScreen(false, null, {}, {}, {}, {}, {}, {})
            } else {
                StartScreen(connecting = false, customServerLabel = null, onStart = {}, onEnterLink = {}, onRestore = {}, onServer = {})
            }
        }
        val slideArt = rule.node(StartGalleryTags.art(0)).bounds
        val start = rule.node(StartTags.CONNECT).bounds
        install = true
        rule.waitForIdle()
        assertEquals(slideArt, rule.node(InstallDesktopTags.ART).bounds)
        val scan = rule.node(InstallDesktopTags.SCAN).bounds
        assertDp("scan's top", start.top, scan.top)
        assertDp("scan's bottom", start.bottom, scan.bottom)
    }

    @Test
    fun scanTheSiteAndBack() {
        show()
        rule.onNodeWithText("Scan QR code").performClick()
        rule.onNodeWithContentDescription("Download from happy.engineering").performClick()
        rule.node(HeaderTags.LEFT).performClick()
        assertEquals(listOf("scan", "site", "back"), taps)
    }

    /** ⋮ holds the first screen's other ways in. */
    @Test
    fun theMenuIsTheFirstScreens() {
        show()
        for ((label, tap) in listOf(
            "Enter link manually" to "link",
            "Restore Legacy Account" to "restore",
            "Legacy Server" to "server",
        )) {
            rule.onNodeWithContentDescription("More").performClick()
            rule.node(StartTags.MENU).assertExists()
            rule.onNodeWithText(label).performClick()
            rule.node(StartTags.MENU).assertDoesNotExist()
            assertEquals(tap, taps.last())
        }
    }

    @Test
    fun darkModeLaysOutTheSame() {
        show(dark = true)
        val scan = rule.node(InstallDesktopTags.SCAN).bounds
        assertDp("scan centred", (PHONE_WIDTH / 2f).dp, (scan.left + scan.right) / 2)
        assertDp("scan 48 above the bottom", PHONE_HEIGHT.dp - 48.dp, scan.bottom)
    }
}

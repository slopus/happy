package com.slopus.happy.ui.start

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

/** The screen after Start: its words, Scan QR code, the site, and the first screen's ⋮ under the standard bar. */
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
        rule.onNodeWithText("Install Happy on your computer").assertExists()
        rule.onNodeWithText("Open Happy and choose Link\u00A0Mobile\u00A0App.").assertExists()
        rule.node(InstallDesktopTags.BACKGROUND).assertExists()

        // Centred: glyph 56, title 20 under it, the line 8 under that, the site 4 under, Scan 20 under: download first.
        val icon = rule.node(InstallDesktopTags.ICON).bounds
        val title = rule.node(InstallDesktopTags.TITLE).bounds
        val description = rule.node(InstallDesktopTags.DESCRIPTION).bounds
        val scan = rule.node(InstallDesktopTags.SCAN).bounds
        val site = rule.node(InstallDesktopTags.SITE).bounds
        assertDp("icon", 56, icon.width)
        assertDp("title 20 under the icon", icon.bottom + 20.dp, title.top)
        assertDp("description 8 under the title", title.bottom + 8.dp, description.top)
        assertDp("site 4 under the description", description.bottom + 4.dp, site.top)
        assertDp("site a 40 target", 40, site.height)
        assertDp("scan 20 under the site", site.bottom + 20.dp, scan.top)
        assertTrue("scan at least 200 wide", scan.width >= 200.dp - 0.34.dp)
        for ((name, box) in listOf("icon" to icon, "title" to title, "scan" to scan, "site" to site)) {
            assertDp("$name centred", (PHONE_WIDTH / 2f).dp, (box.left + box.right) / 2)
        }
        rule.assertActionsLabelled()
    }

    @Test
    fun scanTheSiteAndBack() {
        show()
        rule.onNodeWithText("Scan QR code").performClick()
        rule.onNodeWithContentDescription("Download Happy from happy.engineering").performClick()
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
    }
}

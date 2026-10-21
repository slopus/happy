package com.slopus.happy.ui.settings

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemTags
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.Settings
import com.slopus.happy.ui.assertBox
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AppearanceLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    /**
     * TalkBack over Settings > Appearance: the title is a header, pressable
     * rows are buttons, and each switch reads its row's title with its state
     * (RN's platform switch is unnamed; the row is a stop of its own).
     */
    @Test
    fun appearanceReadsForTalkBack() {
        rule.setHappyContent {
            AppearanceScreen(theme = ThemePreference.Light, onThemeChange = {}, onBack = {}, settings = Settings.Defaults, onSettingsChange = {})
        }
        rule.onNode(hasText("Appearance") and isHeading(), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("Appearance") and hasRole(Role.Button)).assertExists()
        rule.onNode(hasContentDescription("Compact Tool Calls") and hasRole(Role.Switch)).performScrollTo().assertIsOff()
        rule.onNode(hasContentDescription("Show Quota Remaining") and hasRole(Role.Switch)).assertExists()
        rule.assertActionsLabelled()
    }

    @Test
    fun appearanceCyclesTheTheme() {
        var theme = ThemePreference.Adaptive
        rule.setHappyContent { AppearanceScreen(theme = theme, onThemeChange = { theme = it }, onBack = {}) }
        rule.onNodeWithText("Adaptive").assertIsDisplayed()
        val row = rule.onAllNodesWithTag(ItemTags.ROW, useUnmergedTree = true)[0]
        assertDp("theme row: icon, title and subtitle", 76, row.bounds.let { it.bottom - it.top })
        row.performClick()
        assertEquals(ThemePreference.Light, theme)
    }

    @Test
    fun appearanceBubbleColorDropdown() {
        var settings = Settings.Defaults
        rule.setHappyContent {
            AppearanceScreen(theme = ThemePreference.Light, onThemeChange = {}, onBack = {}, settings = settings, onSettingsChange = { settings = it(settings) })
        }
        val value = rule.node(AppearanceTags.BUBBLE_DROPDOWN).bounds
        assertTrue("dropdown value at most 184 wide", value.right - value.left <= 184.dp)
        val preview = rule.onAllNodesWithTag(AppearanceTags.BUBBLE_PREVIEW, useUnmergedTree = true)[0].bounds
        assertBox("bubble preview", preview, value.left, preview.top, 46.dp, 28.dp)
        rule.onNodeWithText("Gray").assertIsDisplayed()
        rule.node(AppearanceTags.BUBBLE_DROPDOWN).performClick()
        val options = rule.onAllNodesWithTag(AppearanceTags.OPTION, useUnmergedTree = true)
        options.assertCountEquals(6)
        assertTrue("options at least 48 high", options[0].bounds.let { it.bottom - it.top } >= 48.dp)
        rule.onNodeWithText("Purple").performClick()
        assertEquals("purple", settings.userMessageBubbleColor)
        rule.onAllNodesWithTag(AppearanceTags.OPTION, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun appearanceAvatarStyleAndSwitches() {
        var settings = Settings.Defaults
        rule.setHappyContent {
            AppearanceScreen(theme = ThemePreference.Light, onThemeChange = {}, onBack = {}, settings = settings, onSettingsChange = { settings = it(settings) })
        }
        rule.node(AppearanceTags.AVATAR_DROPDOWN).performScrollTo().performClick()
        rule.onAllNodesWithTag(AppearanceTags.OPTION, useUnmergedTree = true).assertCountEquals(3)
        rule.onNodeWithText("Gradient").performScrollTo().performClick()
        assertEquals("gradient", settings.avatarStyle)
        rule.onNodeWithText("Flat List").performScrollTo().performClick()
        assertEquals(SessionListGrouping.Project, settings.sessionListGrouping)
        rule.onNodeWithText("File Diffs Sidebar").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun languageRowShowsTheDetail() {
        var opened = false
        rule.setHappyContent {
            AppearanceScreen(theme = ThemePreference.Light, onThemeChange = {}, onBack = {}, languageDetail = "Automatic (English)", onLanguage = { opened = true })
        }
        rule.onNodeWithText("Automatic (English)").performClick()
        assertTrue(opened)
    }
}

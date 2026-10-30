package com.slopus.happy.ui.connection

import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** An agent connection's settings: Appearance, removing only after asking, one surface under the bar. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentConnectionSettingsTest {
    @get:Rule val rule = createComposeRule()

    private var removed = 0
    private var appearance = 0
    private var page = 0

    private fun show(dark: Boolean = false) = rule.setHappyContent(dark) {
        page = HappyTheme.colors.grouped.background.toArgb()
        AgentConnectionSettingsScreen("Studio", "agent-connection-1", null, AgentLinkStatus.Connected, {}, { appearance++ }, { removed++ })
    }

    @Test
    fun removingAsksAndCancelKeepsTheConnection() {
        show()
        rule.node(AgentSettingsTags.REMOVE).performClick()
        rule.onNodeWithText("Remove Studio?").assertExists()
        rule.onNodeWithText("Cancel").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Remove Studio?").assertDoesNotExist()
        assertEquals(0, removed)

        rule.node(AgentSettingsTags.REMOVE).performClick()
        // The dialog's button, after the row of the same name.
        rule.onAllNodesWithText("Remove connection").onLast().performClick()
        rule.waitForIdle()
        assertEquals(1, removed)
    }

    @Test
    fun appearanceOpens() {
        show()
        rule.node(AgentSettingsTags.APPEARANCE).performClick()
        assertEquals(1, appearance)
    }

    private fun barCorner(): Int {
        val bar = rule.node(AgentSettingsTags.BAR).captureToImage().toPixelMap()
        // A corner of the bar, clear of the back arrow and the title.
        return bar[bar.width - 4, 4].toArgb()
    }

    @Test
    fun theBarIsThePagesOwnGreyInLight() {
        show(dark = false)
        assertEquals(page, barCorner())
    }

    @Test
    fun theBarIsThePagesOwnColourInDark() {
        show(dark = true)
        assertEquals(page, barCorner())
    }
}

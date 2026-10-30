package com.slopus.happy.ui.connection

import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * An agent connection's settings: the profile changed through the Chief of
 * Staff, every account with the open one checked and Connect Agent,
 * Appearance, removing only after asking, one surface under the bar.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentConnectionSettingsTest {
    @get:Rule val rule = createComposeRule()

    private var removed = 0
    private var appearance = 0
    private var connect = 0
    private val switched = mutableListOf<String>()
    private val asked = mutableListOf<String>()
    private var page = 0

    private val accounts = AccountMenu(
        listOf(
            AccountMenuEntry("account-1", "Steve"),
            AccountMenuEntry("agent-connection-1", "Studio", agent = true, active = true),
            AccountMenuEntry("agent-connection-2", "Laptop", agent = true),
        ),
    )

    private val actions = AgentSettingsActions(
        onBack = {},
        onAppearance = { appearance++ },
        onRemove = { removed++ },
        onSwitchAccount = { switched += it },
        onConnectAgent = { connect++ },
        onAskChief = { asked += it },
    )

    private fun show(dark: Boolean = false) = rule.setHappyContent(dark) {
        page = HappyTheme.colors.grouped.background.toArgb()
        AgentConnectionSettingsScreen("Studio", "agent-connection-1", null, AgentLinkStatus.Connected, accounts, actions)
    }

    @Test
    fun editingTheProfileOpensTheChiefWithAnUnsentPrefix() {
        show()
        rule.node(AgentSettingsTags.EDIT_NAME).performClick()
        rule.node(AgentSettingsTags.EDIT_AVATAR).performClick()
        assertEquals(listOf("Change this agent connection's name to ", "Change this agent connection's avatar: "), asked)
        assertEquals(0, removed)
    }

    @Test
    fun everyAccountIsListedTheOpenOneCheckedAndATapOpensAnother() {
        show()
        rule.node(AgentSettingsTags.account("agent-connection-1")).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        rule.node(AgentSettingsTags.account("account-1")).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
        // The open one stays open.
        rule.node(AgentSettingsTags.account("agent-connection-1")).performClick()
        rule.node(AgentSettingsTags.account("account-1")).performClick()
        rule.node(AgentSettingsTags.account("agent-connection-2")).performClick()
        assertEquals(listOf("account-1", "agent-connection-2"), switched)
        rule.node(AgentSettingsTags.CONNECT).performScrollTo().performClick()
        assertEquals(1, connect)
    }

    @Test
    fun removingAsksAndCancelKeepsTheConnection() {
        show()
        rule.node(AgentSettingsTags.REMOVE).performScrollTo().performClick()
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
        rule.node(AgentSettingsTags.APPEARANCE).performScrollTo().performClick()
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

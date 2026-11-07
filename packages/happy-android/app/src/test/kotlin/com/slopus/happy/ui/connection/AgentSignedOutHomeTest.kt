package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.home.AccountMenuTags
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** A team server whose session ended: its home is the account menu, its name and Sign in again, and nothing else. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class AgentSignedOutHomeTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun showsOnlySignIn() {
        var signIns = 0
        rule.setHappyContent {
            AgentSignedOutHome(
                name = "Acme",
                accounts = AccountMenu(listOf(AccountMenuEntry("agent-connection-1", "Acme", agent = true, active = true))),
                onSwitchAccount = {},
                onAdd = {},
                onSignIn = { signIns++ },
            )
        }
        rule.onNodeWithTag(AgentHomeTags.SIGNED_OUT).assertIsDisplayed()
        rule.onNodeWithTag(AccountMenuTags.BUTTON).assertIsDisplayed()
        rule.onNodeWithText("Acme").assertIsDisplayed()
        for (tag in listOf(AgentHomeTags.LIST, AgentHomeTags.SEARCH, AgentHomeTags.SETTINGS, AgentHomeTags.COMPOSE, AgentHomeTags.VOICE, AgentHomeTags.BANNER, AgentHomeTags.OFFLINE)) {
            rule.onAllNodesWithTag(tag).fetchSemanticsNodes().let { assertEquals(tag, 0, it.size) }
        }
        rule.onNodeWithText("Sign in again").performClick()
        assertEquals(1, signIns)
    }
}

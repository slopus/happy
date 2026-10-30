package com.slopus.happy.ui.home

import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Home's account menu: every account and agent connection, then one Add. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AccountMenuTest {
    @get:Rule val rule = createComposeRule()

    private val menu = AccountMenu(
        listOf(
            AccountMenuEntry("0123456789abcdef", "Steve", active = true),
            AccountMenuEntry("fedcba9876543210", null, detail = "selfhost.test"),
            AccountMenuEntry("agent-connection-1", "Studio", agent = true),
            AccountMenuEntry("agent-connection-2", "Old Mac", agent = true, attention = true),
        ),
    )

    @Test
    fun listsEveryAccountAndSwitches() {
        val switched = mutableListOf<String>()
        var added = 0
        rule.setHappyContent {
            AccountMenuButton(menu, onSwitch = { switched += it }, onAdd = { added++ })
        }
        rule.node(AccountMenuTags.BUTTON).performClick()
        rule.onNodeWithText("Steve").assertExists()
        rule.onNodeWithText("Happy account").assertExists()
        rule.onNodeWithText("selfhost.test").assertExists()
        rule.onNodeWithText("Studio").assertExists()
        rule.node(AccountMenuTags.entry("0123456789abcdef")).assertIsSelected()
        rule.node(AccountMenuTags.entry("agent-connection-1")).assertIsNotSelected()
        rule.assertActionsLabelled()

        // The open account is already open.
        rule.node(AccountMenuTags.entry("0123456789abcdef")).performClick()
        rule.node(AccountMenuTags.BUTTON).performClick()
        rule.node(AccountMenuTags.entry("agent-connection-1")).performClick()
        assertEquals(listOf("agent-connection-1"), switched)

        rule.node(AccountMenuTags.BUTTON).performClick()
        rule.onNodeWithText("Add").assertExists()
        rule.node(AccountMenuTags.ADD).performClick()
        assertEquals(1, added)
    }
}

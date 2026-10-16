package com.slopus.happy.ui.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * happy-app settings/connect/claude.tsx (the unsupported view it ships):
 * "Connect Claude", 20 below it the instruction, 24 below that a terminal
 * card at least 280 wide with 16 padding holding `$ happy connect claude`,
 * all centred horizontally and the column centred vertically.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConnectClaudeLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun commandIsCentred() {
        rule.setHappyContent { ConnectClaudeScreen(onBack = {}) }
        rule.onNodeWithText("Connect to Claude").assertIsDisplayed()
        rule.onNodeWithText("$ happy connect claude").assertIsDisplayed()
        val title = rule.node(ConnectClaudeTags.TITLE).bounds
        val body = rule.node(ConnectClaudeTags.BODY).bounds
        val terminal = rule.node(ConnectClaudeTags.TERMINAL).bounds
        val centre = PHONE_WIDTH / 2f
        for ((name, rect) in listOf("title" to title, "body" to body, "terminal" to terminal)) {
            assertDp("$name centred", centre.dp, (rect.left + rect.right) / 2)
        }
        assertDp("instruction 20 under the title", 20, body.top - title.bottom)
        assertDp("terminal 24 under the instruction", 24, terminal.top - body.bottom)
        assertTrue("terminal at least 280 wide", terminal.right - terminal.left >= 280.dp)
        val command = rule.onNodeWithText("$ happy connect claude", useUnmergedTree = true).bounds
        assertDp("terminal pads 16", 16, command.top - terminal.top)
        assertDp("terminal pads 16 below", 16, terminal.bottom - command.bottom)
        assertTrue("column centred vertically", title.top > 300.dp && terminal.bottom < 600.dp)
    }
}

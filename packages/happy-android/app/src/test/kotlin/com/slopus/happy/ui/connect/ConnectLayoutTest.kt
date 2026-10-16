package com.slopus.happy.ui.connect

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The connect screens against terminal/index.tsx, terminal/connect.tsx and WebPromptModal.tsx. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConnectLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    /** The card's hairline border insets its content by one physical pixel. */
    private val hairline = (1 / 3f).dp

    @Test
    fun terminalConfirmSpec() {
        var accepted = 0
        rule.setHappyContent {
            TerminalConfirmScreen(publicKey = "abcdefghijklmnopqrstuvwxyz", connecting = false, onAccept = { accepted++ }, onReject = {})
        }
        // First group: no title, so a 16 spacer under the 64 header; cards are inset 16.
        val heroCard = rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true)[0].bounds
        assertBox("hero card", heroCard, 16.dp, (64 + 16).dp, (PHONE_WIDTH - 32).dp, heroCard.bottom - heroCard.top)
        val icon = rule.node(TerminalScreenTags.HERO_ICON).bounds
        assertBox("terminal icon", icon, ((PHONE_WIDTH - 48) / 2f).dp, heroCard.top + hairline + 24.dp, 48.dp, 48.dp)

        rule.onNodeWithText("abcdefghijkl...").assertExists()
        rule.onNodeWithText("End-to-end encrypted").assertExists()

        val actions = rule.node(TerminalScreenTags.ACTIONS).bounds
        val accept = rule.node(TerminalScreenTags.ACCEPT).bounds
        val reject = rule.node(TerminalScreenTags.REJECT).bounds
        assertBox("accept", accept, actions.left + 16.dp, actions.top + 16.dp, actions.right - actions.left - 32.dp, 50.dp)
        assertBox("reject", reject, accept.left, accept.bottom + 12.dp, accept.right - accept.left, 50.dp)
        assertDp("actions bottom padding", reject.bottom + 16.dp, actions.bottom)

        rule.onNodeWithText("Accept Connection").performClick()
        assertEquals(1, accepted)
    }

    @Test
    fun terminalConfirmWhileConnecting() {
        rule.setHappyContent { TerminalConfirmScreen(publicKey = "abc", connecting = true, onAccept = {}, onReject = {}) }
        rule.node(TerminalScreenTags.ACCEPT).assertIsNotEnabled()
        rule.node(TerminalScreenTags.REJECT).assertIsNotEnabled()
    }

    @Test
    fun terminalWithoutAKeyIsAnInvalidLink() {
        rule.setHappyContent { TerminalConfirmScreen(publicKey = null, connecting = false, onAccept = {}, onReject = {}) }
        rule.onNodeWithText("Invalid Connection Link").assertExists()
        rule.node(TerminalScreenTags.ACTIONS).assertDoesNotExist()
        val card = rule.node(ItemGroupTags.CARD).bounds
        val icon = rule.node(TerminalScreenTags.HERO_ICON).bounds
        assertBox("warning icon", icon, ((PHONE_WIDTH - 48) / 2f).dp, card.top + hairline + 32.dp, 48.dp, 48.dp)
    }

    @Test
    fun terminalWebLinkExplainsItself() {
        rule.setHappyContent { TerminalWebScreen(onBack = {}) }
        rule.onNodeWithText("Web Browser Required").assertExists()
        val card = rule.node(ItemGroupTags.CARD).bounds
        val icon = rule.node(TerminalScreenTags.HERO_ICON).bounds
        assertBox("laptop icon", icon, ((PHONE_WIDTH - 64) / 2f).dp, card.top + hairline + 32.dp, 64.dp, 64.dp)
    }

    @Test
    fun urlPromptSpecAndResult() {
        val results = mutableListOf<String?>()
        rule.setHappyContent {
            UrlPromptDialog(
                title = "Paste link",
                message = "On your computer, choose Copy auth link, then paste it here.",
                placeholder = "happy://terminal?...",
                confirmText = "Link",
                onResult = { results += it },
            )
        }
        rule.onNode(isDialog()).assertExists()
        val card = rule.node(UrlPromptTags.CARD).bounds
        assertDp("card width", 270, card.right - card.left)
        val input = rule.node(UrlPromptTags.INPUT).bounds
        assertBox("input", input, card.left + 16.dp, input.top, (270 - 32).dp, 36.dp)
        val cancel = rule.node(UrlPromptTags.CANCEL).bounds
        val confirm = rule.node(UrlPromptTags.CONFIRM).bounds
        // Content padding 16 under the field, then the 1 divider.
        assertDp("buttons under the divider", input.bottom + 16.dp + 1.dp, cancel.top)
        assertDp("cancel and confirm share the width", cancel.right - cancel.left, confirm.right - confirm.left)
        assertDp("split by a 1 divider", cancel.right + 1.dp, confirm.left)

        rule.node(UrlPromptTags.INPUT).performTextInput("happy://terminal?xyz")
        rule.onNodeWithText("Link").performClick()
        rule.onNodeWithText("Cancel").performClick()
        assertEquals(listOf("happy://terminal?xyz", null), results)
    }
}

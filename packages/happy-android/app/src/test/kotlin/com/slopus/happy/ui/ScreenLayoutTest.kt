package com.slopus.happy.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.AuthApi.ServerProbe
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.server.ServerScreen
import com.slopus.happy.ui.server.ServerTags
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreenLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun serverFormSpec() {
        rule.setHappyContent {
            ServerScreen(customUrl = "https://happy.example.com", probe = { ServerProbe.HappyServer }, onSave = {}, onReset = {}, onBack = {})
        }
        val card = rule.node(ItemGroupTags.CARD).bounds
        assertDp("card left", 16, card.left)
        assertDp("card top (header + 16 spacer)", 64 + 16, card.top)
        val form = rule.node(ServerTags.FORM).bounds
        assertDp("form inset 16 from the card", card.left + hairline() + 16.dp, form.left)
        assertDp("form top inset 12 from the card", card.top + hairline() + 12.dp, form.top)
        val label = rule.node(ServerTags.LABEL).bounds
        val input = rule.node(ServerTags.INPUT).bounds
        assertDp("input top", label.bottom + 8.dp, input.top)
        assertDp("input left", form.left, input.left)
        assertDp("input width", form.right - form.left, input.right - input.left)
        assertTrue("input at least 44 high", input.bottom - input.top >= 44.dp)
        val save = rule.node(ServerTags.SAVE).bounds
        assertBox("save", save, form.left, input.bottom + 8.dp + 4.dp, form.right - form.left, 44.dp)
        val reset = rule.node(ServerTags.RESET).bounds
        assertBox("reset", reset, form.left, save.bottom + 4.dp, form.right - form.left, 44.dp)
        val status = rule.node(ServerTags.STATUS).bounds
        assertDp("status top", reset.bottom + 12.dp, status.top)
        assertDp("form bottom", status.bottom, form.bottom)
    }

    @Test
    fun serverRejectsANonHttpUrlInline() {
        var saved: String? = null
        rule.setHappyContent {
            ServerScreen(customUrl = null, probe = { ServerProbe.HappyServer }, onSave = { saved = it }, onReset = {}, onBack = {})
        }
        rule.onAllNodesWithTag(ServerTags.RESET, useUnmergedTree = true).assertCountEquals(0)
        rule.node(ServerTags.INPUT).performTextReplacement("ftp://happy.example.com")
        rule.node(ServerTags.SAVE).performClick()
        rule.node(ServerTags.ERROR).assertIsDisplayed()
        rule.onNodeWithText("Server URL must use HTTP or HTTPS protocol").assertIsDisplayed()
        val input = rule.node(ServerTags.INPUT).bounds
        val error = rule.node(ServerTags.ERROR).bounds
        assertDp("error under the input", input.bottom + 8.dp, error.top)
        assertDp("save under the error", error.bottom + 12.dp + 4.dp, rule.node(ServerTags.SAVE).bounds.top)
        assertEquals(null, saved)
    }

    @Test
    fun serverSavesAfterTheProbeAndConfirmation() {
        var saved: String? = null
        rule.setHappyContent {
            ServerScreen(customUrl = null, probe = { ServerProbe.HappyServer }, onSave = { saved = it }, onReset = {}, onBack = {})
        }
        rule.node(ServerTags.INPUT).performTextReplacement("https://happy.example.com")
        rule.node(ServerTags.SAVE).performClick()
        rule.onNodeWithText("Continue with this server?").assertIsDisplayed()
        rule.onNodeWithText("Continue").performClick()
        assertEquals("https://happy.example.com", saved)
    }

    private fun hairline() = (1f / 3f).dp
}

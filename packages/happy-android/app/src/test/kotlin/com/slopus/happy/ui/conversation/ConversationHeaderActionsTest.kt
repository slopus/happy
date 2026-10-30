package com.slopus.happy.ui.conversation

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.LayoutDirection
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Header actions in both reading directions; new and existing chats share every permission mode. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [26, 33], qualifiers = PHONE)
class ConversationHeaderActionsTest {
    @get:Rule val rule = createComposeRule()

    @Test fun `compose glyph and overflow mirror around a constrained title and preserve all modes and details`() {
        var current by mutableStateOf(Mode("claude", "opus", "high", null, "auto"))
        var created by mutableStateOf(false)
        var direction by mutableStateOf(LayoutDirection.Ltr)
        var composed = 0
        var details = 0
        val modes = listOf("read_only" to "Read only", "workspace_write" to "Workspace write", "auto" to "Auto", "full_access" to "Full access")
        rule.setHappyContent {
            CompositionLocalProvider(LocalLayoutDirection provides direction) {
                ConversationScreen(
                    ConversationState(created = created, loaded = true, knownTitle = "A long chat title that must leave room for both actions", mode = current, catalog = ModeCatalog(emptyList(), current)),
                    null,
                    ConversationScreenActions(onCompose = { composed++ }, onDetails = { details++ }, onModeChange = { current = it }),
                )
            }
        }
        for (rtl in listOf(false, true)) {
            rule.runOnIdle { direction = if (rtl) LayoutDirection.Rtl else LayoutDirection.Ltr }
            for (exists in listOf(false, true)) {
                rule.runOnIdle { created = exists }
                rule.onNodeWithText(String(Character.toChars(Ionicon.CreateOutline.codepoint))).assertExists()
                val compose = rule.node(ConversationScreenTags.COMPOSE).bounds
                val more = rule.node(ConversationScreenTags.MORE).bounds
                val title = rule.node(ConversationScreenTags.TITLE).bounds
                assertTrue("compose/overflow order", if (rtl) more.right <= compose.left else compose.right <= more.left)
                assertTrue("title leaves both actions clear", if (rtl) title.left >= compose.right else title.right <= compose.left)
                rule.node(ConversationScreenTags.COMPOSE).performClick()
                rule.node(ConversationScreenTags.MORE).performClick()
                if (exists) rule.node(ConversationScreenTags.DETAILS).assertIsDisplayed()
                else rule.node(ConversationScreenTags.DETAILS).assertDoesNotExist()
                rule.node(ConversationModeTags.PERMISSION).performClick()
                for ((index, entry) in modes.withIndex()) {
                    if (index > 0) {
                        rule.node(ConversationScreenTags.MORE).performClick()
                        rule.node(ConversationModeTags.PERMISSION).performClick()
                    }
                    rule.onNodeWithText(modes.first { it.first == current.permissionMode }.second).assertIsSelected()
                    rule.onNodeWithText(entry.second).performClick()
                    assertEquals(entry.first, current.permissionMode)
                }
                if (exists) {
                    rule.node(ConversationScreenTags.MORE).performClick()
                    rule.node(ConversationScreenTags.DETAILS).performClick()
                    rule.node(ConversationScreenTags.MENU).assertDoesNotExist()
                }
            }
        }
        assertEquals(4, composed)
        assertEquals(2, details)
    }
}
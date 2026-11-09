package com.slopus.happy.ui.conversation

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
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

/**
 * The header's actions in both reading directions: compose alone once the
 * chat exists, nothing before; no More menu (iOS da5fda505), the details
 * opening from the name.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [26, 33], qualifiers = PHONE)
class ConversationHeaderActionsTest {
    @get:Rule val rule = createComposeRule()

    @Test fun `compose alone mirrors beside a constrained title, and the name opens the details`() {
        val current = Mode("claude", "opus", "high", null, "auto")
        var created by mutableStateOf(false)
        var direction by mutableStateOf(LayoutDirection.Ltr)
        var composed = 0
        var details = 0
        rule.setHappyContent {
            CompositionLocalProvider(LocalLayoutDirection provides direction) {
                ConversationScreen(
                    ConversationState(created = created, loaded = true, knownTitle = "A long chat title that must leave room for both actions", mode = current, catalog = ModeCatalog(emptyList(), current)),
                    ConversationScreenActions(onCompose = { composed++ }, onDetails = { details++ }),
                )
            }
        }
        for (rtl in listOf(false, true)) {
            rule.runOnIdle { direction = if (rtl) LayoutDirection.Rtl else LayoutDirection.Ltr }
            for (exists in listOf(false, true)) {
                rule.runOnIdle { created = exists }
                rule.onNode(hasContentDescription("More") and hasAnyAncestor(hasTestTag(ConversationScreenTags.BAR))).assertDoesNotExist()
                if (exists) {
                    rule.onNodeWithText(String(Character.toChars(Ionicon.CreateOutline.codepoint))).assertExists()
                    rule.onNode(hasTestTag(ConversationScreenTags.COMPOSE) and hasAnyAncestor(hasTestTag(ConversationScreenTags.BAR))).assertExists()
                    val compose = rule.node(ConversationScreenTags.COMPOSE).bounds
                    val title = rule.node(ConversationScreenTags.TITLE).bounds
                    assertTrue("title leaves compose clear", if (rtl) title.left >= compose.right else title.right <= compose.left)
                    rule.node(ConversationScreenTags.COMPOSE).performClick()
                    rule.node(ConversationScreenTags.TITLE_BUTTON).performClick()
                } else {
                    // Until the chat exists: no compose, and no name to tap.
                    rule.node(ConversationScreenTags.COMPOSE).assertDoesNotExist()
                }
            }
        }
        assertEquals(2, composed)
        assertEquals(2, details)
    }
}

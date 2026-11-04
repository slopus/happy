package com.slopus.happy.ui.todos

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.components.PromptTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TodoNamePromptTest {
    @get:Rule val rule = createComposeRule()

    @Test fun aNameIsRequiredForBothTheButtonAndKeyboardDone() {
        val names = mutableListOf<String?>()
        var dismissed = 0
        rule.setHappyContent {
            PromptModal(Prompt(title = "New todo list", confirmText = "Create", allowBlank = false, onResult = { names += it }), onDismiss = { dismissed++ })
        }
        rule.node(PromptTags.CONFIRM).assertIsNotEnabled()
        rule.node(PromptTags.INPUT).performTextReplacement("   ")
        rule.node(PromptTags.INPUT).performImeAction()
        rule.runOnIdle { assertEquals(emptyList<String?>(), names); assertEquals(0, dismissed) }
        rule.node(PromptTags.CONFIRM).assertIsNotEnabled()
        rule.node(PromptTags.INPUT).performTextReplacement("Groceries")
        rule.node(PromptTags.CONFIRM).assertIsEnabled().performClick()
        rule.runOnIdle { assertEquals(listOf("Groceries"), names); assertEquals(1, dismissed) }
    }
}
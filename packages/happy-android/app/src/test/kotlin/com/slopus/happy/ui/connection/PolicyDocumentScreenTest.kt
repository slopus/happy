package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.PolicyDocument
import com.slopus.happy.agent.PolicyDocumentSource
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** A policy document's page: read-only with the owners' note for members, Save and Back's question for owners. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class PolicyDocumentScreenTest {
    @get:Rule val rule = createComposeRule()

    private fun source(text: String, saves: MutableList<String> = mutableListOf()) =
        PolicyDocumentSource({ text }, { saves += it; it }, MutableSharedFlow<AgentEvent>(), CoroutineScope(Dispatchers.Main.immediate))

    @Test
    fun aMemberReadsItWithTheOwnersNote() {
        val source = source("Be kind.")
        rule.setHappyContent { PolicyDocumentScreen(PolicyDocument.Instructions, source, editable = false, onBack = {}) }
        rule.waitForIdle()
        rule.onNodeWithTag(PolicyDocumentTags.TEXT).assertTextEquals("Be kind.")
        rule.onNodeWithTag(PolicyDocumentTags.NOTE).assertTextEquals("Every agent on this server follows these instructions (AGENTS.md). Only owners can change this. Agents can't.")
        assertEquals(0, rule.onAllNodesWithTag(PolicyDocumentTags.SAVE).fetchSemanticsNodes().size)
    }

    @Test
    fun anOwnerSavesWhatTheyTypedAndBackAsksFirstWhileItWaits() {
        val saves = mutableListOf<String>()
        val source = source("", saves)
        var left = 0
        rule.setHappyContent { PolicyDocumentScreen(PolicyDocument.Security, source, editable = true, onBack = { left++ }) }
        rule.waitForIdle()
        rule.onNodeWithTag(PolicyDocumentTags.SAVE).assertIsNotEnabled()
        rule.onNodeWithTag(PolicyDocumentTags.TEXT).performTextInput("No deploys.")
        rule.onNodeWithTag(PolicyDocumentTags.SAVE).assertIsEnabled()
        rule.onNodeWithTag(com.slopus.happy.ui.components.HeaderTags.LEFT).performClick()
        rule.onNodeWithText("Discard your changes?").assertExists()
        rule.onNodeWithText("Keep editing").performClick()
        assertEquals(0, left)
        rule.onNodeWithTag(PolicyDocumentTags.SAVE).performClick()
        rule.waitForIdle()
        assertEquals(listOf("No deploys."), saves)
        rule.onNodeWithTag(PolicyDocumentTags.SAVE).assertIsNotEnabled()
        rule.onNodeWithTag(com.slopus.happy.ui.components.HeaderTags.LEFT).performClick()
        assertEquals(1, left)
    }

    @Test
    fun tooLongSaysTheLimit() {
        val source = source("")
        rule.setHappyContent { PolicyDocumentScreen(PolicyDocument.Security, source, editable = true, onBack = {}) }
        rule.waitForIdle()
        rule.onNodeWithTag(PolicyDocumentTags.TEXT).performTextInput("x".repeat(32 * 1024 + 1))
        rule.onNodeWithTag(PolicyDocumentTags.NOTE).assertTextEquals("Too long: the server keeps up to 32 KB.")
        rule.onNodeWithTag(PolicyDocumentTags.SAVE).assertIsNotEnabled()
    }
}

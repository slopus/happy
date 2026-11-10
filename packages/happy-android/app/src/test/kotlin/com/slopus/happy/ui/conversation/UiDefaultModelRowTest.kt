package com.slopus.happy.ui.conversation

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.Permission
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.conversation.Problem
import com.slopus.happy.conversation.UiWork
import com.slopus.happy.conversation.ui.UiAction
import com.slopus.happy.conversation.ui.UiActions
import com.slopus.happy.conversation.ui.UiOffer
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A chat UI `default_model` in the transcript ([UiDefaultModel]): drawn from the computer's models as last read, acting through presses. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UiDefaultModelRowTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Setup", "idle", null, null, 1, 2, 0, 0)
    private val sent = ArrayList<Pair<UiOffer, UiAction>>()

    private val models = ModeCatalog(
        listOf(
            ModelChoice("claude", "Claude", "claude", "anthropic/opus-5", "Opus 5", listOf("low", "medium", "high"), "high", emptyList()),
            ModelChoice("codex", "Codex", "codex", "openai/gpt-5.6", "GPT-5.6", listOf("medium", "xhigh"), "medium", emptyList()),
            ModelChoice("local", "Local", "ollama", "llama", "Llama", emptyList(), null, emptyList()),
        ),
        Mode("claude", "anthropic/opus-5", "high", null, "auto"),
    )

    private val row = ConversationRowBuilder.build(
        Message.parse(
            Json.parseToJsonElement(
                """{"id":"m1","role":"agent","createdAt":1,"metadata":{},"content":[{"type":"text","text":"Pick the model new chats start on."},
                {"type":"ui","ui":{"id":"u1","components":[{"id":"model","type":"default_model","fallback":"Change the default model in Settings.","props":{}}]}}]}""",
            ),
        )!!,
        "a1", null, streaming = false,
    )

    private var work by mutableStateOf(UiWork.Idle)
    private var catalog by mutableStateOf<ModeCatalog?>(models)
    private var archived by mutableStateOf(false)
    private var granted by mutableStateOf(setOf(Permission.CONFIG_MANAGE))

    private fun screen() {
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(
                    created = true,
                    loaded = true,
                    rows = row.map { if (it is ConversationRow.Ui) it.copy(work = work) else it }.asReversed(),
                    agent = if (archived) agent.copy(archivedAt = 5) else agent,
                    catalog = catalog,
                ),
                ConversationScreenActions(onUiAction = { offer, action -> sent += offer to action }),
                roleAllows = { it in granted },
            )
        }
        rule.waitForIdle()
    }

    private fun line(text: String) = rule.onNodeWithText(text, useUnmergedTree = true)

    @Test fun `the default model is a card of its title, the model and effort it is read as, and what they do`() {
        screen()
        val root = rule.onRoot().bounds
        val card = rule.node(UiDefaultModelTags.CARD).bounds
        assertDp("the row spans the column", root.right - root.left, card.right - card.left)
        val title = line("Default model").bounds
        assertDp("16 in, 12 in the card", root.left + 28.dp, title.left)
        assertDp("6 above, 12 in the card", card.top + 18.dp, title.top)
        assertDp("a 20 line", 20.dp, title.bottom - title.top)
        val model = rule.node(UiDefaultModelTags.MODEL).bounds
        val effort = rule.node(UiDefaultModelTags.EFFORT).bounds
        assertDp("8 under the title", title.bottom + 8.dp, model.top)
        assertDp("at the card's edge", title.left, model.left)
        assertDp("a 36 pill", 36.dp, model.bottom - model.top)
        assertDp("the effort 8 after the model", model.right + 8.dp, effort.left)
        assertDp("on its line", model.top, effort.top)
        line("Opus 5").assertExists()
        line("High").assertExists()
        val status = rule.node(UiDefaultModelTags.LINE).bounds
        assertDp("8 under the pills", model.bottom + 8.dp, status.top)
        val words = line("New chats start here. Chats you already have keep their own.").bounds
        assertDp("after the 16 mark and 8", status.left + 24.dp, words.left)
        assertDp("12 in the card, 6 below", status.bottom + 18.dp, card.bottom)
        rule.node(UiDefaultModelTags.MODEL).assertIsEnabled()
        rule.node(UiDefaultModelTags.EFFORT).assertIsEnabled()
    }

    @Test fun `picking a model sends it with the effort it keeps or its own, and picking an effort the model as it is`() {
        screen()
        rule.node(UiDefaultModelTags.MODEL).performClick()
        rule.waitForIdle()
        // Each model under its account's name.
        rule.onNodeWithText("Codex").assertExists()
        rule.onNodeWithText("GPT-5.6").performClick()
        rule.waitForIdle()
        // Codex doesn't run "high": its own default.
        assertEquals(listOf(UiOffer("m1", "u1", "model") to UiActions.setDefaultModel("codex", "openai/gpt-5.6", "medium")), sent)
        rule.node(UiDefaultModelTags.EFFORT).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Low").performClick()
        rule.waitForIdle()
        assertEquals(UiActions.setDefaultModel("claude", "anthropic/opus-5", "low"), sent.last().second)
        // A model without efforts keeps the effort there is; the one already set sends nothing.
        rule.node(UiDefaultModelTags.MODEL).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Llama").performClick()
        rule.waitForIdle()
        assertEquals(UiActions.setDefaultModel("local", "llama", "high"), sent.last().second)
        rule.node(UiDefaultModelTags.MODEL).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Claude").performClick()
        rule.waitForIdle()
        assertEquals(3, sent.size)
        assertTrue(sent.all { UiActions.takes(com.slopus.happy.conversation.ui.UiComponent.DefaultModel("model", ""), it.second) })
    }

    @Test fun `while a press goes the pills show what was picked and take no tap, and nothing moves`() {
        screen()
        val boxes = { listOf(UiDefaultModelTags.CARD, UiDefaultModelTags.LINE).map { rule.node(it).bounds } }
        val before = boxes()
        rule.node(UiDefaultModelTags.SPINNER).assertDoesNotExist()
        work = UiWork(sending = UiActions.setDefaultModel("codex", "openai/gpt-5.6", "xhigh"))
        rule.waitForIdle()
        line("GPT-5.6").assertExists()
        line("xHigh").assertExists()
        rule.node(UiDefaultModelTags.SPINNER).assertContentDescriptionEquals("Saving…")
        line("New chats start here. Chats you already have keep their own.").assertExists()
        rule.node(UiDefaultModelTags.MODEL).assertIsNotEnabled()
        rule.node(UiDefaultModelTags.EFFORT).assertIsNotEnabled()
        assertEquals("the card and its line stay as they were", before, boxes())
        // Answered, the computer's own word is what shows: here it never changed.
        work = UiWork.Idle
        rule.waitForIdle()
        line("Opus 5").assertExists()
        // Another device's attempt, pending: busy, with what the computer says now.
        work = UiWork(pending = true)
        rule.waitForIdle()
        line("Opus 5").assertExists()
        rule.node(UiDefaultModelTags.SPINNER).assertContentDescriptionEquals("Saving…")
        rule.node(UiDefaultModelTags.MODEL).assertIsNotEnabled()
        assertEquals(before, boxes())
    }

    @Test fun `a refusal says why under the live default, which it never hides, and a press again is open`() {
        work = UiWork(problem = Problem.Said("That model is switched off."))
        screen()
        line("That model is switched off.").assertExists()
        line("Opus 5").assertExists()
        line("High").assertExists()
        rule.node(UiDefaultModelTags.MODEL).assertIsEnabled()
        // Read again, the models are what they are and the refusal is gone.
        catalog = models.copy(defaults = Mode("codex", "openai/gpt-5.6", "medium", null, "auto"))
        work = UiWork.Idle
        rule.waitForIdle()
        line("GPT-5.6").assertExists()
        line("Medium").assertExists()
        line("New chats start here. Chats you already have keep their own.").assertExists()
    }

    @Test fun `until the models are read there are no pills, and the line says so`() {
        catalog = null
        screen()
        line("Reading the models this Happy Agent offers…").assertExists()
        rule.node(UiDefaultModelTags.SPINNER).assertExists()
        rule.node(UiDefaultModelTags.MODEL).assertDoesNotExist()
        rule.node(UiDefaultModelTags.EFFORT).assertDoesNotExist()
        catalog = models
        rule.waitForIdle()
        line("Opus 5").assertExists()
    }

    @Test fun `a role without the permission, or an archived chat, sees the default and can't change it`() {
        granted = emptySet()
        screen()
        line("Opus 5").assertExists()
        line("You don't have permission to do that.").assertExists()
        rule.node(UiDefaultModelTags.MODEL).assertIsNotEnabled()
        rule.node(UiDefaultModelTags.EFFORT).assertIsNotEnabled()
        granted = setOf(Permission.CONFIG_MANAGE)
        rule.waitForIdle()
        rule.node(UiDefaultModelTags.MODEL).assertIsEnabled()
        archived = true
        rule.waitForIdle()
        rule.node(UiDefaultModelTags.MODEL).assertIsNotEnabled()
        rule.node(UiDefaultModelTags.MODEL).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("GPT-5.6").assertDoesNotExist()
        assertTrue(sent.isEmpty())
    }

    @Test fun `a model with no efforts has no effort pill`() {
        catalog = models.copy(defaults = Mode("local", "llama", "high", null, "auto"))
        screen()
        line("Llama").assertExists()
        rule.node(UiDefaultModelTags.EFFORT).assertDoesNotExist()
    }
}

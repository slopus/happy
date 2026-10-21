package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.AgentQuestion
import com.slopus.happy.chat.AgentQuestionAnswer
import com.slopus.happy.chat.AgentQuestionOption
import com.slopus.happy.chat.AgentState
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.PendingAgentCommunication
import com.slopus.happy.chat.PermissionAnswer
import com.slopus.happy.chat.PermissionDecision
import com.slopus.happy.chat.PermissionStatus
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolPermission
import com.slopus.happy.chat.ToolState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
class QuestionLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val gray = userMessageBubblePalette("gray", dark = false)

    private val askInput = """{"questions":[{"question":"Which colour?","header":"Colour","options":[{"label":"Red","description":"Warm"},{"label":"Blue"}],"multiSelect":false}]}"""

    private fun show(message: ChatMessage.ToolCallMessage, callbacks: MessageCallbacks, agentState: AgentState? = null) {
        rule.setHappyContent {
            CompositionLocalProvider(LocalToolAgentState provides agentState) {
                Column(Modifier.fillMaxWidth()) { MessageView(ChatRow.Tool(message), gray, callbacks) }
            }
        }
    }

    // InlineQuestionForm: chip 4 above the question, options 4 apart and at least 44 high.
    @Test
    fun askUserQuestionAnswersThroughThePermission() {
        val answers = mutableListOf<PermissionAnswer>()
        val tool = ToolCall(
            name = "AskUserQuestion", state = ToolState.Running, input = Json.parseToJsonElement(askInput), createdAt = 0,
            permission = ToolPermission("r1", PermissionStatus.Pending),
        )
        show(ChatMessage.ToolCallMessage("t", 0, tool), MessageCallbacks(onPermission = { a, _ -> answers += a }))
        // No permission footer: the form answers.
        rule.node(PermissionTags.FOOTER).assertDoesNotExist()
        rule.onNodeWithText("COLOUR").assertExists()
        val options = rule.onAllNodesWithTag(QuestionTags.OPTION, useUnmergedTree = true)
        options.assertCountEquals(2)
        val first = options[0].bounds
        val second = options[1].bounds
        assertDp("4 apart", 4, second.top - first.bottom)
        assertTrue(second.bottom - second.top >= 44.dp)
        val content = rule.node(ToolTags.CONTENT).bounds
        assertDp("options 12 in", 12, first.left - content.left)
        // TalkBack: one answer, so the options are radio buttons; picking one selects it.
        rule.onNode(hasText("Red") and hasRole(Role.RadioButton)).assertIsNotSelected()
        rule.onNodeWithText("Red").performClick()
        rule.onNode(hasText("Red") and hasRole(Role.RadioButton)).assertIsSelected()
        rule.onNode(hasTestTag(QuestionTags.SUBMIT) and hasRole(Role.Button)).assertExists()
        rule.assertActionsLabelled()
        rule.node(QuestionTags.SUBMIT).performClick()
        rule.waitForIdle()
        val answer = answers.single()
        assertEquals("r1", answer.requestId)
        assertEquals(PermissionDecision.Approved, answer.decision)
        assertEquals(Json.parseToJsonElement("""{"answers":{"Which colour?":"Red"}}"""), answer.updatedInput)
        rule.onNodeWithText("Colour:").assertExists()
    }

    @Test
    fun requestUserInputAnswersItsCommunication() {
        val state = AgentState.parse(
            """{"communications":{"c1":{"id":"c1","kind":"form","toolUseId":"call-1","createdAt":1,"form":{"questions":[{"id":"q1","header":"Mode","question":"Pick","options":[{"label":"Fast"},{"label":"Safe"}]}]}}}}""",
        )
        val sent = mutableListOf<Pair<String, Map<String, AgentQuestionAnswer>>>()
        val tool = ToolCall(callId = "call-1", name = "request_user_input", state = ToolState.Running, input = JsonObject(emptyMap()), createdAt = 0)
        show(
            ChatMessage.ToolCallMessage("t", 0, tool),
            MessageCallbacks(onAnswerQuestion = { id, a, _ -> sent += id to a }),
            state,
        )
        rule.onNodeWithText("Safe").performClick()
        rule.node(QuestionTags.SUBMIT).performClick()
        rule.waitForIdle()
        assertEquals(listOf("c1" to mapOf("q1" to AgentQuestionAnswer(listOf("Safe")))), sent)
    }

    private val textOnly = PendingAgentCommunication.Form(
        "c2", 1, null,
        listOf(AgentQuestion("q", "Name", "What should it be called?"), AgentQuestion("q2", "Size", "How big?", listOf(AgentQuestionOption("S"), AgentQuestionOption("L")))),
    )

    // AgentQuestionBanner: 12 side margins, 8 below, padded 12/10, a 24 icon box.
    @Test
    fun bannerForATextOnlyForm() {
        rule.setHappyContent { AgentQuestionBannerView(textOnly) }
        rule.onNodeWithText("Name").assertExists()
        rule.onNodeWithText("1 more question").assertExists()
        val banner = rule.node(QuestionTags.BANNER).bounds
        assertBox("banner", banner, 12.dp, 0.dp, (PHONE_WIDTH - 24).dp, banner.bottom - banner.top)
    }

    @Test
    fun unsupportedKindsCanBeDismissed() {
        val cancelled = mutableListOf<Pair<String, String>>()
        rule.setHappyContent {
            AgentQuestionBanner(
                listOf(PendingAgentCommunication.Unsupported("c3", 1, null, "survey", null)),
                onAnswer = { _, _, _ -> },
                onCancel = { id, kind -> cancelled += id to kind },
            )
        }
        rule.onNodeWithText("Unsupported request").assertExists()
        rule.node(QuestionTags.BANNER_DISMISS).performClick()
        rule.waitForIdle()
        assertEquals(listOf("c3" to "survey"), cancelled)
    }

    // AgentQuestionModal: sending waits for every required answer; written answers count.
    @Test
    fun modalFormSubmitsWrittenAndChosenAnswers() {
        val sent = mutableListOf<Map<String, AgentQuestionAnswer>>()
        var closed = false
        rule.setHappyContent { AgentQuestionForm(textOnly, onSubmit = { sent += it }, onDismiss = {}, onClose = { closed = true }) }
        rule.onNode(hasText("Send answer") and hasRole(Role.Button)).assertIsNotEnabled()
        rule.onNode(hasText("Cancel") and hasRole(Role.Button)).assertExists()
        rule.assertActionsLabelled()
        rule.onNodeWithText("Send answer").performClick()
        rule.waitForIdle()
        assertTrue(sent.isEmpty())
        rule.onAllNodesWithTag(QuestionTags.MODAL_CUSTOM, useUnmergedTree = true)[0].performTextInput("Widget")
        rule.onNodeWithText("L").performClick()
        rule.onNodeWithText("Send answer").performClick()
        rule.waitForIdle()
        assertEquals(listOf(mapOf("q" to AgentQuestionAnswer(emptyList(), "Widget"), "q2" to AgentQuestionAnswer(listOf("L")))), sent)
        assertTrue(closed)
    }
}

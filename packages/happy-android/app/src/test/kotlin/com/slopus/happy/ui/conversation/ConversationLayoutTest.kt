package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ComposerFocus
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.conversation.Question
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Fixture conversations through [ConversationScreen]; each test also writes its picture under build/conversation-screens. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConversationLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val mode = Mode("claude", "anthropic/opus-5", "high", null, "auto")

    private fun rows(vararg messages: Message): List<ConversationRow> =
        messages.flatMap { ConversationRowBuilder.build(it, "a1", null, false) }.asReversed()

    private val history = rows(
        Message("m1", "user", 1, listOf(Block.Text("The login page loops back to itself after sign-in. Can you find out why?"))),
        Message(
            "m2", "agent", 2,
            listOf(
                Block.Reasoning("The redirect loop suggests the session cookie is not set before the callback."),
                Block.ToolCall("c1", "Bash", "completed", Presentation.Command("grep -rn redirect sources/auth", "...")),
                Block.ToolCall("c2", "Read", "completed", Presentation.Exploration(listOf("sources/auth/callback.ts"))),
                Block.Text("Found it: the callback rewrites the URL **before** the cookie is written.\n\n```ts\nawait setSession(token)\nredirect(next)\n```"),
            ),
        ),
        Message("m3", "agent", 3, listOf(Block.ToolCall("c3", "show_media", "completed", Presentation.Media(listOf(MediaItem("image", "before.png", "image/png", 800.0, 600.0), MediaItem("video", "repro.mp4", "video/mp4")))))),
        Message("f1", "service", 4, listOf(Block.Text("Claude usage limit reached.")), failure = kotlinx.serialization.json.buildJsonObject { put("kind", kotlinx.serialization.json.JsonPrimitive("usage_limit")) }),
    )

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun show(state: ConversationState, connection: String? = null, dark: Boolean = false, actions: ConversationScreenActions = ConversationScreenActions()) {
        rule.setHappyContent(dark) { ConversationScreen(state, connection, actions) }
    }

    @Test fun `a new chat is empty with New chat and only compose in the header`() {
        show(ConversationState(created = false, loaded = true))
        rule.node(ConversationScreenTags.TITLE).assertIsDisplayed()
        rule.onNodeWithText("New chat").assertIsDisplayed()
        rule.node(ConversationScreenTags.EMPTY).assertIsDisplayed()
        rule.node(ConversationScreenTags.COMPOSE).assertIsDisplayed()
        rule.node(ConversationScreenTags.DETAILS).assertDoesNotExist()
        // The composer runs edge to edge, 8 in, above the navigation bar.
        val composer = rule.node(ConversationComposerTags.COMPOSER).bounds
        assertDp("composer left", 0, composer.left)
        assertDp("composer width", 411, composer.width)
        shot("new-chat")
    }

    @Test fun `history renders text, tools, media and a failure, with the connection state in the header`() {
        show(ConversationState(created = true, loaded = true, rows = history, agent = agent, mode = mode), connection = "Offline")
        rule.onNodeWithText("Fix the login redirect").assertIsDisplayed()
        rule.node(ConversationScreenTags.SUBTITLE).assertIsDisplayed()
        rule.onNodeWithText("Offline").assertIsDisplayed()
        rule.node(ConversationScreenTags.DETAILS).assertIsDisplayed()
        rule.node(ConversationRowTags.FAILURE).assertIsDisplayed()
        // The header is the standard 64 bar.
        assertDp("header", 64, rule.node(ConversationScreenTags.BAR).bounds.height)
        shot("history-offline")
    }

    @Test fun `history in dark`() {
        show(ConversationState(created = true, loaded = true, rows = history, agent = agent, mode = mode), dark = true)
        shot("history-dark")
    }

    @Test fun `working shows the working line and Stop on an empty composer`() {
        var stops = 0
        val pending = ConversationRow.User("s:user", "s", "Then update the tests", parseMarkdown("Then update the tests"), emptyList(), Delivery.Pending)
        val state = ConversationState(created = true, loaded = true, rows = listOf(pending) + history, agent = agent.copy(status = "running_tools"), working = true, activity = Activity.RunningTools)
        show(state, actions = ConversationScreenActions(onStop = { stops++ }))
        rule.onNodeWithText("Running tools…").assertIsDisplayed()
        assertEquals(PrimaryAction.Stop, primaryActionOf(false, state))
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        assertEquals(1, stops)
        shot("working")
    }

    @Test fun `typing sends and clears, the draft following each keystroke`() {
        val drafts = ArrayList<String>()
        val sent = ArrayList<String>()
        show(
            ConversationState(created = true, loaded = true, rows = history, agent = agent),
            actions = ConversationScreenActions(onDraftChange = { drafts += it }, onSend = { words, _ -> sent += words; true }),
        )
        rule.node(ConversationComposerTags.INPUT).performTextInput("Ship it")
        assertEquals("Ship it", drafts.last())
        shot("typed")
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        assertEquals(listOf("Ship it"), sent)
        rule.onNodeWithText("Ship it").assertDoesNotExist()
    }

    @Test fun `a failed send offers retry and discard`() {
        val retries = ArrayList<String>()
        val failed = ConversationRow.User("x:user", "x", "Hello", parseMarkdown("Hello"), emptyList(), Delivery.Failed("Unknown model."))
        show(
            ConversationState(created = true, loaded = true, rows = listOf(failed), agent = agent),
            actions = ConversationScreenActions(onRetrySend = { retries += it }),
        )
        rule.onNodeWithText("Not sent: Unknown model.", substring = true).assertIsDisplayed()
        rule.onNodeWithText("Retry").performClick()
        assertEquals(listOf("x"), retries)
        shot("failed-send")
    }

    @Test fun `a question shows over the composer and answers`() {
        val question = Question(
            "q1", "pending", "The billing service needs storage.",
            listOf(Question.Prompt("p1", "Database", "Which database should it use?", false, listOf(Question.Option("PostgreSQL", "Matches the stack."), Question.Option("SQLite", null)), false)),
            null, false,
        )
        show(ConversationState(created = true, loaded = true, rows = history, agent = agent, question = question, activity = Activity.AwaitingAnswer))
        rule.node(ConversationQuestionTags.CARD).assertIsDisplayed()
        rule.onNodeWithText("Waiting for your answer").assertIsDisplayed()
        shot("question")
    }

    @Test fun `the header is the screen's own colour, light and dark`() {
        var dark by mutableStateOf(false)
        rule.setContent {
            com.slopus.happy.ui.theme.HappyTheme(preference = if (dark) com.slopus.happy.ui.theme.ThemePreference.Dark else com.slopus.happy.ui.theme.ThemePreference.Light) {
                ConversationScreen(ConversationState(created = true, loaded = true, rows = history, agent = agent), null, ConversationScreenActions())
            }
        }
        for (mode in listOf(false, true)) {
            dark = mode
            rule.waitForIdle()
            val image = rule.onRoot().captureToImage().asAndroidBitmap()
            val bar = rule.node(ConversationScreenTags.BAR).bounds
            val list = rule.node(ConversationScreenTags.LIST).bounds
            val density = image.width / 411f
            // The bar's right half below its icons, and the list's right edge: both plain background.
            val header = image.getPixel(image.width - 4, ((bar.bottom.value - 2) * density).toInt())
            val content = image.getPixel(image.width - 4, ((list.top.value + 2) * density).toInt())
            assertEquals("dark=$dark", content, header)
            shot(if (dark) "header-dark" else "header-light")
        }
    }

    @Test fun `a failed older page shows Retry`() {
        val asks = ArrayList<Boolean>()
        show(ConversationState(created = true, loaded = true, rows = history, agent = agent, hasMore = true, olderFailed = true), actions = ConversationScreenActions(onLoadOlder = { asks += it }))
        rule.node(ConversationScreenTags.LIST).performScrollToNode(androidx.compose.ui.test.hasTestTag(ConversationScreenTags.OLDER))
        rule.node(ConversationScreenTags.OLDER_FAILED).assertIsDisplayed()
        shot("older-failed")
        rule.node(ConversationScreenTags.OLDER_RETRY).performClick()
        assertEquals(listOf(true), asks)
    }

    @Test fun `a subagent can't take messages`() {
        show(ConversationState(created = true, loaded = true, rows = history, agent = agent.copy(parentAgentId = "p")))
        rule.node(ConversationScreenTags.READ_ONLY).assertIsDisplayed()
        rule.node(ConversationComposerTags.COMPOSER).assertDoesNotExist()
    }

    @Test fun `a chat that could not be read says why`() {
        show(ConversationState(created = true, loaded = true, error = "Could not reach the agent."))
        rule.node(ConversationScreenTags.ERROR).assertIsDisplayed()
        shot("error")
    }

    @Test fun `the composer picks the model, keeping the effort it runs`() {
        val catalog = ModeCatalog(
            listOf(
                ModelChoice("claude", "Current CLI", "claude", "anthropic/opus-5", "Opus 5 1M", listOf("low", "medium", "high", "max"), "high", emptyList()),
                ModelChoice("codex", "Codex", "codex", "openai/gpt-5.6-sol", "GPT-5.6 Sol", listOf("low", "medium", "high", "xhigh"), "medium", listOf("priority")),
            ),
            mode,
        )
        val picks = ArrayList<Mode>()
        show(
            ConversationState(created = true, loaded = true, rows = history, agent = agent, mode = mode, catalog = catalog),
            actions = ConversationScreenActions(onModeChange = { picks += it }),
        )
        rule.onNodeWithText("Opus 5 1M").assertIsDisplayed()
        rule.onNodeWithText("High").assertIsDisplayed()
        rule.onNodeWithText("Auto").assertIsDisplayed()
        rule.node(ConversationComposerTags.ATTACH).assertIsDisplayed()
        shot("modes")
        rule.node(ConversationModeTags.MODEL).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("GPT-5.6 Sol").assertIsDisplayed()
        rule.onNodeWithText("GPT-5.6 Sol").performClick()
        rule.waitForIdle()
        assertEquals(listOf(Mode("codex", "openai/gpt-5.6-sol", "high", null, "auto")), picks)
    }

    @Test fun `the permission sheet lists the four modes`() {
        val picks = ArrayList<Mode>()
        show(
            ConversationState(created = true, loaded = true, rows = history, agent = agent, mode = mode, catalog = ModeCatalog(emptyList(), mode)),
            actions = ConversationScreenActions(onModeChange = { picks += it }),
        )
        rule.node(ConversationModeTags.PERMISSION).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Workspace write").assertIsDisplayed()
        rule.onNodeWithText("Full access").assertIsDisplayed()
        rule.onNodeWithText("Read only").performClick()
        rule.waitForIdle()
        assertEquals(listOf(mode.copy(permissionMode = "read_only")), picks)
    }

    @Test fun `a chief of staff that can't be found says so with Retry`() {
        var retries = 0
        rule.setHappyContent { ChiefOfStaffScreen("There's no Chief of Staff on this computer.", onRetry = { retries++ }, onBack = {}) }
        rule.onNodeWithText("Chief of Staff").assertIsDisplayed()
        rule.node(ConversationScreenTags.RETRY).performClick()
        assertEquals(1, retries)
        shot("chief-missing")
    }

    @Test fun `a prefilled composer shows the kept draft below the prefix`() {
        val prefix = "Change this agent connection's name to "
        show(
            ConversationState(
                created = true, loaded = true, rows = history, agent = agent, mode = mode,
                draft = prefix + "\n\nkeep me", draftArrivals = 1,
                composerFocus = ComposerFocus(1, prefix.length),
            ),
        )
        rule.onNodeWithText(prefix + "\n\nkeep me").assertIsDisplayed()
        shot("prefilled")
    }

    @Test fun `details list the agent and its mode`() {
        rule.setHappyContent { ConversationDetailsScreen(agent.copy(subagentsRunning = 1), mode, null) {} }
        rule.onNodeWithText("anthropic/opus-5").assertIsDisplayed()
        rule.onNodeWithText("1 running of 2").assertIsDisplayed()
        shot("details")
    }
}

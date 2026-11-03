package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.LinkState
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ComposerFocus
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.conversation.Problem
import com.slopus.happy.conversation.AskPhase
import com.slopus.happy.conversation.Question
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.LinkStatusTags
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.node
import com.slopus.happy.ui.chat.DeliveryTags
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.setHappyContent
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import androidx.compose.ui.test.onAllNodesWithTag
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
                Block.ToolCall("c2", "Read", "completed", Presentation.Exploration.reads("sources/auth/callback.ts")),
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

    @Test
    @Config(qualifiers = "w900dp-h731dp-xhdpi")
    fun `at 900 the composer and the bar are held to the messages' 800 column`() {
        val state = ConversationState(created = true, loaded = true, rows = history, agent = agent, mode = mode)
        rule.setHappyContent { ProvideWindowLayout { ConversationScreen(state, null, ConversationScreenActions()) } }
        val composer = rule.node(ConversationComposerTags.COMPOSER).bounds
        assertDp("composer width", 800, composer.width)
        assertDp("composer centred", 50, composer.left)
        // The bar too, so its glyphs sit on the messages' keyline; its glass still spans the window.
        assertDp("bar on the column", 800, rule.node(ConversationScreenTags.BAR).bounds.width)
        assertDp("bar centred", 50, rule.node(ConversationScreenTags.BAR).bounds.left)
    }

    @Test fun `an opened chat has home's name from its first frame, and is never called New chat`() {
        // The first frame: nothing read yet, the name home showed on the row.
        show(ConversationState(created = true, loaded = false, knownTitle = "Chief of Staff"))
        rule.node(ConversationScreenTags.TITLE).assertTextEquals("Chief of Staff")
        rule.onNodeWithText("New chat").assertDoesNotExist()
    }

    @Test fun `an opened chat home has no name for is blank until read, not New chat`() {
        show(ConversationState(created = true, loaded = false))
        rule.node(ConversationScreenTags.TITLE).assertTextEquals("")
        rule.onNodeWithText("New chat").assertDoesNotExist()
    }

    @Test fun `a new chat asks Task or Bot, with Back and overflow alone in the header`() {
        show(ConversationState(created = false, loaded = true, newWork = com.slopus.happy.conversation.NewWork(com.slopus.happy.conversation.WorkChoice())))
        // No name and no compose until the first send (iOS 323fb2e9f); the overflow keeps the permission mode.
        rule.onNodeWithText("New chat").assertDoesNotExist()
        rule.node(ConversationScreenTags.TITLE_BUTTON).assertDoesNotExist()
        rule.node(ConversationScreenTags.BACK).assertIsDisplayed()
        rule.node(com.slopus.happy.ui.chat.NewWorkTags.PANEL).assertIsDisplayed()
        rule.node(ConversationScreenTags.EMPTY).assertDoesNotExist()
        rule.node(ConversationScreenTags.COMPOSE).assertDoesNotExist()
        rule.node(ConversationScreenTags.MORE).assertIsDisplayed()
        rule.node(ConversationScreenTags.DETAILS).assertDoesNotExist()
        // The composer runs edge to edge, 8 in, above the navigation bar.
        val composer = rule.node(ConversationComposerTags.COMPOSER).bounds
        assertDp("composer left", 0, composer.left)
        assertDp("composer width", 411, composer.width)
        shot("new-chat")
    }

    @Test fun `the name, status and compose fade in with the first send`() {
        var created by androidx.compose.runtime.mutableStateOf(false)
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = created, loaded = true, knownTitle = "Fix it", newWork = if (created) null else com.slopus.happy.conversation.NewWork(com.slopus.happy.conversation.WorkChoice())),
                null,
                ConversationScreenActions(),
            )
        }
        rule.node(ConversationScreenTags.TITLE_BUTTON).assertDoesNotExist()
        fun darkestNow(): Int {
            val image = rule.onRoot().captureToImage().asAndroidBitmap()
            val title = rule.node(ConversationScreenTags.TITLE).bounds
            val density = image.width / 411f
            return ((title.left.value * density).toInt() until (title.right.value * density).toInt()).minOf { x ->
                ((title.top.value * density).toInt() until (title.bottom.value * density).toInt()).minOf { y -> image.getPixel(x, y) and 0xff }
            }
        }
        rule.mainClock.autoAdvance = false
        created = true
        // Frame by frame, as the screen draws them: from the fade's first frame to half its time.
        var frames = 0
        while (darkestNow() == 0xff && frames++ < 10) rule.mainClock.advanceTimeByFrame()
        repeat(ConversationHeaderSpec.FADE_MILLIS / 2 / 16) { rule.mainClock.advanceTimeByFrame() }
        val half = darkestNow()
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        val whole = darkestNow()
        // Ease-out: more than half shown at half the time, and black once over.
        assertTrue("half way: $half, then $whole", half in 0x10 until 0x80 && whole < 0x10)
        rule.node(ConversationScreenTags.TITLE).assertTextEquals("Fix it")
        rule.node(ConversationScreenTags.COMPOSE).assertIsDisplayed()
    }

    @Test fun `history renders text, tools, media and a failure, with the connection state in the header`() {
        show(ConversationState(created = true, loaded = true, rows = history, agent = agent, mode = mode), connection = "Offline")
        rule.onNodeWithText("Fix the login redirect").assertIsDisplayed()
        rule.node(ConversationScreenTags.SUBTITLE).assertIsDisplayed()
        rule.onNodeWithText("Offline").assertIsDisplayed()
        rule.node(ConversationScreenTags.DETAILS).assertDoesNotExist()
        rule.node(ConversationScreenTags.MORE).assertIsDisplayed()
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

    @Test fun `the working line is the bar's, and starting work doesn't move the transcript`() {
        var state by mutableStateOf(ConversationState(created = true, loaded = true, rows = history, agent = agent))
        rule.setHappyContent { ConversationScreen(state, null, ConversationScreenActions()) }
        val bar = rule.node(ConversationScreenTags.BAR).bounds
        val list = rule.node(ConversationScreenTags.LIST).bounds
        rule.node(ConversationScreenTags.SUBTITLE).assertExists()
        rule.onNodeWithText("online").assertIsDisplayed()
        state = state.copy(working = true, activity = Activity.WaitingForModel)
        rule.waitForIdle()
        // Neither the bar nor the transcript gives up any room for it.
        assertEquals(bar, rule.node(ConversationScreenTags.BAR).bounds)
        assertEquals(list, rule.node(ConversationScreenTags.LIST).bounds)
        // And it is under the title, in the content nowhere.
        rule.onNodeWithText("Waiting for the model…").assertIsDisplayed()
        rule.node(ConversationScreenTags.SUBTITLE).assertIsDisplayed()
        shot("working-line")
    }

    @Test fun `the link and the work coming and going move neither the title nor the transcript`() {
        var state by mutableStateOf(ConversationState(created = true, loaded = true, rows = history, agent = agent))
        var connection by mutableStateOf<String?>(null)
        var link by mutableStateOf(LinkState.Online)
        rule.setHappyContent { ConversationScreen(state, connection, ConversationScreenActions(), link = link) }
        val bar = rule.node(ConversationScreenTags.BAR).bounds
        val title = rule.node(ConversationScreenTags.TITLE).bounds
        val list = rule.node(ConversationScreenTags.LIST).bounds
        val idle = state
        // (offline words, link, activity, chat syncing)
        val flips = listOf<Flip>(
            Flip(null, LinkState.Connecting, null, false), Flip(null, LinkState.Online, null, false),
            Flip("offline", LinkState.Offline, Activity.Thinking, false), Flip(null, LinkState.Online, Activity.Thinking, true),
            Flip(null, LinkState.WaitingForNetwork, Activity.Thinking, false), Flip(null, LinkState.Online, Activity.AwaitingAnswer, false),
            Flip(null, LinkState.Syncing, Activity.AwaitingAnswer, false), Flip(null, LinkState.Online, null, false),
        )
        for (flip in flips) {
            val at = "${flip.link}, ${flip.activity ?: "idle"}, syncing ${flip.syncing}"
            rule.mainClock.autoAdvance = false
            connection = flip.words
            link = flip.link
            state = idle.copy(working = flip.activity != null, activity = flip.activity, syncing = flip.syncing)
            Snapshot.sendApplyNotifications()
            rule.mainClock.advanceTimeByFrame()
            rule.mainClock.advanceTimeBy(64)
            assertTrue("the line is on its way, $at", rule.onAllNodesWithTag(ConversationScreenTags.SUBTITLE, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
            assertEquals("bar, fading to $at", bar, rule.node(ConversationScreenTags.BAR).bounds)
            assertEquals("title, fading to $at", title, rule.node(ConversationScreenTags.TITLE).bounds)
            rule.mainClock.autoAdvance = true
            rule.waitForIdle()
            assertEquals("bar, $at", bar, rule.node(ConversationScreenTags.BAR).bounds)
            assertEquals("title, $at", title, rule.node(ConversationScreenTags.TITLE).bounds)
            assertEquals("transcript, $at", list, rule.node(ConversationScreenTags.LIST).bounds)
            rule.node(ConversationScreenTags.SUBTITLE).assertExists()
            val label = flip.words ?: when {
                flip.link == LinkState.Connecting -> "connecting…"
                flip.link == LinkState.WaitingForNetwork -> "waiting for network…"
                flip.link == LinkState.Syncing || flip.syncing -> "updating…"
                flip.activity == Activity.Thinking -> "Thinking…"
                flip.activity == Activity.AwaitingAnswer -> "Waiting for your answer"
                else -> "online"
            }
            rule.onNodeWithText(label, useUnmergedTree = true).assertExists()
            // The link on its way, or the chat catching up, turns a spinner before the words (iOS 7aee3a9b8).
            val spins = label.endsWith("…") && label != "Thinking…"
            assertEquals("spinner, $at", spins, rule.onAllNodesWithTag(LinkStatusTags.SPINNER, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        }
    }

    private data class Flip(val words: String?, val link: LinkState, val activity: Activity?, val syncing: Boolean)

    @Test fun `a link on its way says so with a 14 spinner 5 before its words`() {
        rule.setHappyContent {
            ConversationScreen(ConversationState(created = true, loaded = true, rows = history, agent = agent), null, ConversationScreenActions(), link = LinkState.Connecting)
        }
        val spinner = rule.node(LinkStatusTags.SPINNER).bounds
        val words = rule.onNodeWithText("connecting…", useUnmergedTree = true).bounds
        assertDp("14 wide", 14, spinner.right - spinner.left)
        assertDp("14 high", 14, spinner.bottom - spinner.top)
        assertDp("5 before the words", 5, words.left - spinner.right)
        assertDp("centred on their line", (words.top + words.bottom) / 2, (spinner.top + spinner.bottom) / 2)
        shot("link-connecting")
    }

    @Test fun `a sent message stays in view, and reading older history is left alone`() {
        var rows by mutableStateOf(history)
        rule.setHappyContent {
            ConversationScreen(ConversationState(created = true, loaded = true, rows = rows, agent = agent, hasMore = true), null, ConversationScreenActions())
        }
        // At the newest end: the message just sent is the one on screen.
        val sent = ConversationRow.User("s:user", "s", "Ship it", parseMarkdown("Ship it"), emptyList(), Delivery.Sending)
        rows = listOf(sent) + history
        rule.waitForIdle()
        rule.onNodeWithText("Ship it").assertIsDisplayed()
        shot("sent-in-view")
        // Reading older history: a row arriving at the newest end doesn't move the page.
        rule.node(ConversationScreenTags.LIST).performScrollToNode(hasTestTag(ConversationScreenTags.OLDER))
        rule.waitForIdle()
        val older = rule.onNodeWithText("The login page loops back", substring = true).bounds
        rows = listOf(ConversationRow.Text("a:0", "And again", parseMarkdown("And again"))) + rows
        rule.waitForIdle()
        assertEquals(older, rule.onNodeWithText("The login page loops back", substring = true).bounds)
        rule.onNodeWithText("And again").assertDoesNotExist()
    }

    @Test fun `a failed send offers retry and discard`() {
        val retries = ArrayList<String>()
        val failed = ConversationRow.User("x:user", "x", "Hello", parseMarkdown("Hello"), emptyList(), Delivery.Failed(Problem.Said("Unknown model.")))
        show(
            ConversationState(created = true, loaded = true, rows = listOf(failed), agent = agent),
            actions = ConversationScreenActions(onRetrySend = { retries += it }),
        )
        // iOS 65f9eb1a0: the red mark says it, with no line under the bubble; a tap sends it again.
        rule.onNodeWithText("Not sent: Unknown model.", substring = true).assertDoesNotExist()
        rule.onNode(hasTestTag(DeliveryTags.MARK) and hasStateDescription("Message failed to send."), useUnmergedTree = true).assertExists()
        rule.node(MessageTags.USER_BUBBLE).performClick()
        assertEquals(listOf("x"), retries)
        shot("failed-send")
    }

    @Test fun `a question waits in the transcript, not over the composer`() {
        val question = Question(
            "q1", "pending", "The billing service needs storage.",
            listOf(Question.Prompt("p1", "Database", "Which database should it use?", false, listOf(Question.Option("PostgreSQL", "Matches the stack."), Question.Option("SQLite", null)), null)),
            null, false,
        )
        val rows = listOf(ConversationRow.Ask(ConversationRowBuilder.askKey("q1"), question, AskPhase.Pending)) + history
        show(ConversationState(created = true, loaded = true, rows = rows, agent = agent, question = question, activity = Activity.AwaitingAnswer))
        rule.node(ConversationQuestionTags.CARD).assertDoesNotExist()
        rule.node(AskTags.ROW).assertIsDisplayed()
        rule.onNodeWithText("Waiting for your answer").assertIsDisplayed()
        shot("question")
    }

    @Test fun `the header is the screen's own colour, light and dark`() {
        var dark by mutableStateOf(false)
        var surface = 0
        rule.setContent {
            com.slopus.happy.ui.theme.HappyTheme(preference = if (dark) com.slopus.happy.ui.theme.ThemePreference.Dark else com.slopus.happy.ui.theme.ThemePreference.Light) {
                surface = com.slopus.happy.ui.theme.HappyTheme.colors.surface.toArgb()
                // The newest rows only, so no row lies under the bar's right edge, where its colour is read.
                ConversationScreen(ConversationState(created = true, loaded = true, rows = history.take(2), agent = agent), null, ConversationScreenActions())
            }
        }
        for (mode in listOf(false, true)) {
            dark = mode
            rule.waitForIdle()
            val image = rule.onRoot().captureToImage().asAndroidBitmap()
            val bar = rule.node(ConversationScreenTags.BAR).bounds
            val density = image.width / 411f
            // The bar's right half below its icons: the screen's own background. The bar is glass over
            // the list, so its ground composites over the same colour and may round a step off it.
            val header = image.getPixel(image.width - 4, ((bar.bottom.value - 2) * density).toInt())
            for (shift in listOf(16, 8, 0)) {
                val step = (header shr shift and 0xff) - (surface shr shift and 0xff)
                assertTrue("dark=$dark: #${Integer.toHexString(header)} vs #${Integer.toHexString(surface)}", step in -1..1)
            }
            shot(if (dark) "header-dark" else "header-light")
        }
    }

    @Test fun `a failed older page shows Retry`() {
        val asks = ArrayList<Boolean>()
        show(ConversationState(created = true, loaded = true, rows = history, agent = agent, hasMore = true, olderFailed = true), actions = ConversationScreenActions(onLoadOlder = { asks += it }))
        rule.node(ConversationScreenTags.LIST).performScrollToNode(androidx.compose.ui.test.hasTestTag(ConversationScreenTags.OLDER))
        // On to the very top, so the row is clear of the glass bar lying over the list's top. The
        // drag starts mid-list: the bar takes touches on itself, as it should.
        rule.node(ConversationScreenTags.LIST).performTouchInput { swipe(center, bottomCenter) }
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
        show(ConversationState(created = true, loaded = true, error = Problem.Said("Could not reach the agent.")))
        rule.node(ConversationScreenTags.ERROR).assertIsDisplayed()
        shot("error")
    }

    @Test fun `the composer picks the model, at the model's own effort`() {
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
        // ChatGPT's Work composer: at rest no chips; in use, the model and effort chips beside send.
        rule.node(ConversationModeTags.MODEL).assertDoesNotExist()
        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
        rule.onNodeWithText("Opus 5 1M", substring = true).assertIsDisplayed()
        rule.onNodeWithText("High", substring = true).assertIsDisplayed()
        shot("modes")
        rule.node(ConversationModeTags.MODEL).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("GPT-5.6 Sol").assertIsDisplayed()
        rule.onNodeWithText("GPT-5.6 Sol").performClick()
        rule.waitForIdle()
        // Another model runs at its own default effort, never one carried over (desktop's happyAgentSelectionModelUpdate).
        assertEquals(listOf(Mode("codex", "openai/gpt-5.6-sol", "medium", null, "auto")), picks)
        // [+] is exclusively attachments; permissions live in the header overflow.
        rule.node(ConversationComposerTags.MORE).performClick()
        rule.waitForIdle()
        rule.node(ConversationModeTags.PERMISSION).assertDoesNotExist()
        rule.node(com.slopus.happy.ui.attach.AttachTags.SHEET).assertExists()
    }

    @Test fun `the header permission picker lists the four modes`() {
        val picks = ArrayList<Mode>()
        show(
            ConversationState(created = true, loaded = true, rows = history, agent = agent, mode = mode, catalog = ModeCatalog(emptyList(), mode)),
            actions = ConversationScreenActions(onModeChange = { picks += it }),
        )
        rule.node(ConversationScreenTags.MORE).performClick()
        rule.waitForIdle()
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
        rule.onNodeWithText("Retry").performClick()
        assertEquals(1, retries)
        shot("chief-missing")
    }

    @Test fun `a chief of staff being looked up is titled with the name its computer gives it`() {
        rule.setHappyContent { ChiefOfStaffScreen(null, onRetry = {}, onBack = {}, name = "Happy") }
        rule.onNodeWithText("Happy").assertIsDisplayed()
        rule.onAllNodesWithText("Chief of Staff").assertCountEquals(0)
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

    @Test fun `a video is a tile that opens the viewer`() {
        val ref = MediaRef("c3", 1, MediaItem("video", "repro.mp4", "video/mp4"))
        val opened = ArrayList<String>()
        rule.setHappyContent {
            ConversationRowView(
                ConversationRow.Media("m:0", listOf(ref)),
                userMessageBubblePalette(null, false),
                ConversationRowActions(
                    legacy = MessageCallbacks(),
                    onRetryFailure = {},
                    loadMedia = { ByteArray(0) },
                    onOpenPicture = { opened += it },
                    onOpenMedia = { error("a video is no file card") },
                ),
            )
        }
        // No longer a file card handed to another app: a tile, played in the viewer.
        rule.onNodeWithText("repro.mp4").assertDoesNotExist()
        rule.node(ConversationRowTags.MEDIA_FILE).assertDoesNotExist()
        rule.node(ConversationMediaTags.PLAY).assertIsDisplayed()
        rule.node(ConversationMediaTags.TILE).performClick()
        assertEquals(listOf("conversation/media/c3/1"), opened)
    }

    @Test fun `a file nothing can read says so on its card`() {
        val ref = MediaRef("c3", 1, MediaItem("file", "repro.key", "application/x-iwork-keynote-sffkey"))
        rule.setHappyContent {
            ConversationRowView(
                ConversationRow.Media("m:0", listOf(ref)),
                userMessageBubblePalette(null, false),
                ConversationRowActions(
                    legacy = MessageCallbacks(),
                    onRetryFailure = {},
                    loadMedia = { ByteArray(0) },
                    onOpenMedia = {},
                    mediaOpening = { MediaOpening.Failed("Nothing on this phone opens this kind of file.") },
                ),
            )
        }
        rule.onNodeWithText("Nothing on this phone opens this kind of file.").assertIsDisplayed()
        shot("media-no-app")
    }

    @Test fun `a person's six photos show four, and the viewer pages through all six`() {
        val photos = listOf(android.graphics.Color.RED, android.graphics.Color.GREEN, android.graphics.Color.BLUE, android.graphics.Color.CYAN, android.graphics.Color.MAGENTA, android.graphics.Color.YELLOW).map { color ->
            val png = java.io.ByteArrayOutputStream()
                .also { Bitmap.createBitmap(120, 90, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }.compress(Bitmap.CompressFormat.PNG, 100, it) }
                .toByteArray()
            Block.Image("image/png", android.util.Base64.encodeToString(png, android.util.Base64.NO_WRAP))
        }
        show(ConversationState(created = true, loaded = true, rows = rows(Message("p6", "user", 1, listOf(Block.Text("The six screens")) + photos)), agent = agent))
        assertEquals(4, rule.onAllNodes(hasTestTag(ConversationMediaTags.TILE), useUnmergedTree = true).fetchSemanticsNodes().size)
        rule.onNodeWithText("+2", useUnmergedTree = true).assertIsDisplayed()
        shot("pictures-user-six")
        rule.node(ConversationMediaTags.MORE).performClick()
        rule.waitForIdle()
        fun inView(position: String) = rule.onNode(
            hasTestTag(PictureViewerTags.IMAGE) and hasAnyAncestor(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, position)),
            useUnmergedTree = true,
        )
        inView("4 of 6").assertExists()
        rule.node(PictureViewerTags.VIEWER).performTouchInput { swipeLeft() }
        rule.waitForIdle()
        rule.node(PictureViewerTags.VIEWER).performTouchInput { swipeLeft() }
        rule.waitForIdle()
        // The sixth, which the row never showed, is the picture in view.
        inView("6 of 6").assertExists()
        rule.waitUntil(5_000) {
            val viewer = rule.node(PictureViewerTags.VIEWER).captureToImage().asAndroidBitmap()
            viewer.getPixel(viewer.width / 2, viewer.height / 2) == android.graphics.Color.YELLOW
        }
        shot("picture-viewer-sixth")
    }

    @Test fun `a picture in the transcript opens full screen and closes`() {
        val png = java.io.ByteArrayOutputStream()
            .also { Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.GREEN) }.compress(Bitmap.CompressFormat.PNG, 100, it) }
            .toByteArray()
        val data = android.util.Base64.encodeToString(png, android.util.Base64.NO_WRAP)
        show(ConversationState(created = true, loaded = true, rows = rows(Message("p1", "user", 1, listOf(Block.Image("image/png", data)))), agent = agent))
        rule.node(ConversationMediaTags.TILE).performClick()
        rule.waitForIdle()
        rule.node(PictureViewerTags.IMAGE).assertIsDisplayed()
        shot("picture-viewer")
        rule.node(PictureViewerTags.CLOSE).performClick()
        rule.waitForIdle()
        rule.node(PictureViewerTags.VIEWER).assertDoesNotExist()
    }

    /** A question long enough to fill any cap, over a chat with history. */
    private fun tallQuestion() {
        val question = Question(
            "q2", "pending", (1..12).joinToString("\n\n") { "Step $it of the migration touches another table." },
            // A secret's form is the one question still over the composer.
            listOf(Question.Prompt("p1", "Plan", "Which key should the migration use?", false, emptyList(), Question.SecretRequest("stripe", "Billing's key.", listOf(Question.SecretVariable("STRIPE_KEY", null))))),
            null, false,
        )
        show(ConversationState(created = true, loaded = true, rows = history, agent = agent, question = question, activity = Activity.AwaitingAnswer))
    }

    /** The card at most half the screen and 360, with the bar above it and the composer below it, whole. */
    private fun assertQuestionLeavesRoom(screenHeight: Int, name: String) {
        val screen = rule.onRoot().bounds
        val card = rule.node(ConversationQuestionTags.CARD).assertIsDisplayed().bounds
        val bar = rule.node(ConversationScreenTags.BAR).assertIsDisplayed().bounds
        val composer = rule.node(ConversationComposerTags.COMPOSER).assertIsDisplayed().bounds
        // The cap is on the card itself: what the tag reports is the card.
        assertDp("card height", minOf(360.dp, screenHeight.dp / 2), card.height)
        assertEquals("bar on screen", true, bar.top >= screen.top && bar.bottom <= card.top)
        assertEquals("composer on screen", true, composer.top >= card.bottom && composer.bottom <= screen.bottom)
        shot(name)
    }

    @Config(qualifiers = "w411dp-h731dp-xxhdpi")
    @Test fun `on a 731dp phone a long question stays at 360 over the composer`() {
        tallQuestion()
        assertQuestionLeavesRoom(731, "question-cap-731")
    }

    @Config(qualifiers = "w731dp-h411dp-xxhdpi")
    @Test fun `on a 411dp-tall screen a long question takes half and keeps the composer`() {
        tallQuestion()
        assertQuestionLeavesRoom(411, "question-cap-411")
    }
}

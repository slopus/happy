package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Artifact
import com.slopus.happy.conversation.ArtifactFile
import com.slopus.happy.conversation.ArtifactView
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
import com.slopus.happy.conversation.Question
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.node
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

    @Test
    @Config(qualifiers = "w900dp-h731dp-xhdpi")
    fun `at 900 the composer is held to the messages' 800 column and the bar is not`() {
        val state = ConversationState(created = true, loaded = true, rows = history, agent = agent, mode = mode)
        rule.setHappyContent { ProvideWindowLayout { ConversationScreen(state, null, ConversationScreenActions()) } }
        val composer = rule.node(ConversationComposerTags.COMPOSER).bounds
        assertDp("composer width", 800, composer.width)
        assertDp("composer centred", 50, composer.left)
        assertDp("bar full width", 900, rule.node(ConversationScreenTags.BAR).bounds.width)
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

    @Test fun `a new chat is empty with compose and overflow in the header`() {
        show(ConversationState(created = false, loaded = true))
        rule.node(ConversationScreenTags.TITLE).assertIsDisplayed()
        rule.onNodeWithText("New chat").assertIsDisplayed()
        rule.node(ConversationScreenTags.EMPTY).assertIsDisplayed()
        rule.node(ConversationScreenTags.COMPOSE).assertIsDisplayed()
        rule.node(ConversationScreenTags.MORE).assertIsDisplayed()
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
        rule.setHappyContent { ConversationScreen(state, connection, ConversationScreenActions()) }
        val bar = rule.node(ConversationScreenTags.BAR).bounds
        val title = rule.node(ConversationScreenTags.TITLE).bounds
        val list = rule.node(ConversationScreenTags.LIST).bounds
        val idle = state
        val flips = listOf<Triple<String?, Activity?, Boolean>>(
            Triple("connecting", null, false), Triple(null, null, false),
            Triple("offline", Activity.Thinking, false), Triple(null, Activity.Thinking, true),
            Triple(null, Activity.Thinking, false), Triple(null, Activity.AwaitingAnswer, false),
            Triple("connecting", Activity.AwaitingAnswer, false), Triple(null, null, false),
        )
        for ((link, activity, syncing) in flips) {
            val at = "${link ?: "live"}, ${activity ?: "idle"}"
            rule.mainClock.autoAdvance = false
            connection = link
            state = idle.copy(working = activity != null, activity = activity, syncing = syncing)
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
            val label = link ?: when {
                syncing -> "syncing"
                activity == Activity.Thinking -> "Thinking…"
                activity == Activity.AwaitingAnswer -> "Waiting for your answer"
                else -> "online"
            }
            rule.onNodeWithText(label, useUnmergedTree = true).assertExists()
        }
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
            listOf(Question.Prompt("p1", "Database", "Which database should it use?", false, listOf(Question.Option("PostgreSQL", "Matches the stack."), Question.Option("SQLite", null)), null)),
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
        // ChatGPT's Work composer: at rest no label; in use, model and effort as one label beside send.
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
        assertEquals(listOf(Mode("codex", "openai/gpt-5.6-sol", "high", null, "auto")), picks)
        // [+] is exclusively attachments; permissions live in the header overflow.
        rule.node(ConversationComposerTags.MORE).performClick()
        rule.waitForIdle()
        rule.node(ConversationModeTags.PERMISSION).assertDoesNotExist()
        rule.node(ConversationComposerTags.ATTACH).assertIsDisplayed()
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

    @Test fun `a video is opened by tapping it, and says so when nothing reads it`() {
        val ref = MediaRef("c3", 1, MediaItem("video", "repro.mp4", "video/mp4"))
        val opened = ArrayList<String>()
        fun card(opening: MediaOpening?) = @Composable {
            ConversationRowView(
                ConversationRow.Media("m:0", listOf(ref)),
                userMessageBubblePalette(null, false),
                ConversationRowActions(
                    legacy = MessageCallbacks(),
                    onRetryFailure = {},
                    loadMedia = { ByteArray(0) },
                    onOpenMedia = { opened += it.key },
                    mediaOpening = { opening },
                ),
            )
        }
        rule.setHappyContent(content = card(null))
        // No longer a desktop-only card: it is the thing you tap.
        rule.onNodeWithText("Videos play in Happy Agent on your computer.").assertDoesNotExist()
        rule.node(ConversationRowTags.MEDIA_FILE).performClick()
        assertEquals(listOf("c3/1"), opened)
    }

    @Test fun `a video nothing can read says so on its card`() {
        val ref = MediaRef("c3", 1, MediaItem("video", "repro.mp4", "video/mp4"))
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

    @Test fun `a picture in the transcript opens full screen and closes`() {
        val png = java.io.ByteArrayOutputStream()
            .also { Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.GREEN) }.compress(Bitmap.CompressFormat.PNG, 100, it) }
            .toByteArray()
        val data = android.util.Base64.encodeToString(png, android.util.Base64.NO_WRAP)
        show(ConversationState(created = true, loaded = true, rows = rows(Message("p1", "user", 1, listOf(Block.Image("image/png", data)))), agent = agent))
        rule.node(ConversationRowTags.PICTURE).performClick()
        rule.waitForIdle()
        rule.node(PictureViewerTags.IMAGE).assertIsDisplayed()
        shot("picture-viewer")
        rule.node(PictureViewerTags.CLOSE).performClick()
        rule.waitForIdle()
        rule.node(PictureViewerTags.VIEWER).assertDoesNotExist()
    }

    @Test fun `an artifact's words are read here`() {
        val words = Artifact("r7", "markdown", "Release notes", 2, "index.md", listOf(ArtifactFile("index.md", "text/markdown", 12)), false, false)
        rule.setHappyContent {
            ArtifactScreen(ArtifactContent.Ready(words, ArtifactView.Words("# Ready\n\nIt all passed."), emptyMap()), {}, {}, { _, _, _ -> }, {})
        }
        rule.onNodeWithText("Release notes").assertIsDisplayed()
        rule.onNodeWithText("It all passed.").assertIsDisplayed()
        shot("artifact-words")
    }

    @Test fun `an artifact kind this build doesn't draw says where it opens`() {
        val page = Artifact("r8", "html", "Dashboard", 1, "index.html", listOf(ArtifactFile("index.html", "text/html", 40)), false, false)
        rule.setHappyContent { ArtifactScreen(ArtifactContent.Ready(page, ArtifactView.NotHere("html"), emptyMap()), {}, {}, { _, _, _ -> }, {}) }
        rule.node(ArtifactTags.NOT_HERE).assertIsDisplayed()
        rule.onNodeWithText("Happy Agent on your computer", substring = true).assertIsDisplayed()
        shot("artifact-not-here")
    }

    @Test fun `an artifact that couldn't be read says why, with Retry`() {
        var retries = 0
        rule.setHappyContent { ArtifactScreen(ArtifactContent.Failed("Could not reach the agent."), {}, { retries++ }, { _, _, _ -> }, {}) }
        rule.onNodeWithText("Could not reach the agent.").assertIsDisplayed()
        rule.onNodeWithText("Retry").performClick()
        assertEquals(1, retries)
        shot("artifact-failed")
    }

    /** A question long enough to fill any cap, over a chat with history. */
    private fun tallQuestion() {
        val question = Question(
            "q2", "pending", (1..12).joinToString("\n\n") { "Step $it of the migration touches another table." },
            listOf(Question.Prompt("p1", "Plan", "Which order should the tables move in?", false, emptyList(), null)),
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

    @Test fun `details list the agent and its mode`() {
        rule.setHappyContent { ConversationDetailsScreen(agent.copy(subagentsRunning = 1), mode, null) {} }
        rule.onNodeWithText("anthropic/opus-5").assertIsDisplayed()
        rule.onNodeWithText("1 running of 2").assertIsDisplayed()
        shot("details")
    }
}

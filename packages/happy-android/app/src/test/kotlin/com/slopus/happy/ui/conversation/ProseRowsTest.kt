package com.slopus.happy.ui.conversation

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.ProvideLinks
import com.slopus.happy.ui.chat.AgentMessage
import com.slopus.happy.ui.chat.MarkdownTags
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.chat.UserMessage
import com.slopus.happy.chat.UserDisplay
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * The transcript's drawn text rows (research/telegram-chat.md, phase 3):
 * laid out off the main thread ([Typesetter]), drawn as one node a segment,
 * and still what AgentMessage, MarkdownView and the bubble were: the same
 * pixels, links, semantics and selection.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ProseRowsTest {
    @get:Rule
    val rule = createComposeRule()

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val typesetter: Typesetter get() = Typesetter.of(context)
    private val bubble = userMessageBubblePalette(null, false)
    private val actions = ConversationRowActions(MessageCallbacks(), onRetryFailure = {}, loadMedia = { ByteArray(0) })

    private val markdown = """
        ## Found it
        The callback rewrites the URL **before** the cookie is written, so the guard sends the reader back to `/login`. See [the auth docs](https://example.com/auth) for more.

        - a first point that is long enough to wrap onto a second line on a phone
        - second
          - nested, *in italics*

        1. one
        2. two

        ---

        ```ts
        await setSession(token)
        ```

        Last paragraph after the code.
    """.trimIndent()

    @After fun relax() {
        ProseThread.strict = false
        ProseSelection.selected = null
    }

    /** Lays [rows] out as a conversation's lane does: off the main thread, before they are shown. */
    private fun prepare(rows: List<ConversationRow>) {
        var failure: Throwable? = null
        Thread { try { typesetter.prepare(rows) } catch (e: Throwable) { failure = e } }.apply { start(); join() }
        failure?.let { throw it }
    }

    private fun shot(name: String, image: Bitmap) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun `a drawn answer is today's AgentMessage, pixel for pixel, light and dark`() {
        var dark by mutableStateOf(false)
        var drawn by mutableStateOf(true)
        rule.setContent {
            com.slopus.happy.ui.theme.HappyTheme(preference = if (dark) com.slopus.happy.ui.theme.ThemePreference.Dark else com.slopus.happy.ui.theme.ThemePreference.Light) {
                val row = ConversationRow.Text("parity:0", markdown, parseMarkdown(markdown))
                androidx.compose.foundation.layout.Box(Modifier.background(com.slopus.happy.ui.theme.HappyTheme.colors.surface)) {
                    if (drawn) {
                        ConversationRowView(row, bubble, actions)
                    } else {
                        Box(Modifier.fillMaxWidth().testTag(ConversationRowTags.ROW)) {
                            AgentMessage(ChatRow.AgentText(ChatMessage.AgentText(row.key, 0, row.text), row.blocks), MessageCallbacks(), Modifier.contentMaxWidth(LocalWindowLayout.current))
                        }
                    }
                }
            }
        }
        for (mode in listOf(false, true)) {
            dark = mode
            drawn = true
            rule.waitForIdle()
            val ours = rule.node(ConversationRowTags.ROW).captureToImage().asAndroidBitmap()
            drawn = false
            rule.waitForIdle()
            val today = rule.node(ConversationRowTags.ROW).captureToImage().asAndroidBitmap()
            shot("prose-answer-${if (mode) "dark" else "light"}", ours)
            assertEquals("height", today.height, ours.height)
            assertEquals("width", today.width, ours.width)
            var different = 0
            for (y in 0 until ours.height) for (x in 0 until ours.width) if (ours.getPixel(x, y) != today.getPixel(x, y)) different++
            assertEquals("pixels that differ from AgentMessage's, dark=$mode", 0, different)
        }
    }

    @Test fun `a row drawn ahead on the lane plays back as AgentMessage, and is drawn again for a new theme`() {
        val row = ConversationRow.Text("ahead:0", markdown, parseMarkdown(markdown))
        val source = typesetter.sourceOf(row)!!
        var dark by mutableStateOf(false)
        var drawn by mutableStateOf(false)
        ProseThread.strict = true
        rule.setContent {
            com.slopus.happy.ui.theme.HappyTheme(preference = if (dark) com.slopus.happy.ui.theme.ThemePreference.Dark else com.slopus.happy.ui.theme.ThemePreference.Light) {
                androidx.compose.foundation.layout.Box(Modifier.background(com.slopus.happy.ui.theme.HappyTheme.colors.surface)) {
                    if (drawn) {
                        ConversationRowView(row, bubble, actions)
                    } else {
                        Box(Modifier.fillMaxWidth().testTag(ConversationRowTags.ROW)) {
                            AgentMessage(ChatRow.AgentText(ChatMessage.AgentText(row.key, 0, row.text), row.blocks), MessageCallbacks(), Modifier.contentMaxWidth(LocalWindowLayout.current))
                        }
                    }
                }
            }
        }
        for (mode in listOf(false, true)) {
            drawn = false
            dark = mode
            rule.waitForIdle()
            val today = rule.node(ConversationRowTags.ROW).captureToImage().asAndroidBitmap()
            val palette = ProsePalette.of(if (mode) com.slopus.happy.ui.theme.DarkColors else com.slopus.happy.ui.theme.LightColors)
            typesetter.reportPalette(palette)
            prepare(listOf(row))
            runBlocking { withContext(typesetter.lane) {} }
            assertTrue("drawn ahead in ${if (mode) "dark" else "light"}", typesetter.peek(source)!!.recorded(palette))
            val played = ProseThread.playbacks.get()
            drawn = true
            rule.waitForIdle()
            val ours = rule.node(ConversationRowTags.ROW).captureToImage().asAndroidBitmap()
            assertTrue("the row played back what the lane drew", ProseThread.playbacks.get() > played)
            shot("prose-ahead-${if (mode) "dark" else "light"}", ours)
            assertEquals("height", today.height, ours.height)
            var different = 0
            for (y in 0 until ours.height) for (x in 0 until ours.width) if (ours.getPixel(x, y) != today.getPixel(x, y)) different++
            assertEquals("pixels that differ from AgentMessage's, dark=$mode", 0, different)
        }
    }

    /** Our row and AgentMessage under [wrap], compared pixel for pixel. */
    private fun assertAnswerParity(name: String, text: String, wrap: @androidx.compose.runtime.Composable (@androidx.compose.runtime.Composable () -> Unit) -> Unit) {
        val row = ConversationRow.Text("$name:0", text, parseMarkdown(text))
        var drawn by mutableStateOf(true)
        rule.setHappyContent {
            wrap {
                if (drawn) {
                    ConversationRowView(row, bubble, actions)
                } else {
                    Box(Modifier.fillMaxWidth().testTag(ConversationRowTags.ROW)) {
                        AgentMessage(ChatRow.AgentText(ChatMessage.AgentText(row.key, 0, row.text), row.blocks), MessageCallbacks(), Modifier.contentMaxWidth(LocalWindowLayout.current))
                    }
                }
            }
        }
        val ours = rule.node(ConversationRowTags.ROW).captureToImage().asAndroidBitmap()
        drawn = false
        rule.waitForIdle()
        val today = rule.node(ConversationRowTags.ROW).captureToImage().asAndroidBitmap()
        shot("prose-answer-$name", ours)
        assertEquals("height", today.height, ours.height)
        var different = 0
        for (y in 0 until ours.height) for (x in 0 until ours.width) if (ours.getPixel(x, y) != today.getPixel(x, y)) different++
        assertEquals("pixels that differ from AgentMessage's", 0, different)
    }

    @Test fun `right to left, a drawn answer is AgentMessage mirrored as it mirrors`() {
        val hebrew = "## כותרת\nשלום עולם, זו פסקה ארוכה מספיק כדי לעבור לשורה שנייה על מסך של טלפון רגיל, עם **הדגשה**.\n\n- פריט ראשון\n- פריט שני\n  - פנימי\n\nEnglish words in a right-to-left screen."
        assertAnswerParity("rtl", hebrew) { content ->
            androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalLayoutDirection provides androidx.compose.ui.unit.LayoutDirection.Rtl) { content() }
        }
    }

    @Test fun `at a large font scale a drawn answer is still AgentMessage`() {
        org.robolectric.RuntimeEnvironment.setFontScale(1.6f)
        try {
            assertAnswerParity("font-1.6", markdown) { it() }
        } finally {
            org.robolectric.RuntimeEnvironment.setFontScale(1f)
        }
    }

    @Test fun `a drawn bubble and a collaborator are what they were`() {
        val text = "Can you look at **this** and [the page](https://example.com/x)?\n\n- one\n- two"
        val user = ConversationRow.User("u1:user", "u1", text, parseMarkdown(text), emptyList(), com.slopus.happy.conversation.Delivery.Sent)
        var drawn by mutableStateOf(true)
        rule.setHappyContent {
            if (drawn) {
                ConversationRowView(user, bubble, actions)
            } else {
                Box(Modifier.fillMaxWidth().testTag(ConversationRowTags.ROW)) {
                    UserMessage(
                        ChatRow.User(
                            ChatMessage.UserText(id = user.key, localId = user.messageId, createdAt = 0, text = text), UserDisplay.Text(text, user.blocks),
                            delivery = com.slopus.happy.chat.MessageDelivery.Accepted, time = 0,
                        ),
                        bubble, MessageCallbacks(), Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth(), statusLine = false,
                    )
                }
            }
        }
        val bubbleOurs = rule.node(MessageTags.USER_BUBBLE).captureToImage().asAndroidBitmap()
        drawn = false
        rule.waitForIdle()
        val bubbleToday = rule.node(MessageTags.USER_BUBBLE).captureToImage().asAndroidBitmap()
        shot("prose-user", bubbleOurs)
        assertEquals(bubbleToday.width, bubbleOurs.width)
        assertEquals(bubbleToday.height, bubbleOurs.height)
        var different = 0
        for (y in 0 until bubbleOurs.height) for (x in 0 until bubbleOurs.width) if (bubbleOurs.getPixel(x, y) != bubbleToday.getPixel(x, y)) different++
        assertEquals("pixels that differ from the bubble's MarkdownView", 0, different)
    }

    @Test fun `the words are in semantics, a row's paragraphs found by their text`() {
        val row = ConversationRow.Text("sem:0", markdown, parseMarkdown(markdown))
        rule.setHappyContent { ConversationRowView(row, bubble, actions) }
        rule.onNodeWithText("Found it").assertIsDisplayed()
        rule.onNodeWithText("Last paragraph after the code.").assertIsDisplayed()
        rule.onNodeWithText("The callback rewrites the URL", substring = true).assertIsDisplayed()
        rule.onNodeWithText("nested, in italics").assertIsDisplayed()
        // The link is an action TalkBack offers on the paragraph.
        val paragraph = rule.onNodeWithText("The callback rewrites the URL", substring = true).fetchSemanticsNode()
        val actions = paragraph.config.getOrNull(SemanticsActions.CustomActions).orEmpty()
        assertEquals(listOf("the auth docs"), actions.map { it.label })
        // The code block stays MarkdownView's own, with its copy button.
        rule.node(MarkdownTags.CODE_BLOCK).assertIsDisplayed()
        rule.node(MarkdownTags.CODE_COPY).assertIsDisplayed()
        assertEquals(1, rule.onAllNodesWithTag(MessageTags.AGENT_COPY, useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    private class Calls {
        val taps = ArrayList<String>()
        val menus = ArrayList<String>()
    }

    private fun linkPoint(source: ProseSource): Offset {
        val prose = typesetter.prose(source, typesetter.geometry.at(Density(context), false))
        val segment = prose.segments.first() as DrawnSegment
        segment.parts.forEachIndexed { i, part ->
            for (piece in part.pieces) {
                val link = piece.text.getLinkAnnotations(0, piece.text.length).firstOrNull() ?: continue
                val box = piece.layout.getBoundingBox(link.start + 1)
                return Offset(piece.x + box.center.x, segment.tops[i] + piece.y + box.center.y)
            }
        }
        error("no link")
    }

    @Test fun `a tap on a drawn link opens it, a long press offers the menu, and off it nothing`() {
        val row = ConversationRow.Text("link:0", markdown, parseMarkdown(markdown))
        val calls = Calls()
        val opener = LinkOpener(proxied = true, computer = "Studio", tap = { calls.taps += it }, inApp = {}, external = {})
        rule.setHappyContent { ProvideLinks(opener) { ConversationRowView(row, bubble, actions) } }
        val at = linkPoint(ProseSource(row.key, ProseKind.Answer, row.text, row.blocks))
        val segment = rule.onAllNodesWithTag(ProseTags.TEXT, useUnmergedTree = true)[0]
        segment.performTouchInput { click(at) }
        rule.waitForIdle()
        assertEquals(listOf("https://example.com/auth"), calls.taps)
        segment.performTouchInput { click(Offset(at.x, 4f)) }
        rule.waitForIdle()
        assertEquals("a tap on the header opens nothing", 1, calls.taps.size)
        segment.performTouchInput { longClick(at) }
        rule.waitForIdle()
        assertEquals("https://example.com/auth", opener.menu)
        assertEquals("the long press is the link's, not a tap", 1, calls.taps.size)
        // And not the selection either: the answer is still drawn.
        rule.node(MarkdownTags.TEXT).assertDoesNotExist()
    }

    @Test fun `a long press on the words selects in today's selectable answer, and it is drawn again after`() {
        val row = ConversationRow.Text("select:0", markdown, parseMarkdown(markdown))
        val selected = ArrayList<String>()
        ProseSelection.selected = { selected += it }
        rule.setHappyContent { ConversationRowView(row, bubble, actions) }
        val before = rule.node(ConversationRowTags.ROW).fetchSemanticsNode().boundsInRoot
        val segment = rule.onAllNodesWithTag(ProseTags.TEXT, useUnmergedTree = true)[0]
        val source = ProseSource(row.key, ProseKind.Answer, row.text, row.blocks)
        val prose = typesetter.prose(source, typesetter.geometry.at(Density(context), false))
        val drawn = prose.segments.first() as DrawnSegment
        // On "cookie" in the paragraph.
        val paragraph = drawn.parts[1].pieces.single()
        val offset = paragraph.text.text.indexOf("cookie") + 2
        val box = paragraph.layout.getBoundingBox(offset)
        segment.performTouchInput { longClick(Offset(paragraph.x + box.center.x, drawn.tops[1] + paragraph.y + box.center.y)) }
        rule.mainClock.advanceTimeBy(200)
        rule.waitForIdle()
        // Today's selectable MarkdownView, in the same place, at the same height.
        assertTrue(rule.onAllNodesWithTag(MarkdownTags.TEXT, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        rule.node(ProseTags.TEXT).assertDoesNotExist()
        assertEquals(before, rule.node(ConversationRowTags.ROW).fetchSemanticsNode().boundsInRoot)
        assertEquals(listOf("cookie"), selected)
        // A tap clears it, and the answer is drawn again.
        rule.onAllNodesWithTag(MarkdownTags.TEXT, useUnmergedTree = true)[0].performTouchInput { click(Offset(10f, 10f)) }
        rule.mainClock.advanceTimeBy(500)
        rule.waitForIdle()
        rule.node(MarkdownTags.TEXT).assertDoesNotExist()
        assertTrue(rule.onAllNodesWithTag(ProseTags.TEXT, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        assertEquals(before, rule.node(ConversationRowTags.ROW).fetchSemanticsNode().boundsInRoot)
    }

    @Test fun `layouts are kept by row, words and geometry`() {
        val geometry = typesetter.geometry
        val text = "Kept by its words: **one** paragraph."
        val source = ProseSource("keys:0", ProseKind.Answer, text, parseMarkdown(text))
        val built = typesetter.build(source, geometry)
        // The same words in another string, the same layout.
        assertSame(built, typesetter.peek(ProseSource("keys:0", ProseKind.Answer, String(text.toCharArray()), parseMarkdown(text)), geometry))
        // Other words under the same key: not this layout.
        assertNull(typesetter.peek(ProseSource("keys:0", ProseKind.Answer, "$text More.", parseMarkdown("$text More.")), geometry))
        // Another kind, label or row: not this layout.
        assertNull(typesetter.peek(ProseSource("keys:0", ProseKind.User, text, parseMarkdown(text)), geometry))
        assertNull(typesetter.peek(ProseSource("keys:1", ProseKind.Answer, text, parseMarkdown(text)), geometry))
        // Another width, font scale, density or direction: stale.
        assertNull(typesetter.peek(source, geometry.withColumn(geometry.column - 30)))
        assertNull(typesetter.peek(source, geometry.at(Density(geometry.density.density, 1.3f), false)))
        assertNull(typesetter.peek(source, geometry.at(Density(2f, geometry.density.fontScale), false)))
        assertNull(typesetter.peek(source, geometry.at(geometry.density, true)))
        // A grown answer keeps its settled paragraph's layout and lays out only the new one.
        val grown = "$text\n\nAnd a second paragraph."
        val next = typesetter.build(ProseSource("keys:0", ProseKind.Answer, grown, listOf(source.blocks.single()) + parseMarkdown(grown).drop(1)), geometry)
        assertSame(built.parts.single(), next.parts.first())
        assertNotSame(built, next)
        assertEquals(2, next.parts.size)
    }

    @Test fun `a new width draws the old layout scaled while the lane lays it out again, never on the main thread`() {
        val row = ConversationRow.Text("width:0", markdown, parseMarkdown(markdown))
        prepare(listOf(row))
        val start = typesetter.geometry
        val version = typesetter.version
        ProseThread.strict = true
        var drawn by mutableStateOf(true)
        rule.setHappyContent {
            Box(Modifier.width(300.dp)) {
                if (drawn) {
                    ConversationRowView(row, bubble, actions)
                } else {
                    Box(Modifier.fillMaxWidth().testTag(ConversationRowTags.ROW)) {
                        AgentMessage(ChatRow.AgentText(ChatMessage.AgentText(row.key, 0, row.text), row.blocks), MessageCallbacks(), Modifier.contentMaxWidth(LocalWindowLayout.current))
                    }
                }
            }
        }
        val source = ProseSource(row.key, ProseKind.Answer, row.text, row.blocks)
        rule.waitUntil(5_000) { typesetter.version != version && typesetter.peek(source, typesetter.geometry) != null }
        rule.waitForIdle()
        val narrow = typesetter.geometry
        assertEquals("the column the row was in", (300 * 3), narrow.column)
        assertTrue(start.column != narrow.column)
        // Laid out at 300 less 16 a side, and now drawn so: as tall as AgentMessage would be there.
        val prose = typesetter.peek(source, narrow)
        assertNotNull(prose)
        assertEquals(300 * 3 - 2 * 48, prose!!.available)
        val drawnHeight = rule.node(ConversationRowTags.ROW).fetchSemanticsNode().size.height
        ProseThread.strict = false
        drawn = false
        rule.waitForIdle()
        assertEquals(rule.node(ConversationRowTags.ROW).fetchSemanticsNode().size.height, drawnHeight)
        typesetter.report(start)
    }

    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)

    @Test fun `a chat laid out on the lane opens and scrolls with nothing laid out on the main thread`() {
        val messages = (0 until 12).flatMap { i ->
            listOf(
                Message("q$i", "user", 3L * i, listOf(Block.Text("Question $i: why does the login page loop back to itself?"))),
                Message(
                    "r$i", "agent", 3L * i + 1,
                    listOf(
                        Block.Reasoning("Thinking about the redirect, round $i."),
                        Block.ToolCall("c$i", "Bash", "completed", Presentation.Command("grep -rn redirect", "...")),
                        Block.Text("Answer $i. $markdown"),
                    ),
                ),
                Message("o$i", "agent", 3L * i + 2, listOf(Block.Text("A note from a collaborator, $i.")), senderAgentId = "other"),
            )
        }
        val rows = messages.flatMap { ConversationRowBuilder.build(it, "a1", null, false) }.asReversed()
        prepare(rows)
        ProseThread.strict = true
        val before = ProseThread.mainBuilds.get()
        rule.setHappyContent { ConversationScreen(ConversationState(created = true, loaded = true, rows = rows, agent = agent), ConversationScreenActions()) }
        rule.node(ConversationScreenTags.LIST).performScrollToNode(hasTestTag(ConversationScreenTags.OLDER))
        rule.waitForIdle()
        rule.onNodeWithText("Question 0: why does the login page loop back to itself?").assertExists()
        rule.onNodeWithText("A note from a collaborator, 0.").assertExists()
        assertEquals("built on the main thread", before, ProseThread.mainBuilds.get())
    }

    @Test fun `a streaming answer is laid out on the lane, delta by delta`() {
        val builder = ConversationRowBuilder(typesetter = typesetter)
        var words = "Streaming the first words of the answer"
        var message = Message("stream", "agent", 10, listOf(Block.Text(words)))
        var rows: List<ConversationRow> = emptyList()
        fun onLane(block: () -> Unit) = Thread(block).apply { start(); join() }
        onLane { rows = builder.rows(message, "a1", null, true).asReversed(); typesetter.prepare(rows) }
        ProseThread.strict = true
        val before = ProseThread.mainBuilds.get()
        rule.setHappyContent {
            ConversationScreen(ConversationState(created = true, loaded = true, rows = rows, agent = agent, working = true), ConversationScreenActions())
        }
        rule.waitForIdle()
        repeat(12) { i ->
            words += if (i % 4 == 3) "\n\nA new paragraph $i" else " and more words $i"
            message = message.copy(content = listOf(Block.Text(words)))
            onLane { check(builder.grow(message, 0)) }
            rule.mainClock.advanceTimeByFrame()
        }
        rule.waitForIdle()
        rule.onNodeWithText("A new paragraph 11", substring = true).assertExists()
        assertEquals("built on the main thread", before, ProseThread.mainBuilds.get())
    }
}

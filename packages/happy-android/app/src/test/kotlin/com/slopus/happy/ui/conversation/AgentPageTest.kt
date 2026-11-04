package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.KeptMedia
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.conversation.Shared
import com.slopus.happy.conversation.SharedMedia
import com.slopus.happy.media.DownloadPhase
import com.slopus.happy.media.MediaAutoDownload
import com.slopus.happy.media.MediaLibrary
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.GlassBarTags
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * The agent page against iOS's `SessionDetailLayout` on the 411 phone: the
 * hero under the bar's feather, tiles two to a row (an odd last one the
 * row's width), the shared grid three square cells to a row 2 apart,
 * Activity's fold, the family's rows, the placeholders while it reads,
 * and what it says when it couldn't read. With HAPPY_SHOTS_DIR set, the
 * page is written there light and dark, at rest and scrolled.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentPageTest {
    @get:Rule val rule = createComposeRule()
    @get:Rule val folder = TemporaryFolder()
    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)
    private val now = AgentPageFixtures.NOW

    /** The card's width on the phone: the window less the 16 inset each side. */
    private val card = (PHONE_WIDTH - 32).dp

    private fun show(state: AgentPageState = AgentPageFixtures.page, actions: AgentPageActions = AgentPageActions(), dark: Boolean = false) {
        rule.setHappyContent(dark) { AgentPageScreen(state, actions, now = now) }
        rule.waitForIdle()
    }

    private fun shot(name: String) {
        val dir = dir ?: return
        dir.mkdirs()
        rule.mainClock.advanceTimeBy(1_000)
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "agent-page-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun all(tag: String): List<DpRect> = rule.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().map { node ->
        with(rule.density) { DpRect(node.boundsInRoot.left.toDp(), node.boundsInRoot.top.toDp(), node.boundsInRoot.right.toDp(), node.boundsInRoot.bottom.toDp()) }
    }

    @Test fun `the hero is the mark, the name and the kind line, centred under the feather`() {
        show()
        val bar = rule.node(GlassBarTags.BAR).bounds
        val mark = rule.node(AgentPageTags.MARK).bounds
        val name = rule.node(AgentPageTags.NAME).bounds
        val subtitle = rule.node(AgentPageTags.SUBTITLE).bounds
        assertDp("the mark rests 12 under the feather", bar.bottom + GlassSpec.feather + 12.dp, mark.top)
        assertDp("the mark is 88", 88, mark.width)
        assertDp("the mark is 88 high", 88, mark.height)
        assertDp("the mark is centred", (PHONE_WIDTH.dp - 88.dp) / 2, mark.left)
        assertDp("the name is 14 under the mark", mark.bottom + 14.dp, name.top)
        assertDp("the name's line is 34", 34, name.height)
        assertDp("the kind line is 2 under the name", name.bottom + 2.dp, subtitle.top)
        rule.onNodeWithText("Task · Working").assertIsDisplayed()
        shot("light")
    }

    /** iOS SessionDetailViewController's bar: Copy Link puts the agent's instance link on the clipboard (desktop e712a6e4). */
    @Test fun `copy link puts the agents happy link on the clipboard, and without an instance there is none`() {
        show(actions = AgentPageActions(link = "happy://inst/agents/a1"))
        val bar = rule.node(GlassBarTags.BAR).bounds
        val copy = rule.node(AgentPageTags.COPY_LINK).bounds
        assertTrue("in the bar's end", copy.right <= bar.right && copy.left > (PHONE_WIDTH / 2).dp)
        rule.node(AgentPageTags.COPY_LINK).performClick()
        val clipboard = ApplicationProvider.getApplicationContext<android.content.Context>().getSystemService(android.content.ClipboardManager::class.java)
        assertEquals("happy://inst/agents/a1", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
    }

    @Test fun `a daemon with no instance id offers no copy link`() {
        show()
        rule.node(AgentPageTags.COPY_LINK).assertDoesNotExist()
    }

    @Test fun `the tiles are two to a row on the cards inset`() {
        show()
        val tiles = all(AgentPageTags.TILE)
        assertEquals("model, effort, started and tokens", 4, tiles.size)
        val half = (card - 10.dp) / 2
        tiles.forEach { assertDp("a tile is 80 high", 80, it.height) }
        assertDp("the first starts on the inset", 16, tiles[0].left)
        assertDp("half the row less the gap", half, tiles[0].width)
        assertDp("the second ends on the inset", (PHONE_WIDTH - 16).dp, tiles[1].right)
        assertDp("10 between rows", tiles[0].bottom + 10.dp, tiles[2].top)
        rule.onNodeWithText("Opus 5").assertIsDisplayed()
        rule.onNodeWithText("High").assertIsDisplayed()
        rule.onNodeWithText("1.2M").assertIsDisplayed()
    }

    @Test fun `with no tokens recorded the third tile takes the row`() {
        show(AgentPageFixtures.page.copy(detail = AgentPageFixtures.detail.copy(tokens = null)))
        val three = all(AgentPageTags.TILE)
        assertEquals("no tokens recorded: no tile", 3, three.size)
        assertDp("the odd last one is the row's width", card, three[2].width)
    }

    @Test fun `shared media is three square cells to a row, 2 apart, on its card`() {
        show()
        rule.node(AgentPageTags.MEDIA).performScrollTo()
        val media = rule.node(AgentPageTags.MEDIA).bounds
        val cells = all(AgentPageTags.MEDIA_CELL)
        assertEquals("five pictures, a recording and a file", 7, cells.size)
        val side = (card - 4.dp) / 3
        assertDp("the card is on the inset", 16, media.left)
        assertDp("the card is the column less its inset", card, media.width)
        cells.forEach {
            assertDp("square", it.width, it.height)
            assertDp("a third of the card less the gaps", side, it.width)
        }
        assertDp("2 between columns", cells[0].right + 2.dp, cells[1].left)
        assertDp("the last column ends on the card's edge", media.right, cells[2].right)
        assertDp("2 between rows", cells[0].bottom + 2.dp, cells[3].top)
        assertTrue("nothing more to read: no Show more", rule.onAllNodesWithTag(AgentPageTags.MEDIA_MORE, useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        rule.onNodeWithText("launch-plan.pdf", useUnmergedTree = true).assertIsDisplayed()
    }

    // iOS SharedMediaCell: kept, a cell reads, rings and plays as the chat's tile does.
    @Test fun `kept, a presented picture rings until a tap reads it and a recording's ring plays`() {
        val png = java.io.ByteArrayOutputStream().also {
            Bitmap.createBitmap(300, 300, Bitmap.Config.ARGB_8888).apply { eraseColor(0xFF2979FF.toInt()) }.compress(Bitmap.CompressFormat.PNG, 100, it)
        }.toByteArray()
        val kept = KeptMedia(
            library = MediaLibrary(folder.newFolder("media")),
            agentId = "a1",
            range = { _, span ->
                val end = minOf(span.end, png.size.toLong()).toInt()
                TransportResponse(206, mapOf("Content-Range" to "bytes ${span.start}-${end - 1}/${png.size}"), png.copyOfRange(span.start.toInt(), end))
            },
            rules = MutableStateFlow(MediaAutoDownload(photos = MediaAutoDownload.Rule(false, MediaAutoDownload.MEGABYTE))),
            scope = CoroutineScope(Dispatchers.Unconfined),
        )
        val picture = MediaRef("call3", 0, MediaItem("image", "chart.png", "image/png", 300.0, 300.0, size = png.size.toDouble()))
        val video = MediaRef("call1", 0, MediaItem("video", "demo.mp4", "video/mp4", 1280.0, 720.0, size = 8.4 * 1024 * 1024))
        val state = AgentPageFixtures.page.copy(shared = Shared(listOf(SharedMedia.Presented(picture), SharedMedia.Presented(video))))
        show(state, AgentPageActions(loadMedia = { error("read through what is kept") }, kept = kept))
        rule.node(AgentPageTags.MEDIA).performScrollTo()
        rule.waitUntil(5_000) { kept.phase(picture) is DownloadPhase.Remote && kept.phase(video) != null }
        rule.waitForIdle()
        fun rings() = rule.onAllNodesWithTag(UploadRingSpec.TAG, useUnmergedTree = true).fetchSemanticsNodes().size
        assertEquals("the picture's arrow and the recording's play", 2, rings())
        captured("agent-page-kept-arrow")

        rule.onAllNodesWithTag(AgentPageTags.MEDIA_CELL, useUnmergedTree = true)[0].performClick()
        rule.waitUntil(5_000) { kept.phase(picture) is DownloadPhase.Complete }
        rule.mainClock.advanceTimeBy(2_000)
        rule.waitForIdle()
        assertEquals("the picture's ring filled and went", 1, rings())
        captured("agent-page-kept")
    }

    private fun captured(name: String) {
        val dir = File("build/chat-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun `show more reads history back for one more than each section shows`() {
        val asked = ArrayList<Pair<Int, Int>>()
        show(AgentPageFixtures.page.copy(sharedMore = true), AgentPageActions(onWant = { media, links -> asked += media to links }))
        assertEquals("twelve media and five links, and one more of each", listOf(13 to 6), asked)
        rule.node(AgentPageTags.MEDIA_MORE).performScrollTo().performClick()
        rule.waitForIdle()
        rule.node(AgentPageTags.LINKS_MORE).performScrollTo().performClick()
        rule.waitForIdle()
        assertEquals(listOf(13 to 6, 25 to 6, 25 to 16), asked)
    }

    @Test fun `links read their text or host over their address, 62 high`() {
        show()
        rule.node(AgentPageTags.LINKS).performScrollTo()
        val links = all(AgentPageTags.LINK)
        assertEquals(3, links.size)
        links.forEach { assertDp("a row is 62", 62, it.height) }
        rule.onNodeWithText("Onboarding PR", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("github.com/slopus/happy/pull/412", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("figma.com", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test fun `a family row opens its conversation and its own row goes back`() {
        val opened = ArrayList<String>()
        var back = 0
        show(actions = AgentPageActions(onBack = { back++ }, onOpenConversation = { opened += it }))
        val rows = rule.onAllNodesWithTag(AgentPageTags.FAMILY_ROW, useUnmergedTree = true)
        assertEquals("itself over its two subtasks", 3, rows.fetchSemanticsNodes().size)
        val bounds = all(AgentPageTags.FAMILY_ROW)
        assertDp("rows are home's 48", 48, bounds[0].height)
        rows[1].performClick()
        rows[0].performClick()
        assertEquals(listOf("s1"), opened)
        assertEquals(1, back)
    }

    @Test fun `activity has the work running, then the settled children folded under their count`() {
        val opened = ArrayList<String>()
        show(actions = AgentPageActions(onOpenConversation = { opened += it }))
        rule.node(AgentPageTags.RUNNING).performScrollTo()
        assertEquals("a child and a terminal at work", 2, all(AgentPageTags.ACTIVITY_ROW).size)
        rule.onNodeWithText("running tools · 48K tokens", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("running · 12 min", useUnmergedTree = true).assertIsDisplayed()
        val toggle = rule.node(AgentPageTags.COMPLETED_TOGGLE).performScrollTo()
        assertDp("the fold's row is 52", 52, toggle.bounds.height)
        toggle.performClick()
        rule.waitForIdle()
        assertEquals("the three settled ones open under it", 5, all(AgentPageTags.ACTIVITY_ROW).size)
        rule.onNodeWithText("closed", useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Read the analytics", useUnmergedTree = true).performClick()
        assertEquals(listOf("c1"), opened)
    }

    @Test fun `details say provider, permissions, context, where it runs and its id`() {
        show()
        rule.node(AgentPageTags.DETAILS).performScrollTo()
        for (text in listOf("Claude", "Auto", "201K of 272K", "Happy", "onboarding", "a1")) {
            rule.onNodeWithText(text, useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        }
        all(AgentPageTags.DETAILS_ROW).forEach { assertDp("a detail is 52", 52, it.height) }
    }

    @Test fun `over its chat the permission mode is a card under the tiles that picks through the chat`() {
        val picked = ArrayList<com.slopus.happy.conversation.Mode>()
        show(AgentPageFixtures.page.copy(chatMode = AgentPageFixtures.mode), AgentPageActions(onModeChange = { picked += it }))
        val tiles = rule.node(AgentPageTags.TILES).bounds
        val row = rule.node(AgentPageTags.PERMISSION).bounds
        assertDp("the card is a card gap under the tiles", 24, row.top - tiles.bottom)
        assertDp("the row is a Settings row", 52, row.height)
        assertDp("on the card's width", card, row.width)
        rule.onNodeWithText("Auto", useUnmergedTree = true).assertIsDisplayed()
        // The details leave it to the card.
        rule.onAllNodesWithText("Permission mode", useUnmergedTree = true).assertCountEquals(1)

        rule.node(AgentPageTags.PERMISSION).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Full access").performClick()
        rule.waitForIdle()
        assertEquals(listOf(AgentPageFixtures.mode.copy(permissionMode = "full_access")), picked)
    }

    @Test fun `opened from anywhere else there is no card and the details name the mode`() {
        show()
        rule.onAllNodesWithTag(AgentPageTags.PERMISSION, useUnmergedTree = true).assertCountEquals(0)
        rule.node(AgentPageTags.DETAILS).performScrollTo()
        rule.onNodeWithText("Permission mode", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test fun `a workspace's changes are a detail of their own, counted as home counts them, opening the changes`() {
        val opened = ArrayList<String>()
        val changes = com.slopus.happy.agent.WorkspaceLineChanges("ready", 12, 3, true, 1.0)
        show(AgentPageFixtures.page.copy(workspaceId = "w1", lineChanges = changes), AgentPageActions(onOpenChanges = { opened += it }))
        rule.node(AgentPageTags.CHANGES).performScrollTo()
        assertDp("a detail is 52", 52, rule.node(AgentPageTags.CHANGES).bounds.height)
        rule.onNodeWithText("+12 \u22123", useUnmergedTree = true).assertIsDisplayed()
        rule.node(AgentPageTags.CHANGES).performClick()
        assertEquals(listOf("w1"), opened)
        assertEquals("≈ +1.2k", changesText(changes.copy(insertions = 1234, deletions = 0, countsExact = false)))
        assertEquals("", changesText(null))
    }

    @Test fun `before the bootstrap answers the unknown values shimmer and activity waits`() {
        show(AgentPageState("a1", name = "Ship the onboarding", reading = true, sharedReading = true))
        assertTrue("placeholders stand in", all(AgentPageTags.PLACEHOLDER).size >= 3 + 3)
        assertTrue("no activity yet", all(AgentPageTags.RUNNING).isEmpty() && all(AgentPageTags.COMPLETED).isEmpty())
        shot("reading")
    }

    @Test fun `an agent that couldn't be read says why`() {
        show(AgentPageState("a1", reading = false, error = "The agent refused this (404)."))
        rule.node(AgentPageTags.ERROR).assertIsDisplayed()
        rule.onNodeWithText("The agent refused this (404).").assertIsDisplayed()
    }

    @Test fun shotDark() {
        show(dark = true)
        shot("dark")
    }

    @Test fun shotScrolled() {
        show()
        rule.node(AgentPageTags.SCROLL).performTouchInput { swipeUp(startY = centerY + 300f, endY = centerY - 300f) }
        rule.waitForIdle()
        shot("scrolled-light")
    }

    @Test fun shotScrolledDark() {
        show(dark = true)
        rule.node(AgentPageTags.SCROLL).performTouchInput { swipeUp(startY = bottom - 100f, endY = top + 100f) }
        rule.waitForIdle()
        shot("scrolled-dark")
    }

    /** desktop's task panel's Files, under Changes: the workspace's folder, opened on tap. */
    @Test fun `a workspace's files follow its changes and open its folder`() {
        val opened = ArrayList<String>()
        show(
            AgentPageFixtures.page.copy(workspaceId = "w1"),
            AgentPageActions(onOpenChanges = { opened += "changes:$it" }, onOpenFiles = { opened += "files:$it" }),
        )
        rule.node(AgentPageTags.FILES).performScrollTo()
        val changes = rule.node(AgentPageTags.CHANGES).bounds
        val files = rule.node(AgentPageTags.FILES).bounds
        assertDp("a detail is 52", 52, files.height)
        assertDp("Files is under Changes", changes.bottom, files.top)
        rule.onNodeWithText("Files", useUnmergedTree = true).assertIsDisplayed()
        rule.node(AgentPageTags.FILES).performClick()
        assertEquals(listOf("files:w1"), opened)
    }

    @Test fun `without a workspace there are no changes or files`() {
        show(AgentPageFixtures.page.copy(workspaceId = null))
        rule.onAllNodesWithTag(AgentPageTags.CHANGES, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(AgentPageTags.FILES, useUnmergedTree = true).assertCountEquals(0)
    }
}

package com.slopus.happy.ui.artifacts

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactCatalogFeed
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactFile
import com.slopus.happy.artifacts.ArtifactSummary
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.Problem
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.cards.CardListSpec
import com.slopus.happy.ui.cards.CardListTags
import com.slopus.happy.ui.components.StateAnimationTags
import com.slopus.happy.ui.connection.AgentSearchTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import coil3.asImage
import com.slopus.happy.artifacts.ArtifactCover
import com.slopus.happy.feed.FeedCovers
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * The artifacts list against iOS's 497725441 (CardListLayoutTests,
 * HostedArtifactsListTests): home's inset cards under date headings, the
 * row's tile, title, kind and time where CardRowLayout puts them, search,
 * the notes in place of rows, the hold menu and the pictures. Shots go to
 * build/artifact-screens.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ArtifactsListTest {
    @get:Rule val rule = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    @After fun tearDown() = scope.cancel()

    private val zone = ZoneId.systemDefault()
    private fun at(text: String) = LocalDateTime.parse(text).atZone(zone).toInstant().toEpochMilli()
    private val now = at("2026-11-02T15:00")

    private fun summary(id: String, title: String, type: String, updated: String, entry: ArtifactFile? = ArtifactFile("index.md", "text/markdown", 1), fileCount: Int = 1, live: Boolean = false) =
        ArtifactSummary(id, type, title, 2, entry, fileCount, live, at(updated), at(updated))

    private val sample = listOf(
        summary("a1", "Release notes", "markdown", "2026-11-02T09:41"),
        summary("a2", "Dashboard", "html", "2026-11-02T08:05"),
        summary("a3", "Onboarding screenshots on every size of phone, light and dark", "image_series", "2026-11-01T18:20", ArtifactFile("1.png", "image/png", 1), fileCount = 6),
        summary("a4", "", "video", "2026-10-29T10:00", ArtifactFile("demo.mp4", "video/mp4", 1)),
        summary("a5", "Waitlist", "html", "2026-10-12T10:00", live = true),
        summary("a6", "Q3 report", "document", "2026-08-14T10:00", ArtifactFile("q3.pdf", "application/pdf", 1)),
        summary("a7", "Old notes", "markdown", "2025-12-03T10:00"),
    )

    private fun shot(name: String) {
        rule.waitForIdle()
        val dir = File("build/artifact-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun show(state: ArtifactCatalogFeed.State, dark: Boolean = false, onOpen: (ArtifactSummary) -> Unit = {}, thumbnails: ArtifactThumbnails? = null) {
        rule.setHappyContent(dark) { ArtifactsScreen(state, {}, onOpen, thumbnails, clock = { now }) }
        rule.waitForIdle()
    }

    private val loaded = ArtifactCatalogFeed.State(sample, loaded = true)

    @Test fun headingsGroupTheRowsByWhenTheyChanged() {
        show(loaded)
        for (heading in listOf("TODAY", "YESTERDAY", "PREVIOUS 7 DAYS", "PREVIOUS 30 DAYS", "AUGUST", "DECEMBER 2025")) {
            rule.onNodeWithText(heading).assertExists()
        }
        // Kind under the title; a series counts its files; the untitled are named so.
        rule.onAllNodesWithText("Document").assertCountEquals(2)
        rule.onNodeWithText("Images · 6").assertExists()
        rule.onNodeWithText("Live page").assertExists()
        rule.onNodeWithText("Untitled artifact").assertExists()
        // The time today and yesterday, the weekday this week, the day and month this year, the whole date before.
        rule.onNodeWithText("9:41 AM").assertExists()
        rule.onNodeWithText("6:20 PM").assertExists()
        rule.onNodeWithText("Thursday").assertExists()
        rule.onNodeWithText("Aug 14").assertExists()
        shot("artifacts-list")
    }

    @Test fun aRowStandsWhereCardRowLayoutPutsIt() {
        show(loaded)
        val heading = rule.onAllNodesWithTag(CardListTags.HEADING, useUnmergedTree = true)[0].bounds
        val row = rule.onAllNodesWithTag(ArtifactsTags.ROW, useUnmergedTree = true)[0].bounds
        val tile = rule.onAllNodesWithTag(CardListTags.LEADING, useUnmergedTree = true)[0].bounds
        val title = rule.onAllNodesWithTag(CardListTags.TITLE, useUnmergedTree = true)[0].bounds
        val trailing = rule.onAllNodesWithTag(CardListTags.TRAILING, useUnmergedTree = true)[0].bounds
        val divider = rule.onAllNodesWithTag(CardListTags.DIVIDER, useUnmergedTree = true)[0].bounds
        assertDp("the first heading is 36 tall", 36, heading.height)
        assertDp("its card starts under it", heading.bottom, row.top)
        assertDp("a row with a tile is at least 60", 60, row.height)
        assertDp("the slot is 16 into a card 16 in", 32, tile.left)
        assertDp("the slot is 16:9 at the tile's height", 72, tile.width)
        assertDp("the slot is 40 tall", 40, tile.height)
        assertDp("centred in the row", (row.top + row.bottom) / 2, (tile.top + tile.bottom) / 2)
        assertDp("the title 12 after it", 116, title.left)
        assertDp("the time ends 16 inside the card", PHONE_WIDTH - 32, trailing.right)
        assertDp("the hairline from the title's start", 116, divider.left)
        assertDp("to the card's edge", PHONE_WIDTH - 16, divider.right)
        assertDp("a hairline", (1f / 3f).dp, divider.height)
    }

    @Test fun aTapOpensAndAHoldOffersOpenAndCopyTitle() {
        val opened = mutableListOf<String>()
        show(loaded, onOpen = { opened += it.id })
        rule.onNodeWithText("Dashboard").performClick()
        assertEquals(listOf("a2"), opened)
        rule.onNodeWithText("Release notes").performTouchInput { longClick() }
        rule.waitForIdle()
        shot("artifacts-menu")
        rule.node(ArtifactsTags.MENU_COPY).performClick()
        val clipboard = ApplicationProvider.getApplicationContext<Context>().getSystemService(ClipboardManager::class.java)
        assertEquals("Release notes", clipboard.primaryClip!!.getItemAt(0).text.toString())
        rule.onNodeWithText("Release notes").performTouchInput { longClick() }
        rule.node(ArtifactsTags.MENU_OPEN).performClick()
        assertEquals(listOf("a2", "a1"), opened)
    }

    @Test fun searchFindsEveryWordOfTheTitleOrKind() {
        show(loaded)
        rule.node(ArtifactsTags.SEARCH).performClick()
        rule.node(AgentSearchTags.FIELD).performTextInput("web")
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(ArtifactsTags.ROW, useUnmergedTree = true).fetchSemanticsNodes().size == 1 }
        rule.onNodeWithText("Dashboard").assertExists()
        shot("artifacts-search")
        rule.node(AgentSearchTags.CLEAR).performClick()
        rule.node(AgentSearchTags.FIELD).performTextInput("zebra")
        rule.waitUntil(5_000) { rule.onAllNodesWithText("No artifacts match.").fetchSemanticsNodes().isNotEmpty() }
        rule.onAllNodesWithTag(ArtifactsTags.ROW, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun theTitleSaysWhereTheLinkIsWhileItIsOnItsWay() {
        var link by mutableStateOf(com.slopus.happy.connection.LinkState.Connecting)
        rule.setHappyContent { ArtifactsScreen(ArtifactCatalogFeed.State(loaded = true), {}, {}, clock = { now }, link = link) }
        rule.onNodeWithText("Connecting…").assertExists()
        link = com.slopus.happy.connection.LinkState.Syncing
        rule.onNodeWithText("Updating…").assertExists()
        link = com.slopus.happy.connection.LinkState.Online
        rule.onNodeWithText("Artifacts").assertExists()
    }

    @Test fun aNoteStandsInPlaceOfTheRows() {
        var state by mutableStateOf(ArtifactCatalogFeed.State())
        rule.setHappyContent { ArtifactsScreen(state, {}, {}, clock = { now }) }
        rule.onNodeWithText("Loading artifacts...").assertExists()
        for ((next, words) in listOf(
            ArtifactCatalogFeed.State(loaded = true) to "No artifacts yet. Ask an agent to make one.",
            ArtifactCatalogFeed.State(loaded = true, unsupported = true) to "This Happy Agent doesn’t keep artifacts.",
            ArtifactCatalogFeed.State(loaded = true, error = Problem.Said("offline")) to "Artifacts couldn’t be loaded. Check that your computer is on.",
        )) {
            state = next
            rule.waitUntil(5_000) { rule.onAllNodesWithText(words).fetchSemanticsNodes().isNotEmpty() }
        }
        val note = rule.node(CardListTags.NOTE).bounds
        assertDp("the note is centred in the column", (PHONE_WIDTH / 2f).dp, (note.left + note.right) / 2)
        assertCentredInTheList(note.top, note.bottom)
        shot("artifacts-failed")
    }

    /**
     * What spans [top] to [bottom] sits in the middle of the screen, not of
     * the room under the bar: the room's centre lifted by half the bar, so
     * off the screen's centre only by the list's uneven padding (8 above, 24 below).
     */
    private fun assertCentredInTheList(top: Dp, bottom: Dp) {
        val bar = rule.node(PlaceTags.BAR).bounds
        val list = rule.node(ArtifactsTags.LIST).bounds
        val room = rule.node(ArtifactsTags.NOTE).bounds
        assertDp("the note's room starts under the bar and the list's padding", bar.bottom + CardListSpec.contentTop, room.top)
        assertDp("and ends above the list's padding", list.bottom - CardListSpec.contentBottom, room.bottom)
        val screen = (list.top + list.bottom) / 2 + (CardListSpec.contentTop - CardListSpec.contentBottom) / 2
        assertDp("the note is centred on the screen", screen, (top + bottom) / 2)
    }

    @Test fun theEmptyListShowsTheTicketOverItsNote() {
        var state by mutableStateOf(ArtifactCatalogFeed.State())
        rule.setHappyContent { ArtifactsScreen(state, {}, {}, clock = { now }) }
        rule.onNodeWithText("Loading artifacts...").assertExists()
        rule.onAllNodesWithTag(StateAnimationTags.ANIMATION, useUnmergedTree = true).assertCountEquals(0)
        state = ArtifactCatalogFeed.State(loaded = true)
        rule.waitUntil(5_000) { rule.onAllNodesWithText("No artifacts yet. Ask an agent to make one.").fetchSemanticsNodes().isNotEmpty() }
        val art = rule.node(StateAnimationTags.ANIMATION).bounds
        val note = rule.node(CardListTags.NOTE).bounds
        assertDp("a 128 box", 128, art.width)
        assertDp("square", 128, art.height)
        assertDp("centred in the column", (PHONE_WIDTH / 2f).dp, (art.left + art.right) / 2)
        assertDp("the note right under it", art.bottom, note.top)
        assertCentredInTheList(art.top, note.bottom)
        shot("artifacts-empty")
        // Only the empty list has it: a failed read keeps its plain note.
        state = ArtifactCatalogFeed.State(loaded = true, error = Problem.Said("offline"))
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(StateAnimationTags.ANIMATION, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun picturesLandOverTheirTiles() {
        val png = ByteArrayOutputStream().also { out ->
            Bitmap.createBitmap(120, 80, Bitmap.Config.ARGB_8888).also { Canvas(it).drawColor(0xFF3A7BD5.toInt()) }.compress(Bitmap.CompressFormat.PNG, 100, out)
        }.toByteArray()
        val files = ArtifactClient(
            AgentClient(
                object : Transport {
                    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                        assertEquals(RequestCategory.File, category)
                        return TransportResponse(200, body = png)
                    }

                    override suspend fun close() {}
                },
                "t",
            ),
        )
        val pictures = listOf(summary("p1", "Chart", "image", "2026-11-02T10:00", ArtifactFile("chart.png", "image/png", png.size.toLong())))
        show(ArtifactCatalogFeed.State(pictures, loaded = true), thumbnails = ArtifactThumbnails(files, scope))
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(ArtifactsTags.THUMBNAIL, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        val thumbnail = rule.node(ArtifactsTags.THUMBNAIL).bounds
        assertDp("the picture covers the slot", 72, thumbnail.width)
        assertTrue(thumbnail.left.value > 0)
    }

    private val wide = ArtifactCover("cover.png", "image/png", ArtifactCover.Aspect.Wide)
    private val square = ArtifactCover("chart.png", "image/png", ArtifactCover.Aspect.Square)
    private val covered = listOf(
        summary("c1", "Q3 revenue", "html", "2026-11-02T11:00").copy(cover = wide, background = "#0b1020"),
        summary("c2", "Pipeline by stage", "html", "2026-11-02T10:30").copy(cover = square),
        summary("c3", "Release notes", "markdown", "2026-11-02T09:41"),
        // A shape this phone doesn't draw is the glyph.
        summary("c4", "Funnel", "html", "2026-11-02T09:00").copy(cover = ArtifactCover("funnel.svg", "image/svg+xml", ArtifactCover.Aspect.Square)),
    )

    /** The covers drawn here: a blue card for the wide one, a warm chart for the square. */
    private val coverLoader = coil3.ImageLoader.Builder(androidx.test.core.app.ApplicationProvider.getApplicationContext())
        .components {
            add(
                coil3.test.FakeImageLoaderEngine.Builder()
                    .intercept({ it is ByteArray && it.size == 1 }, chart(160, 90, 0xFF0B1020.toInt(), 0xFF5B8CFF.toInt()).asImage())
                    .default(chart(120, 120, 0xFFF8F6F0.toInt(), 0xFFEB5757.toInt()).asImage())
                    .build(),
            )
        }
        .build()

    private fun chart(width: Int, height: Int, ground: Int, ink: Int): Bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply {
        val canvas = Canvas(this)
        canvas.drawColor(ground)
        val paint = android.graphics.Paint().apply { color = ink }
        listOf(0.3f, 0.5f, 0.45f, 0.7f).forEachIndexed { index, value ->
            val step = width / 5f
            canvas.drawRect(step * (index + 0.6f), height * (0.9f - value), step * (index + 1.3f), height * 0.9f, paint)
        }
    }

    private fun showCovered(dark: Boolean = false) {
        // One byte for the wide cover, two for the square, so the fake engine tells them apart.
        val covers = FeedCovers(fetch = { cover -> if (cover.path == "cover.png") ByteArray(1) else ByteArray(2) })
        rule.setHappyContent(dark) {
            androidx.compose.runtime.CompositionLocalProvider(com.slopus.happy.ui.components.LocalImageLoader provides coverLoader) {
                ArtifactsScreen(ArtifactCatalogFeed.State(covered, loaded = true), {}, {}, clock = { now }, covers = covers)
            }
        }
        rule.waitForIdle()
    }

    @Test fun coversStandInTheirSlotAndEveryRowKeepsItsHeight() {
        showCovered()
        val slots = rule.onAllNodesWithTag(CardListTags.LEADING, useUnmergedTree = true)
        val rows = rule.onAllNodesWithTag(ArtifactsTags.ROW, useUnmergedTree = true)
        for (index in covered.indices) {
            assertDp("slot $index width", 72, slots[index].bounds.width)
            assertDp("slot $index height", 40, slots[index].bounds.height)
            assertDp("row $index height", 60, rows[index].bounds.height)
        }
        // Two covers; the markdown and the SVG ones keep their glyphs.
        rule.onAllNodesWithTag(ArtifactsTags.COVER, useUnmergedTree = true).assertCountEquals(2)
        rule.onAllNodesWithTag(ArtifactsTags.GLYPH, useUnmergedTree = true).assertCountEquals(2)
        shot("artifacts-covers")
    }

    @Test fun theSlotReadsTheComputersStillPreviewWhereItKeepsOne() {
        val asked = mutableListOf<String>()
        val covers = FeedCovers(
            fetch = { cover -> asked += "file ${cover.path}"; ByteArray(1) },
            previews = { id, version, path -> asked += "preview $id/$version/$path"; ByteArray(2) },
        )
        val items = listOf(
            // A previewed cover reads its preview, not the file.
            summary("v1", "Q3 revenue", "html", "2026-11-02T11:00").copy(cover = wide.copy(preview = true, thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI")),
            // A picture without a cover reads the preview of its first image.
            summary("v2", "Shots", "image", "2026-11-02T10:30", ArtifactFile("a.png", "image/png", 12, thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI", preview = true)),
            // An older daemon's picture keeps the old thumbnail over the glyph.
            summary("v3", "Old", "image", "2026-11-02T10:00", ArtifactFile("b.png", "image/png", 12)),
        )
        rule.setHappyContent {
            androidx.compose.runtime.CompositionLocalProvider(com.slopus.happy.ui.components.LocalImageLoader provides coverLoader) {
                ArtifactsScreen(ArtifactCatalogFeed.State(items, loaded = true), {}, {}, clock = { now }, covers = covers)
            }
        }
        rule.waitUntil(5_000) { asked.size >= 2 }
        assertEquals(setOf("preview v1/2/cover.png", "preview v2/2/a.png"), asked.toSet())
        rule.onAllNodesWithTag(ArtifactsTags.COVER, useUnmergedTree = true).assertCountEquals(1)
        rule.onAllNodesWithTag(ArtifactsTags.PREVIEW, useUnmergedTree = true).assertCountEquals(1)
        rule.onAllNodesWithTag(ArtifactsTags.GLYPH, useUnmergedTree = true).assertCountEquals(1)
        val rows = rule.onAllNodesWithTag(ArtifactsTags.ROW, useUnmergedTree = true)
        for (index in items.indices) assertDp("row $index height", 60, rows[index].bounds.height)
    }

    @Test fun coversInTheDark() {
        showCovered(dark = true)
        shot("artifacts-covers-dark")
    }

    @Test fun theListDark() {
        show(loaded, dark = true)
        shot("artifacts-list-dark")
    }
}

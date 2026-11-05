package com.slopus.happy.ui.feed

import android.graphics.Bitmap
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.performCustomAccessibilityActionWithLabel
import org.junit.Assert.assertTrue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import coil3.asImage
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.Wire
import com.slopus.happy.agent.WireDesktopBootstrap
import com.slopus.happy.feed.FeedActor
import com.slopus.happy.feed.FeedActorName
import com.slopus.happy.artifacts.ArtifactCover
import com.slopus.happy.feed.FeedCluster
import com.slopus.happy.feed.FeedCovers
import com.slopus.happy.feed.FeedFilter
import com.slopus.happy.feed.FeedItem
import com.slopus.happy.feed.FeedLatest
import com.slopus.happy.feed.FeedLibrary
import com.slopus.happy.feed.FeedLookups
import com.slopus.happy.feed.FeedRow
import com.slopus.happy.feed.FeedRows
import com.slopus.happy.feed.FeedSubject
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.connection.AgentHomeList
import com.slopus.happy.ui.connection.AgentHomeTags
import com.slopus.happy.ui.connection.agentHomeItems
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * The Feed's screen: entries in date cards with their faces, dot and what
 * happened; opening one and Mark All Read; Following's switches. Each
 * rendered to build/feed-screens for review against iOS.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FeedScreenTest {
    @get:Rule val rule = createComposeRule()

    private val now = 1_780_000_000_000L
    private val hour = 3_600_000L

    private val catalog = AgentCatalog().withBootstrap(
        AgentClient.json.decodeFromJsonElement(
            WireDesktopBootstrap.serializer(),
            Wire.bootstrap(
                bots = listOf(Wire.bot("b1", "Scout", Wire.agent("ab1"))),
                tasks = listOf(Wire.task("t1", "Fix the login redirect on Safari", Wire.agent("at1"))),
                projects = listOf(Wire.project("p1", "happy", emptyList())),
                surfaces = listOf(Wire.surface("s1", "Groceries", "todo"), Wire.surface("s2", "Launch notes", "document")),
            ),
        ),
    )

    private fun item(id: String, subject: FeedSubject, at: Long, seen: Boolean = false, created: Boolean = false, updates: Int = 0, actors: List<FeedActor> = emptyList(), actorCount: Int = actors.size, latest: FeedLatest? = null) =
        FeedItem(id, "1", "c$id", subject, created, updates, actors, actorCount, latest, firstAt = at, lastAt = at, seenAt = if (seen) at else null)

    private val items = listOf(
        item("9", FeedSubject("artifact", "a1"), now - hour, updates = 2, actors = listOf(FeedActor(agentId = "ab1"))),
        item("8", FeedSubject("surface", "s1"), now - 2 * hour, updates = 3, actors = listOf(FeedActor(userId = "u1"), FeedActor(agentId = "ab1"), FeedActor(userId = "u7"), FeedActor(userId = "u8")), actorCount = 6, latest = FeedLatest("todo.created", todoId = "td1")),
        item("7", FeedSubject("task", "t1"), now - 3 * hour, seen = true, created = true, updates = 5, actors = listOf(FeedActor(agentId = "at1"))),
        item("6", FeedSubject("surface", "s2"), now - 26 * hour, seen = true, updates = 1, actors = listOf(FeedActor(userId = "u1"))),
        item("5", FeedSubject("bot", "b1"), now - 5 * 24 * hour, seen = true, created = true),
    )

    private val found = FeedLookups.Found(
        artifacts = mapOf("a1" to FeedLookups.Artifact("Release plan", "markdown", 4, deleted = false)),
        todos = mapOf(FeedLookups.todoKey("s1", "td1") to "Oat milk"),
    )

    private val state = FeedLibrary.State(available = true, items = items, unread = 2, loaded = true)

    private fun rows(state: FeedLibrary.State): List<FeedRow> = FeedRows.make(state.items, state::isUnread, catalog, found, "conn")

    @Test fun `who acted is said in full for one or two, then how many more`() {
        val words = FeedWords(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>().resources)
        val ann = FeedActorName.Named("Ann")
        assertEquals("", words.actors(emptyList(), 0))
        assertEquals("You", words.actors(listOf(FeedActorName.You), 1))
        assertEquals("Ann and You", words.actors(listOf(ann, FeedActorName.You), 2))
        assertEquals("Ann and 1 other", words.actors(listOf(ann), 2))
        assertEquals("Ann and 4 others", words.actors(listOf(ann, FeedActorName.You), 5))
    }

    @Test
    @Config(qualifiers = "ru")
    fun `who acted counts in the language's plural forms`() {
        val words = FeedWords(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>().resources)
        assertEquals("Ann и ещё 4", words.actors(listOf(FeedActorName.Named("Ann")), 5))
        assertEquals("Ann и Вы", words.actors(listOf(FeedActorName.Named("Ann"), FeedActorName.You), 2))
    }

    private fun shot(name: String) {
        rule.waitForIdle()
        val dir = File("build/feed-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun show(dark: Boolean = false, state: FeedLibrary.State = this.state, following: FeedFollowingState = FeedFollowingState(), actions: FeedActions = FeedActions(onBack = {})) =
        rule.setHappyContent(dark) { ProvideWindowLayout { FeedScreen(state, rows(state), catalog, following, actions, clock = { now }) } }

    @Test
    fun entriesSitInDateCardsWithFacesTheirDotAndWhatHappened() {
        show()
        rule.onNodeWithText("TODAY").assertExists()
        rule.onNodeWithText("YESTERDAY").assertExists()
        rule.onNodeWithText("PREVIOUS 7 DAYS").assertExists()
        rule.onNodeWithText("Release plan").assertExists()
        rule.onNodeWithText("2 new versions").assertExists()
        // A new todo says itself; a task's changes are updates, after it was made.
        rule.onNodeWithText("Oat milk").assertExists()
        rule.onNodeWithText("Created · 5 updates").assertExists()
        rule.onNodeWithText("1 edit").assertExists()
        rule.onNodeWithText("Created").assertExists()
        // Three faces at most, the rest counted.
        rule.onNodeWithText("+3").assertExists()
        rule.onAllNodesWithTag(FeedTags.DOT, useUnmergedTree = true).assertCountEquals(2)
        shot("feed-activity")
    }

    @Test
    fun theFeedInTheDark() {
        show(dark = true)
        shot("feed-activity-dark")
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun theFeedOnATabletKeepsTheReadingWidth() {
        show()
        shot("feed-activity-tablet")
    }

    @Test
    fun openingAnEntryAndMarkAllReadGoThroughTheirActions() {
        val opened = mutableListOf<String>()
        var readAll = 0
        show(actions = FeedActions(onBack = {}, onOpen = { opened += it.title }, onReadAll = { readAll++ }))
        rule.onNodeWithText("Release plan").performClick()
        rule.onNodeWithTag(FeedTags.READ_ALL).performClick()
        assertEquals(listOf("Release plan"), opened)
        assertEquals(1, readAll)
    }

    @Test
    fun itSaysWhyThereIsNothingToShow() {
        show(state = FeedLibrary.State(available = false, loaded = true))
        rule.onNodeWithText("This Happy Agent doesn’t track activity yet. Update it to see activity here.").assertExists()
    }

    @Test
    fun homesFeedRowSaysHowManyAreUnreadAndOpensTheFeed() {
        var opened = 0
        val feed = AgentFeed.derive(catalog, feedUnread = 3)
        rule.setHappyContent {
            ProvideWindowLayout {
                AgentHomeList(agentHomeItems(feed), rememberLazyListState(), onOpen = {}, contentPadding = PaddingValues(), onOpenFeed = { opened++ })
            }
        }
        rule.onNodeWithTag(AgentHomeTags.ROW_COUNT, useUnmergedTree = true).assertTextEquals("3")
        shot("home-feed-row")
        rule.onNodeWithText("Activity").performClick()
        assertEquals(1, opened)
    }

    @Test
    fun followingListsEverywhereThenEachPlaceWithItsSwitch() {
        val follows = mutableListOf<Pair<String, Boolean>>()
        val peeked = mutableListOf<String>()
        var read = 0
        val following = FeedFollowingState(
            clusters = listOf(
                FeedCluster("*", "everything", "subscribed"),
                FeedCluster("team", "team"),
                FeedCluster("bot:b1", "bot", "muted"),
                FeedCluster("task:t1", "task"),
                FeedCluster("project:p1", "project"),
                FeedCluster("surface:s1", "surface"),
                FeedCluster("task:gone", "task"),
            ),
            pending = setOf("project:p1"),
            loaded = true,
        )
        show(following = following, actions = FeedActions(onBack = {}, onReadFollowing = { read++ }, onFollow = { cluster, on -> follows += cluster to on }, onPeek = { peeked += it.cluster }))
        rule.onNodeWithTag(FeedTags.tab(following = true)).performClick()
        rule.waitForIdle()
        assertEquals(1, read)
        rule.onNodeWithText("EVERYWHERE").assertExists()
        rule.onNodeWithText("PLACES").assertExists()
        rule.onNodeWithText("Everything").assertExists()
        rule.onNodeWithText("Team").assertExists()
        rule.onAllNodesWithTag(FeedTags.PLACE).assertCountEquals(6)
        rule.onNodeWithTag(FeedTags.follow("bot:b1"), useUnmergedTree = true).assertIsOff()
        // No choice of its own follows Everything.
        rule.onNodeWithTag(FeedTags.follow("task:t1"), useUnmergedTree = true).assertIsOn()
        rule.onAllNodesWithTag(FeedTags.READ_ALL).assertCountEquals(0)
        shot("feed-following")
        // The switch follows or mutes; the row peeks in.
        rule.onNodeWithTag(FeedTags.follow("bot:b1"), useUnmergedTree = true).performClick()
        rule.onNodeWithText("Groceries").performClick()
        assertEquals(listOf("bot:b1" to true), follows)
        assertEquals(listOf("surface:s1"), peeked)
    }

    @Test
    fun aPeekShowsAPlacesNewestEntriesWithoutTheDot() {
        val opened = mutableListOf<String>()
        val peek = FeedPeekState(items.take(2), loaded = true)
        rule.setHappyContent {
            ProvideWindowLayout {
                FeedPeekScreen("Groceries", peek, FeedRows.make(peek.items, { false }, catalog, found, "conn"), catalog, FeedActions(onBack = {}, onOpen = { opened += it.title }), clock = { now })
            }
        }
        rule.onNodeWithText("Oat milk").assertExists()
        rule.onAllNodesWithTag(FeedTags.DOT, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(FeedTags.READ_ALL).assertCountEquals(0)
        shot("feed-peek")
        rule.onNodeWithText("Release plan").performClick()
        assertEquals(listOf("Release plan"), opened)
    }

    @Test
    fun aQuietPlaceSaysSo() {
        rule.setHappyContent(dark = true) {
            ProvideWindowLayout { FeedPeekScreen("Groceries", FeedPeekState(loaded = true), emptyList(), catalog, FeedActions(onBack = {}), clock = { now }) }
        }
        rule.onNodeWithText("Nothing has happened here in the last 30 days.").assertExists()
        shot("feed-peek-empty-dark")
    }

    /** Feed pictures as the screen reads them: a drawn chart for the cover, through a loader that decodes nothing. */
    private val coverReads = java.util.concurrent.CopyOnWriteArrayList<String>()

    /** The covers kept in memory are Android's LruCache, so they are read here, under Robolectric. */
    @Test
    fun coversAndPreviewsAreReadOnceAndKeptApart() = kotlinx.coroutines.test.runTest {
        val asked = mutableListOf<String>()
        val covers = FeedCovers(
            fetch = { cover -> asked += cover.key; byteArrayOf(1) },
            previews = { id, version, path -> asked += FeedCovers.previewKey(id, version, path); byteArrayOf(2) },
        )
        val cover = com.slopus.happy.feed.FeedCover("a1", 3, "loop.webp", "image/webp", com.slopus.happy.artifacts.ArtifactCover.Aspect.Square)
        assertEquals(1, covers.read(cover)?.single()?.toInt())
        assertEquals(2, covers.preview("a1", 3, "loop.webp")?.single()?.toInt())
        covers.read(cover)
        covers.preview("a1", 3, "loop.webp")
        assertEquals(listOf("artifact/a1/3/loop.webp", "artifact-preview/a1/3/loop.webp"), asked)
        assertEquals(2, covers.kept("artifact-preview/a1/3/loop.webp")?.single()?.toInt())
        // A computer without previews gives none, and it is asked again later.
        org.junit.Assert.assertNull(FeedCovers(fetch = { null }).preview("a1", 3, "loop.webp"))
    }

    private val covers = FeedCovers(fetch = { cover -> coverReads += cover.key; ByteArray(8) })
    private val chart: Bitmap = Bitmap.createBitmap(160, 90, Bitmap.Config.ARGB_8888).apply {
        val canvas = android.graphics.Canvas(this)
        canvas.drawColor(0xFF0B1020.toInt())
        val paint = android.graphics.Paint().apply { color = 0xFF5B8CFF.toInt() }
        listOf(30, 45, 40, 62, 75).forEachIndexed { index, value -> canvas.drawRect(16f + index * 28f, 80f - value, 36f + index * 28f, 80f, paint) }
    }
    private val loader = coil3.ImageLoader.Builder(androidx.test.core.app.ApplicationProvider.getApplicationContext())
        .components { add(coil3.test.FakeImageLoaderEngine.Builder().default(chart.asImage()).build()) }
        .build()

    private val covered = FeedLookups.Artifact(
        "Q3 revenue", "html", 4, deleted = false,
        cover = ArtifactCover("cover.png", "image/png", ArtifactCover.Aspect.Wide),
        summary = "Revenue up 18% QoQ, driven by enterprise seats.",
        background = "#0b1020",
    )
    private val postItems = listOf(item("10", FeedSubject("artifact", "a2"), now - hour / 2, updates = 1, actors = listOf(FeedActor(agentId = "ab1")))) + items
    private val postFound = found.copy(artifacts = found.artifacts + ("a2" to covered))

    /** A wide post, then a square one, over the rows. */
    private val bothItems = postItems.take(1) + item("11", FeedSubject("artifact", "a3"), now - hour / 2 - 60_000, created = true, actors = listOf(FeedActor(agentId = "at1"))) + postItems.drop(1)
    private val bothFound = postFound.copy(
        artifacts = postFound.artifacts + ("a3" to covered.copy(title = "Pipeline by stage", cover = ArtifactCover("pipeline.png", "image/png", ArtifactCover.Aspect.Square), summary = "Pipeline by stage, this week.", background = null)),
    )

    private fun showPosts(state: FeedLibrary.State, dark: Boolean = false, actions: FeedActions = FeedActions(onBack = {}), found: FeedLookups.Found = postFound) =
        rule.setHappyContent(dark) {
            androidx.compose.runtime.CompositionLocalProvider(com.slopus.happy.ui.components.LocalImageLoader provides loader) {
                ProvideWindowLayout {
                    FeedScreen(state, FeedRows.make(state.items, state::isUnread, catalog, found, "conn"), catalog, FeedFollowingState(), actions, clock = { now }, covers = covers)
                }
            }
        }

    @Test
    fun aCoveredArtifactIsAPostItsHeightFromItsCover() {
        val opened = mutableListOf<String>()
        showPosts(FeedLibrary.State(available = true, items = postItems, unread = 3, loaded = true), actions = FeedActions(onBack = {}, onOpen = { opened += it.title }))
        rule.waitForIdle()
        rule.onNodeWithText("Revenue up 18% QoQ, driven by enterprise seats.").assertExists()
        // Across the card inside its 16: 411 − 2 × 16 − 2 × 16 wide, as tall as 16:9 makes it.
        val card = rule.node(FeedTags.row("10")).bounds
        val cover = rule.node(FeedTags.COVER).bounds
        val width = (PHONE_WIDTH - 64).toFloat()
        assertBox("cover", cover, 32.dp, cover.top, width.dp, (width * 9 / 16).dp)
        val summary = rule.node(FeedTags.POST_SUMMARY).bounds
        assertDp("summary start", 32, summary.left)
        assertDp("cover under the summary", summary.bottom + FeedSpec.coverGap, cover.top)
        assertDp("16 under the cover", cover.bottom + 16.dp, card.bottom)
        assertEquals(listOf("artifact/a2/4/cover.png"), coverReads.toList())
        // Other rows keep theirs.
        rule.onAllNodesWithTag(FeedTags.COVER, useUnmergedTree = true).assertCountEquals(1)
        shot("feed-post")
        rule.node(FeedTags.COVER).performClick()
        assertEquals(listOf("Q3 revenue"), opened)
    }

    @Test
    fun aSquareCoverIsAsTallAsItIsWide() {
        val square = covered.copy(title = "Pipeline by stage", cover = ArtifactCover("chart.png", "image/png", ArtifactCover.Aspect.Square), summary = null)
        rule.setHappyContent {
            ProvideWindowLayout {
                val state = FeedLibrary.State(available = true, items = postItems.take(1), loaded = true)
                FeedScreen(state, FeedRows.make(state.items, state::isUnread, catalog, postFound.copy(artifacts = mapOf("a2" to square)), "conn"), catalog, FeedFollowingState(), FeedActions(onBack = {}), clock = { now })
            }
        }
        val cover = rule.node(FeedTags.COVER).bounds
        assertDp("square width", PHONE_WIDTH - 64, cover.width)
        assertDp("square height", cover.width, cover.height)
        // No summary: the cover follows the header.
        rule.onAllNodesWithTag(FeedTags.POST_SUMMARY, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun onATabletASquareKeepsTheReadingWidth() {
        val square = covered.copy(title = "Pipeline by stage", cover = ArtifactCover("chart.png", "image/png", ArtifactCover.Aspect.Square))
        rule.setHappyContent {
            androidx.compose.runtime.CompositionLocalProvider(com.slopus.happy.ui.components.LocalImageLoader provides loader) {
                ProvideWindowLayout {
                    val state = FeedLibrary.State(available = true, items = postItems, loaded = true)
                    FeedScreen(state, FeedRows.make(state.items, state::isUnread, catalog, postFound.copy(artifacts = postFound.artifacts + ("a2" to square)), "conn"), catalog, FeedFollowingState(), FeedActions(onBack = {}), clock = { now }, covers = covers)
                }
            }
        }
        val cover = rule.node(FeedTags.COVER).bounds
        // Desktop's 640 card, not the tablet's 768 measure, and the cover 16 inside it.
        assertDp("square width", 640 - 32, cover.width)
        assertDp("square height", cover.width, cover.height)
        shot("feed-post-square-tablet")
    }

    private val long = (1..12).joinToString("\n") { "Line $it of the quarter's notes: revenue, seats and churn." }

    private fun showLong(opened: MutableList<String>, cover: ArtifactCover? = covered.cover) {
        val artifact = covered.copy(cover = cover, summary = long)
        rule.setHappyContent {
            androidx.compose.runtime.CompositionLocalProvider(com.slopus.happy.ui.components.LocalImageLoader provides loader) {
                ProvideWindowLayout {
                    val state = FeedLibrary.State(available = true, items = postItems.take(2), loaded = true)
                    FeedScreen(state, FeedRows.make(state.items, state::isUnread, catalog, postFound.copy(artifacts = postFound.artifacts + ("a2" to artifact)), "conn"), catalog, FeedFollowingState(), FeedActions(onBack = {}, onOpen = { opened += it.title }), clock = { now }, covers = covers)
                }
            }
        }
        rule.waitForIdle()
    }

    @OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)
    @Test
    fun aLongSummaryShowsFourLinesThenOpensInPlace() {
        val opened = mutableListOf<String>()
        showLong(opened)
        val summary = rule.node(FeedTags.POST_SUMMARY)
        // Four 20 lines, the fourth ending "… Show more"; its breaks kept.
        assertDp("four lines", 80, summary.bounds.height)
        summary.assertTextContains("Show more", substring = true)
        summary.assertTextContains("Line 1 of the quarter's notes: revenue, seats and churn.\nLine 2", substring = true)
        shot("feed-summary-collapsed")
        summary.performCustomAccessibilityActionWithLabel("Show more")
        rule.waitForIdle()
        assertTrue(rule.node(FeedTags.POST_SUMMARY).bounds.height > 200.dp)
        rule.node(FeedTags.POST_SUMMARY).assertTextContains("Line 12", substring = true)
        rule.node(FeedTags.POST_SUMMARY).assertTextContains("Show less", substring = true)
        shot("feed-summary-expanded")
        // Opening it in place opened nothing; the cover still opens the artifact.
        assertEquals(emptyList<String>(), opened)
        rule.node(FeedTags.COVER).performClick()
        assertEquals(listOf("Q3 revenue"), opened)
        // And Show less folds it again.
        rule.node(FeedTags.POST_SUMMARY).performCustomAccessibilityActionWithLabel("Show less")
        rule.waitForIdle()
        assertDp("four lines again", 80, rule.node(FeedTags.POST_SUMMARY).bounds.height)
    }

    @Test
    fun aSummaryWithoutACoverIsAPostOfWords() {
        showLong(mutableListOf(), cover = null)
        rule.onAllNodesWithTag(FeedTags.COVER, useUnmergedTree = true).assertCountEquals(0)
        val summary = rule.node(FeedTags.POST_SUMMARY).bounds
        val card = rule.node(FeedTags.row("10")).bounds
        assertDp("16 under the words", summary.bottom + 16.dp, card.bottom)
        shot("feed-summary-no-cover")
    }

    @Test
    fun aShortSummaryHasNoToggle() {
        showPosts(FeedLibrary.State(available = true, items = postItems.take(1), loaded = true))
        rule.node(FeedTags.POST_SUMMARY).assertTextEquals("Revenue up 18% QoQ, driven by enterprise seats.")
    }

    @Test
    fun highlightsShowArtifactsAndTasksAndThePickIsSent() {
        val picked = mutableListOf<FeedFilter>()
        val highlights = FeedLibrary.State(available = true, items = postItems.filter(FeedFilter.Highlights::admits), unread = 2, loaded = true, filter = FeedFilter.Highlights)
        showPosts(highlights, actions = FeedActions(onBack = {}, onFilter = { picked += it }))
        rule.node(FeedTags.filter(FeedFilter.Highlights)).assertIsSelected()
        rule.onNodeWithText("Q3 revenue").assertExists()
        rule.onNodeWithText("Fix the login redirect on Safari").assertExists()
        rule.onNodeWithText("Groceries").assertDoesNotExist()
        // The filter spans the cards' width, 8 under the bar: its segments 2 inside it.
        val slot = rule.node(FeedTags.FILTER).bounds
        val all = rule.node(FeedTags.filter(FeedFilter.All)).bounds
        val chosen = rule.node(FeedTags.filter(FeedFilter.Highlights)).bounds
        assertDp("filter start", 18, all.left)
        assertDp("filter end", PHONE_WIDTH - 18, chosen.right)
        assertDp("filter top", slot.top + 10.dp, all.top)
        assertDp("halves", all.width, chosen.width)
        shot("feed-highlights")
        rule.node(FeedTags.filter(FeedFilter.All)).performClick()
        assertEquals(listOf(FeedFilter.All), picked)
    }

    @Test
    fun allShowsWideAndSquarePostsBesideRows() {
        showPosts(FeedLibrary.State(available = true, items = bothItems, unread = 3, loaded = true), found = bothFound)
        rule.node(FeedTags.filter(FeedFilter.All)).assertIsSelected()
        rule.onNodeWithTag(FeedTags.LIST).performScrollToNode(androidx.compose.ui.test.hasText("Pipeline by stage"))
        shot("feed-posts-wide-square")
    }

    @Test
    fun postsInTheDark() {
        showPosts(FeedLibrary.State(available = true, items = bothItems, unread = 3, loaded = true), dark = true, found = bothFound)
        shot("feed-post-dark")
    }

    @Test
    fun anEmptyHighlightsSaysWhatShowsThere() {
        show(state = FeedLibrary.State(available = true, loaded = true, filter = FeedFilter.Highlights))
        rule.onNodeWithText("No highlights yet").assertExists()
        rule.onNodeWithText("Artifacts and new tasks appear here.").assertExists()
        shot("feed-highlights-empty")
    }

    @Test
    fun highlightsFilteredHereKeepPagingWhileOlderPagesMayHoldOne() {
        var more = 0
        show(state = FeedLibrary.State(available = true, loaded = true, hasMore = true, filter = FeedFilter.Highlights), actions = FeedActions(onBack = {}, onLoadMore = { more++ }))
        rule.waitForIdle()
        rule.onNodeWithText("Loading activity…").assertExists()
        rule.onNodeWithText("No highlights yet").assertDoesNotExist()
        assertEquals(1, more)
    }

    @Test
    fun followingInTheDarkAndARefusalSaysWhy() {
        val following = FeedFollowingState(clusters = listOf(FeedCluster("*", "everything"), FeedCluster("bot:b1", "bot", "muted")), loaded = true, refused = "Not allowed.")
        show(dark = true, following = following)
        rule.onNodeWithTag(FeedTags.tab(following = true)).performClick()
        rule.onNodeWithText("Couldn’t change what you follow. Not allowed.").assertExists()
    }
}

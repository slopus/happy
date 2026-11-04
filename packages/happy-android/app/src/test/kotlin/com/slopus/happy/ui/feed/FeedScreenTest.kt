package com.slopus.happy.ui.feed

import android.graphics.Bitmap
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.Wire
import com.slopus.happy.agent.WireDesktopBootstrap
import com.slopus.happy.feed.FeedActor
import com.slopus.happy.feed.FeedActorName
import com.slopus.happy.feed.FeedCluster
import com.slopus.happy.feed.FeedItem
import com.slopus.happy.feed.FeedLatest
import com.slopus.happy.feed.FeedLibrary
import com.slopus.happy.feed.FeedLookups
import com.slopus.happy.feed.FeedRow
import com.slopus.happy.feed.FeedRows
import com.slopus.happy.feed.FeedSubject
import com.slopus.happy.ui.PHONE
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
        rule.onNodeWithText("This Happy Agent doesn’t keep a feed. Updating it adds one.").assertExists()
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
        rule.onNodeWithText("Feed").performClick()
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

    @Test
    fun followingInTheDarkAndARefusalSaysWhy() {
        val following = FeedFollowingState(clusters = listOf(FeedCluster("*", "everything"), FeedCluster("bot:b1", "bot", "muted")), loaded = true, refused = "Not allowed.")
        show(dark = true, following = following)
        rule.onNodeWithTag(FeedTags.tab(following = true)).performClick()
        rule.onNodeWithText("Couldn’t change what you follow. Not allowed.").assertExists()
    }
}

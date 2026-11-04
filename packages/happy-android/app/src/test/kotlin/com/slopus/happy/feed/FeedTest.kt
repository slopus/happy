package com.slopus.happy.feed

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.IntentOutbox
import com.slopus.happy.agent.IntentRefusal
import com.slopus.happy.agent.MemoryIntentStorage
import com.slopus.happy.agent.Wire
import com.slopus.happy.agent.WireDesktopBootstrap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** iOS's FeedLibraryTests and FeedPresentationTests: the feed kept, merged, seen through the outbox, and joined into rows. */
class FeedTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After fun tearDown() = scope.cancel()

    private fun item(id: String, cursor: String, version: String = "1", subject: FeedSubject = FeedSubject("artifact", id), seenAt: Long? = null, updates: Int = 1, actors: List<FeedActor> = emptyList(), actorCount: Int = actors.size) =
        FeedItem(id, version, cursor, subject, updates = updates, actors = actors, actorCount = actorCount, firstAt = 1, lastAt = 2, seenAt = seenAt)

    private class Routes : FeedRoutes {
        @Volatile var capable = true
        @Volatile var page = FeedPage(emptyList(), 0, hasMore = false)
        val seen = CopyOnWriteArrayList<Pair<FeedSubject, String?>>()
        val readAll = CopyOnWriteArrayList<String?>()
        @Volatile var seenAnswer: (FeedSubject) -> Pair<List<FeedItem>, Int> = { emptyList<FeedItem>() to 0 }
        @Volatile var refuse: Int? = null

        override suspend fun capable() = capable
        override suspend fun page(before: String?, limit: Int) = page
        override suspend fun seen(subject: FeedSubject, through: String?, mutationId: String): Pair<List<FeedItem>, Int> {
            refuse?.let { throw AgentApiException(it, "invalid_request", "No such subject") }
            seen += subject to through
            return seenAnswer(subject)
        }
        override suspend fun readAll(through: String?, mutationId: String): Int {
            readAll += through
            return 0
        }
        override suspend fun clusters() = emptyList<FeedCluster>()
        override suspend fun follow(cluster: String, follow: Boolean, mutationId: String) = FeedCluster(cluster, FeedCluster.kindOf(cluster), if (follow) "subscribed" else "muted")
        override suspend fun peek(cluster: String, limit: Int) = emptyList<FeedItem>()
    }

    private suspend fun eventually(check: () -> Boolean) {
        withTimeout(5_000) { while (!check()) delay(10) }
    }

    private fun library(routes: Routes, outbox: IntentOutbox, kept: JsonObject? = null, written: MutableList<JsonObject> = CopyOnWriteArrayList()) =
        FeedLibrary(scope, routes, outbox, kept = { kept }, keep = { written += it }, now = { 77 })

    @Test
    fun entriesMergeByIdTheGreaterVersionWinningNewestCursorFirst() {
        val held = listOf(item("b", "c2", version = "2"), item("a", "c1"))
        val merged = FeedLibrary.upsert(held, listOf(item("b", "c2", version = "1"), item("a", "c3", version = "2"), item("n", "c4")), hasMore = false)
        assertEquals(listOf("n" to "1", "a" to "2", "b" to "2"), merged.map { it.id to it.version })
        // With more to page in, an entry older than the last one held waits for its page, so the list has no gap.
        assertEquals(listOf("b", "a"), FeedLibrary.upsert(held, listOf(item("old", "c0")), hasMore = true).map { it.id })
        assertTrue("nothing new is the same list", FeedLibrary.upsert(held, listOf(item("a", "c1")), hasMore = false) === held)
    }

    @Test
    fun aComputerHasAFeedWhereHealthSaysSoAndNoBootstrapDenies(): Unit = runBlocking {
        val routes = Routes().apply { page = FeedPage(listOf(item("a", "c2"), item("b", "c1", seenAt = 5)), unread = 1, hasMore = false, cursor = "e9") }
        val outbox = IntentOutbox(scope, MemoryIntentStorage())
        val feed = library(routes, outbox)
        feed.start()
        feed.bootstrap(1, "e1")
        feed.connected()
        eventually { feed.state.value.items.size == 2 }
        assertEquals(true, feed.state.value.available)
        assertEquals(1, feed.state.value.unread)
        assertEquals(listOf(true, false), feed.state.value.items.map(feed.state.value::isUnread))

        // An older daemon's bootstrap carries no `feedUnread`: no feed, and nothing of it kept.
        val old = library(Routes().apply { capable = false }, IntentOutbox(scope, MemoryIntentStorage()))
        old.start()
        old.bootstrap(null, "e1")
        old.connected()
        eventually { old.state.value.available == false }
        assertEquals(emptyList<FeedItem>(), old.state.value.items)
    }

    @Test
    fun anEntryOpenedReadsSeenAtOnceGoesThroughTheOutboxAndItsAnswerClosesIt(): Unit = runBlocking {
        val open = item("a", "c2")
        val routes = Routes().apply {
            page = FeedPage(listOf(open, item("b", "c1")), unread = 2, hasMore = false)
            seenAnswer = { listOf(open.copy(version = "2", seenAt = 9)) to 1 }
        }
        val outbox = IntentOutbox(scope, MemoryIntentStorage())
        val feed = library(routes, outbox)
        feed.start()
        feed.bootstrap(2, "e1")
        feed.connected()
        eventually { feed.state.value.items.size == 2 }

        feed.open(open)
        eventually { feed.state.value.unread == 1 }
        assertEquals("seen here before the computer hears", setOf("a"), feed.state.value.seenHere)
        assertEquals(emptyList<Pair<FeedSubject, String?>>(), routes.seen.toList())

        outbox.setOnline(true)
        eventually { routes.seen.isNotEmpty() && outbox.pending.value.isEmpty() }
        assertEquals(listOf(FeedSubject("artifact", "a") to "c2"), routes.seen.toList())
        eventually { feed.state.value.seenHere.isEmpty() }
        assertFalse(feed.state.value.isUnread(feed.state.value.items.first { it.id == "a" }))
        assertEquals(1, feed.state.value.unread)

        // Seen again from its own screen: nothing more to send.
        feed.seen(FeedSubject("artifact", "a"))
        delay(100)
        assertEquals(1, routes.seen.size)
    }

    @Test
    fun markAllReadReadsThroughTheNewestEntryShownAndARefusalIsDropped(): Unit = runBlocking {
        val routes = Routes().apply { page = FeedPage(listOf(item("a", "c3"), item("b", "c2")), unread = 2, hasMore = false) }
        val outbox = IntentOutbox(scope, MemoryIntentStorage())
        val feed = library(routes, outbox)
        feed.start()
        feed.bootstrap(2, "e1")
        feed.connected()
        eventually { feed.state.value.items.size == 2 }
        feed.readAll()
        eventually { feed.state.value.unread == 0 }
        outbox.setOnline(true)
        eventually { routes.readAll.isNotEmpty() && outbox.pending.value.isEmpty() }
        assertEquals(listOf<String?>("c3"), routes.readAll.toList())
        eventually { feed.state.value.items.none { it.open } }
        assertEquals(listOf(77L, 77L), feed.state.value.items.map { it.seenAt })

        // The computer refusing a seen is final: the intent goes, rather than wait forever.
        routes.refuse = 400
        try {
            feed.deliver(com.slopus.happy.agent.Intent("i1", FeedLibrary.FEED_SEEN, "artifact:x", buildJsonObject { put("type", "artifact"); put("id", "x") }, 1))
            fail("a 400 is a refusal")
        } catch (_: IntentRefusal) {
        }
        // A daemon without the route has none to refuse: done.
        routes.refuse = 404
        feed.deliver(com.slopus.happy.agent.Intent("i2", FeedLibrary.FEED_SEEN, "artifact:x", buildJsonObject { put("type", "artifact"); put("id", "x") }, 1))
    }

    @Test
    fun eventsKeepItCurrentAndAnOlderCountNeverReplacesANewerOne(): Unit = runBlocking {
        val feed = library(Routes(), IntentOutbox(scope, MemoryIntentStorage()))
        feed.start()
        feed.bootstrap(0, "e1")
        feed.connected()
        eventually { feed.state.value.loaded && !feed.state.value.refreshing }
        val made = item("a", "c5")
        feed.receive(AgentEvent("e2", "feed.item.created", buildJsonObject { put("item", made.json()) }))
        feed.receive(AgentEvent("e5", "feed.unread.updated", buildJsonObject { put("unread", 1) }))
        feed.receive(AgentEvent("e3", "feed.unread.updated", buildJsonObject { put("unread", 9) }))
        assertEquals(listOf("a"), feed.state.value.items.map { it.id })
        assertEquals(1, feed.state.value.unread)
        feed.receive(AgentEvent("e6", "feed.item.updated", buildJsonObject { put("item", made.copy(version = "2", updates = 4).json()) }))
        assertEquals(4, feed.state.value.items.single().updates)
        feed.receive(AgentEvent("e7", "feed.item.removed", buildJsonObject { put("itemId", "a") }))
        assertEquals(emptyList<FeedItem>(), feed.state.value.items)
    }

    @Test
    fun whatWasKeptShowsFirstAndAnEntryRoundTrips(): Unit = runBlocking {
        val entry = item("a", "c2", actors = listOf(FeedActor(agentId = "ab1"), FeedActor(userId = "u2")), actorCount = 7)
        assertEquals(entry, FeedItem.parse(entry.json()))
        val written = CopyOnWriteArrayList<JsonObject>()
        val first = library(Routes(), IntentOutbox(scope, MemoryIntentStorage()), written = written)
        first.start()
        first.bootstrap(1, "e1")
        first.connected()
        eventually { first.state.value.loaded && !first.state.value.refreshing }
        first.receive(AgentEvent("e2", "feed.item.created", buildJsonObject { put("item", entry.json()) }))
        eventually { written.any { FeedItem.list(it["items"]).isNotEmpty() } }

        val next = library(Routes(), IntentOutbox(scope, MemoryIntentStorage()), kept = written.last())
        next.start()
        eventually { next.state.value.loaded }
        assertEquals(true, next.state.value.available)
        assertEquals(listOf(entry), next.state.value.items)
    }

    private fun catalog(bootstrap: JsonObject) = AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), bootstrap))

    private val synced = catalog(
        Wire.bootstrap(
            bots = listOf(Wire.bot("b1", "Scout", Wire.agent("ab1"), thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI")),
            tasks = listOf(Wire.task("t1", "Fix login", Wire.agent("at1"))),
            surfaces = listOf(Wire.surface("s1", "Groceries", "todo")),
        ),
    )

    @Test
    fun rowsAreJoinedFromWhatTheConnectionSyncsAndAnEntryWithoutItIsLeftOut() {
        val items = listOf(
            item("e1", "c6", subject = FeedSubject("bot", "b1"), actors = listOf(FeedActor(agentId = "ab1"), FeedActor(userId = "u2"), FeedActor(agentId = "zz"), FeedActor(userId = "u3")), actorCount = 5),
            item("e2", "c5", subject = FeedSubject("task", "t1")),
            item("e3", "c4", subject = FeedSubject("surface", "s1")).copy(latest = FeedLatest("todo.created", todoId = "td1")),
            item("e4", "c3", subject = FeedSubject("artifact", "a1")),
            item("e5", "c2", subject = FeedSubject("artifact", "a2")),
            item("e6", "c1", subject = FeedSubject("surface", "gone")),
            item("e7", "c0", subject = FeedSubject("artifact", "dead")),
        )
        val found = FeedLookups.Found(
            artifacts = mapOf("a1" to FeedLookups.Artifact("Plan", "markdown", 3, deleted = false), "dead" to FeedLookups.Artifact("Old", "html", 1, deleted = true)),
            todos = mapOf(FeedLookups.todoKey("s1", "td1") to "Buy milk"),
        )
        val rows = FeedRows.make(items, { it.id != "e2" }, synced, found, personSeed = "conn")
        assertEquals(listOf("e1", "e2", "e3", "e4", "e7"), rows.map { it.id })
        val byId = rows.associateBy { it.id }
        val bot = byId.getValue("e1")
        assertEquals("Scout", bot.title)
        assertEquals(FeedTarget.Chat("ab1", "Scout"), bot.target)
        assertEquals(FeedRows.MAX_FACES, bot.actors.size)
        assertEquals(5, bot.actorCount)
        // An agent wears its bot's face; a person their own, round; an agent no bot or task holds its own placeholder.
        assertEquals(FeedFace.Mark("b1", round = false, picture = "/v0/bots/b1/avatar", thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"), bot.actors[0])
        assertEquals(FeedFace.Mark("u2", round = true), bot.actors[1])
        assertEquals(FeedFace.Mark("zz", round = false), bot.actors[2])
        assertFalse(byId.getValue("e2").unread)
        assertEquals("Buy milk", byId.getValue("e3").detail)
        assertEquals(FeedFace.Tile(FeedSubjectKind.TodoList), byId.getValue("e3").face)
        assertEquals(FeedTarget.Surface("s1", "todo", "Groceries"), byId.getValue("e3").target)
        assertEquals(3, (byId.getValue("e4").target as FeedTarget.Artifact).ref.version)
        assertNull("a deleted artifact shows and opens nothing", byId.getValue("e7").target)
    }

    @Test
    fun thePersonsFaceWearsTheirProfilePhotoOverItsThumbHash() {
        // desktop 0ffabe03, iOS FeedDirectory.face: the person, and the standalone reader, wear their photo.
        val mine = synced.copy(userId = "me")
        val hash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"
        // In a team the person's own is read as any member's; standalone, from the profile.
        val photo = FeedFace.Mark("me", round = true, picture = "/v0/users/me/photo", thumbhash = hash)
        assertEquals(photo, FeedRows.face(FeedActor(userId = "me"), mine, emptyMap(), "conn", hash))
        assertEquals(FeedFace.Mark("conn", round = true, picture = "/v0/profile/photo", thumbhash = hash), FeedRows.face(FeedActor(), synced.copy(userId = null), emptyMap(), "conn", hash))
        // Someone else, or no photo: the placeholder.
        assertEquals(FeedFace.Mark("u2", round = true), FeedRows.face(FeedActor(userId = "u2"), mine, emptyMap(), "conn", hash))
        assertEquals(FeedFace.Mark("me", round = true), FeedRows.face(FeedActor(userId = "me"), mine, emptyMap(), "conn", null))
    }

    @Test
    fun inATeamPeopleWearTheirFacesAndNamesAndATaskItsAuthors() {
        val hash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"
        val team = catalog(
            Wire.bootstrap(tasks = listOf(JsonObject(Wire.task("t1", "Fix login", Wire.agent("at1")) + ("ownerUserId" to kotlinx.serialization.json.JsonPrimitive("u2"))))),
        )
        val users = mapOf("u2" to com.slopus.happy.agent.TeamUser("u2", "Ann", hash), "u3" to com.slopus.happy.agent.TeamUser("u3", "Bo"))
        val items = listOf(
            item("e1", "c1", subject = FeedSubject("task", "t1"), actors = listOf(FeedActor(userId = "u2"), FeedActor(userId = "u3"), FeedActor(userId = Wire.USER), FeedActor(userId = "u9"), FeedActor(agentId = "at1")), actorCount = 6),
        )
        // Who the Feed needs read: the actors and the task's author, not the person.
        assertEquals(setOf("u2", "u3", "u9"), FeedRows.people(items, team))
        val row = FeedRows.make(items, { false }, team, FeedLookups.Found(), "conn", users = users).single()
        // The task wears its author's face, a rounded square.
        assertEquals(FeedFace.Mark("u2", round = false, picture = "/v0/users/u2/photo", thumbhash = hash), row.face)
        assertEquals(FeedFace.Mark("u2", round = true, picture = "/v0/users/u2/photo", thumbhash = hash), row.actors[0])
        assertEquals(FeedFace.Mark("u3", round = true), row.actors[1])
        // Names as known: the person is You; one not read yet is left out; an agent its task's name.
        assertEquals(listOf(FeedActorName.Named("Ann"), FeedActorName.Named("Bo"), FeedActorName.You, FeedActorName.Named("Fix login")), row.actorNames)
    }

    @Test
    fun homesFeedRowSitsUnderArtifactsWhileTheComputerKeepsAFeed() {
        val with = AgentFeed.derive(synced, feedUnread = 4).rows.map { it.key }
        assertEquals(listOf("section-places", "artifacts", "feed"), with.take(3))
        assertEquals(AgentFeedRow.Feed(4), AgentFeed.derive(synced, feedUnread = 4).rows.first { it is AgentFeedRow.Feed })
        assertTrue(AgentFeed.derive(synced).rows.none { it is AgentFeedRow.Feed })
    }
}

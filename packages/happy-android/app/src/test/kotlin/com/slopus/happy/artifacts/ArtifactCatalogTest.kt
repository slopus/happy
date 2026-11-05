package com.slopus.happy.artifacts

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.conversation.Problem
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * iOS's ArtifactCatalogTests, DateBucketTests and ArtifactCatalogFeedTests,
 * against the same rules. The feed runs in `backgroundScope`, which
 * `advanceUntilIdle` leaves alone, so each step is `runCurrent`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ArtifactCatalogTest {
    private fun obj(text: String) = Json.parseToJsonElement(text) as JsonObject

    private fun summary(id: String, updatedAt: Long, title: String = id, type: String = "markdown") =
        ArtifactSummary(id, type, title, 1, ArtifactFile("index.md", "text/markdown", 10), createdAt = updatedAt, updatedAt = updatedAt)

    @Test fun aPageReadsLiveArtifactsAndItsCursor() {
        val (items, next) = ArtifactCatalog.page(
            obj(
                """{"artifacts":[
                {"id":"a1","type":"image_series","title":"Shots","latestVersion":4,"entry":{"path":"a.png","mimeType":"image/png","size":12},"fileCount":3,"createdAt":1,"updatedAt":5},
                {"id":"a2","type":"html","title":"Live","live":{"url":"http://localhost:3000","networkId":"n"},"createdAt":2},
                {"id":"gone","status":"deleted","createdAt":3},
                {"title":"no id"}
                ],"nextPageCursor":"p2"}""",
            ),
        )
        assertEquals(listOf("a1", "a2"), items.map { it.id })
        assertEquals(ArtifactSummary("a1", "image_series", "Shots", 4, ArtifactFile("a.png", "image/png", 12), 3, false, 1, 5), items[0])
        assertTrue(items[0].showsPicture)
        // A live page's entry only stands in for it, and its time is its creation's.
        assertTrue(items[1].live)
        assertFalse(items[1].showsPicture)
        assertEquals(2L, items[1].updatedAt)
        assertEquals("p2", next)
    }

    @Test fun whatIsKeptReadsBackTheSame() {
        val items = listOf(summary("b", 20), summary("a", 10).copy(live = true, entry = null, fileCount = 2))
        assertEquals(items, ArtifactCatalog.fromKept(ArtifactCatalog.kept(items)))
    }

    @Test fun theLatestVersionsCoverSummaryAndBackgroundAreKeptAndFollowTheirChanges() {
        val read = ArtifactSummary.parse(
            obj("""{"id":"a","type":"html","title":"Q3","latestVersion":2,"createdAt":1,"updatedAt":2,"background":"#0B1020","summary":"Up 18%.",
                "cover":{"path":"cover.png","mimeType":"image/png","width":1600,"height":900,"aspect":"wide"}}"""),
        )!!
        assertEquals(ArtifactCover("cover.png", "image/png", ArtifactCover.Aspect.Wide), read.cover)
        assertEquals("Up 18%.", read.summary)
        assertEquals("#0b1020", read.background)
        assertEquals(read, ArtifactSummary.parse(read.json()))
        // An older daemon's artifact has none.
        val older = ArtifactSummary.parse(obj("""{"id":"b","type":"markdown","title":"B","latestVersion":1,"createdAt":1,"updatedAt":1}"""))!!
        assertEquals(null, older.cover)
        // A change naming the cover sets it, `null` clears it, and one that doesn't name it keeps it.
        val square = ArtifactCatalog.apply(
            "artifact.updated",
            obj("""{"artifactId":"a","changes":{"latestVersion":3,"updatedAt":3,"cover":{"path":"c.png","mimeType":"image/png","width":1200,"height":1200,"aspect":"square"}}}"""),
            listOf(read),
        ) as ArtifactCatalog.Change.Changed
        assertEquals(ArtifactCover.Aspect.Square, square.items.single().cover?.aspect)
        assertEquals("Up 18%.", square.items.single().summary)
        val cleared = ArtifactCatalog.apply("artifact.updated", obj("""{"artifactId":"a","changes":{"updatedAt":4,"cover":null,"summary":null}}"""), square.items) as ArtifactCatalog.Change.Changed
        assertEquals(null, cleared.items.single().cover)
        assertEquals(null, cleared.items.single().summary)
        assertEquals("#0b1020", cleared.items.single().background)
    }

    @Test fun eventsAddChangeAndRemove() {
        val list = listOf(summary("a", 30), summary("b", 20))
        val created = ArtifactCatalog.apply("artifact.created", obj("""{"artifact":{"id":"c","type":"html","title":"New","createdAt":40,"updatedAt":40}}"""), list)
        assertEquals(listOf("c", "a", "b"), (created as ArtifactCatalog.Change.Changed).items.map { it.id })

        val updated = ArtifactCatalog.apply(
            "artifact.updated",
            obj("""{"artifactId":"b","changes":{"title":"Renamed","latestVersion":3,"entry":{"path":"v.mp4","mimeType":"video/mp4","size":9},"fileCount":1,"live":null,"updatedAt":50}}"""),
            list,
        ) as ArtifactCatalog.Change.Changed
        assertEquals(listOf("b", "a"), updated.items.map { it.id })
        assertEquals(ArtifactSummary("b", "markdown", "Renamed", 3, ArtifactFile("v.mp4", "video/mp4", 9), 1, false, 20, 50), updated.items[0])

        // Nothing it carries is new: nothing changes.
        assertEquals(ArtifactCatalog.Change.None, ArtifactCatalog.apply("artifact.updated", obj("""{"artifactId":"a","changes":{"title":"a","updatedAt":30}}"""), list))
        // One the list doesn't hold is read.
        assertEquals(ArtifactCatalog.Change.Read("z"), ArtifactCatalog.apply("artifact.updated", obj("""{"artifactId":"z","changes":{}}"""), list))
        val deleted = ArtifactCatalog.apply("artifact.deleted", obj("""{"artifactId":"a","changes":{"status":"deleted"}}"""), list) as ArtifactCatalog.Change.Changed
        assertEquals(listOf("b"), deleted.items.map { it.id })
        assertEquals(ArtifactCatalog.Change.None, ArtifactCatalog.apply("artifact.deleted", obj("""{"artifactId":"z"}"""), list))
        assertEquals(ArtifactCatalog.Change.None, ArtifactCatalog.apply("agent.updated", obj("{}"), list))
    }

    @Test fun newestChangeFirstTheIdBreakingTies() {
        assertEquals(listOf("c", "b", "a"), ArtifactCatalog.sorted(listOf(summary("a", 10), summary("c", 20), summary("b", 10))).map { it.id })
    }

    @Test fun searchFindsEveryWordInTheTitleOrKindIgnoringCaseAndAccents() {
        val list = listOf(summary("1", 1, "Café menu"), summary("2", 2, "Quarterly report", type = "html"), summary("3", 3, "Report draft"))
        val kind = { a: ArtifactSummary -> if (a.type == "html") "Web page" else "Document" }
        assertEquals(listOf("1"), ArtifactCatalog.matching("CAFE", list, kind).map { it.id })
        assertEquals(listOf("2", "3"), ArtifactCatalog.matching("report", list, kind).map { it.id })
        assertEquals(listOf("2"), ArtifactCatalog.matching("report web", list, kind).map { it.id })
        assertEquals(list, ArtifactCatalog.matching("   ", list, kind))
    }

    private val zone = ZoneId.of("Europe/Berlin")
    private fun at(text: String) = LocalDateTime.parse(text).atZone(zone).toInstant().toEpochMilli()

    @Test fun datesFallInTodayYesterdayTheWeekTheMonthThenMonths() {
        val now = at("2026-11-02T09:30")
        assertEquals(DateBucket.Today, DateBucket.of(at("2026-11-02T00:00"), now, zone))
        assertEquals(DateBucket.Today, DateBucket.of(at("2026-11-03T12:00"), now, zone))
        assertEquals(DateBucket.Yesterday, DateBucket.of(at("2026-11-01T23:59"), now, zone))
        assertEquals(DateBucket.Yesterday, DateBucket.of(at("2026-11-01T00:00"), now, zone))
        assertEquals(DateBucket.Previous7Days, DateBucket.of(at("2026-10-26T00:00"), now, zone))
        assertEquals(DateBucket.Previous30Days, DateBucket.of(at("2026-10-25T23:00"), now, zone))
        assertEquals(DateBucket.Previous30Days, DateBucket.of(at("2026-10-03T00:00"), now, zone))
        assertEquals(DateBucket.Month(2026, 10), DateBucket.of(at("2026-10-02T23:59"), now, zone))
        assertEquals(DateBucket.Month(2025, 12), DateBucket.of(at("2025-12-31T10:00"), now, zone))
    }

    @Test fun groupsKeepTheirOrderAndALateItemJoinsItsBucket() {
        val now = at("2026-11-02T09:30")
        val items = listOf(at("2026-11-02T08:00"), at("2026-11-01T08:00"), at("2026-11-02T07:00"), at("2026-08-01T08:00"))
        val groups = DateBucket.group(items, now, zone) { it }
        assertEquals(listOf(DateBucket.Today, DateBucket.Yesterday, DateBucket.Month(2026, 8)), groups.map { it.first })
        assertEquals(2, groups[0].second.size)
    }

    private class Fake {
        val pages = HashMap<String?, String>()
        val asked = mutableListOf<String?>()
        var fail: Exception? = null
        var gate: CompletableDeferred<Unit>? = null
        var kept: JsonObject? = null
        val one = HashMap<String, String>()

        suspend fun fetch(cursor: String?): JsonObject {
            asked += cursor
            gate?.await()
            fail?.let { throw it }
            return Json.parseToJsonElement(pages.getValue(cursor)) as JsonObject
        }
    }

    @Test fun theFeedShowsWhatWasKeptThenReadsEveryPageAndKeepsIt() = runTest {
        val fake = Fake()
        fake.kept = ArtifactCatalog.kept(listOf(summary("old", 1)))
        fake.pages[null] = """{"artifacts":[{"id":"a1","createdAt":30},{"id":"a2","createdAt":20}],"nextPageCursor":"p2"}"""
        fake.pages["p2"] = """{"artifacts":[{"id":"a2","createdAt":20},{"id":"a3","createdAt":10}],"nextPageCursor":null}"""
        fake.gate = CompletableDeferred()
        val io = StandardTestDispatcher(testScheduler)
        val feed = ArtifactCatalogFeed(backgroundScope, fake::fetch, { error("unused") }, { fake.kept }, { fake.kept = it }, io)
        feed.start(MutableSharedFlow())
        runCurrent()
        // What was kept shows while the computer is read.
        assertEquals(listOf("old"), feed.state.value.items.map { it.id })
        assertTrue(feed.state.value.loaded)
        assertTrue(feed.state.value.refreshing)
        fake.gate!!.complete(Unit)
        runCurrent()
        assertEquals(listOf("a1", "a2", "a3"), feed.state.value.items.map { it.id })
        assertFalse(feed.state.value.refreshing)
        assertEquals(listOf(null, "p2"), fake.asked)
        assertEquals(listOf("a1", "a2", "a3"), ArtifactCatalog.fromKept(fake.kept!!).map { it.id })
    }

    @Test fun theFeedFollowsEventsAndReadsAnArtifactItDoesntHold() = runTest {
        val fake = Fake()
        fake.pages[null] = """{"artifacts":[{"id":"a1","title":"One","createdAt":10}],"nextPageCursor":null}"""
        fake.one["z"] = """{"id":"z","title":"Zed","createdAt":5,"updatedAt":99}"""
        val events = MutableSharedFlow<AgentEvent>()
        val io = StandardTestDispatcher(testScheduler)
        val feed = ArtifactCatalogFeed(backgroundScope, fake::fetch, { id -> Json.parseToJsonElement(fake.one.getValue(id)) as JsonObject }, { null }, { fake.kept = it }, io)
        feed.start(events)
        runCurrent()
        events.emit(AgentEvent("c1", "artifact.updated", obj("""{"artifactId":"a1","changes":{"title":"Renamed"}}""")))
        runCurrent()
        assertEquals("Renamed", feed.state.value.items.single().title)
        events.emit(AgentEvent("c2", "artifact.updated", obj("""{"artifactId":"z","changes":{}}""")))
        runCurrent()
        assertEquals(listOf("z", "a1"), feed.state.value.items.map { it.id })
        assertEquals(listOf("z", "a1"), ArtifactCatalog.fromKept(fake.kept!!).map { it.id })
        // A reconnect reads the whole catalog again.
        events.emit(AgentEvent(null, AgentEvent.HELLO, obj("{}")))
        runCurrent()
        assertEquals(listOf("a1"), feed.state.value.items.map { it.id })
        assertEquals(listOf<String?>(null, null), fake.asked)
    }

    @Test fun aRefreshAskedDuringARefreshRunsOnceMoreAfterIt() = runTest {
        val fake = Fake()
        fake.pages[null] = """{"artifacts":[],"nextPageCursor":null}"""
        fake.gate = CompletableDeferred()
        val feed = ArtifactCatalogFeed(backgroundScope, fake::fetch, { error("unused") }, { null }, {}, StandardTestDispatcher(testScheduler))
        feed.start(MutableSharedFlow())
        runCurrent()
        feed.refresh()
        feed.refresh()
        fake.gate!!.complete(Unit)
        runCurrent()
        assertEquals(2, fake.asked.size)
    }

    @Test fun aDaemonWithoutArtifactsIsUnsupportedAndAFailureKeepsWhatShows() = runTest {
        val fake = Fake()
        fake.kept = ArtifactCatalog.kept(listOf(summary("old", 1)))
        fake.fail = java.io.IOException("offline")
        val feed = ArtifactCatalogFeed(backgroundScope, fake::fetch, { error("unused") }, { fake.kept }, { fake.kept = it }, StandardTestDispatcher(testScheduler))
        feed.start(MutableSharedFlow())
        runCurrent()
        assertEquals(listOf("old"), feed.state.value.items.map { it.id })
        assertEquals(Problem.Said("offline"), feed.state.value.error)
        fake.fail = AgentApiException(404, "not_found", "Not found")
        feed.refresh()
        runCurrent()
        assertTrue(feed.state.value.unsupported)
        assertTrue(feed.state.value.items.isEmpty())
        assertNull(feed.state.value.error)
    }
}

package com.slopus.happy.conversation

import com.slopus.happy.agent.AgentFamily
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset

/** The agent page's data: the bootstrap's detail, the tiles' numbers, what a conversation shared, and its family. */
class AgentDetailTest {
    private fun parse(json: String) = AgentDetail.parse(Json.parseToJsonElement(json))

    @Test fun `the detail sums the subtree's tokens over every model and sorts the activity`() {
        val detail = parse(
            """{
              "agent":{"id":"a1","workspaceId":"w1","status":"working","title":"Ship it","subagents":{"total":3,"running":1},"createdAt":1755300000000},
              "mode":{"providerId":"codex","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"auto"},
              "context":{"approximate":false,"contextTokens":201000,"contextWindow":272000},
              "usage":{"codex":{"openai/gpt-5.6-sol":{"input":1250000,"output":84000,"cacheRead":900000}},"claude":{"anthropic/sonnet-5":{"input":310000,"output":42000}}},
              "processes":[{"id":"p1","agentId":"a1","command":"pnpm dev","status":"running","startedAt":1755400000000},{"id":"p2","command":"pnpm test","status":"exited"}],
              "subagents":[
                {"id":"c1","workspaceId":"w1","status":"running_tools","title":"Migrate","totalTokens":48200,"subtask":true},
                {"id":"c2","workspaceId":"w1","status":"idle","title":"Read","totalTokens":null},
                {"id":"c3","workspaceId":"w1","status":"working","archivedAt":1755400000000}
              ],
              "cursor":"x"
            }""",
        )!!
        assertEquals("input and output only, cache left out", 1_686_000L, detail.tokens)
        assertEquals(ContextUsage(201_000, 272_000), detail.context)
        assertEquals("openai/gpt-5.6-sol", detail.mode?.modelId)
        assertEquals(listOf("c1"), detail.running.map { it.id })
        assertEquals(48_200L, detail.running.single().tokens)
        assertTrue(detail.running.single().subtask)
        assertEquals("settled: idle, and archived even while working", listOf("c2", "c3"), detail.completed.map { it.id })
        assertNull("no usage recorded", detail.completed.first().tokens)
        assertEquals("exited processes aren't running", listOf("pnpm dev"), detail.terminals.map { it.command })
        assertFalse(detail.isQuiet)
    }

    @Test fun `an older daemon's bootstrap has no usage or activity, and the page says nothing of them`() {
        val detail = parse("""{"agent":{"id":"a1","workspaceId":"w1","status":"idle"},"mode":null,"pending":[]}""")!!
        assertNull(detail.tokens)
        assertNull(detail.context)
        assertTrue(detail.isQuiet)
        assertNull(parse("""{"mode":null}"""))
    }

    @Test fun `tokens read as desktop's tiles, tenths only under ten, never rounded up`() {
        assertEquals("980", DetailFormat.tokens(980))
        assertEquals("1K", DetailFormat.tokens(1_000))
        assertEquals("1.2K", DetailFormat.tokens(1_299))
        assertEquals("12K", DetailFormat.tokens(12_999))
        assertEquals("121M", DetailFormat.tokens(121_500_000))
        assertEquals("1.2B", DetailFormat.tokens(1_250_000_000))
        assertEquals("0", DetailFormat.tokens(-5))
    }

    @Test fun `an age is its largest whole unit`() {
        val now = 10_000_000_000L
        assertEquals(DetailFormat.Age.JustNow, DetailFormat.age(now - 59_000, now))
        assertEquals(DetailFormat.Age.Minutes(12), DetailFormat.age(now - 12 * 60_000, now))
        assertEquals(DetailFormat.Age.Hours(2), DetailFormat.age(now - 150 * 60_000, now))
        assertEquals(DetailFormat.Age.Days(3), DetailFormat.age(now - 3 * 86_400_000L, now))
        assertEquals(DetailFormat.Age.Months(2), DetailFormat.age(now - 61 * 86_400_000L, now))
        assertEquals(DetailFormat.Age.Years(1), DetailFormat.age(now - 400 * 86_400_000L, now))
        assertEquals("a clock ahead of now is just now", DetailFormat.Age.JustNow, DetailFormat.age(now + 5_000, now))
    }

    @Test fun `a start is today, yesterday, a weekday this week, a date this year, or a date with its year`() {
        val zone: ZoneId = ZoneOffset.UTC
        fun at(text: String) = LocalDateTime.parse(text).toInstant(ZoneOffset.UTC).toEpochMilli()
        val now = at("2026-10-31T08:00:00")
        assertEquals(DetailFormat.Started.Today, DetailFormat.started(at("2026-10-31T00:05:00"), now, zone))
        assertEquals(DetailFormat.Started.Yesterday, DetailFormat.started(at("2026-10-30T23:59:00"), now, zone))
        assertEquals(DetailFormat.Started.Weekday, DetailFormat.started(at("2026-10-26T12:00:00"), now, zone))
        assertEquals(DetailFormat.Started.ThisYear, DetailFormat.started(at("2026-10-24T12:00:00"), now, zone))
        assertEquals(DetailFormat.Started.Date, DetailFormat.started(at("2025-12-31T12:00:00"), now, zone))
    }

    @Test fun `links are found as written, Markdown with its text, bare ones without their punctuation`() {
        val links = Shared.links(
            "See [the PR](https://github.com/slopus/happy/pull/1) and https://www.figma.com/file/x. " +
                "Not ![a picture](https://example.com/a.png), but (https://en.wikipedia.org/wiki/Foo_(bar)) is.",
        )
        assertEquals(
            listOf(
                SharedLink("https://github.com/slopus/happy/pull/1", "the PR", "github.com"),
                SharedLink("https://www.figma.com/file/x", null, "figma.com"),
                SharedLink("https://en.wikipedia.org/wiki/Foo_(bar)", null, "en.wikipedia.org"),
            ),
            links,
        )
        assertEquals("a link's text that is itself has no title", null, Shared.links("[https://a.dev](https://a.dev)").single().title)
        assertEquals("figma.com/file/x", Shared.address("https://www.figma.com/file/x/"))
        assertTrue(Shared.links("no links here").isEmpty())
    }

    private val picture = Block.Image("image/png", "AAAA")

    private fun history(): List<Message> = listOf(
        Message("m1", "user", 1, listOf(Block.Text("Look at https://a.dev"), picture, picture)),
        Message("m2", "agent", 2, listOf(Block.Text("Done, see [docs](https://b.dev)."), Block.ToolCall("call1", "show", "completed", Presentation.Media(listOf(MediaItem("image", "shot.png", "image/png"), MediaItem("file", "log.txt", "text/plain")))))),
        Message("m3", "agent", 3, listOf(Block.Text("From a collaborator: https://c.dev")), senderAgentId = "other"),
        Message("m4", "agent", 4, listOf(picture, Block.Text("again https://a.dev"))),
    )

    @Test fun `a page of history shares what the transcript draws, newest first, each once`() {
        val shared = Shared.of(history(), "a1", null)
        assertEquals(
            listOf("conversation/m4:0:0", "conversation/media/call1/0", "conversation/media/call1/1", "conversation/m1:user:0", "conversation/m1:user:1"),
            shared.media.map { it.key },
        )
        assertEquals("another agent's message shares nothing; a link once", listOf("https://a.dev", "https://b.dev"), shared.links.map { it.url })
        assertEquals("the same keys as the transcript's own rows", shared, Shared.of(history().asReversed().flatMap { ConversationRowBuilder.build(it, "a1", null, false).asReversed() }))
    }

    @Test fun `what the chat holds comes first and history adds only what it lacks`() {
        val newer = Shared.of(history().takeLast(1), "a1", null)
        val merged = newer.merged(Shared.of(history(), "a1", null))
        assertEquals(5, merged.media.size)
        assertEquals("conversation/m4:0:0", merged.media.first().key)
        assertEquals(2, merged.links.size)
    }

    /** History of [runs] runs of one message each, newest last, served [limit] at a time from the newest. */
    private class History(runs: Int) {
        val asked = ArrayList<String?>()
        private val all = (1..runs).map { """{"id":"r$it","status":"completed","messages":[{"id":"m$it","role":"user","createdAt":$it,"content":[{"type":"text","text":"https://site$it.dev"},{"type":"image","mimeType":"image/png","data":"AAAA"}]}]}""" }
        val api = object : ConversationApi({ _, path, _ ->
            val before = Regex("before=([^&]+)").find(path)?.groupValues?.get(1)
            val limit = Regex("limit=(\\d+)").find(path)!!.groupValues[1].toInt()
            asked += before
            val end = before?.let { id -> all.indexOfFirst { it.contains("\"id\":\"$id\"") } } ?: all.size
            val start = maxOf(0, end - limit)
            TransportResponse(200, body = """{"runs":[${all.subList(start, end).joinToString(",")}],"hasMore":${start > 0}}""".toByteArray())
        }) {}
    }

    @Test fun `the shared feed reads back only as far as asked, a page at a time, and stops where history does`() = runBlocking {
        val history = History(25)
        val feed = SharedFeed(history.api, "a1") { null }
        val first = feed.load(media = 13, links = 6)
        assertEquals("two pages of ten for thirteen", listOf(null, "r16"), history.asked)
        assertEquals(20, first.shared.media.size)
        assertEquals("newest first", "https://site25.dev", first.shared.links.first().url)
        assertTrue(first.hasMore)
        val second = feed.load(media = 100, links = null)
        assertEquals(listOf(null, "r16", "r6"), history.asked)
        assertEquals(25, second.shared.media.size)
        assertFalse("history ended", second.hasMore)
        feed.load(media = 200, links = 200)
        assertEquals("nothing more is asked once it ended", 3, history.asked.size)
    }

    @Test fun `a page that fails says so and leaves what was read`() = runBlocking {
        val api = object : ConversationApi({ _, _, _ -> TransportResponse(503, body = "{}".toByteArray()) }) {}
        val state = SharedFeed(api, "a1") { null }.load(media = 13, links = 6)
        assertTrue(state.failed)
        assertTrue(state.read)
        assertTrue(state.shared.isEmpty)
    }

    private fun row(id: String, parent: String? = null, depth: Int = if (parent == null) 0 else 1) =
        AgentFeedRow.Conversation(id, id.uppercase(), if (parent == null) ConversationKind.Task else ConversationKind.Subtask, depth, parentId = parent)

    @Test fun `a top-level conversation's family is itself over its children`() {
        val rows = listOf(row("a"), row("a1", "a"), row("a2", "a"), row("b"), row("b1", "b"))
        val family = AgentFamily.of("a", rows)
        assertEquals(listOf("a" to 0, "a1" to 1, "a2" to 1), family.map { it.row.agentId to it.depth })
        assertTrue(family.first().self)
        assertTrue("alone, no family", AgentFamily.of("c", rows + row("c")).isEmpty())
        assertTrue("not on home, no family", AgentFamily.of("x", rows).isEmpty())
    }

    @Test fun `a subtask's family is its parent, its nearest siblings and its own children`() {
        val siblings = (1..8).map { row("s$it", "p") }
        val rows = listOf(row("p")) + siblings.take(2) + listOf(row("g1", "s2", 2)) + siblings.drop(2)
        val family = AgentFamily.of("s2", rows)
        assertEquals(
            "the window stays five wide at the start",
            listOf("p" to 0, "s1" to 1, "s2" to 1, "g1" to 2, "s3" to 1, "s4" to 1, "s5" to 1),
            family.map { it.row.agentId to it.depth },
        )
        assertEquals(listOf("s2"), family.filter { it.self }.map { it.row.agentId })
        val last = AgentFamily.of("s8", rows).map { it.row.agentId }
        assertEquals("and at the end", listOf("p", "s4", "s5", "s6", "s7", "s8"), last)
    }
}

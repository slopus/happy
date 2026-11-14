package com.slopus.happy.references

import com.slopus.happy.agent.AgentCatalog
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reference tags found exactly where the reference `parseHappyReferences`
 * finds them (the fixtures iOS's HappyReferencesTests read, from
 * `scripts/generate-reference-fixtures.ts`), settled and streaming, and how
 * a message reads with them: iOS HappyReferencesTests, case for case.
 */
class HappyReferencesTest {
    private val cases: JsonArray by lazy {
        val text = requireNotNull(javaClass.getResource("/references/happy-references.json")) { "missing fixtures" }.readText()
        Json.parseToJsonElement(text).jsonObject["cases"]!!.jsonArray
    }

    private fun expected(segments: JsonArray): List<String> = segments.map { element ->
        val segment = element.jsonObject
        if (segment["type"]!!.jsonPrimitive.content != "reference") return@map "T:" + segment["text"]!!.jsonPrimitive.content
        val reference = segment["reference"]!!.jsonObject
        val version = reference["version"]?.let { " v${it.jsonPrimitive.int}" }.orEmpty()
        val workspace = reference["workspaceId"]?.let { " w${it.jsonPrimitive.content}" }.orEmpty()
        "R:${reference["kind"]!!.jsonPrimitive.content}/${reference["id"]!!.jsonPrimitive.content}$version$workspace ${segment["source"]!!.jsonPrimitive.content}"
    }

    private fun actual(segments: List<HappyReferences.Segment>): List<String> = segments.map { segment ->
        when (segment) {
            is HappyReferences.Segment.Text -> "T:" + segment.text
            is HappyReferences.Segment.Tag -> with(segment.reference) {
                "R:$kind/$id${version?.let { " v$it" }.orEmpty()}${workspaceId?.let { " w$it" }.orEmpty()} ${segment.source}"
            }
        }
    }

    @Test
    fun parsesAsTheReference() {
        assertTrue(cases.size > 400)
        cases.forEachIndexed { index, element ->
            val entry = element.jsonObject
            val text = entry["text"]!!.jsonPrimitive.content
            assertEquals("case $index: $text", expected(entry["settled"]!!.jsonArray), actual(HappyReferences.parse(text)))
            assertEquals("case $index streaming: $text", expected(entry["streaming"]!!.jsonArray), actual(HappyReferences.parse(text, streaming = true)))
        }
    }

    /** The bots and tasks as the catalog holds them: a bot whose agent has a subtask with its own workspace, and a task. */
    private val catalog: AgentCatalog by lazy {
        fun agent(id: String, workspaceId: String? = null, title: String? = null, subtasks: List<JsonObject> = emptyList()) = buildJsonObject {
            put("id", id)
            workspaceId?.let { put("workspaceId", it) }
            title?.let { put("title", it) }
            put("subtasks", JsonArray(subtasks))
        }
        val guests = agent("as", "ws", "Guest list template", listOf(agent("ag", "ws", "  ")))
        val bot = buildJsonObject {
            put("id", "b1")
            put("name", "Chef")
            put("workspaceId", "wb")
            put("agent", agent("ab", "wb", "Chief of Staff chat", listOf(guests)))
        }
        val task = buildJsonObject {
            put("id", "t1")
            put("name", "Birthday party for Maya")
            put("workspaceId", "wt")
            put("agent", agent("at"))
        }
        AgentCatalog(bots = mapOf("b1" to bot), tasks = mapOf("t1" to task), loaded = true)
    }

    private fun owners(): References = References.entities(catalog).let { (agents, workspaces) -> References(agents, workspaces) }

    private fun markdown(text: String, references: References) = HappyReferences.markdown(text, references)

    @Test
    fun anAgentReadsAsItsConversationsName() {
        val references = owners()
        // A bot's or task's own agent by the bot's or task's name; a subtask by its title.
        assertEquals("[Chef](happy://agents/ab)", markdown("<happy-agent id=\"ab\"/>", references))
        assertEquals("[Birthday party for Maya](happy://agents/at)", markdown("<happy-agent id=\"at\"/>", references))
        assertEquals("Started [Guest list template](happy://agents/as) to draft it.", markdown("Started <happy-agent id=\"as\"/> to draft it.", references))
        // A subtask without a name yet, and one the lists don't hold (archived).
        assertEquals("[Untitled agent](happy://agents/ag)", markdown("<happy-agent id=\"ag\"/>", references))
        assertEquals("an unavailable agent", markdown("<happy-agent id=\"gone\"/>", references))
        assertEquals(References.Entity("Guest list template", "as"), references.entity(HappyReferences.Reference("agent", "as")))
    }

    @Test
    fun theCatalogsNewestCopyOfAnAgentAndItsArchivedSubtasks() {
        // A subtask renamed since its owner's snapshot reads by the catalog's copy; an archived one isn't held.
        val renamed = buildJsonObject { put("id", "as"); put("workspaceId", "ws"); put("title", "Seating plan") }
        val archived = buildJsonObject { put("id", "ag"); put("archivedAt", 1) }
        val references = References.entities(catalog.copy(agents = mapOf("as" to renamed, "ag" to archived))).let { (a, w) -> References(a, w) }
        assertEquals("[Seating plan](happy://agents/as)", markdown("<happy-agent id=\"as\"/>", references))
        assertEquals("an unavailable agent", markdown("<happy-agent id=\"ag\"/>", references))
        // An archived task isn't either.
        val gone = catalog.copy(tasks = catalog.tasks.mapValues { JsonObject(it.value + ("archivedAt" to JsonPrimitive(1))) })
        assertEquals("an unavailable agent", markdown("<happy-agent id=\"at\"/>", References.entities(gone).let { (a, w) -> References(a, w) }))
    }

    @Test
    fun aHiddenSubagentReadsAsItsTitleAndOpensNothing() {
        val references = owners().copy(subagents = mapOf("c1" to "Find flights", "c2" to " ", "as" to "Not this"))
        assertEquals("Dispatched to Find flights.", markdown("Dispatched to <happy-agent id=\"c1\"/>.", references))
        assertEquals("Subagent", markdown("<happy-agent id=\"c2\"/>", references))
        // A subtask the lists hold still opens as itself.
        assertEquals("[Guest list template](happy://agents/as)", markdown("<happy-agent id=\"as\"/>", references))
        assertNull(references.entity(HappyReferences.Reference("agent", "c1")))
    }

    @Test
    fun aWorkspaceReadsAsWhatItHolds() {
        val references = owners()
        assertEquals("[Chef](happy://workspaces/wb)", markdown("<happy-workspace id=\"wb\"/>", references))
        assertEquals("[Birthday party for Maya](happy://workspaces/wt)", markdown("<happy-workspace id=\"wt\"/>", references))
        // A subtask's own workspace by the first subtask in it.
        assertEquals("[Guest list template](happy://workspaces/ws)", markdown("<happy-workspace id=\"ws\"/>", references))
        assertEquals("ab", references.entity(HappyReferences.Reference("workspace", "wb"))?.agentId)
        assertEquals("an unavailable workspace", markdown("<happy-workspace id=\"nope\"/>", references))
    }

    @Test
    fun anArtifactReadsAsItsTitleOnceRead() {
        var references = References()
        val text = "See <happy-artifact id=\"r1\" version=\"2\"/>."
        assertEquals(listOf("r1"), references.unread(text))
        assertEquals("reading", "See [artifact](happy://artifacts/r1?version=2).", markdown(text, references))
        val read = References.artifact(buildJsonObject { put("title", "Q3 revenue report"); put("status", "active"); put("type", "markdown"); put("latestVersion", 2) })
        references = references.copy(artifacts = mapOf("r1" to read))
        assertEquals(emptyList<String>(), references.unread(text))
        assertEquals("See [Q3 revenue report](happy://artifacts/r1?version=2).", markdown(text, references))
        references = references.copy(artifacts = mapOf("r1" to References.Artifact.Active(" ", "html", 1)))
        assertEquals("See [Untitled artifact](happy://artifacts/r1?version=2).", markdown(text, references))
        // Deleted: named, not offered. Missing: words that say so.
        references = references.copy(artifacts = mapOf("r1" to References.artifact(buildJsonObject { put("title", "Old report"); put("status", "deleted") })))
        assertEquals("See Old report.", markdown(text, references))
        references = references.copy(artifacts = mapOf("r1" to References.Artifact.Missing))
        assertEquals("See an unavailable artifact.", markdown(text, references))
        // Found past any other script, and only whole.
        assertEquals(listOf("r1"), References().unread("Привет 👋🏽 $text"))
        assertEquals(emptyList<String>(), References().unread("<happy-artifac"))
    }

    @Test
    fun aPersonReadsAsAMentionSetApartForTheReader() {
        var references = References(users = mapOf("u-steve" to "Steve", "u-kirill" to " Kirill "), me = "u-steve")
        val text = "<happy-user id=\"u-steve\"/>, can you look? <happy-user id=\"u-kirill\"/> signed off."
        assertEquals("[@Steve](happy://users/u-steve), can you look? [@Kirill](happy://users/u-kirill) signed off.", markdown(text, references))
        assertEquals("@Steve, can you look? @Kirill signed off.", HappyReferences.plain(text, references))
        // Someone not read yet is a mention waiting for its name; someone the computer doesn't know reads as words that say so.
        assertEquals(listOf("u-gone"), references.unknownUsers("$text <happy-user id=\"u-gone\"/> <happy-user id=\"u-gone\"/>"))
        assertEquals("[@…](happy://users/u-gone)", markdown("<happy-user id=\"u-gone\"/>", references))
        references = references.copy(missingUsers = setOf("u-gone"))
        assertEquals("an unavailable user", markdown("<happy-user id=\"u-gone\"/>", references))
        // A link to a person is a mention, whoever wrote it; it opens nothing.
        assertTrue(HappyReferences.mention("happy://users/u-steve"))
        assertTrue(HappyReferences.mention("happy://abcdefghijklmnopqrstuvwx/users/u-steve"))
        assertEquals(false, HappyReferences.mention("happy://agents/a1"))
        assertEquals(false, HappyReferences.opensInApp("happy://users/u-steve"))
        assertNull(references.entity(HappyReferences.Reference("user", "u-steve")))
    }

    @Test
    fun projectsServicesAndUnknownKindsAreInert() {
        assertEquals(
            "an unavailable project an unavailable service an unavailable reference",
            markdown("<happy-project id=\"p\"/> <happy-service id=\"s\" workspace=\"wb\"/> <happy-gizmo id=\"g\"/>", owners()),
        )
    }

    @Test
    fun theAppsWordsReadWhereNothingNamesIt() {
        val words = ReferenceWords("artefacto", "Artefacto sin título", "Agente sin título", "Espacio sin título", "Subagente", mapOf("agent" to "un agente no disponible"), "una referencia no disponible")
        val references = owners().copy(words = words)
        assertEquals("[artefacto](happy://artifacts/r)", markdown("<happy-artifact id=\"r\"/>", references))
        assertEquals("un agente no disponible", markdown("<happy-agent id=\"gone\"/>", references))
        assertEquals("una referencia no disponible", markdown("<happy-gizmo id=\"g\"/> ", references).trim())
    }

    @Test
    fun namesAreRunningWordsAndOnlyThisPhonesLinksOpen() {
        val references = References(agents = mapOf("a1" to References.Entity("Guest *list* [draft]\nnow", "a1")))
        val text = "Started <happy-agent id=\"a1\"/> to draft the [guest] list, not `<happy-agent id=\"a1\"/>`."
        assertEquals("Started [Guest list (draft) now](happy://agents/a1) to draft the [guest] list, not `<happy-agent id=\"a1\"/>`.", markdown(text, references))
        assertEquals("Started Guest *list* [draft]\nnow to draft the [guest] list, not `<happy-agent id=\"a1\"/>`.", HappyReferences.plain(text, references))
        // What a link names is read from its own address: a Happy URL, internal or locked to an installation, or a share link carrying one.
        assertEquals(HappyReferences.Reference("agent", "a1") to null, HappyReferences.reference("happy://agents/a1"))
        assertEquals(HappyReferences.Reference("artifact", "r", version = 3) to null, HappyReferences.reference("happy://artifacts/r?version=3"))
        assertEquals(HappyReferences.Reference("agent", "a1") to "abcdefghijklmnopqrstuvwx", HappyReferences.reference("happy://abcdefghijklmnopqrstuvwx/agents/a1"))
        assertEquals(HappyReferences.Reference("agent", "a1") to "abcdefghijklmnopqrstuvwx", HappyReferences.reference("https://link.happy.page/#1/abcdefghijklmnopqrstuvwx/agents/a1?as=task"))
        assertNull(HappyReferences.reference("happy://artifacts/r?version=0"))
        assertNull(HappyReferences.reference("happy://settings/providers"))
        assertNull(HappyReferences.reference("https://example.com"))
        // What opens in the app: Happy URLs and share links, never a mention or the web.
        assertTrue(HappyReferences.opensInApp("happy://agents/a1"))
        assertTrue(HappyReferences.opensInApp("happy://artifacts/r1"))
        assertTrue(HappyReferences.opensInApp("https://link.happy.page/#1/abcdefghijklmnopqrstuvwx/agents/a1"))
        assertEquals(false, HappyReferences.opensInApp("https://example.com"))
    }

    @Test
    fun happyLinksReadAsTheCurrentNameAndKeepTheirAddress() {
        val references = owners().copy(
            artifacts = mapOf("r1" to References.Artifact.Active("Q3 report", "markdown", 2)),
            users = mapOf("u1" to "Steve"),
        )
        val here = { instanceId: String -> instanceId == "abcdefghijklmnopqrstuvwx" }
        val share = "https://link.happy.page/#1/abcdefghijklmnopqrstuvwx/agents/ab?as=bot"
        val bold = "https://link.happy.page/#1/abcdefghijklmnopqrstuvwx/artifacts/r1"
        val theirs = "happy://zyxwvutsrqponmlkjihgfedc/agents/ab"
        val text = "Ask []($share), see [my notes](happy://artifacts/r1) or **[X]($bold)**, " +
            "[their bot]($theirs), [gone](happy://agents/nobody), [Bob](happy://users/u1) and $share."
        // The label is never what a Happy link reads as: the current name, or the placeholder; the address stays as written.
        // What opens nothing is words, unless it is a share link, which still says so when tapped.
        assertEquals(
            "Ask [Chef]($share), see [Q3 report](happy://artifacts/r1) or **[Q3 report]($bold)**, " +
                "an unavailable agent, an unavailable agent, [@Steve](happy://users/u1) and $share.",
            HappyReferences.markdown(text, references, here = here),
        )
        val foreign = "https://link.happy.page/#1/zyxwvutsrqponmlkjihgfedc/agents/ab"
        assertEquals("[an unavailable agent]($foreign) [an unavailable agent]($share)",
            HappyReferences.markdown("[their bot]($foreign) [old]($share)", References(), here = here))
        // A malformed Happy link, and a deleted artifact by its last title, are words.
        assertEquals("an unavailable reference, Old report",
            HappyReferences.markdown("[x](happy://agents/), [](happy://artifacts/r2)", references.copy(artifacts = mapOf("r2" to References.Artifact.Deleted("Old report")))))
        // Copying keeps it all exactly as written.
        assertEquals(text, HappyReferences.plain(text, references))
        // A file link reads as its path and a settings link as "Settings", as on desktop; a button keeps its words.
        assertEquals(
            "[src/main.ts](happy://agents/ab/files/src/main.ts) [Settings](happy://settings/providers) [Open providers](happy://settings/providers \"button\")",
            markdown("[main](happy://agents/ab/files/src/main.ts) [Providers](happy://settings/providers) [Open providers](happy://settings/providers \"button\")", references),
        )
        // A tag becomes a link to the Happy URL it names.
        val tagged = markdown("<happy-agent id=\"ab\"/> wrote <happy-artifact id=\"r1\" version=\"2\"/>", references)
        assertEquals("[Chef](happy://agents/ab) wrote [Q3 report](happy://artifacts/r1?version=2)", tagged)
        for (shown in listOf(HappyReferences.markdown(text, references, here = here), HappyReferences.plain(text, references), tagged)) {
            assertEquals(false, shown.contains("happy-reference"))
        }
        // What a link names is read once, as its tag would be.
        assertEquals("<happy-artifact id=\"r1\"/> <happy-agent id=\"ab\"/> $theirs", HappyReferences.linkTags("[](happy://artifacts/r1) []($share) $theirs", here))
    }

    @Test
    fun aDocumentKeepsTheLabelsItGaveItsLinks() {
        val references = owners()
        val here = { instanceId: String -> instanceId == "abcdefghijklmnopqrstuvwx" }
        val share = "https://link.happy.page/#1/abcdefghijklmnopqrstuvwx/agents/ab?as=bot"
        val gone = "https://link.happy.page/#1/abcdefghijklmnopqrstuvwx/agents/zz"
        val text = "Ask [the chef]($share), [old](happy://agents/zz), [last week]($gone), []($share), []($gone), " +
            "[main](happy://agents/ab/files/src/main.ts), <happy-agent id=\"ab\"/> and $share."
        // Labelled, as written, resolving or not; unlabelled, the name or the placeholder; a tag its name; a bare link its address.
        assertEquals(
            "Ask [the chef]($share), [old](happy://agents/zz), [last week]($gone), [Chef]($share), [an unavailable agent]($gone), " +
                "[main](happy://agents/ab/files/src/main.ts), [Chef](happy://agents/ab) and $share.",
            HappyReferences.markdown(text, references, here = here, labels = true),
        )
        // A chat never keeps them.
        assertEquals(
            "Ask [Chef]($share), an unavailable agent, [an unavailable agent]($gone), [Chef]($share), [an unavailable agent]($gone), " +
                "[src/main.ts](happy://agents/ab/files/src/main.ts), [Chef](happy://agents/ab) and $share.",
            HappyReferences.markdown(text, references, here = here),
        )
        // The labelled links still resolve and shimmer by their address.
        assertEquals(HappyReferences.Reference("agent", "ab"), references.resolve(share, here))
        assertEquals(true, references.busy(share, here, setOf("ab")))
    }

    @Test
    fun streamingHoldsBackATagStillArriving() {
        assertEquals("Started ", HappyReferences.droppingPartialTag("Started <happy-agent id=\"a"))
        assertEquals("1 < 2", HappyReferences.droppingPartialTag("1 < 2"))
        assertEquals("Done <happy-agent id=\"a\"/>", HappyReferences.droppingPartialTag("Done <happy-agent id=\"a\"/>"))
        assertEquals("Started ", HappyReferences.markdown("Started <happy-agent id=\"a", References(), streaming = true))
    }

    @Test
    fun aSurfaceThePersonIsInIsNamedAndOpens() {
        fun surface(id: String, name: String, member: String, archived: Boolean = false) = buildJsonObject {
            put("id", id)
            put("type", "todo")
            put("name", name)
            if (archived) put("status", "archived")
            put("members", JsonArray(listOf(buildJsonObject { put("userId", member) })))
        }
        val catalog = AgentCatalog(
            userId = "u1",
            surfaces = mapOf("s1" to surface("s1", "Groceries", "u1"), "s2" to surface("s2", "Theirs", "u2"), "s3" to surface("s3", "Old", "u1", archived = true)),
        )
        val surfaces = References.surfaces(catalog)
        assertEquals(mapOf("s1" to "Groceries"), surfaces)
        val references = References(surfaces = surfaces + ("s4" to " "))
        assertEquals("[Groceries](happy://surfaces/s1) and [Untitled](happy://surfaces/s4) but an unavailable surface",
            HappyReferences.markdown("[list](happy://surfaces/s1) and <happy-surface id=\"s4\"/> but [](happy://surfaces/s2)", references))
    }
}

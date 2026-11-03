package com.slopus.happy.references

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * A connection's references as its messages need them read (iOS Store's
 * `readArtifacts`, `readUsers`): each title and name once, a 404 as
 * missing, a failure asked again, and a title read following its
 * artifact's events. Its work runs in the test's `backgroundScope`, which
 * `advanceUntilIdle` leaves alone, so each step is `runCurrent`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ReferenceReaderTest {
    private class Fake {
        val artifacts = HashMap<String, String>()
        val asked = ArrayList<String>()
        val people = ArrayList<List<String>>()
        var names: Map<String, String> = emptyMap()
        var failing = false

        fun artifact(id: String): JsonObject {
            asked += id
            if (failing) throw IllegalStateException("offline")
            val body = artifacts[id] ?: throw AgentApiException(404, "not_found", "gone")
            return Json.parseToJsonElement(body) as JsonObject
        }

        fun users(ids: List<String>): Map<String, String> {
            people += ids
            return names.filterKeys { it in ids }
        }
    }

    private fun TestScope.reader(fake: Fake, catalog: MutableStateFlow<AgentCatalog> = MutableStateFlow(AgentCatalog(loaded = true)), events: MutableSharedFlow<AgentEvent> = MutableSharedFlow()) =
        StandardTestDispatcher(testScheduler).let { dispatcher ->
            ReferenceReader(backgroundScope, catalog, events, { fake.artifact(it) }, { fake.users(it) }, io = dispatcher, compute = dispatcher)
        }

    @Test
    fun anArtifactAMessageNamesIsReadOnceForItsTitle() = runTest {
        val fake = Fake().apply { artifacts["r1"] = """{"id":"r1","title":"Q3 revenue report","type":"markdown","latestVersion":2}""" }
        val reader = reader(fake)
        runCurrent()
        val text = "See <happy-artifact id=\"r1\"/> and <happy-artifact id=\"gone\"/>."
        reader.read(text)
        reader.read(text)
        runCurrent()
        assertEquals(References.Artifact.Active("Q3 revenue report", "markdown", 2), reader.references.value.artifacts["r1"])
        assertEquals("a 404 is an artifact nobody can open", References.Artifact.Missing, reader.references.value.artifacts["gone"])
        reader.read(text)
        runCurrent()
        assertEquals(listOf("r1", "gone"), fake.asked)
        assertEquals("See [Q3 revenue report](${HappyReferences.linkPrefix}artifact/r1) and an unavailable artifact.", HappyReferences.markdown(text, reader.references.value))
    }

    @Test
    fun aReadThatFailedIsAskedAgainByTheNextMessage() = runTest {
        val fake = Fake().apply { failing = true; artifacts["r1"] = """{"title":"Plan"}""" }
        val reader = reader(fake)
        runCurrent()
        reader.read("<happy-artifact id=\"r1\"/>")
        runCurrent()
        assertEquals(null, reader.references.value.artifacts["r1"])
        fake.failing = false
        reader.read("<happy-artifact id=\"r1\"/>")
        runCurrent()
        assertEquals(References.Artifact.Active("Plan", "", 1), reader.references.value.artifacts["r1"])
        assertEquals(listOf("r1", "r1"), fake.asked)
    }

    @Test
    fun aTitleReadFollowsItsArtifactsEvents() = runTest {
        val fake = Fake().apply { artifacts["r1"] = """{"title":"Draft","type":"markdown","latestVersion":1}""" }
        val events = MutableSharedFlow<AgentEvent>()
        val reader = reader(fake, events = events)
        runCurrent()
        reader.read("<happy-artifact id=\"r1\"/>")
        runCurrent()
        events.emit(AgentEvent("c1", "artifact.updated", Json.parseToJsonElement("""{"artifactId":"r1","changes":{"title":"Launch page","latestVersion":3}}""") as JsonObject))
        // One no message named is not kept.
        events.emit(AgentEvent("c2", "artifact.updated", Json.parseToJsonElement("""{"artifactId":"other","changes":{"title":"x"}}""") as JsonObject))
        runCurrent()
        assertEquals(mapOf("r1" to References.Artifact.Active("Launch page", "markdown", 3)), reader.references.value.artifacts)
        events.emit(AgentEvent("c3", "artifact.deleted", Json.parseToJsonElement("""{"artifactId":"r1"}""") as JsonObject))
        runCurrent()
        assertEquals(References.Artifact.Deleted("Launch page"), reader.references.value.artifacts["r1"])
    }

    /** iOS LoopInTests: an HTML artifact that asks to be shown inline is a page the conversation draws. */
    @Test
    fun anArtifactThatAsksToBeInlineIsAPage() {
        fun page(changes: String = "") = References.page(
            Json.parseToJsonElement(
                """{"id":"p1","type":"html","status":"active","latestVersion":3,"entry":{"path":"index.html"},"display":"inline_expanded","live":null,"background":null$changes}""",
            ) as JsonObject,
        )
        assertEquals(References.Page(3, "index.html"), page())
        assertEquals("#0b0b0f", page(""","background":"#0B0B0F"""")?.background)
        assertEquals(null, page(""","background":"red"""")?.background)
        for (display in listOf("null", "\"side\"", "\"inline_compact\"", "\"someday\"")) assertEquals(display, null, page(""","display":$display"""))
        assertEquals(null, page(""","type":"markdown""""))
        assertEquals(null, page(""","status":"deleted""""))
        assertEquals(null, page(""","live":{"url":"http://localhost:5173/"}"""))
        assertEquals(null, page(""","entry":null"""))
    }

    @Test
    fun aPageFollowsItsArtifactsNewVersionsAndGoesWithIt() = runTest {
        val fake = Fake().apply {
            artifacts["p1"] = """{"title":"Waveform","type":"html","latestVersion":1,"entry":{"path":"index.html"},"display":"inline_expanded"}"""
            artifacts["m1"] = """{"title":"Notes","type":"markdown","latestVersion":1}"""
        }
        val events = MutableSharedFlow<AgentEvent>()
        val reader = reader(fake, events = events)
        runCurrent()
        reader.readArtifacts(listOf("p1", "m1"))
        runCurrent()
        assertEquals(mapOf("p1" to References.Page(1, "index.html")), reader.references.value.pages)
        // A new version is read again, for its version, entry and display.
        fake.artifacts["p1"] = """{"title":"Waveform","type":"html","latestVersion":2,"entry":{"path":"v2/main.html"},"display":"inline_expanded"}"""
        events.emit(AgentEvent("c1", "artifact.updated", Json.parseToJsonElement("""{"artifactId":"p1","changes":{"latestVersion":2}}""") as JsonObject))
        events.emit(AgentEvent("c2", "artifact.updated", Json.parseToJsonElement("""{"artifactId":"m1","changes":{"latestVersion":2}}""") as JsonObject))
        runCurrent()
        assertEquals(References.Page(2, "v2/main.html"), reader.references.value.pages["p1"])
        assertEquals("only an HTML artifact is read again", listOf("p1", "m1", "p1"), fake.asked)
        // One that no longer asks to be inline is a card again.
        fake.artifacts["p1"] = """{"title":"Waveform","type":"html","latestVersion":3,"entry":{"path":"index.html"},"display":"side"}"""
        events.emit(AgentEvent("c3", "artifact.updated", Json.parseToJsonElement("""{"artifactId":"p1","changes":{"latestVersion":3}}""") as JsonObject))
        runCurrent()
        assertEquals(emptyMap<String, References.Page>(), reader.references.value.pages)
        fake.artifacts["p1"] = """{"title":"Waveform","type":"html","latestVersion":4,"entry":{"path":"index.html"},"display":"inline_expanded"}"""
        events.emit(AgentEvent("c4", "artifact.updated", Json.parseToJsonElement("""{"artifactId":"p1","changes":{"latestVersion":4}}""") as JsonObject))
        runCurrent()
        assertEquals(References.Page(4, "index.html"), reader.references.value.pages["p1"])
        events.emit(AgentEvent("c5", "artifact.deleted", Json.parseToJsonElement("""{"artifactId":"p1"}""") as JsonObject))
        runCurrent()
        assertEquals(emptyMap<String, References.Page>(), reader.references.value.pages)
        assertEquals(References.Artifact.Deleted("Waveform"), reader.references.value.artifacts["p1"])
    }

    @Test
    fun peopleAreReadByNameAndOnesTheComputerDoesntKnowSaySo() = runTest {
        val fake = Fake().apply { names = mapOf("u1" to "Steve", "u2" to "") }
        val catalog = MutableStateFlow(AgentCatalog(userId = "u1", loaded = true))
        val reader = reader(fake, catalog)
        runCurrent()
        val text = "<happy-user id=\"u1\"/> and <happy-user id=\"u2\"/> and <happy-user id=\"u3\"/>"
        reader.read(text)
        runCurrent()
        assertEquals(listOf(listOf("u1", "u2", "u3")), fake.people)
        assertEquals("@Steve and an unavailable user and an unavailable user", HappyReferences.plain(text, reader.references.value))
        assertEquals(References.View.Mention("@Steve", me = true), reader.references.value.view(HappyReferences.Reference("user", "u1")))
        // Not asked again: named, or known not to be.
        reader.read(text)
        runCurrent()
        assertEquals(1, fake.people.size)
    }

    @Test
    fun theCatalogsConversationsAndTheAppsWords() = runTest {
        val bot = buildJsonObject {
            put("id", "b1")
            put("name", "Chef")
            put("agent", buildJsonObject { put("id", "ab") })
        }
        val catalog = MutableStateFlow(AgentCatalog(loaded = true))
        val reader = reader(Fake(), catalog)
        runCurrent()
        val before = reader.references.value
        // A change that names nothing new keeps the same reading, so no row is built again.
        catalog.value = catalog.value.copy(cursor = "c9")
        runCurrent()
        assertSame(before, reader.references.value)
        catalog.value = catalog.value.copy(bots = mapOf("b1" to bot))
        runCurrent()
        assertEquals("[Chef](${HappyReferences.linkPrefix}agent/ab)", HappyReferences.markdown("<happy-agent id=\"ab\"/>", reader.references.value))
        reader.setWords(ReferenceWords.English.copy(unavailableKinds = mapOf("agent" to "un agente no disponible")))
        runCurrent()
        assertEquals("un agente no disponible", HappyReferences.markdown("<happy-agent id=\"zz\"/>", reader.references.value))
    }
}

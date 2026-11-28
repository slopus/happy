package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Which features are available to the person (happy-cluster API.md, "Feature plugins"): the wire, and following it live. */
@OptIn(ExperimentalCoroutinesApi::class)
class FeaturesTest {
    private class Server(var status: Int = 200, var text: String = LIST_AVAILABLE) : Transport {
        val asked = mutableListOf<String>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path"
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    /** The route in memory: [features] answers what `GET /v0/features` would; each read counts. */
    private class Api(var features: List<Feature>? = listOf(PIPELINES)) : FeaturesApi {
        var reads = 0
        var gate: CompletableDeferred<Unit>? = null
        override suspend fun features(): List<Feature>? {
            reads++
            gate?.await()
            return features
        }
    }

    private fun event(type: String, data: JsonObject = JsonObject(emptyMap())) = AgentEvent("c1", type, data)

    private fun updated(available: Boolean) = event(Feature.UPDATED, Json.parseToJsonElement("""{"features":[{"id":"pipelines","available":$available}]}""").jsonObject)

    @Test
    fun featuresReadAsTheContractWritesThem() {
        val list = Feature.parseList(Json.parseToJsonElement("""{"features":[
            {"id":"pipelines","available":false},
            {"id":"later","available":true,"name":"Later"},
            {"id":"","available":true},
            {"id":"words","available":"yes"},
            "pipelines"]}"""))
        assertEquals(listOf(Feature("pipelines", false), Feature("later", true)), list)
        assertNull("not a list", Feature.parseList(Json.parseToJsonElement("""{"feature":{}}""")))
        assertEquals(list, Feature.parseList(Feature.toJson(list!!)))
    }

    @Test
    fun theRouteAndAServerWithoutItWhereEveryFeatureIsAvailable() = runBlocking {
        val server = Server()
        val api = ClusterFeatures(AgentClient(server, "t", cloud = true))
        assertEquals(listOf(PIPELINES), api.features())
        assertEquals("GET /v0/features", server.asked.last())
        for (status in listOf(404, 501)) {
            server.status = status
            server.text = """{"error":"Not found","code":"not_found"}"""
            assertNull("$status: no feature plugins", api.features())
        }
        server.status = 500
        try {
            api.features()
            fail("a server error is a failed read, not every feature available")
        } catch (e: AgentApiException) {
            assertEquals(500, e.status)
        }
    }

    @Test
    fun aFeatureRouteRefusedAsNotInstalled() {
        fun refusal(status: Int, code: String?, body: String) = AgentApiException(status, code, "Pipelines are not installed for your account.").also { it.body = Json.parseToJsonElement(body) }
        val off = """{"error":"Pipelines are not installed for your account. Install the Pipelines plugin to use them again.","code":"feature_not_installed","feature":"pipelines","plugin":"pipelines"}"""
        assertTrue(Feature.notInstalled(refusal(403, "feature_not_installed", off), Feature.PIPELINES))
        assertTrue("a body that names none is the route's own", Feature.notInstalled(refusal(403, "feature_not_installed", "{}"), Feature.PIPELINES))
        assertFalse("another feature's", Feature.notInstalled(refusal(403, "feature_not_installed", """{"feature":"later"}"""), Feature.PIPELINES))
        assertFalse("a role's refusal", Feature.notInstalled(refusal(403, "forbidden", "{}"), Feature.PIPELINES))
        assertFalse("not a 403", Feature.notInstalled(refusal(404, "feature_not_installed", off), Feature.PIPELINES))
        assertFalse(Feature.notInstalled(IllegalStateException(), Feature.PIPELINES))
    }

    /** Read on every connect where health says the server has feature plugins, and as soon as it says so once connected; never otherwise. */
    @Test
    fun readOnEveryHelloOnlyWhereServed() = runTest {
        val api = Api()
        val events = MutableSharedFlow<AgentEvent>()
        val served = MutableStateFlow(false)
        val source = FeaturesSource(api, events, served, { null }, {}, backgroundScope)
        runCurrent()
        served.value = true
        runCurrent()
        assertEquals("kept as served, but no link yet", 0, api.reads)
        served.value = false
        runCurrent()
        events.emit(event(AgentEvent.HELLO))
        runCurrent()
        assertEquals("a server without feature plugins is never asked", 0, api.reads)
        assertNull(source.features.value)
        served.value = true
        runCurrent()
        assertEquals(1, api.reads)
        assertEquals(listOf(PIPELINES), source.features.value)
        // Back in the foreground the link starts again: a hello.
        events.emit(event(AgentEvent.HELLO))
        runCurrent()
        assertEquals(2, api.reads)
        events.emit(event("pipeline.updated"))
        runCurrent()
        assertEquals(2, api.reads)
    }

    /** The event replaces the list, live, with no read; a read on its way meanwhile can't undo it. */
    @Test
    fun theEventReplacesTheListAndOutrunsARead() = runTest {
        val api = Api()
        val events = MutableSharedFlow<AgentEvent>()
        val kept = mutableListOf<JsonObject>()
        val source = FeaturesSource(api, events, MutableStateFlow(true), { null }, { kept += it }, backgroundScope)
        val off = source.unavailable(Feature.PIPELINES)
        runCurrent()
        events.emit(event(AgentEvent.HELLO))
        runCurrent()
        assertFalse(off.value)
        events.emit(updated(false))
        runCurrent()
        assertTrue(off.value)
        assertEquals(1, api.reads)
        assertEquals(Feature.toJson(listOf(PIPELINES.copy(available = false))), kept.last())
        // A read under way when the event that makes it available comes: its older answer is dropped.
        api.features = listOf(PIPELINES.copy(available = false))
        api.gate = CompletableDeferred()
        events.emit(event(AgentEvent.HELLO))
        runCurrent()
        events.emit(updated(true))
        runCurrent()
        assertFalse(off.value)
        api.gate!!.complete(Unit)
        runCurrent()
        assertFalse("the event was newer", off.value)
        // A list the next read brings is taken.
        api.gate = null
        events.emit(event(AgentEvent.HELLO))
        runCurrent()
        assertTrue(off.value)
    }

    /**
     * Nothing known, a feature not listed, or a server without feature
     * plugins: available. What was kept shows before the first read, but
     * only while health says the server has them.
     */
    @Test
    fun everyFeatureIsAvailableUnlessTheServerSaysOtherwise() = runTest {
        val api = Api(features = null)
        val served = MutableStateFlow(true)
        val source = FeaturesSource(api, MutableSharedFlow(), served, { Feature.toJson(listOf(PIPELINES.copy(available = false))) }, {}, backgroundScope)
        val off = source.unavailable(Feature.PIPELINES)
        runCurrent()
        assertTrue("kept from the last run", off.value)
        assertFalse("not listed is available", source.unavailable("later").value)
        served.value = false
        runCurrent()
        assertFalse("health without capabilities.features: every feature is available", off.value)
        served.value = true
        runCurrent()
        source.refresh()
        runCurrent()
        assertNull("404/501: no list", source.features.value)
        assertFalse(off.value)
    }

    /** A route refused as not installed, or the plugin installed or uninstalled here, shows at once. */
    @Test
    fun whatHappenedHereShowsAtOnce() = runTest {
        val source = FeaturesSource(Api(), MutableSharedFlow(), MutableStateFlow(true), { null }, {}, backgroundScope)
        val off = source.unavailable(Feature.PIPELINES)
        runCurrent()
        assertFalse(off.value)
        source.note(Feature.PIPELINES, available = false)
        runCurrent()
        assertTrue(off.value)
        source.note(Feature.PIPELINES, available = true)
        runCurrent()
        assertFalse(off.value)
    }

    private companion object {
        val PIPELINES = Feature("pipelines", true)
        const val LIST_AVAILABLE = """{"features":[{"id":"pipelines","available":true}]}"""
    }
}

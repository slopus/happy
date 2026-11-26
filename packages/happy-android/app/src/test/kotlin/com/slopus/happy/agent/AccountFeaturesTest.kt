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

/** The person's account features (happy-cluster API.md, "Account features"): the wire, and following them live. */
@OptIn(ExperimentalCoroutinesApi::class)
class AccountFeaturesTest {
    private class Server(var status: Int = 200, var text: String = LIST_ON) : Transport {
        val asked = mutableListOf<String>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path" + (body?.let { " " + String(it) } ?: "")
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    /** The route in memory: [features] answers what `GET` would; each read counts. */
    private class Api(var features: List<AccountFeature>? = listOf(PIPELINES_ON)) : AccountFeaturesApi {
        var reads = 0
        var gate: CompletableDeferred<Unit>? = null
        override suspend fun features(): List<AccountFeature>? {
            reads++
            gate?.await()
            return features
        }
    }

    private fun event(type: String, data: JsonObject = JsonObject(emptyMap())) = AgentEvent("c1", type, data)

    private fun updated(enabled: Boolean) = event(AccountFeature.UPDATED, Json.parseToJsonElement("""{"features":[{"id":"pipelines","name":"Pipelines","enabled":$enabled}]}""").jsonObject)

    @Test
    fun featuresReadAsTheContractWritesThem() {
        val list = AccountFeature.parseList(Json.parseToJsonElement("""{"features":[
            {"id":"pipelines","name":"Pipelines","enabled":false},
            {"id":"later","enabled":true},
            {"id":"","name":"No ID","enabled":true},
            {"id":"words","name":"Words","enabled":"yes"},
            "pipelines"]}"""))
        assertEquals(listOf(AccountFeature("pipelines", "Pipelines", false), AccountFeature("later", "later", true)), list)
        assertNull("not a list", AccountFeature.parseList(Json.parseToJsonElement("""{"feature":{}}""")))
        assertEquals(list, AccountFeature.parseList(AccountFeature.toJson(list!!)))
    }

    @Test
    fun theRouteAndAnOlderServerWhereEveryFeatureIsOn() = runBlocking {
        val server = Server()
        val api = ClusterAccountFeatures(AgentClient(server, "t", cloud = true))
        assertEquals(listOf(PIPELINES_ON), api.features())
        for (status in listOf(404, 501)) {
            server.status = status
            server.text = """{"error":"Not found","code":"not_found"}"""
            assertNull("$status: deployed before account features", api.features())
        }
        server.status = 500
        try {
            api.features()
            fail("a server error is a failed read, not every feature on")
        } catch (e: AgentApiException) {
            assertEquals(500, e.status)
        }
        assertEquals("GET /v0/account/features", server.asked.last())
    }

    @Test
    fun aFeatureRouteRefusedAsTurnedOff() {
        fun refusal(status: Int, code: String?, body: String) = AgentApiException(status, code, "Pipelines are turned off for your account.").also { it.body = Json.parseToJsonElement(body) }
        val off = """{"error":"Pipelines are turned off for your account. Turn them on in your account settings to use them again.","code":"feature_not_installed","feature":"pipelines"}"""
        assertTrue(AccountFeature.refusedAsOff(refusal(403, "feature_not_installed", off), AccountFeature.PIPELINES))
        assertTrue("a body that names none is the route's own", AccountFeature.refusedAsOff(refusal(403, "feature_not_installed", "{}"), AccountFeature.PIPELINES))
        assertFalse("another feature's", AccountFeature.refusedAsOff(refusal(403, "feature_not_installed", """{"feature":"later"}"""), AccountFeature.PIPELINES))
        assertFalse("a role's refusal", AccountFeature.refusedAsOff(refusal(403, "forbidden", "{}"), AccountFeature.PIPELINES))
        assertFalse("not a 403", AccountFeature.refusedAsOff(refusal(404, "feature_not_installed", off), AccountFeature.PIPELINES))
        assertFalse(AccountFeature.refusedAsOff(IllegalStateException(), AccountFeature.PIPELINES))
    }

    /** Read on every connect while the server has a feature it governs, and as soon as it says it has once connected; never otherwise. */
    @Test
    fun readOnEveryHelloOnlyWhereServed() = runTest {
        val api = Api()
        val events = MutableSharedFlow<AgentEvent>()
        val served = MutableStateFlow(false)
        val source = AccountFeaturesSource(api, events, served, { null }, {}, backgroundScope)
        runCurrent()
        served.value = true
        runCurrent()
        assertEquals("kept as served, but no link yet", 0, api.reads)
        served.value = false
        runCurrent()
        events.emit(event(AgentEvent.HELLO))
        runCurrent()
        assertEquals("a server without pipelines is never asked", 0, api.reads)
        assertNull(source.features.value)
        served.value = true
        runCurrent()
        assertEquals(1, api.reads)
        assertEquals(listOf(PIPELINES_ON), source.features.value)
        // Back in the foreground the link starts again: a hello.
        events.emit(event(AgentEvent.HELLO))
        runCurrent()
        assertEquals(2, api.reads)
        events.emit(event("pipeline.updated"))
        runCurrent()
        assertEquals(2, api.reads)
        // Health stops saying so: a server that answered the list is still asked, so the switch stays true to it.
        served.value = false
        events.emit(event(AgentEvent.HELLO))
        runCurrent()
        assertEquals(3, api.reads)
    }

    /** The event replaces the list, live, with no read; a read on its way meanwhile can't undo it. */
    @Test
    fun theEventReplacesTheListAndOutrunsARead() = runTest {
        val api = Api()
        val events = MutableSharedFlow<AgentEvent>()
        val kept = mutableListOf<JsonObject>()
        val source = AccountFeaturesSource(api, events, MutableStateFlow(true), { null }, { kept += it }, backgroundScope)
        val off = source.off(AccountFeature.PIPELINES)
        runCurrent()
        events.emit(event(AgentEvent.HELLO))
        runCurrent()
        assertFalse(off.value)
        events.emit(updated(false))
        runCurrent()
        assertTrue(off.value)
        assertEquals(1, api.reads)
        assertEquals(AccountFeature.toJson(listOf(PIPELINES_ON.copy(enabled = false))), kept.last())
        // A read under way when the event that turns it back on comes: its older answer is dropped.
        api.features = listOf(PIPELINES_ON.copy(enabled = false))
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

    /** Nothing known, a feature not listed, or an older server: on. What was kept shows before the first read. */
    @Test
    fun everyFeatureIsOnUntilTurnedOffAndTheKeptListShowsFirst() = runTest {
        val api = Api(features = null)
        val events = MutableSharedFlow<AgentEvent>()
        val source = AccountFeaturesSource(api, events, MutableStateFlow(false), { AccountFeature.toJson(listOf(PIPELINES_ON.copy(enabled = false))) }, {}, backgroundScope)
        val off = source.off(AccountFeature.PIPELINES)
        runCurrent()
        assertTrue("kept from the last run", off.value)
        assertFalse("not listed is on", source.off("later").value)
        source.refresh()
        runCurrent()
        assertNull("an older server: no list", source.features.value)
        assertFalse(off.value)
    }

    /** A route refused as turned off turns it off here, at once. */
    @Test
    fun aRefusalTurnsItOff() = runTest {
        val source = AccountFeaturesSource(Api(), MutableSharedFlow(), MutableStateFlow(true), { null }, {}, backgroundScope)
        val off = source.off(AccountFeature.PIPELINES)
        runCurrent()
        assertFalse(off.value)
        source.turnedOff(AccountFeature.PIPELINES)
        runCurrent()
        assertTrue(off.value)
    }

    private companion object {
        val PIPELINES_ON = AccountFeature("pipelines", "Pipelines", true)
        const val LIST_ON = """{"features":[{"id":"pipelines","name":"Pipelines","enabled":true}]}"""
    }
}

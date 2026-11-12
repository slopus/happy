package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.Mode
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import java.util.Locale
import java.util.TimeZone

class UserEnvironmentTest {
    private val berlin = UserEnvironment(
        UserEnvironment.DeviceKind.Phone, "Europe/Berlin", 60, "de-DE", listOf("de-DE", "en-US"), "h23", 1, "gregory",
    )
    private val mode = Mode("claude", "anthropic/opus-5", "high", null, "auto")

    /** A computer whose health answers [takes] and whose environment route answers [status]; it keeps what it is asked. */
    private class Computer(var takes: Boolean?, var status: Int = 200) : Transport {
        val asked = mutableListOf<Pair<String, JsonObject?>>()

        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path" to body?.let { AgentClient.json.parseToJsonElement(it.toString(Charsets.UTF_8)).jsonObject }
            val text = when (path) {
                "/v0/health" -> buildJsonObject {
                    put("ready", true)
                    put("capabilities", buildJsonObject { takes?.let { put("userEnvironment", it) } })
                }.toString()
                "/v0/environment" -> return TransportResponse(status, body = """{"environment":{"deviceId":"d","updatedAt":1,"reportedAt":1}}""".toByteArray())
                else -> "{}"
            }
            return TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}

        fun paths() = asked.map { it.first }
    }

    private fun conversation(client: AgentClient) = ConversationApi(
        bytesRequest = null,
        request = { method, path, body, category -> client.send(method, path, body, category = category) },
        sendingDevice = { client.environment.sendingDeviceId },
    )

    @Test
    fun readsThisDeviceInTheApisTerms() {
        val winter = 1_768_000_000_000L
        val read = UserEnvironment.of(
            UserEnvironment.DeviceKind.Phone, TimeZone.getTimeZone("Europe/Berlin"), Locale.GERMANY,
            listOf(Locale.GERMANY, Locale.US), twentyFourHour = true, now = winter,
        )
        assertEquals(berlin, read)

        val american = UserEnvironment.of(
            UserEnvironment.DeviceKind.Tablet, TimeZone.getTimeZone("America/Los_Angeles"), Locale.US,
            emptyList(), twentyFourHour = false, now = winter,
        )
        assertEquals(-480, american.utcOffsetMinutes)
        assertEquals("h12", american.hourCycle)
        assertEquals(7, american.firstDayOfWeek)
        assertEquals("en-US", american.locale)
        // An empty language list is left out of the report, not sent as one it refuses.
        assertNull(american.report("d")["languages"])

        val thai = UserEnvironment.of(null, TimeZone.getTimeZone("Asia/Bangkok"), Locale.forLanguageTag("th-TH-u-ca-buddhist"), emptyList(), true, winter)
        assertEquals("buddhist", thai.calendar)
        assertNull(UserEnvironment.of(null, TimeZone.getTimeZone("UTC"), Locale.forLanguageTag("en-u-ca-bogus"), emptyList(), true, winter).calendar)
        assertEquals(6, UserEnvironment.isoWeekday(7))
        assertNull(UserEnvironment.name("a".repeat(65)))
        assertNull(UserEnvironment.name("a\u0007b"))
    }

    @Test
    fun reportsWhatTheApiDocumentsAndNamesTheDeviceOnSendsOnceTaken() = runBlocking {
        val computer = Computer(takes = true)
        val client = AgentClient(computer, "t")
        client.environment.report(client, berlin, "6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c")
        assertEquals("PUT /v0/environment", computer.asked.last().first)
        assertEquals(
            buildJsonObject {
                put("deviceId", "6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c"); put("deviceKind", "phone"); put("timeZone", "Europe/Berlin")
                put("utcOffsetMinutes", 60); put("locale", "de-DE"); put("languages", JsonArray(listOf(JsonPrimitive("de-DE"), JsonPrimitive("en-US"))))
                put("hourCycle", "h23"); put("firstDayOfWeek", 1); put("calendar", "gregory")
            },
            computer.asked.last().second,
        )

        conversation(client).send("agent", "m1", "hi", emptyList(), mode)
        assertEquals(JsonPrimitive("6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c"), computer.asked.last().second?.get("deviceId"))

        // Unchanged: nothing is asked again, health included.
        val before = computer.asked.size
        client.environment.report(client, berlin, "6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c")
        assertEquals(before, computer.asked.size)

        // Travelled: told again.
        client.environment.report(client, berlin.copy(timeZone = "Asia/Tokyo", utcOffsetMinutes = 540), "6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c")
        assertEquals("PUT /v0/environment", computer.asked.last().first)
        assertEquals(JsonPrimitive("Asia/Tokyo"), computer.asked.last().second?.get("timeZone"))
    }

    @Test
    fun aComputerThatDoesntTakeReportsIsNeverToldNorSentADevice() = runBlocking {
        val computer = Computer(takes = null)
        val client = AgentClient(computer, "t")
        client.environment.report(client, berlin, "d1")
        conversation(client).send("agent", "m1", "hi", emptyList(), mode)
        assertEquals(listOf("GET /v0/health", "POST /v0/agents/agent/send"), computer.paths())
        assertFalse(computer.asked.last().second!!.containsKey("deviceId"))

        // Updated while the app runs: health is asked again and now says yes.
        computer.takes = true
        client.environment.report(client, berlin, "d1")
        assertEquals(listOf("GET /v0/health", "PUT /v0/environment"), computer.paths().takeLast(2))
    }

    @Test
    fun aRefusedRouteStopsNamingTheDevice() = runBlocking {
        val computer = Computer(takes = true, status = 404)
        val client = AgentClient(computer, "t")
        client.environment.report(client, berlin, "d1")
        assertNull(client.environment.sendingDeviceId)
        conversation(client).send("agent", "m1", "hi", emptyList(), mode)
        assertFalse(computer.asked.last().second!!.containsKey("deviceId"))
    }

    @Test
    fun aFailedReportIsToldAgain() = runBlocking {
        val computer = Computer(takes = true, status = 500)
        val client = AgentClient(computer, "t")
        try {
            client.environment.report(client, berlin, "d1")
            fail("a 500 is thrown")
        } catch (_: AgentApiException) {
        }
        computer.status = 200
        client.environment.report(client, berlin, "d1")
        assertEquals(2, computer.paths().count { it == "PUT /v0/environment" })
    }
}

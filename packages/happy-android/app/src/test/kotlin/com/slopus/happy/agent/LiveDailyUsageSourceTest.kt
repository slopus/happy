package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

/**
 * `GET /v0/usage/daily` behind [DailyUsageSource]: asked only where health's
 * `capabilities.dailyUsage` is true, as iOS; health read once, and again only
 * after it failed; a failure is nothing, and a 404 or 501 is never asked again.
 */
class LiveDailyUsageSourceTest {
    private val asked = mutableListOf<String>()
    private val answers = ArrayDeque<Pair<Int, String>>()
    private val history = """{"since":"2026-01-05","days":[{"date":"2026-01-05","byProvider":{"claude":{"opus":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4}}}}]}"""
    private val health = "GET /v0/health"
    private val daily = "GET /v0/usage/daily?days=371&tz=America%2FLos_Angeles"

    /** A source whose health answers [healths] in turn, the last from then on; the daily route answers [answers] in turn. */
    private fun source(vararg healths: Pair<Int, String>): LiveDailyUsageSource {
        val left = ArrayDeque(healths.toList())
        return LiveDailyUsageSource(
            AgentClient(
                object : Transport {
                    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                        asked += "$method $path"
                        val (status, text) = if (path == "/v0/health") (if (left.size > 1) left.removeFirst() else left.first()) else answers.removeFirst()
                        return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
                    }

                    override suspend fun close() {}
                },
                "t",
            ),
        )
    }

    private val on = 200 to """{"ok":true,"capabilities":{"feed":true,"dailyUsage":true}}"""

    private fun LiveDailyUsageSource.year() = runBlocking { read(DailyUsage.DAYS, ZoneId.of("America/Los_Angeles")) }

    @Test
    fun flagOnReadsTheYearInThePhonesZoneAndAsksHealthOnce() {
        answers += 200 to history
        answers += 200 to history
        val source = source(on)
        val read = source.year()!!
        source.year()
        assertEquals(listOf(health, daily, daily), asked)
        assertEquals(LocalDate.of(2026, 1, 5), read.since)
        assertEquals(7L, read.days.single().byProvider.getValue("claude").getValue("opus").counted)
    }

    @Test
    fun flagOffAsksNothing() {
        val source = source(200 to """{"ok":true,"capabilities":{"feed":true,"dailyUsage":false}}""")
        assertNull(source.year())
        assertNull(source.year())
        assertEquals(listOf(health), asked)
    }

    @Test
    fun flagMissingAsksNothing() {
        val source = source(200 to """{"ok":true,"capabilities":{"feed":true}}""")
        assertNull(source.year())
        assertNull(source.year())
        assertEquals(listOf(health), asked)
    }

    /** The route and the flag ship together: a health with no capabilities at all has no route. */
    @Test
    fun noCapabilitiesAsksNothing() {
        val source = source(200 to """{"ok":true}""")
        assertNull(source.year())
        assertNull(source.year())
        assertEquals(listOf(health), asked)
    }

    /** Health that can't be read gives nothing now, and is read again at the next refresh. */
    @Test
    fun aFailedHealthIsReadAgain() {
        answers += 200 to history
        val source = source(500 to """{"error":"boom"}""", on)
        assertNull(source.year())
        assertEquals(LocalDate.of(2026, 1, 5), source.year()?.since)
        assertEquals(listOf(health, health, daily), asked)
    }

    /** A server that sets the flag but has no route isn't asked again. */
    @Test
    fun aFlaggedServerWithoutTheRouteIsNotAskedAgain() {
        for (status in listOf(404, 501)) {
            asked.clear()
            answers += status to """{"error":"Not found","code":"not_found"}"""
            val source = source(on)
            assertNull(source.year())
            assertNull(source.year())
            assertEquals("$status", listOf(health, daily), asked)
        }
    }

    @Test
    fun aFailureIsNothingAndIsAskedAgain() {
        answers += 500 to """{"error":"boom"}"""
        answers += 200 to """not json"""
        answers += 200 to """{"days":[]}"""
        val source = source(on)
        assertNull(source.year())
        assertNull(source.year())
        assertNull(source.year())
        assertEquals(listOf(health, daily, daily, daily), asked)
    }
}

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

/** `GET /v0/usage/daily` behind [DailyUsageSource]: any failure is nothing, and a 404 is never asked again. */
class LiveDailyUsageSourceTest {
    private val asked = mutableListOf<String>()
    private val answers = ArrayDeque<Pair<Int, String>>()

    private val source = LiveDailyUsageSource(
        AgentClient(
            object : Transport {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    asked += "$method $path"
                    val (status, text) = answers.removeFirst()
                    return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
                }

                override suspend fun close() {}
            },
            "t",
        ),
    )

    private fun read() = runBlocking { source.read(DailyUsage.DAYS, ZoneId.of("America/Los_Angeles")) }

    @Test
    fun readsTheYearInThePhonesZone() {
        answers += 200 to """{"since":"2026-01-05","days":[{"date":"2026-01-05","byProvider":{"claude":{"opus":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4}}}}]}"""
        val history = read()!!
        assertEquals(listOf("GET /v0/usage/daily?days=371&tz=America%2FLos_Angeles"), asked)
        assertEquals(LocalDate.of(2026, 1, 5), history.since)
        assertEquals(7L, history.days.single().byProvider.getValue("claude").getValue("opus").counted)
    }

    @Test
    fun aFailureIsNothingAndIsAskedAgain() {
        answers += 500 to """{"error":"boom"}"""
        answers += 200 to """not json"""
        answers += 200 to """{"days":[]}"""
        assertNull(read())
        assertNull(read())
        assertNull(read())
        assertEquals(3, asked.size)
    }

    @Test
    fun aServerWithoutTheRouteIsNotAskedAgain() {
        answers += 404 to """{"error":"Not found","code":"not_found"}"""
        assertNull(read())
        assertNull(read())
        assertEquals(1, asked.size)
    }
}

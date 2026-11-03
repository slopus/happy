package com.slopus.happy.agent

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

/** Which finished conversations chime (desktop 962201a2, a72f8304), and the chime itself. */
class CompletionWatchTest {
    private val now = 1_000_000L

    private fun catalog(settings: List<JsonObject> = emptyList()) = AgentCatalog().withBootstrap(
        AgentClient.json.decodeFromJsonElement(
            WireDesktopBootstrap.serializer(),
            Wire.bootstrap(
                bots = listOf(Wire.bot("b1", "Happy", Wire.agent("a1", subtasks = listOf(Wire.agent("s1", subtask = true, parent = "a1"))))),
                tasks = listOf(Wire.task("t1", "Task", Wire.agent("a2"))),
                memberships = listOf(Wire.membership("t1", "1")),
                userSettings = settings,
            ),
        ),
    )

    private val listed = { _: String -> true }

    private fun run(id: String, endedAt: Long? = null) = buildJsonObject {
        put("id", id)
        if (endedAt != null) put("endedAt", endedAt)
    }

    private fun started(agentId: String, runId: String) = Wire.event("c", "run.started", buildJsonObject { put("agentId", agentId); put("run", run(runId)) })
    private fun finished(agentId: String, runId: String, endedAt: Long = now) =
        Wire.event("c", "run.finished", buildJsonObject { put("agentId", agentId); put("run", run(runId, endedAt)) })

    @Test
    fun aTopLevelConversationsLiveFinishChimes() {
        val watch = CompletionWatch()
        val catalog = catalog()
        assertNull(watch.finished(started("a1", "r1"), catalog, listed, now))
        assertEquals("a1", watch.finished(finished("a1", "r1"), catalog, listed, now))
        // One whose start this connect never heard chimes too.
        assertEquals("a2", watch.finished(finished("a2", "r9"), catalog, listed, now))
    }

    @Test
    fun aSubtaskAReplayAReplacedRunAndAnUnlistedOneStayQuiet() {
        val watch = CompletionWatch()
        val catalog = catalog()
        assertNull("a subtask", watch.finished(finished("s1", "r1"), catalog, listed, now))
        assertNull("ended a minute ago", watch.finished(finished("a1", "r1", endedAt = now - 60_000), catalog, listed, now))
        watch.finished(started("a1", "r3"), catalog, listed, now)
        assertNull("a newer run started", watch.finished(finished("a1", "r2"), catalog, listed, now))
        assertNull("not on home", watch.finished(finished("a2", "r1"), catalog, { it != "a2" }, now))
        assertNull("unknown", watch.finished(finished("zz", "r1"), catalog, listed, now))
        // A hello forgets the runs: the next finish is heard as its own.
        watch.finished(Wire.event("c", AgentEvent.HELLO, buildJsonObject {}), catalog, listed, now)
        assertEquals("a1", watch.finished(finished("a1", "r2"), catalog, listed, now))
    }

    @Test
    fun neverOrAMutedOrHiddenBotSilencesIt() {
        val never = catalog(listOf(Wire.setting(DesktopSettings.COMPLETION_SOUND, JsonPrimitive("never"), "v1")))
        assertEquals(CompletionSound.Never, DesktopSettings.completionSound(never.settingValues))
        assertNull(CompletionWatch().finished(finished("a1", "r1"), never, listed, now))
        val focused = catalog(listOf(Wire.setting(DesktopSettings.COMPLETION_SOUND, JsonPrimitive("focused"), "v1")))
        assertEquals("a1", CompletionWatch().finished(finished("a1", "r1"), focused, listed, now))
        for (attention in listOf("muted", "hidden")) {
            val quiet = catalog(listOf(Wire.setting(DesktopSettings.BOT_PREFIX + "b1", buildJsonObject { put(attention, true) }, "v1")))
            assertNull(attention, CompletionWatch().finished(finished("a1", "r1"), quiet, listed, now))
            // A task's conversation isn't the bot's.
            assertEquals("a2", CompletionWatch().finished(finished("a2", "r1"), quiet, listed, now))
        }
    }

    @Test
    fun alwaysIsTheSettingClearedAsTheDesktopWritesIt() {
        assertEquals(JsonNull, DesktopSettings.completionSoundValue(CompletionSound.Always))
        assertEquals(JsonPrimitive("focused"), DesktopSettings.completionSoundValue(CompletionSound.Focused))
        assertEquals(JsonPrimitive("never"), DesktopSettings.completionSoundValue(CompletionSound.Never))
        assertEquals(CompletionSound.Always, DesktopSettings.completionSound(mapOf(DesktopSettings.COMPLETION_SOUND to JsonNull)))
    }

    @Test
    fun theChimeIsTwoSinesUnderDesktopsEnvelope() {
        val rate = 44_100
        val samples = CompletionChime.samples(rate)
        assertEquals(18_522, samples.size) // ceil(44100 × 0.42)
        fun expected(time: Double): Double {
            val envelope = if (time < 0.015) 0.0001 * Math.pow(1200.0, time / 0.015) else 0.12 * Math.pow(0.0001 / 0.12, (time - 0.015) / 0.405)
            var value = sin(2 * PI * 659.25 * time)
            if (time >= 0.11 && time < 0.39) value += sin(2 * PI * 880.0 * (time - 0.11))
            if (time >= 0.28) value -= sin(2 * PI * 659.25 * time)
            return value * envelope * Short.MAX_VALUE
        }
        for (index in listOf(10, 661, 3000, 6000, 12_000, 18_000)) {
            assertTrue("sample $index", abs(samples[index] - expected(index.toDouble() / rate)) <= 1.0)
        }
        // Loudest just after the attack, at most 0.12 × 2 of full scale, and faded out at the end.
        assertTrue(samples.maxOf { abs(it.toInt()) } <= (0.24 * Short.MAX_VALUE).toInt())
        assertTrue(abs(samples.last().toInt()) < 10)
    }
}

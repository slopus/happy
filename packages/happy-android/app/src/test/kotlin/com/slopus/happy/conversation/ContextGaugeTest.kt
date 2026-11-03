package com.slopus.happy.conversation

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** iOS AgentContextGaugeTests and AccountUsageWarningTests (083c30df4). */
class ContextGaugeTest {
    private val catalog = ModeCatalog.parse(
        Json.parseToJsonElement(
            """{"config":{"models":{"m":{"name":"M","contextWindow":200000,"autoCompactWindow":160000},"big":{"name":"Big","contextWindow":1000000},"custom":{"name":"Custom"}},""" +
                """"providers":{"codex":{"type":"codex","enabled":true,"models":[{"id":"m","enabled":true},{"id":"big","enabled":true},{"id":"custom","enabled":true}]}},""" +
                """"defaults":{"providerId":"codex","modelId":"m","effort":"high","permissionMode":"auto"}}}""",
        ).jsonObject,
    )
    private fun mode(model: String) = Mode("codex", model, "high", null, "auto")

    @Test fun `the catalog keeps each model's window and where it compacts`() {
        assertEquals(ContextWindow(200000, 160000), catalog.windows["m"])
        assertEquals(ContextWindow(1000000, null), catalog.windows["big"])
        assertNull(catalog.windows["custom"])
    }

    @Test fun `before a measurement the selection's window shows with nothing spent`() {
        val gauge = ContextGauge.derive(catalog, null, mode("m"))!!
        assertEquals(ContextGauge(0, 200000, 160000, measured = false), gauge)
        assertEquals(0.0, gauge.fraction, 0.0)
        assertEquals(0.8, gauge.compactFraction, 1e-9)
        assertNull(ContextGauge.derive(catalog, null, mode("custom")))
        assertNull(ContextGauge.derive(null, null, mode("m")))
    }

    @Test fun `a measurement is read against its own window, clamped, the threshold from its model`() {
        val gauge = ContextGauge.derive(catalog, ContextMeasurement(true, 84_400.4, 200000.0, "m", "codex"), mode("big"))!!
        assertEquals(ContextGauge(84400, 200000, 160000, approximate = true), gauge)
        assertEquals(42, gauge.percent)
        assertEquals(ContextGauge.Tone.Ample, gauge.tone)
        // Past the window it is full; no window at all, the model's.
        assertEquals(200000L, ContextGauge.derive(catalog, ContextMeasurement(false, 250000.0, 200000.0, "m", "codex"), null)!!.usedTokens)
        assertEquals(1000000L, ContextGauge.derive(catalog, ContextMeasurement(false, 1.0, null, "big", "codex"), null)!!.totalTokens)
        assertNull(ContextGauge.derive(catalog, ContextMeasurement(false, 1.0, null, "custom", "codex"), null))
        // A threshold at or past the window is none: the notch falls back to three quarters.
        val over = ContextGauge(10, 100, compactTokens = 100)
        assertEquals(ContextGauge.DEFAULT_COMPACT_FRACTION, over.compactFraction, 0.0)
    }

    @Test fun `the colour comes within a fifth of the compaction point and turns at it`() {
        fun tone(used: Long) = ContextGauge(used, 100_000, 80_000).tone
        assertEquals(ContextGauge.Tone.Ample, tone(63_999))
        assertEquals(ContextGauge.Tone.Compact, tone(64_001))
        assertEquals(ContextGauge.Tone.Critical, tone(80_000))
        assertEquals(ContextGauge.Tone.Ample, ContextGauge(0, 100, measured = false).tone)
    }

    @Test fun `token counts read as desktop's tokensFormat`() {
        assertEquals("950", ContextGauge.tokens(950))
        assertEquals("1.2k", ContextGauge.tokens(1_200))
        assertEquals("1.3k", ContextGauge.tokens(1_250))
        assertEquals("84k", ContextGauge.tokens(84_000))
        assertEquals("128k", ContextGauge.tokens(128_400))
        assertEquals("1M", ContextGauge.tokens(1_000_000))
        assertEquals("1.5M", ContextGauge.tokens(1_500_000))
    }

    @Test fun `usage projects each account and warns of the week before the session`() {
        val usage = AccountUsage.project(
            Json.parseToJsonElement(
                """{"providers":[""" +
                    """{"providerId":"a","refreshedAt":1000,"usage":{"planName":"Pro","windows":{"fiveHour":{"usedPercent":95,"resetsAt":5000},"weekly":{"usedPercent":80,"resetsAt":9000}}}},""" +
                    """{"providerId":"b","usage":{"planName":"Pro","exhausted":true,"windows":{"fiveHour":{"usedPercent":100,"resetsAt":5000},"weekly":{"usedPercent":40}}}},""" +
                    """{"providerId":"c","usage":{"planName":"Pro","windows":{"fiveHour":{"usedPercent":10},"weekly":{"usedPercent":30}}}},""" +
                    """{"providerId":"d","signIn":"signed_out"},""" +
                    """{"providerId":"e"}""" +
                    """]}""",
            ).jsonObject,
        )
        assertEquals(setOf("a", "b", "c", "d"), usage.keys)
        // The week is low, so it is the one warned of though the session is lower.
        val a = usage.getValue("a").warning!!
        assertEquals(AccountUsage.Window.Kind.Week, a.window.kind)
        assertEquals(20, a.left)
        assertEquals(AccountUsage.Tone.Low, a.tone)
        assertEquals(1000L, usage.getValue("a").updatedAt)
        // A window holding a spent account back is critical whatever its number.
        val b = usage.getValue("b")
        assertEquals(true, b.limited)
        assertEquals(5000L, b.limitResets)
        assertEquals(AccountUsage.Window.Kind.Session, b.warning!!.window.kind)
        assertEquals(AccountUsage.Tone.Critical, b.warning!!.tone)
        assertFalse(b.week!!.blocking)
        assertNull(usage.getValue("c").warning)
        assertEquals(true, usage.getValue("d").signedOut)
        assertEquals(AccountUsage.Tone.Critical, AccountUsage.tone(9, false))
        assertEquals(AccountUsage.Tone.Low, AccountUsage.tone(24, false))
        assertEquals(AccountUsage.Tone.Ample, AccountUsage.tone(25, false))
    }
}

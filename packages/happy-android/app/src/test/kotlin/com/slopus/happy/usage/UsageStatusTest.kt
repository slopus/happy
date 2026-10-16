package com.slopus.happy.usage

import com.slopus.happy.chat.AgentState
import com.slopus.happy.chat.ContextUsage
import com.slopus.happy.chat.UsageLimits
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale
import java.util.TimeZone

/** AgentInput.tsx's getContextStatus/formatTokenCount and sessionStatusBar.ts's usage-limit helpers. */
class UsageStatusTest {
    private fun usage(size: Long, window: Long?) = ContextUsage(0, 0, 0, 0, size, window)

    private fun limits(vararg windows: UsageLimits.Window) = UsageLimits(1.0, windows.toList())

    @Test
    fun tokenCounts() {
        mapOf(
            0.0 to "0", -5.0 to "0", 999.0 to "999", 999.5 to "1000", 1500.0 to "2k", 12_345.0 to "12k",
            999_499.0 to "999k", 999_500.0 to "1M", 1_250_000.0 to "1.3M", 2_000_000.0 to "2M",
            9_960_000.0 to "10M", 12_400_000.0 to "12M",
        ).forEach { (tokens, text) -> assertEquals("$tokens", text, formatTokenCount(tokens)) }
    }

    @Test
    fun contextShowsOnlyNearTheLimitUnlessAlwaysShown() {
        assertNull("no window yet", contextStatus(usage(150_000, null), alwaysShow = true))
        assertNull("nothing used", contextStatus(usage(0, 200_000), alwaysShow = true))
        assertNull("plenty left", contextStatus(usage(100_000, 200_000), alwaysShow = false))
        assertEquals(ContextStatus(50, "100k", "200k", ContextLevel.Normal), contextStatus(usage(100_000, 200_000), alwaysShow = true))
        assertEquals(ContextLevel.Warning, contextStatus(usage(180_000, 200_000), alwaysShow = false)?.level)
        assertEquals(ContextLevel.Warning, contextStatus(usage(189_999, 200_000), alwaysShow = false)?.level)
        assertEquals(ContextLevel.Critical, contextStatus(usage(190_000, 200_000), alwaysShow = false)?.level)
        assertEquals(100, contextStatus(usage(250_000, 200_000), alwaysShow = false)?.percent)
    }

    @Test
    fun rowsPutSessionAndWeekFirstAndClamp() {
        val rows = usageLimitRows(
            limits(
                UsageLimits.Window("nimbus_quill", utilization = 12.4),
                UsageLimits.Window("seven_day", label = "Week", utilization = 140.0, resetsAt = 5.0),
                UsageLimits.Window("five_hour", utilization = 32.5),
            ),
        )
        assertEquals(
            listOf(
                UsageLimitRow("five_hour", "five hour", 33, null),
                UsageLimitRow("seven_day", "Week", 100, 5.0),
                UsageLimitRow("nimbus_quill", "nimbus quill", 12, null),
            ),
            rows,
        )
        assertEquals(emptyList<UsageLimitRow>(), usageLimitRows(null))
    }

    @Test
    fun weekShowsWithTheContextOrAlways() {
        val week = limits(UsageLimits.Window("five_hour", utilization = 20.0, resetsAt = 9.0), UsageLimits.Window("seven_day", utilization = 30.0))
        val quiet = usageRowState(usage(10_000, 200_000), week, alwaysShowContextSize = false, showRemaining = false)
        assertTrue(quiet.isEmpty)

        val near = usageRowState(usage(185_000, 200_000), week, alwaysShowContextSize = false, showRemaining = false)
        assertEquals(30, near.weekPercent)
        assertEquals(listOf(UsagePopupRow("session", 20, 9.0), UsagePopupRow("week", 30, null)), near.popup)

        val always = usageRowState(null, week, alwaysShowContextSize = true, showRemaining = true)
        assertNull(always.context)
        assertEquals(70, always.weekPercent)
        assertEquals(listOf(80, 70), always.popup.map { it.percent })

        val noWeek = usageRowState(null, limits(UsageLimits.Window("seven_day")), alwaysShowContextSize = true, showRemaining = false)
        assertTrue(noWeek.isEmpty)
    }

    @Test
    fun resetsShowATimeWithin22HoursElseADate() {
        val utc = TimeZone.getTimeZone("UTC")
        val now = 1_760_000_000_000L // 2025-10-09 08:53:20 UTC
        assertEquals("06:00 PM", formatUsageLimitResetTime(now + 32_800_000.0, now, "hh:mm a", "MMM d", Locale.US, utc))
        assertEquals("Oct 10", formatUsageLimitResetTime(now + 22 * 3_600_000.0, now, "hh:mm a", "MMM d", Locale.US, utc))
        assertEquals("Oct 12", formatUsageLimitResetTime(now + 3 * 86_400_000.0, now, "hh:mm a", "MMM d", Locale.US, utc))
    }

    @Test
    fun usageLimitsParseLikeTheSchema() {
        fun parse(json: String) = AgentState.parse(Json.parseToJsonElement("""{"usageLimits": $json}"""))!!.usageLimits
        assertEquals(
            UsageLimits(
                1700.0,
                listOf(
                    UsageLimits.Window("five_hour", "Session", "allowed", 32.0, 1800.0),
                    UsageLimits.Window("plan", utilization = null, resetsAt = null),
                ),
            ),
            parse(
                """{"capturedAt": 1700, "extra": 1, "windows": [
                    {"id": "five_hour", "label": "Session", "status": "allowed", "utilization": 32, "resetsAt": 1800, "x": true},
                    {"id": "plan", "utilization": null, "resetsAt": null}]}""",
            ),
        )
        assertNull("no capturedAt", parse("""{"windows": []}"""))
        assertNull("window without id", parse("""{"capturedAt": 1, "windows": [{"utilization": 1}]}"""))
        assertNull("label null", parse("""{"capturedAt": 1, "windows": [{"id": "a", "label": null}]}"""))
        assertNull("utilization as text", parse("""{"capturedAt": 1, "windows": [{"id": "a", "utilization": "5"}]}"""))
        // A bad snapshot leaves the rest of the state alone.
        val state = AgentState.parse(Json.parseToJsonElement("""{"controlledByUser": true, "usageLimits": 5}"""))!!
        assertEquals(true, state.controlledByUser)
        assertNull(state.usageLimits)
    }
}

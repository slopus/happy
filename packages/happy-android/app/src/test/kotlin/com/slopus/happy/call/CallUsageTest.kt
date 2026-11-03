package com.slopus.happy.call

import org.junit.Assert.assertEquals
import org.junit.Test

/** The device's free time (iOS `CallUsageTests`). */
class CallUsageTest {
    private val day = 86_400_000L

    @Test
    fun useIsCountedOverTheLastThirtyDaysRolling() {
        val usage = CallUsage().record("a", 0, 600_000).record("b", 10 * day, 10 * day + 300_000)
        assertEquals(900_000L, usage.used(20 * day, 30 * day))
        // Thirty days after the first call, only its last part is inside.
        assertEquals(500_000L, usage.used(30 * day + 400_000, 30 * day))
        assertEquals(0L, usage.used(41 * day, 30 * day))
    }

    @Test
    fun puttingTheClockBackGivesNoTimeBack() {
        var usage = CallUsage().record("a", 1_000_000, 1_600_000)
        assertEquals(600_000L, usage.used(100_000, 10 * day))
        usage = usage.record("a", 1_000_000, 50_000)
        assertEquals(listOf(CallUsage.Span("a", 1_000_000, 1_600_000)), usage.spans)
    }

    @Test
    fun theDefaultIsTwentyMinutesInThirtyDaysAndNoCountOfCalls() {
        val allowance = CallAllowance(MemoryUsageStore())
        assertEquals(1_200_000L, allowance.remaining(0))
        repeat(150) { allowance.record("$it", it * 10_000L, it * 10_000L + 1_000) }
        assertEquals(1_050_000L, allowance.remaining(2_000_000))
    }

    @Test
    fun aCallTheAppNeverSawEndCountsToItsLastCheckpointOnce() {
        val store = MemoryUsageStore()
        CallAllowance(store, free = 1_200_000, window = 10 * day).apply {
            record("a", 100_000, 110_000)
            record("a", 100_000, 120_000)
        }
        val next = CallAllowance(store, free = 1_200_000, window = 10 * day)
        assertEquals(1_180_000L, next.remaining(500_000))
    }

    @Test
    fun oldSpansAreForgotten() {
        val store = MemoryUsageStore()
        val allowance = CallAllowance(store, free = 100_000, window = 1_000_000)
        allowance.record("a", 0, 10_000)
        allowance.record("b", 2_000_000, 2_010_000)
        assertEquals(listOf("b"), store.usage.spans.map { it.id })
    }
}

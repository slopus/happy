package com.slopus.happy.sync

import com.slopus.happy.data.ActivityRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class PresenceTest {
    private var now = 50_000L
    private val presence = Presence { now }

    @Test
    fun heartbeatsOfAnActiveSessionPublishNothing() {
        presence.reconcileSessions(listOf(ActivityRow("s", active = true, activeAt = 100)))
        val before = presence.sessions.value
        for (i in 1..50) presence.activity("s", active = true, activeAt = 100L + i * 2_000, thinking = false)
        assertSame(before, presence.sessions.value)
    }

    @Test
    fun flipsArePublishedAtOnce() {
        presence.reconcileSessions(listOf(ActivityRow("s", active = true, activeAt = 100)))
        presence.activity("s", active = true, activeAt = 2_000, thinking = true)
        assertEquals(SessionPresence(active = true, activeAt = 2_000, thinking = true, thinkingAt = 50_000), presence.sessions.value["s"])
        presence.activity("s", active = true, activeAt = 4_000, thinking = false)
        assertEquals(false, presence.sessions.value["s"]!!.thinking)
        presence.activity("s", active = false, activeAt = 6_000, thinking = false)
        assertEquals(SessionPresence(active = false, activeAt = 6_000, thinking = false, thinkingAt = 50_000), presence.sessions.value["s"])
    }

    @Test
    fun anOfflineSessionsLastSeenTimeIsShown() {
        presence.reconcileSessions(listOf(ActivityRow("s", active = false, activeAt = 100)))
        presence.activity("s", active = false, activeAt = 900, thinking = false)
        assertEquals(900L, presence.sessions.value["s"]!!.activeAt)
    }

    @Test
    fun stalePacketsAndUnknownIdsAreIgnored() {
        presence.reconcileSessions(listOf(ActivityRow("s", active = true, activeAt = 1_000)))
        presence.activity("s", active = false, activeAt = 500, thinking = false)
        assertEquals(true, presence.sessions.value["s"]!!.active)
        presence.activity("other", active = true, activeAt = 2_000, thinking = true)
        assertNull(presence.sessions.value["other"])
    }

    @Test
    fun thinkingNeedsAnOnlineSession() {
        presence.reconcileSessions(listOf(ActivityRow("s", active = false, activeAt = 100)))
        presence.activity("s", active = false, activeAt = 200, thinking = true)
        assertEquals(false, presence.sessions.value["s"]!!.thinking)
        presence.setThinking("s", true)
        assertEquals(false, presence.sessions.value["s"]!!.thinking)
    }

    @Test
    fun aNewerStoredRowWinsAndAnOlderOneDoesNot() {
        presence.reconcileSessions(listOf(ActivityRow("s", active = true, activeAt = 100)))
        presence.activity("s", active = true, activeAt = 5_000, thinking = true)
        presence.reconcileSessions(listOf(ActivityRow("s", active = true, activeAt = 3_000)))
        assertEquals(true, presence.sessions.value["s"]!!.thinking)
        // Archived on another device: the row says offline, newer than the last heartbeat.
        presence.reconcileSessions(listOf(ActivityRow("s", active = false, activeAt = 6_000)))
        assertEquals(SessionPresence(active = false, activeAt = 6_000, thinking = false, thinkingAt = 50_000), presence.sessions.value["s"])
    }

    @Test
    fun rowsThatGoTakeTheirPresenceWithThem() {
        presence.reconcileSessions(listOf(ActivityRow("a", true, 1), ActivityRow("b", true, 1)))
        presence.reconcileSessions(listOf(ActivityRow("a", true, 1)))
        assertEquals(setOf("a"), presence.sessions.value.keys)
    }

    @Test
    fun machinesFlipAndStayQuietOtherwise() {
        presence.reconcileMachines(listOf(ActivityRow("m", active = true, activeAt = 100)))
        val before = presence.machines.value
        presence.machineActivity("m", active = true, activeAt = 20_000)
        assertSame(before, presence.machines.value)
        presence.machineActivity("m", active = false, activeAt = 30_000)
        assertEquals(MachinePresence(active = false, activeAt = 30_000), presence.machines.value["m"])
    }
}

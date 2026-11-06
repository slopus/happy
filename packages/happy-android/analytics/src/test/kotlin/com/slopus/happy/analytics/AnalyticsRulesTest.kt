package com.slopus.happy.analytics

import android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_CACHED
import android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
import android.app.ApplicationExitInfo
import com.slopus.happy.analytics.AnalyticsEvent.AgentConnectionLost
import com.slopus.happy.analytics.ConnectionIncidents.Link
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The catalog's "fires" rules: throttle, freshness and dedupe, incidents, app opens, exits. */
class AnalyticsRulesTest {
    @Test
    fun anErrorInALoopSendsOncePerWindowAndDropsTheRest() {
        val throttle = ErrorThrottle()
        val sent = (0 until 25).filter { throttle.occur(ErrorArea.ConversationLoad, ErrorCode.Offline, now = it * 60_000L) }
        // Minutes 0, 10 and 20 go; those in between are dropped, not counted.
        assertEquals(listOf(0, 10, 20), sent)
        // Another code is its own window.
        assertTrue(throttle.occur(ErrorArea.ConversationLoad, ErrorCode.Timeout, 1))
        assertFalse(throttle.occur(ErrorArea.ConversationLoad, ErrorCode.Timeout, 2))
    }

    @Test
    fun aFailureCountsOnceAndOnlyWhileFresh() {
        val seen = FailureExposures()
        val now = 1_800_000_000_000
        assertTrue(seen.shown("m1", createdAt = now - 60_000, now))
        assertFalse("seen again", seen.shown("m1", createdAt = now - 60_000, now + 1))
        assertFalse("older than five minutes", seen.shown("m2", createdAt = now - 5 * 60_000 - 1, now))
        assertFalse("no time", seen.shown("m3", createdAt = 0, now))
        assertTrue(seen.shown("m4", createdAt = now - 5 * 60_000, now))
    }

    @Test
    fun theSeenSetKeepsTheLast500() {
        val seen = FailureExposures()
        for (i in 0 until 501) assertTrue(seen.shown("m$i", 1_000, 1_000))
        assertEquals(500, seen.seen.size)
        assertEquals("m1", seen.seen.first())
        // m0 fell out, so it would count again; m1 still doesn't.
        assertFalse(seen.shown("m1", 1_000, 1_000))
        assertTrue(seen.shown("m0", 1_000, 1_000))
    }

    @Test
    fun anIncidentIsSentWhenItEndsAndOnlyAfterTenSeconds() {
        val sent = mutableListOf<AgentConnectionLost>()
        val incidents = ConnectionIncidents(sent::add)
        val up = Link("agent:a", LinkTransport.Direct, null)
        val down = Link("agent:a", LinkTransport.Direct, ConnectionCode.Unreachable)
        incidents.update(up, foreground = true, network = true, now = 0)
        incidents.update(down, true, true, 1_000)
        incidents.update(up, true, true, 9_000)
        assertEquals("a reconnect under 10 s", emptyList<AgentConnectionLost>(), sent)

        incidents.update(down, true, true, 20_000)
        incidents.update(down.copy(down = ConnectionCode.Revoked), true, true, 25_000)
        incidents.update(down, true, true, 26_000)
        incidents.update(up, true, true, 60_000)
        assertEquals(listOf(AgentConnectionLost(LinkTransport.Direct, ConnectionCode.Revoked, ConnectionOutcome.Recovered, DurationBucket.From30sTo2m)), sent)
    }

    @Test
    fun anIncidentEndsAsTheAppGoesBehindOrAnotherAccountOpens() {
        val sent = mutableListOf<AgentConnectionLost>()
        val incidents = ConnectionIncidents(sent::add)
        val relay = Link("happy:x", LinkTransport.Relay, ConnectionCode.Unreachable)
        incidents.update(relay, true, true, 0)
        incidents.update(relay, foreground = false, network = true, now = 12_000)
        // Behind, it doesn't start again.
        incidents.update(relay, false, true, 50_000)
        incidents.update(relay, true, true, 100_000)
        incidents.update(Link("agent:b", LinkTransport.Direct, null), true, true, 400_000)
        assertEquals(
            listOf(
                AgentConnectionLost(LinkTransport.Relay, ConnectionCode.Unreachable, ConnectionOutcome.Backgrounded, DurationBucket.From10sTo30s),
                AgentConnectionLost(LinkTransport.Relay, ConnectionCode.Unreachable, ConnectionOutcome.GaveUp, DurationBucket.From5mTo15m),
            ),
            sent,
        )
    }

    @Test
    fun noNetworkIsNotTheAgentsIncident() {
        val sent = mutableListOf<AgentConnectionLost>()
        val incidents = ConnectionIncidents(sent::add)
        val down = Link("agent:a", LinkTransport.Direct, ConnectionCode.Unreachable)
        incidents.update(down, true, network = false, now = 0)
        incidents.update(down, true, true, 5_000)
        incidents.update(down, true, false, 30_000)
        incidents.update(down.copy(down = null), true, true, 90_000)
        assertEquals(emptyList<AgentConnectionLost>(), sent)
    }

    @Test
    fun anOpenIsAColdStartOrABackAfterHalfAnHour() {
        val opens = AppOpens()
        assertEquals(true, opens.foreground(0))
        opens.background(1_000)
        assertNull(opens.foreground(1_000 + 29 * 60_000))
        opens.background(2_000_000)
        assertEquals(false, opens.foreground(2_000_000 + 30 * 60_000))
    }

    @Test
    fun aLaunchWithAnalyticsOffHasNoColdStartAndTimeOffIsntTimeAway() {
        val opens = AppOpens()
        opens.skip()
        assertNull(opens.foreground(0))
        opens.background(1_000)
        // Analytics went off behind, and on again an hour later in front.
        opens.pause()
        assertNull(opens.foreground(1_000 + 60 * 60_000))
    }

    @Test
    fun exitsThatCountAndThoseThatDont() {
        assertEquals(CrashReason.Crash, AppExits.reason(ApplicationExitInfo.REASON_CRASH, IMPORTANCE_CACHED))
        assertEquals(CrashReason.NativeCrash, AppExits.reason(ApplicationExitInfo.REASON_CRASH_NATIVE, IMPORTANCE_FOREGROUND))
        assertEquals(CrashReason.Hang, AppExits.reason(ApplicationExitInfo.REASON_ANR, IMPORTANCE_FOREGROUND))
        assertEquals(CrashReason.LaunchFailed, AppExits.reason(ApplicationExitInfo.REASON_INITIALIZATION_FAILURE, IMPORTANCE_FOREGROUND))
        assertEquals(CrashReason.Oom, AppExits.reason(ApplicationExitInfo.REASON_LOW_MEMORY, IMPORTANCE_FOREGROUND))
        assertNull("killed for memory in the background", AppExits.reason(ApplicationExitInfo.REASON_LOW_MEMORY, IMPORTANCE_CACHED))
        assertEquals(CrashReason.Killed, AppExits.reason(ApplicationExitInfo.REASON_SIGNALED, IMPORTANCE_FOREGROUND))
        assertNull(AppExits.reason(ApplicationExitInfo.REASON_USER_REQUESTED, IMPORTANCE_FOREGROUND))
        assertNull(AppExits.reason(ApplicationExitInfo.REASON_EXIT_SELF, IMPORTANCE_FOREGROUND))
        assertNull(AppExits.reason(ApplicationExitInfo.REASON_PACKAGE_UPDATED, IMPORTANCE_FOREGROUND))
    }

    @Test
    fun durationsAndBucketsAndVersions() {
        assertEquals(DurationBucket.Under10s, DurationBucket.of(9_999))
        assertEquals(DurationBucket.From10sTo30s, DurationBucket.of(10_000))
        assertEquals(DurationBucket.From15mTo1h, DurationBucket.of(900_000))
        assertEquals(DurationBucket.Over1h, DurationBucket.of(3_600_000))
        assertEquals(listOf("0", "1", "2", "3+", "3+"), listOf(0, 1, 2, 3, 9).map { Bucket.of(it).wire })
        assertEquals("15", AnalyticsDevice.osVersion("15"))
        assertEquals("8.1", AnalyticsDevice.osVersion("8.1.0"))
        assertNull(AnalyticsDevice.osVersion("Baklava"))
        assertEquals(FailureKind.Untyped, FailureKind.of(null))
        assertEquals(FailureKind.Other, FailureKind.of("quota_from_the_future"))
        assertEquals(FailureKind.Other, FailureKind.of("untyped"))
        assertEquals(ProviderKind.Other, ProviderKind.of("my-proxy"))
        assertNull(ProviderKind.of(""))
    }
}

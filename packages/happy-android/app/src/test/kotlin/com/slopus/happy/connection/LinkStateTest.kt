package com.slopus.happy.connection

import com.slopus.happy.connection.LinkState.Connecting
import com.slopus.happy.connection.LinkState.Online
import com.slopus.happy.connection.LinkState.Syncing
import com.slopus.happy.connection.LinkState.WaitingForNetwork
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.ui.conversation.linkState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The header's debounce on a made-up clock (iOS's LinkStateDebounceTests, in milliseconds). */
class LinkStateTest {
    @Test fun aShortWobbleNeverShows() {
        val d = LinkStateDebounce(wanted = Online, now = 0)
        assertEquals(10_800L, d.want(Connecting, 10_000))
        assertEquals(Online, d.shown)
        assertEquals("still counted from when it went", 10_800L, d.want(Syncing, 10_400))
        assertEquals(10_800L, d.settle(10_500))
        assertNull(d.want(Online, 10_790))
        assertNull(d.settle(10_800))
        assertEquals(Online, d.shown)
    }

    @Test fun connectingShowsAfter800AndHolds600() {
        val d = LinkStateDebounce(wanted = Online, now = 0)
        assertEquals(1_800L, d.want(Connecting, 1_000))
        assertNull(d.settle(1_800))
        assertEquals(Connecting, d.shown)
        assertEquals(2_400L, d.want(Online, 1_900))
        assertEquals(Connecting, d.shown)
        assertEquals(2_400L, d.settle(2_300))
        assertNull(d.settle(2_400))
        assertEquals(Online, d.shown)
    }

    @Test fun theDelayCountsFromLeavingOnline() {
        val d = LinkStateDebounce(wanted = Online, now = 0)
        d.want(Connecting, 5_000)
        d.want(Syncing, 5_500)
        assertNull(d.settle(5_800))
        assertEquals(Syncing, d.shown)
    }

    @Test fun waitingForNetworkShowsAtOnceOverAnyHold() {
        val d = LinkStateDebounce(wanted = Online, now = 0)
        assertNull(d.want(WaitingForNetwork, 3_000))
        assertEquals(WaitingForNetwork, d.shown)
        d.want(Connecting, 3_100)
        assertEquals("held", WaitingForNetwork, d.shown)
        assertNull(d.settle(3_600))
        assertEquals(Connecting, d.shown)
        assertNull(d.want(WaitingForNetwork, 3_700))
        assertEquals(WaitingForNetwork, d.shown)
    }

    @Test fun aMomentOfOnlineBetweenTwoStatusesNeverShowsTheTitle() {
        val d = LinkStateDebounce(wanted = Online, now = 0)
        d.want(Connecting, 0)
        d.settle(800)
        assertEquals(2_300L, d.want(Online, 2_000))
        assertEquals(Connecting, d.shown)
        assertNull(d.want(Syncing, 2_010))
        assertEquals(Syncing, d.shown)
    }

    @Test fun onlineThatStandsGivesTheTitleBack() {
        val d = LinkStateDebounce(wanted = Online, now = 0)
        d.want(Connecting, 0)
        d.settle(800)
        assertEquals(2_300L, d.want(Online, 2_000))
        assertEquals(2_300L, d.settle(2_200))
        assertNull(d.settle(2_300))
        assertEquals(Online, d.shown)
        assertEquals(3_300L, d.want(Syncing, 2_500))
        assertEquals(Online, d.shown)
    }

    @Test fun aHeldStatusMovesStraightToTheNext() {
        val d = LinkStateDebounce(wanted = Online, now = 0)
        d.want(Connecting, 0)
        d.settle(800)
        assertEquals(1_400L, d.want(Syncing, 1_000))
        assertEquals(1_400L, d.want(Online, 1_200))
        assertEquals(1_400L, d.want(Syncing, 1_300))
        assertNull(d.settle(1_400))
        assertEquals(Syncing, d.shown)
        assertEquals(2_000L, d.want(Online, 1_500))
        assertNull(d.settle(2_000))
        assertEquals(Online, d.shown)
    }

    @Test fun aLaunchShowsTheTitleUntilASlowConnectionSaysSo() {
        val d = LinkStateDebounce(wanted = Connecting, now = 100_000)
        assertEquals(Online, d.shown)
        assertEquals(100_800L, d.settle(100_500))
        assertNull(d.settle(100_800))
        assertEquals(Connecting, d.shown)
        val quick = LinkStateDebounce(wanted = Connecting, now = 100_000)
        quick.want(Online, 100_300)
        assertNull(quick.settle(101_000))
        assertEquals(Online, quick.shown)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun theFlowShowsWhatTheDebounceSays() = runTest {
        val link = MutableStateFlow(Online)
        val shown = mutableListOf<Pair<Long, LinkState>>()
        val job = launch { link.shownLinkState { currentTime }.collect { shown += currentTime to it } }
        runCurrent()
        link.value = Connecting
        advanceTimeBy(300); runCurrent()
        link.value = Online
        advanceTimeBy(2_000); runCurrent()
        link.value = Connecting
        advanceTimeBy(900); runCurrent()
        link.value = Online
        advanceTimeBy(1_000); runCurrent()
        job.cancel()
        assertEquals(listOf(0L to Online, 3_100L to Connecting, 3_700L to Online), shown)
    }

    // iOS LegacyLink.headerState: no network first, then the socket, then its catch-up.
    @Test fun aHappyAccountsLinkIsItsSocketItsCatchUpAndTheNetwork() {
        assertEquals(WaitingForNetwork, accountLinkState(connected = true, catchingUp = false, network = false))
        assertEquals(Connecting, accountLinkState(connected = false, catchingUp = true, network = true))
        assertEquals(Syncing, accountLinkState(connected = true, catchingUp = true, network = true))
        assertEquals(Online, accountLinkState(connected = true, catchingUp = false, network = true))
    }

    @Test fun anAgentsLinkSaysOfflineOnItsOwn() {
        assertEquals(WaitingForNetwork, AgentLinkStatus.Offline.linkState(syncing = false, network = false))
        assertEquals(Connecting, AgentLinkStatus.Connecting.linkState(syncing = false, network = true))
        assertEquals(Syncing, AgentLinkStatus.Connected.linkState(syncing = true, network = true))
        // Reading the snapshot before the stream opens: it answered, and the phone is catching up.
        assertEquals(Syncing, AgentLinkStatus.Connecting.linkState(syncing = true, network = true))
        assertEquals(Online, (null as AgentLinkStatus?).linkState(syncing = false, network = true))
        for (away in listOf(AgentLinkStatus.Offline, AgentLinkStatus.Revoked, AgentLinkStatus.UpdateRequired, AgentLinkStatus.SignInRequired)) {
            assertEquals(away.name, LinkState.Offline, away.linkState(syncing = false, network = true))
        }
    }

    @Test fun onlyTheLinkOnItsWaySpins() {
        assertEquals(listOf(Syncing, Connecting, WaitingForNetwork), LinkState.entries.filter { it.spins })
    }
}

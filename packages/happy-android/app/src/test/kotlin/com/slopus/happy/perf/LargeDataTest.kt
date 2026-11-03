package com.slopus.happy.perf

import com.slopus.happy.chat.ChatFeed
import com.slopus.happy.chat.ChatMessagesSource
import com.slopus.happy.chat.ChatPage
import com.slopus.happy.chat.ChatPresenceSource
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ChatSessionSource
import com.slopus.happy.chat.SessionPresenceState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.Settings
import com.slopus.happy.model.settings.LocalSettingsValues
import com.slopus.happy.ui.home.HomeListInputs
import com.slopus.happy.ui.home.HomeListModel
import com.slopus.happy.ui.home.deriveHomeList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.util.Collections

/**
 * The data side of large sessions: a 5000-message chat and a 500-session
 * home are derived off the thread that collects them, and stay well inside
 * a frame budget's order of magnitude. The bounds are loose on purpose (a
 * shared build host); they catch a quadratic, not a regression of a few ms.
 * The chat's are ratios between sizes, which a loaded host doesn't move.
 */
class LargeDataTest {
    private fun millis(block: () -> Unit): Long {
        val start = System.nanoTime()
        block()
        return (System.nanoTime() - start) / 1_000_000
    }

    /** The fastest of [runs]: what the work costs, without what else the host was doing. */
    private fun fastest(runs: Int = 3, block: () -> Unit): Long = (1..runs).minOf { millis(block) }

    @Test
    fun aFiveThousandMessageChatReducesInLinearTime() {
        val records = LargeSessions.records("s", 8_000)
        // Warm the JIT on a smaller run first.
        ChatReduction().apply(ChatPage(records.take(2_000)), null)
        lateinit var rows: List<ChatRow>
        rows = ChatReduction().apply(ChatPage(records), null).rows
        assertEquals(800, rows.count { (it as? ChatRow.Tool)?.message?.children?.isNotEmpty() == true })
        // Linear: four times the records take about four times as long, where a quadratic takes sixteen.
        // Within the old wall-clock bound, or else compared with each other, which a loaded host slows alike.
        val quarter = fastest { ChatReduction().apply(ChatPage(records.take(2_000)), null) }
        val full = fastest { ChatReduction().apply(ChatPage(records), null) }
        assertTrue("8000 records in $full ms, 2000 in $quarter ms", full < 3_000 || full < 10 * maxOf(quarter, 1))

        // Live messages one at a time: a pass over four times the history costs about four times as much
        // (it reads the page it is given), not sixteen.
        fun appends(base: Int): Long {
            val reduction = ChatReduction()
            var list = records.take(base)
            reduction.apply(ChatPage(list), null)
            return millis {
                for (record in records.subList(base, base + 100)) {
                    list = list + record
                    reduction.apply(ChatPage(list), null)
                }
            }
        }
        appends(1_250)
        val small = (1..3).minOf { appends(1_250) }
        val large = (1..3).minOf { appends(5_000) }
        assertTrue("100 live messages over 5000 in $large ms, over 1250 in $small ms", large < 3_000 || large < 12 * maxOf(small, 1))
    }

    @Test
    fun fiveHundredSessionsDeriveTheHomeListQuickly() {
        val snapshot = LargeSessions.home(500)
        val zone = ZoneId.of("UTC")
        val today = LocalDate.of(2026, 10, 16)
        deriveHomeList(HomeListInputs(snapshot, SessionListGrouping.Flat, false, emptySet(), emptySet(), emptySet()), zone, today)
        for (grouping in SessionListGrouping.entries) {
            val took = millis {
                deriveHomeList(HomeListInputs(snapshot, grouping, false, emptySet(), emptySet(), emptySet()), zone, today)
            }
            assertTrue("$grouping in $took ms", took < 500)
        }
    }

    @Test
    fun theChatFeedReducesOffTheCollectingThread() = runBlocking {
        val collector = Thread.currentThread()
        val threads = Collections.synchronizedSet(HashSet<Thread>())
        val records = LargeSessions.records("s", 5_000)
        val feed = ChatFeed(
            messages = object : ChatMessagesSource {
                // Upstream of the feed's flowOn: it runs where the reduction runs.
                override fun messages(sessionId: String): Flow<ChatPage> =
                    flowOf(ChatPage(records)).onEach { threads += Thread.currentThread() }
                override suspend fun loadOlder(sessionId: String) = false
            },
            sessions = object : ChatSessionSource {
                override fun session(sessionId: String): Flow<SessionRecord?> = flowOf(null)
            },
            presence = object : ChatPresenceSource {
                override fun presence(sessionId: String): Flow<SessionPresenceState?> = flowOf(null)
            },
        )
        val state = withTimeout(10_000) { feed.state("s").first { it.snapshot.rows.isNotEmpty() } }
        assertTrue(state.snapshot.rows.size > 1_000)
        assertTrue("reduced on ${threads.map { it.name }}", threads.isNotEmpty() && collector !in threads)
    }

    @Test
    fun theHomeListDerivesOffTheCollectingThread() = runBlocking {
        val collector = Thread.currentThread()
        val threads = Collections.synchronizedSet(HashSet<Thread>())
        val scope = CoroutineScope(SupervisorJob())
        try {
            val model = HomeListModel(
                snapshots = flowOf(LargeSessions.home(500)).onEach { threads += Thread.currentThread() },
                settings = flowOf(Settings()),
                localSettings = flowOf(LocalSettingsValues()),
                unreadSessionIds = flowOf(emptySet()),
                archivingSessionIds = flowOf(emptySet()),
                scope = scope,
            )
            val state = withTimeout(10_000) { model.state.filterNotNull().first() }
            assertTrue(state.rows.size > 400)
            assertTrue("derived on ${threads.map { it.name }}", threads.isNotEmpty() && collector !in threads)
        } finally {
            scope.cancel()
        }
    }
}

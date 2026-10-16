package com.slopus.happy.perf

import com.slopus.happy.chat.ChatPage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.WorkGroupExpansion
import com.slopus.happy.chat.chatListItems
import com.slopus.happy.chat.groupChatRowsForDisplay
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The display passes ChatList runs in composition on every snapshot, at
 * 5040 rows. Measured at 0.2-2.6 ms each (median after warm-up), so they
 * stay on the main thread; past 50 ms one has gone quadratic.
 */
class ChatDisplayTimingTest {
    private fun median(runs: Int, block: () -> Unit): Double {
        val times = (1..runs).map {
            val start = System.nanoTime()
            block()
            (System.nanoTime() - start) / 1_000_000.0
        }
        return times.sorted()[runs / 2]
    }

    @Test
    fun displayPassesOverFiveThousandRowsStayLinear() {
        var rows: List<ChatRow> = ChatReduction().apply(ChatPage(LargeSessions.records("s", 7_200)), null).rows
        if (rows.first().message.createdAt < rows.last().message.createdAt) rows = rows.reversed()
        val expansion = WorkGroupExpansion().observed("s", true, rows, true)
        repeat(50) {
            chatListItems(groupChatRowsForDisplay(rows, true, true), expansion::isExpanded)
            chatListItems(groupChatRowsForDisplay(rows, true, true)) { true }
        }
        val items = groupChatRowsForDisplay(rows, true, true)
        val group = median(41) { groupChatRowsForDisplay(rows, true, true) }
        val flat = median(41) { groupChatRowsForDisplay(rows, false, true) }
        val folded = median(41) { chatListItems(items, expansion::isExpanded) }
        val open = median(41) { chatListItems(items) { true } }
        val observed = median(41) { WorkGroupExpansion().observed("s", true, rows, false) }
        val report = "rows=${rows.size} group=$group flat=$flat listFolded=$folded listOpen=$open observed=$observed"
        println(report)
        assertTrue(report, rows.size >= 5_000)
        for (took in listOf(group, flat, folded, open, observed)) assertTrue(report, took < 50.0)
    }
}

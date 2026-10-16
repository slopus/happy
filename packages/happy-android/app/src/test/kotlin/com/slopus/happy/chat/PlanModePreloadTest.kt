package com.slopus.happy.chat

import com.slopus.happy.data.MessageRecord
import com.slopus.happy.sync.StoredMessages
import com.slopus.happy.sync.StoredSource
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/** sync.preload.test.ts: a preloaded EnterPlanMode waits for the chat to open, and then counts once. */
class PlanModePreloadTest {
    private val entered = mutableListOf<String>()
    private var mode: String? = "default"
    private val follower = PlanModeFollower(permissionMode = { mode }) { entered += it }

    private fun call(seq: Long, name: String) = MessageRecord(
        "s", seq, "m$seq", null,
        """{"role":"agent","content":{"type":"session","data":{"id":"env-$seq","time":1,"role":"agent","turn":"t","ev":{"t":"tool-call-start","call":"c$seq","name":"$name","title":"$name","description":"","args":{}}}}}""",
        seq, seq,
    )

    private suspend fun preload(vararg names: String) =
        follower.onStored(StoredMessages("s", names.mapIndexed { i, name -> call(i + 1L, name) }, StoredSource.PRELOAD))

    private suspend fun opened() = follower.onStored(StoredMessages("s", emptyList(), StoredSource.OPENED))

    @Test
    fun aPreloadedPlanModeSwitchesOnlyWhenTheChatOpensAndOnlyOnce() = runTest {
        preload("Bash", "EnterPlanMode")
        assertEquals(emptyList<String>(), entered)
        opened()
        assertEquals(listOf("s"), entered)
        opened()
        assertEquals(listOf("s"), entered)
    }

    @Test
    fun aModeChosenSinceThePreloadWins() = runTest {
        preload("EnterPlanMode")
        mode = "yolo"
        opened()
        assertEquals(emptyList<String>(), entered)
    }

    @Test
    fun anExitPlanModeSinceThePreloadCancelsIt() = runTest {
        preload("EnterPlanMode")
        follower.onStored(StoredMessages("s", listOf(call(101, "ExitPlanMode"))))
        opened()
        assertEquals(emptyList<String>(), entered)
    }

    @Test
    fun aPreloadedReplayThatLeftPlanModeChangesNothing() = runTest {
        preload("EnterPlanMode", "ExitPlanMode")
        opened()
        assertEquals(emptyList<String>(), entered)
    }
}

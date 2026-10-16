package com.slopus.happy.chat

import com.slopus.happy.data.MessageRecord
import com.slopus.happy.sync.StoredMessages
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/** storage.ts applyMessages `shouldEnterPlanMode`, fed by MessageSync's stored batches. */
class PlanModeFollowerTest {
    private val entered = mutableListOf<String>()
    private val follower = PlanModeFollower { entered += it }

    private fun call(seq: Long, name: String) = MessageRecord(
        "s", seq, "m$seq", null,
        """{"role":"agent","content":{"type":"session","data":{"id":"env-$seq","time":1,"role":"agent","turn":"t","ev":{"t":"tool-call-start","call":"c$seq","name":"$name","title":"$name","description":"","args":{}}}}}""",
        seq, seq,
    )

    @Test
    fun aBatchEndingInPlanModeSwitchesTheSession() = runTest {
        follower.onStored(StoredMessages("s", listOf(call(1, "EnterPlanMode"))))
        assertEquals(listOf("s"), entered)
    }

    @Test
    fun aReplayThatLeavesPlanModeChangesNothing() = runTest {
        follower.onStored(StoredMessages("s", listOf(call(1, "EnterPlanMode"), call(2, "ExitPlanMode"))))
        follower.onStored(StoredMessages("s", listOf(call(3, "Bash"))))
        assertEquals(emptyList<String>(), entered)
    }
}

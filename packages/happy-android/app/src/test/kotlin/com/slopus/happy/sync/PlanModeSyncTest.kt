package com.slopus.happy.sync

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** sync.ts applyMessages: a live EnterPlanMode switches the session to plan. */
@RunWith(AndroidJUnit4::class)
class PlanModeSyncTest {
    private lateinit var h: AccountHarness
    private val server get() = h.server

    @Before
    fun setUp() {
        h = AccountHarness()
        server.addSession("s1", updatedAt = 100)
    }

    @After
    fun tearDown() = h.close()

    private fun call(n: Int, name: String) = Json.parseToJsonElement(
        """{"role":"agent","content":{"type":"session","data":{"id":"env-$n","time":1,"role":"agent","turn":"t","ev":{"t":"tool-call-start","call":"c$n","name":"$name","title":"$name","description":"","args":{}}}}}""",
    ) as JsonObject

    private fun permissionMode() = h.account.composer.mirrors.value["s1"]?.permissionMode

    @Test
    fun aLiveEnterPlanModeSwitchesTheSessionToPlan() {
        server.appendMessage("s1", call(1, "Bash"))
        h.startAndSync()
        eventually { h.store.messages("s1").size == 1 }
        assertEquals(null, permissionMode())

        val message = server.appendMessage("s1", call(2, "EnterPlanMode"))
        server.emitUpdate(server.newMessageBody("s1", message))

        eventually(message = "plan mode") { permissionMode() == "plan" }
    }

    @Test
    fun historyThatLeftPlanModeLeavesTheModeAlone() {
        server.appendMessage("s1", call(1, "EnterPlanMode"))
        server.appendMessage("s1", call(2, "ExitPlanMode"))
        h.startAndSync()
        eventually { h.store.messages("s1").size == 2 }
        Thread.sleep(100)
        assertEquals(null, permissionMode())
    }
}

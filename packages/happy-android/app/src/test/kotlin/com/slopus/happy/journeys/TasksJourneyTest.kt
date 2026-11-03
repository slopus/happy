package com.slopus.happy.journeys

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.sync.rigMetadataJson
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * happy-ios 36b11c5bf on the Happy CLI home: a computer's tasks list after
 * its bots; the long press offers Leave task and Archive task where the task
 * allows them; leaving takes the row at once and only through `leaveTask`,
 * and a machine that says no brings it back with its own words.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TasksJourneyTest {
    @get:Rule val rule = createComposeRule()

    private val journey = Journey()
    private val server = journey.server
    private lateinit var graph: AppGraph

    @After
    fun tearDown() = journey.close()

    private fun dialogButton(text: String) = rule.onNode(hasText(text) and hasClickAction() and hasAnyAncestor(isDialog()))

    private fun task(id: String, name: String, orderKey: String) = server.addSession(
        id,
        updatedAt = 100,
        metadata = buildJsonObject {
            rigMetadataJson(rpcMethods = listOf("leaveTask"), machineId = Journey.MACHINE).forEach { (key, value) -> put(key, value) }
            put("path", "/h/Tasks/$id")
            putJsonObject("task") {
                put("id", "t-$id"); put("name", name); put("folderName", id); put("orderKey", orderKey); put("canArchive", true)
            }
        },
    )

    @Test
    fun aComputersTasksAreListedAndLeftThroughTheirMachine() {
        journey.machine()
        journey.session("s0", updatedAt = 100, title = "Existing chat")
        task("t1", "Release notes", "a")
        task("t2", "Triage", "b")
        val left = journey.rpc("t1", "leaveTask") { buildJsonObject { put("success", true) } }
        journey.rpc("t2", "leaveTask") { buildJsonObject { put("success", false); put("error", "Only members can leave") } }
        graph = journey.graph()
        journey.signIn(graph)
        graph.settings.change { it.copy(sessionListGrouping = SessionListGrouping.Project) }
        rule.setContent { HappyApp(graph) }
        // The phone's inset cards: the tasks are a card of their own (no heading, as the bots' has none).
        rule.waitForText("Release notes")

        rule.onNode(hasText("Release notes"), useUnmergedTree = true).performTouchInput { longClick() }
        rule.waitUntilAtLeastOneExists(hasText("Leave task") and hasAnyAncestor(isDialog()), 5_000)
        rule.onNode(hasText("Archive task") and hasAnyAncestor(isDialog())).assertExists()
        dialogButton("Leave task").performClick()
        rule.waitUntil(10_000) { left.isNotEmpty() }
        rule.waitUntilDoesNotExist(hasText("Release notes"), 5_000)
        // Never a server archive or delete.
        assertEquals(0, server.requestsTo("/v1/sessions/t1/archive").size)

        rule.onNode(hasText("Triage"), useUnmergedTree = true).performTouchInput { longClick() }
        rule.waitUntilAtLeastOneExists(hasText("Leave task") and hasAnyAncestor(isDialog()), 5_000)
        dialogButton("Leave task").performClick()
        rule.waitForText("Only members can leave")
        rule.onNode(hasText("Triage"), useUnmergedTree = true).assertExists()
    }
}

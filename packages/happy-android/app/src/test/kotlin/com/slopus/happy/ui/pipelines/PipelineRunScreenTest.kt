package com.slopus.happy.ui.pipelines

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.pipelines.PipelineAbort
import com.slopus.happy.pipelines.PipelineDefinition
import com.slopus.happy.pipelines.PipelineEdge
import com.slopus.happy.pipelines.PipelineFailure
import com.slopus.happy.pipelines.PipelineLogEntry
import com.slopus.happy.pipelines.PipelineModelUsage
import com.slopus.happy.pipelines.PipelineNodeDefinition
import com.slopus.happy.pipelines.PipelineNodeKind
import com.slopus.happy.pipelines.PipelineNodeLog
import com.slopus.happy.pipelines.PipelineNodeRun
import com.slopus.happy.pipelines.PipelineNodeState
import com.slopus.happy.pipelines.PipelineRun
import com.slopus.happy.pipelines.PipelineRunEntry
import com.slopus.happy.pipelines.PipelineRunRelative
import com.slopus.happy.pipelines.PipelineRunState
import com.slopus.happy.pipelines.PipelineRunTrigger
import com.slopus.happy.pipelines.PipelineRunView
import com.slopus.happy.pipelines.PipelineStatusLine
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** A run's page and a node's page: what they say, the order of the nodes, Abort, the log's rows and their sizes. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class PipelineRunScreenTest {
    @get:Rule val rule = createComposeRule()

    private val now = 1_800_000_000_000L
    private val second = 1_000L

    private fun node(
        id: String,
        state: PipelineNodeState,
        kind: PipelineNodeKind = PipelineNodeKind.Code,
        startedAgo: Long? = null,
        took: Long? = null,
        status: PipelineStatusLine? = null,
        failure: PipelineFailure? = null,
        child: String? = null,
        usage: List<PipelineModelUsage>? = null,
    ) = PipelineNodeRun(
        id, kind, state, status, listOfNotNull(status), null, null, failure, null, child,
        startedAt = startedAgo?.let { now - it }, endedAt = took?.let { now - startedAgo!! + it }, usage = usage,
    )

    private val definition = PipelineDefinition(
        "build",
        listOf(
            PipelineNodeDefinition("triage", PipelineNodeKind.Agent, "anthropic/claude-sonnet-5", null, emptySet()),
            PipelineNodeDefinition("deploy", PipelineNodeKind.Code, null, null, emptySet()),
            PipelineNodeDefinition("test", PipelineNodeKind.Pipeline, null, "p-tests", emptySet()),
            PipelineNodeDefinition("build", PipelineNodeKind.Code, null, null, emptySet()),
        ),
        listOf(PipelineEdge("build", "test", true), PipelineEdge("test", "deploy", true), PipelineEdge("build", "triage", false), PipelineEdge("deploy", "triage", false)),
    )

    private fun run(state: PipelineRunState, nodes: List<PipelineNodeRun>, endedAgo: Long? = null) = PipelineRun(
        PipelineRunEntry("r1", 3, state, PipelineRunTrigger.Agent("a1"), null, createdAt = now - 95 * second, startedAt = now - 93 * second, endedAt = endedAgo?.let { now - it }),
        "p-deploy", "r1", null, null, null, nodes, emptyList(), nodes.mapNotNull { it.childRunId },
    )

    private val running = PipelineRunView(
        loading = false,
        pipelineName = "Deploy production",
        definition = definition,
        run = run(
            PipelineRunState.Running,
            listOf(
                node("build", PipelineNodeState.Succeeded, startedAgo = 90 * second, took = 14 * second),
                node("test", PipelineNodeState.Running, PipelineNodeKind.Pipeline, startedAgo = 75 * second, status = PipelineStatusLine("Waiting for Run tests", 0.4f, now), child = "r2"),
            ),
        ),
        relatives = mapOf("r2" to PipelineRunRelative("r2", "p-tests", "Run tests", 7, PipelineRunState.Running, now - 74 * second, null)),
    )

    private val agents = AgentNames { mapOf("a1" to "Release bot")[it] }

    @Test
    fun aRunningRunInGraphOrderWithItsChildAndAbortBehindAConfirmation() {
        val opened = mutableListOf<String>()
        var aborts = 0
        rule.setHappyContent {
            PipelineRunScreen(running, agents, onRetry = {}, onAbort = { aborts++ }, onBack = {}, onOpenNode = { opened += "node:$it" }, onOpenRun = { opened += "run:$it" }, now = now)
        }
        rule.onNodeWithText("Deploy production").assertIsDisplayed()
        rule.node(PipelineRunTags.DURATION).assertTextEquals("1m 33s")
        rule.onNodeWithText("Release bot").assertIsDisplayed()
        // Graph order, not the definition's: build, test, deploy, then triage on deploy's failure.
        val tops = listOf("build", "test", "deploy", "triage").map { rule.node(PipelineRunTags.node(it)).bounds.top }
        assertEquals(tops.sorted(), tops)
        rule.onNodeWithText("Waiting for Run tests · 40%").assertIsDisplayed()
        rule.node(PipelineRunTags.nodeState("deploy")).assertTextEquals("Waiting")
        rule.node(PipelineRunTags.nodeDuration("build")).assertTextEquals("14s")
        rule.node(PipelineRunTags.nodeDuration("deploy")).assertDoesNotExist()
        rule.node(PipelineRunTags.relative("r2")).performScrollTo().performClick()
        rule.node(PipelineRunTags.node("test")).performScrollTo().performClick()
        assertEquals(listOf("run:r2", "node:test"), opened)
        rule.node(PipelineRunTags.ABORT).performScrollTo().performClick()
        rule.onNodeWithText("Abort this run?").assertIsDisplayed()
        rule.onNodeWithText("Keep running").performClick()
        assertEquals(0, aborts)
        rule.node(PipelineRunTags.ABORT).performClick()
        rule.onNodeWithText("Abort").performClick()
        assertEquals(1, aborts)
    }

    @Test
    fun aFailedRunSaysWhyInWordsAndHasNoAbort() {
        val traceback = "Traceback (most recent call last):\n  File \"main.py\", line 14, in main\nRuntimeError: gradle exited 1"
        val failed = running.copy(
            run = run(
                PipelineRunState.Failed,
                listOf(
                    node("build", PipelineNodeState.Failed, startedAgo = 90 * second, took = 30 * second, failure = PipelineFailure("exception", traceback)),
                    node("test", PipelineNodeState.Skipped, PipelineNodeKind.Pipeline),
                    node("triage", PipelineNodeState.Succeeded, PipelineNodeKind.Agent, startedAgo = 59 * second, took = 20 * second, failure = PipelineFailure("tests_failed", "3 failed")),
                ),
                endedAgo = 39 * second,
            ),
            relatives = emptyMap(),
        )
        rule.setHappyContent { PipelineRunScreen(failed, agents, onRetry = {}, onAbort = {}, onBack = {}, onOpenNode = {}, onOpenRun = {}, now = now) }
        rule.node(PipelineRunTags.ABORT).assertDoesNotExist()
        rule.node(PipelineRunTags.DURATION).assertTextEquals("54s")
        rule.node(PipelineRunTags.nodeState("deploy")).assertTextEquals("Didn't run")
        rule.node(PipelineRunTags.nodeState("test")).assertTextEquals("Skipped")
        // The code in words, the node and the code, and the line a traceback ends with; an agent's own code reads as its words.
        rule.node(PipelineRunTags.failure("build")).performScrollTo()
        rule.onNode(hasText("Raised an exception") and hasTestTag(PipelineRunTags.failure("build"))).assertIsDisplayed()
        rule.onNodeWithText("build · exception\nRuntimeError: gradle exited 1").assertIsDisplayed()
        rule.node(PipelineRunTags.failure("triage")).performScrollTo()
        rule.onNode(hasText("Tests failed") and hasTestTag(PipelineRunTags.failure("triage"))).assertIsDisplayed()
    }

    @Test
    fun aNodeRowIsAnItemsHeight() {
        rule.setHappyContent { PipelineRunScreen(running, agents, onRetry = {}, onAbort = {}, onBack = {}, onOpenNode = {}, onOpenRun = {}, now = now) }
        val row = rule.node(PipelineRunTags.node("build")).bounds
        assertDp("16, a 24 ID over a 20 line, 16", 76, row.bottom - row.top)
        val child = rule.node(PipelineRunTags.relative("r2")).bounds
        assertDp("a child run's row too", 76, child.bottom - child.top)
    }

    @Test
    fun loadingThenMissingThenAFailedAbortSaysSo() {
        val shown = androidx.compose.runtime.mutableStateOf(PipelineRunView())
        rule.setHappyContent { PipelineRunScreen(shown.value, agents, onRetry = {}, onAbort = {}, onBack = {}, onOpenNode = {}, onOpenRun = {}, now = now) }
        rule.onNodeWithText("Loading run…").assertIsDisplayed()
        shown.value = PipelineRunView(loading = false, missing = true)
        rule.onNodeWithText("Run not found").assertIsDisplayed()
        rule.onNodeWithText("This server has no such run.").assertIsDisplayed()
        shown.value = running.copy(abort = PipelineAbort.Failed("Your role can't abort runs"))
        rule.onNodeWithText("The run was not aborted: Your role can't abort runs").assertIsDisplayed()
    }

    private val log = PipelineNodeLog(
        loading = false,
        entries = listOf(
            PipelineLogEntry.Status(1, now - 89 * second, "Checking out", null),
            PipelineLogEntry.Command(2, now - 88 * second, "sh-1", "git clone happy:app .", null, "builder", PipelineLogEntry.CommandState.Exited, 0, 840, "Cloning into '.'...\n", false),
            PipelineLogEntry.Command(3, now - 86 * second, "sh-2", "./gradlew assemble", null, null, PipelineLogEntry.CommandState.Exited, 1, 12_400, "BUILD FAILED\n", true),
            PipelineLogEntry.Output(4, now - 62 * second, true, "RuntimeError: gradle exited 1\n"),
            PipelineLogEntry.Tool(5, now - 61 * second, "fetch-1", "fetch", "https://status.acme.dev", PipelineLogEntry.ToolState.Error, 30_000, "Timed out"),
        ),
    )

    @Test
    fun aNodesLogReadsAsACiLog() {
        val failed = running.copy(
            run = run(
                PipelineRunState.Failed,
                listOf(node("build", PipelineNodeState.Failed, startedAgo = 90 * second, took = 30 * second, failure = PipelineFailure("exception", "Traceback\nRuntimeError: gradle exited 1"))),
                endedAgo = 50 * second,
            ),
        )
        rule.setHappyContent { PipelineNodeScreen(failed, "build", log, onRetry = {}, onBack = {}, onOpenRun = {}, now = now) }
        rule.onNodeWithText("Raised an exception").assertIsDisplayed()
        rule.node(PipelineNodeTags.FAILURE_MESSAGE).assertIsDisplayed()
        rule.node(PipelineNodeTags.LIST).performScrollToKey(2L)
        rule.node(PipelineNodeTags.gutter(2)).assertTextEquals("0:02")
        rule.node(PipelineNodeTags.commandState(2)).assertTextEquals("Exit 0")
        rule.node(PipelineNodeTags.commandState(3)).assertTextEquals("Exit 1")
        rule.onNodeWithText("840ms").assertIsDisplayed()
        // A command that passed starts folded; one that failed starts open, with the note that its output was cut.
        rule.node(PipelineNodeTags.commandOutput(2)).assertDoesNotExist()
        rule.node(PipelineNodeTags.commandOutput(3)).assertIsDisplayed()
        rule.onNodeWithText("Earlier output was cut; this is the last 64 KiB.").assertIsDisplayed()
        rule.node(PipelineNodeTags.commandHead(2)).performClick()
        rule.node(PipelineNodeTags.commandOutput(2)).assertIsDisplayed()
        rule.node(PipelineNodeTags.commandHead(3)).performClick()
        rule.node(PipelineNodeTags.commandOutput(3)).assertDoesNotExist()
        rule.node(PipelineNodeTags.LIST).performScrollToKey(5L)
        rule.onNodeWithText("Timed out").assertIsDisplayed()
    }

    @Test
    fun theLogsRowsSitInACardWithTheirGutter() {
        rule.setHappyContent { PipelineNodeScreen(running, "build", log, onRetry = {}, onBack = {}, onOpenRun = {}, now = now) }
        val first = rule.node(PipelineNodeTags.entry(1)).bounds
        assertDp("the card 16 in from the window, as an ItemGroup's", 16, first.left)
        assertDp("and 16 from its other side", 411 - 16, first.right)
        val gutter = rule.node(PipelineNodeTags.gutter(1)).bounds
        assertDp("the gutter 16 into the card", 32, gutter.left)
        assertDp("44 wide", 44, gutter.right - gutter.left)
        assertDp("the first row 12 below the card's top", 12, gutter.top - first.top)
    }

    @Test
    fun aNodeThatDidNothingSaysSo() {
        val skipped = running.copy(run = run(PipelineRunState.Failed, listOf(node("test", PipelineNodeState.Skipped, PipelineNodeKind.Pipeline)), endedAgo = 10 * second))
        rule.setHappyContent { PipelineNodeScreen(skipped, "test", PipelineNodeLog(loading = false), onRetry = {}, onBack = {}, onOpenRun = {}, now = now) }
        rule.onNodeWithText("This node was skipped; it did nothing.").assertIsDisplayed()
        rule.onNodeWithText("Runs Run tests").assertIsDisplayed()
    }
}

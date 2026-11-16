package com.slopus.happy.ui.pipelines

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.pipelines.PipelineRunEntry
import com.slopus.happy.pipelines.PipelineRunListEntry
import com.slopus.happy.pipelines.PipelineRunState
import com.slopus.happy.pipelines.PipelineRunSummary
import com.slopus.happy.pipelines.PipelineRunTrigger
import com.slopus.happy.pipelines.PipelineRuns
import com.slopus.happy.pipelines.PipelineSummary
import com.slopus.happy.pipelines.PipelinesList
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The Pipelines page: what it lists and says, and the sizes of its rows. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class PipelinesScreenTest {
    @get:Rule val rule = createComposeRule()

    private val now = 1_800_000_000_000L
    private val minute = 60_000L

    private fun run(
        id: String,
        state: PipelineRunState,
        startedAgo: Long?,
        took: Long? = null,
        trigger: PipelineRunTrigger? = PipelineRunTrigger.Agent("a1"),
        parent: String? = null,
        name: String = "Deploy",
        archived: Boolean = false,
    ) = PipelineRunListEntry(
        PipelineRunEntry(id, 3, state, trigger, parent, createdAt = now - (startedAgo ?: minute), startedAt = startedAgo?.let { now - it }, endedAt = took?.let { now - startedAgo!! + it }),
        "p-$name", name, archived,
    )

    private val agents = AgentNames { mapOf("a1" to "Release bot")[it] }

    private val state = PipelinesList(
        loading = false,
        pipelines = listOf(
            PipelineSummary("p1", "Deploy", null, 3, true, PipelineRunSummary("r1", PipelineRunState.Running, now - 2 * minute, null)),
            PipelineSummary("p2", "Nightly backup", null, 1, false, null),
        ),
        runs = PipelineRuns(
            loading = false,
            entries = listOf(
                run("r1", PipelineRunState.Running, startedAgo = 2 * minute + 5_000),
                run("r2", PipelineRunState.Running, startedAgo = minute, trigger = PipelineRunTrigger.Pipeline("r1", "test"), parent = "r1", name = "Run tests"),
                run("r3", PipelineRunState.Failed, startedAgo = 3 * 60 * minute, took = 72 * minute, trigger = PipelineRunTrigger.Agent(null)),
                run("r4", PipelineRunState.Queued, startedAgo = null, name = "Digest", archived = true),
            ),
            nextCursor = "r4",
        ),
    )

    @Test
    fun thePipelinesThenEveryRunNewestFirst() {
        val opened = mutableListOf<String>()
        var more = 0
        rule.setHappyContent { PipelinesScreen(state, agents, onRetry = {}, onMore = { more++ }, onBack = {}, onOpenRun = { opened += it }, now = now) }
        rule.onNodeWithText("Nightly backup").assertIsDisplayed()
        rule.onNodeWithText("v1 · Disabled").assertIsDisplayed()
        rule.onNodeWithText("Never run").assertIsDisplayed()
        rule.onNodeWithText("RUNS").assertIsDisplayed()
        // Who started each: the agent by home's name, a child by its parent run's pipeline and node.
        rule.onNodeWithText("v3 · Release bot · 2m").assertIsDisplayed()
        rule.onNodeWithText("v3 · From Deploy · test · 1m").assertIsDisplayed()
        rule.onNodeWithText("v3 · An agent · 3h").assertIsDisplayed()
        rule.onNodeWithText("v3 · Archived · Release bot · 1m").assertIsDisplayed()
        // How long each took, or has so far; a queued run hasn't started.
        rule.node(PipelinesTags.runDuration("r1")).assertTextEquals("2m 5s")
        rule.node(PipelinesTags.runDuration("r3")).assertTextEquals("1h 12m")
        rule.node(PipelinesTags.runDuration("r4")).assertDoesNotExist()
        // Only the child run wears the ↳.
        rule.node(PipelinesTags.child("r2")).assertIsDisplayed()
        rule.node(PipelinesTags.child("r1")).assertDoesNotExist()
        rule.node(PipelinesTags.run("r3")).performClick()
        rule.node(PipelinesTags.OLDER).performScrollTo().performClick()
        assertEquals(listOf("r3"), opened)
        assertEquals(1, more)
    }

    @Test
    fun aRunRowIsAnItemsHeight() {
        rule.setHappyContent { PipelinesScreen(state, agents, onRetry = {}, onMore = {}, onBack = {}, now = now) }
        val row = rule.node(PipelinesTags.run("r1")).bounds
        assertDp("16, a 24 title over a 20 line, 16", 76, row.bottom - row.top)
        val pipeline = rule.node(PipelinesTags.pipeline("p1")).bounds
        assertDp("a pipeline's row too", 76, pipeline.bottom - pipeline.top)
        val child = rule.node(PipelinesTags.child("r2")).bounds
        assertDp("the child's ↳ 16 in from the card's edge past the 32 glyph and its 12", 16 + 32 + 12, child.left - rule.node(PipelinesTags.run("r2")).bounds.left)
        assertDp("the ↳ is 16", 16, child.right - child.left)
    }

    @Test
    fun loadingThenFailedThenEmpty() {
        var retries = 0
        val shown = androidx.compose.runtime.mutableStateOf(PipelinesList())
        rule.setHappyContent { PipelinesScreen(shown.value, agents, onRetry = { retries++ }, onMore = {}, onBack = {}, now = now) }
        rule.onNodeWithText("Loading pipelines…").assertIsDisplayed()
        shown.value = PipelinesList(loading = false, failed = true)
        rule.node(PipelinesTags.RETRY).performClick()
        assertEquals(1, retries)
        shown.value = PipelinesList(loading = false)
        rule.onNodeWithText("No pipelines yet").assertIsDisplayed()
        rule.node(ItemGroupTags.FOOTER).assertIsDisplayed()
    }

    @Test
    fun aServerWithoutTheRunsListSaysWhereTheyAre() {
        rule.setHappyContent { PipelinesScreen(state.copy(runs = PipelineRuns(loading = false, listed = false)), agents, onRetry = {}, onMore = {}, onBack = {}, now = now) }
        rule.onNodeWithText("This server lists runs on each pipeline's own page.").assertIsDisplayed()
    }
}

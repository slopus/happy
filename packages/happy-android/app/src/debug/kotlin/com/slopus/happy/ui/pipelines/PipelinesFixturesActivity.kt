package com.slopus.happy.ui.pipelines

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.pipelines.PipelineRunEntry
import com.slopus.happy.pipelines.PipelineRunListEntry
import com.slopus.happy.pipelines.PipelineRunPage
import com.slopus.happy.pipelines.PipelineRunState
import com.slopus.happy.pipelines.PipelineRunSummary
import com.slopus.happy.pipelines.PipelineRunTrigger
import com.slopus.happy.pipelines.PipelineSummary
import com.slopus.happy.pipelines.PipelinesBackend
import com.slopus.happy.pipelines.PipelinesSource
import com.slopus.happy.ui.RetainedNavHost
import com.slopus.happy.ui.backdrop
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.connection.AgentHomeItem
import com.slopus.happy.ui.connection.AgentHomeList
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.page
import com.slopus.happy.ui.rememberNavMotion
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Debug builds only: the real Pipelines page over an in-memory Happy Cloud
 * server ([FakePipelines]), reached from a home card with the Pipelines
 * row under Plugins. A queued run starts after 8 s and the running one
 * succeeds after 20 s, each with the `pipeline.run.updated` a server
 * journals, so the page follows them as it would a real one. Start it with
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.pipelines.PipelinesFixturesActivity`
 * (`--ez pipelines.open true` to open the page at once).
 */
class PipelinesFixturesActivity : ComponentActivity() {
    @Serializable private data object FixtureHomeRoute

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val open = intent.getBooleanExtra("pipelines.open", false)
        setContent {
            HappyTheme {
                val nav = rememberNavController()
                val scope = rememberCoroutineScope()
                val events = remember { MutableSharedFlow<AgentEvent>(extraBufferCapacity = 8) }
                val backend = remember { FakePipelines(System.currentTimeMillis()) }
                val source = remember { PipelinesSource(backend, events, scope) }
                LaunchedEffect(Unit) {
                    delay(8_000)
                    backend.start("r-queued")
                    events.emit(AgentEvent(null, PipelinesSource.RUN_UPDATED, JsonObject(emptyMap())))
                    delay(12_000)
                    backend.finish("r-running")
                    events.emit(AgentEvent(null, PipelinesSource.RUN_UPDATED, JsonObject(emptyMap())))
                }
                val agents = AgentNames { mapOf("a-chief" to "Happy", "a-release" to "Release bot")[it] }
                ProvideWindowLayout {
                    RetainedNavHost(nav, if (open) PipelinesRoute("fixture") else FixtureHomeRoute, rememberNavMotion(), modifier = Modifier.backdrop(nav)) {
                        page<FixtureHomeRoute> {
                            Screen(header = { StackHeader("Acme", onBack = ::finish) }) {
                                AgentHomeList(
                                    items = listOf(
                                        AgentHomeItem.Gap(AgentFeedSection.Places, first = true),
                                        AgentHomeItem.Row(AgentFeedRow.Artifacts, first = true, last = false),
                                        AgentHomeItem.Row(AgentFeedRow.Plugins, first = false, last = false),
                                        AgentHomeItem.Row(AgentFeedRow.Pipelines, first = false, last = false),
                                        AgentHomeItem.Row(AgentFeedRow.Todos, first = false, last = true),
                                    ),
                                    state = rememberLazyListState(),
                                    onOpen = {},
                                    contentPadding = PaddingValues(),
                                    onOpenPipelines = { nav.navigate(PipelinesRoute("fixture")) },
                                )
                            }
                        }
                        pipelineRoutes(nav) { PagePipelines(source, agents) }
                    }
                }
            }
        }
    }
}

/** A team's pipelines in memory, answering after a short wait as a server would; 6 runs a page so Older runs shows. */
private class FakePipelines(private val now: Long) : PipelinesBackend {
    private val minute = 60_000L

    private fun run(id: String, pipeline: Pair<String, String>, state: PipelineRunState, ago: Long, took: Long?, trigger: PipelineRunTrigger?, parent: String? = null, version: Int = 3, archived: Boolean = false) =
        PipelineRunListEntry(
            PipelineRunEntry(
                id, version, state, trigger, parent,
                createdAt = now - ago,
                startedAt = if (state == PipelineRunState.Queued) null else now - ago + 2_000,
                endedAt = took?.let { now - ago + 2_000 + it },
            ),
            pipeline.first, pipeline.second, archived,
        )

    private val deploy = "p-deploy" to "Deploy production"
    private val email = "p-email" to "Incoming email"
    private val tests = "p-tests" to "Run tests"
    private val digest = "p-digest" to "Weekly digest"

    private val runs = mutableListOf(
        run("r-queued", deploy, PipelineRunState.Queued, 20_000, null, PipelineRunTrigger.Agent("a-release")),
        run("r-running", deploy, PipelineRunState.Running, 95_000, null, PipelineRunTrigger.Agent("a-release")),
        run("r-child", tests, PipelineRunState.Running, 80_000, null, PipelineRunTrigger.Pipeline("r-running", "test"), parent = "r-running", version = 7),
        run("r-email", email, PipelineRunState.Succeeded, 14 * minute, 48_000, PipelineRunTrigger.Agent("a-chief"), version = 12),
        run("r-failed", deploy, PipelineRunState.Failed, 3 * 60 * minute, 4 * minute + 12_000, PipelineRunTrigger.Agent(null)),
        run("r-aborted", email, PipelineRunState.Aborted, 26 * 60 * minute, 9_000, PipelineRunTrigger.Agent("a-chief"), version = 11),
        run("r-old-child", tests, PipelineRunState.Succeeded, 27 * 60 * minute, 2 * minute, PipelineRunTrigger.Pipeline("r-gone", "test"), parent = "r-gone", version = 6),
        run("r-archived", digest, PipelineRunState.Succeeded, 3 * 24 * 60 * minute, 61 * minute, PipelineRunTrigger.Agent("a-chief"), version = 2, archived = true),
        run("r-superseded", deploy, PipelineRunState.Superseded, 4 * 24 * 60 * minute, 30_000, PipelineRunTrigger.Agent("a-release"), version = 2),
    )

    fun start(id: String) = change(id) { it.copy(state = PipelineRunState.Running, startedAt = System.currentTimeMillis()) }

    fun finish(id: String) = change(id) { it.copy(state = PipelineRunState.Succeeded, endedAt = System.currentTimeMillis()) }

    private fun change(id: String, change: (PipelineRunEntry) -> PipelineRunEntry) {
        val at = runs.indexOfFirst { it.id == id }
        runs[at] = runs[at].copy(run = change(runs[at].run))
    }

    override suspend fun pipelines(): List<PipelineSummary> {
        delay(300)
        fun last(id: String) = runs.firstOrNull { it.pipelineId == id }?.run?.let { PipelineRunSummary(it.id, it.state, it.createdAt, it.endedAt) }
        return listOf(
            PipelineSummary(deploy.first, deploy.second, "Builds, tests and ships main.", 3, true, last(deploy.first)),
            PipelineSummary(email.first, email.second, null, 12, true, last(email.first)),
            PipelineSummary("p-nightly", "Nightly backup", null, 1, false, null),
            PipelineSummary(tests.first, tests.second, null, 7, true, last(tests.first)),
        )
    }

    override suspend fun runs(cursor: String?): PipelineRunPage<PipelineRunListEntry> {
        delay(400)
        val from = cursor?.let { id -> runs.indexOfFirst { it.id == id } } ?: 0
        val page = runs.drop(from).take(PAGE)
        return PipelineRunPage(page, runs.getOrNull(from + PAGE)?.id)
    }

    private companion object {
        const val PAGE = 6
    }
}

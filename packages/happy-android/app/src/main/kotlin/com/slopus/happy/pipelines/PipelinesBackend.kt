package com.slopus.happy.pipelines

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.long
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * A Happy Cloud server's pipelines, read only: the screens see this, and a
 * debug fixture passes its own. Every read throws on failure.
 */
interface PipelinesBackend {
    /** `GET /v0/pipelines`, by name. */
    suspend fun pipelines(): List<PipelineSummary>

    /**
     * `GET /v0/pipeline-runs`: every run of the team, newest first, from
     * [cursor] (the newest page when null). Null where the server doesn't
     * list runs across pipelines (`404`).
     */
    suspend fun runs(cursor: String?): PipelineRunPage<PipelineRunListEntry>?
}

/**
 * happy-cluster API.md, "Pipelines". The readers are desktop's
 * (`pipelineRead.ts`), checked against production answers: what isn't the
 * shape is left out rather than guessed at, a name the server leaves out is
 * the ID, and an agent trigger without its agent is still an agent's run.
 */
class ClusterPipelines(private val client: AgentClient) : PipelinesBackend {
    override suspend fun pipelines(): List<PipelineSummary> =
        summaries(client.decode<JsonObject>("GET", "/v0/pipelines")).sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })

    override suspend fun runs(cursor: String?): PipelineRunPage<PipelineRunListEntry>? = try {
        runList(client.decode<JsonObject>("GET", RUNS + (cursor?.let { "?cursor=${AgentClient.escape(it)}" } ?: "")))
    } catch (e: AgentApiException) {
        if (e.status == 404) null else throw e
    }

    internal companion object {
        const val RUNS = "/v0/pipeline-runs"

        private fun JsonElement?.text(): String? = str?.takeIf { it.isNotEmpty() }

        private fun runSummary(json: JsonElement?): PipelineRunSummary? {
            val run = json.obj ?: return null
            val id = run["id"].str ?: return null
            val state = PipelineRunState.of(run["state"].str) ?: return null
            return PipelineRunSummary(id, state, run["createdAt"].long ?: 0, run["endedAt"].long)
        }

        /** `{ pipelines: [...] }`; a pipeline without an ID or a head version is left out. */
        fun summaries(answer: JsonElement?): List<PipelineSummary> = answer.obj?.get("pipelines").arr.orEmpty().mapNotNull { element ->
            val pipeline = element.obj ?: return@mapNotNull null
            val id = pipeline["id"].str ?: return@mapNotNull null
            val head = pipeline["head"].obj?.get("number").num?.toInt() ?: return@mapNotNull null
            PipelineSummary(
                id = id,
                name = pipeline["name"].text() ?: id,
                description = pipeline["description"].text(),
                headVersion = head,
                enabled = pipeline["enabled"].bool != false,
                lastRun = runSummary(pipeline["lastRun"]),
            )
        }

        fun trigger(json: JsonElement?): PipelineRunTrigger? {
            val trigger = json.obj ?: return null
            return when (trigger["kind"].str) {
                // An agent the server no longer names (removed) is still an agent's run.
                "agent" -> PipelineRunTrigger.Agent(trigger["agentId"].text())
                "pipeline" -> {
                    val runId = trigger["runId"].str ?: return null
                    val nodeId = trigger["nodeId"].str ?: return null
                    PipelineRunTrigger.Pipeline(runId, nodeId)
                }
                else -> null
            }
        }

        fun runEntry(json: JsonElement?): PipelineRunEntry? {
            val run = json.obj ?: return null
            val id = run["id"].str ?: return null
            val state = PipelineRunState.of(run["state"].str) ?: return null
            val version = run["version"].num?.toInt() ?: return null
            return PipelineRunEntry(
                id = id,
                version = version,
                state = state,
                trigger = trigger(run["trigger"]),
                parentRunId = run["parentRunId"].text(),
                createdAt = run["createdAt"].long ?: 0,
                startedAt = run["startedAt"].long,
                endedAt = run["endedAt"].long,
            )
        }

        /** `{ runs: [...], nextCursor }` across pipelines, each entry with its `pipelineId`, `pipelineName` and `pipelineArchived`. */
        fun runList(answer: JsonElement?): PipelineRunPage<PipelineRunListEntry> {
            val page = answer.obj
            val runs = page?.get("runs").arr.orEmpty().mapNotNull { element ->
                val entry = runEntry(element) ?: return@mapNotNull null
                val json = element.obj ?: return@mapNotNull null
                val pipelineId = json["pipelineId"].str ?: return@mapNotNull null
                PipelineRunListEntry(entry, pipelineId, json["pipelineName"].text() ?: pipelineId, json["pipelineArchived"].bool == true)
            }
            return PipelineRunPage(runs, page?.get("nextCursor").text())
        }
    }
}

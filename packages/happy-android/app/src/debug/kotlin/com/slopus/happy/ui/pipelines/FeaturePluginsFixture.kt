package com.slopus.happy.ui.pipelines

import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.Feature
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.pipelines.PipelineDetail
import com.slopus.happy.pipelines.PipelineLogPage
import com.slopus.happy.pipelines.PipelineRun
import com.slopus.happy.pipelines.PipelineRunEntry
import com.slopus.happy.pipelines.PipelineRunListEntry
import com.slopus.happy.pipelines.PipelineRunPage
import com.slopus.happy.pipelines.PipelineSummary
import com.slopus.happy.pipelines.PipelineVersion
import com.slopus.happy.pipelines.PipelineVersionDetail
import com.slopus.happy.pipelines.PipelinesBackend
import com.slopus.happy.pipelines.PipelinesTurnedOff
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The fixture server's plugin and feature routes, on the wire as
 * happy-cluster answers them ("Plugins", "Feature plugins"), so the real
 * `ClusterPlugins` and `ClusterFeatures` read them: GitHub, an integration
 * the person's role can't install, and Pipelines, a feature plugin every
 * member installs and uninstalls for themselves. A change journals
 * `plugins.changed` and `features.updated` ([journal]); [change] is another
 * of the person's apps doing it, [quiet] without the events reaching this
 * one (its next pipeline read is refused instead).
 */
internal class FeaturePluginsServer(private val journal: (AgentEvent) -> Unit) : Transport {
    @Volatile var installed = true
        private set

    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
        delay(250)
        fun answer(status: Int, text: String) = TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        return when ("$method $path") {
            "GET /v0/features" -> answer(200, """{"features":[{"id":"pipelines","available":$installed}]}""")
            "GET /v0/plugins" -> answer(200, """{"plugins":[$GITHUB,${pipelines()}]}""")
            "GET /v0/plugins/installations" -> answer(403, """{"error":"This needs the mcp.manage permission.","code":"forbidden"}""")
            "POST /v0/plugins/installations" -> {
                val plugin = body?.let { Json.parseToJsonElement(String(it)).jsonObject["plugin"]?.jsonPrimitive?.content }
                if (plugin != Feature.PIPELINES) return answer(403, """{"error":"This needs the mcp.manage permission.","code":"forbidden"}""")
                val was = installed
                change(true)
                answer(if (was) 200 else 201, """{"installation":$INSTALLATION}""")
            }
            "DELETE /v0/plugins/installations/pipelines" -> {
                if (!installed) return answer(404, """{"error":"Not found.","code":"not_found"}""")
                change(false)
                answer(200, """{"deleted":true,"secretsDeleted":0,"storageEntriesDeleted":0,"cleanedUpOutside":false}""")
            }
            else -> answer(404, """{"error":"Not found.","code":"not_found"}""")
        }
    }

    override suspend fun close() {}

    fun change(installed: Boolean, quiet: Boolean = false) {
        // Installing what is installed, or uninstalling what is not, journals neither.
        if (this.installed == installed) return
        this.installed = installed
        if (quiet) return
        journal(AgentEvent(null, "plugins.changed", Json.parseToJsonElement("""{"installationId":"pipelines"}""").jsonObject))
        journal(AgentEvent(null, Feature.UPDATED, Json.parseToJsonElement("""{"features":[{"id":"pipelines","available":$installed}]}""").jsonObject))
    }

    private fun pipelines() = """{"id":"pipelines","kind":"feature","installed":$installed,"name":"Pipelines","version":"1.0.0",
        "description":"Typed graphs of code and agent steps that agents create, run and watch.",
        "tools":[{"name":"run_pipeline","summary":"Starts a run of a pipeline."},{"name":"list_pipelines","summary":"Lists the team's pipelines."}],
        "auth":{"required":false,"methods":[]}}"""

    private companion object {
        const val GITHUB = """{"id":"github","kind":"integration","name":"GitHub","version":"2.1.0","description":"Repositories, issues and pull requests for your agents.",
            "tools":[{"name":"list_repos","summary":"Lists the repositories the installation can reach."}],
            "auth":{"required":true,"methods":[{"id":"token","type":"fields","label":"Personal access token","fields":[{"key":"token","label":"Token","required":true,"secret":true}]}]}}"""
        const val INSTALLATION = """{"id":"pipelines","plugin":"pipelines","pluginName":"Pipelines","kind":"feature","ordinal":1,"label":null,
            "status":"active","reason":null,"authMethod":null,"toolPrefix":"","available":true}"""
    }
}

/**
 * [backend]'s pipelines as the server serves them to a person without the
 * Pipelines plugin: every route refused, as `ClusterPipelines` reads its
 * `403 feature_not_installed` ([turnedOff], then [PipelinesTurnedOff]).
 */
internal class FeatureGatedPipelines(
    private val backend: PipelinesBackend,
    private val server: FeaturePluginsServer,
    private val turnedOff: () -> Unit,
) : PipelinesBackend {
    private suspend fun <T> gated(read: suspend () -> T): T {
        if (!server.installed) {
            turnedOff()
            throw PipelinesTurnedOff()
        }
        return read()
    }

    override suspend fun pipelines(): List<PipelineSummary> = gated { backend.pipelines() }
    override suspend fun runs(cursor: String?): PipelineRunPage<PipelineRunListEntry>? = gated { backend.runs(cursor) }
    override suspend fun run(runId: String): PipelineRun? = gated { backend.run(runId) }
    override suspend fun pipelineName(pipelineId: String): String? = gated { backend.pipelineName(pipelineId) }
    override suspend fun pipeline(pipelineId: String): PipelineDetail? = gated { backend.pipeline(pipelineId) }
    override suspend fun versions(pipelineId: String): List<PipelineVersion>? = gated { backend.versions(pipelineId) }
    override suspend fun version(pipelineId: String, number: Int): PipelineVersionDetail? = gated { backend.version(pipelineId, number) }
    override suspend fun pipelineRuns(pipelineId: String, cursor: String?): PipelineRunPage<PipelineRunEntry>? = gated { backend.pipelineRuns(pipelineId, cursor) }
    override suspend fun log(runId: String, nodeId: String, after: Long): PipelineLogPage? = gated { backend.log(runId, nodeId, after) }
    override suspend fun abort(runId: String) = gated { backend.abort(runId) }
}

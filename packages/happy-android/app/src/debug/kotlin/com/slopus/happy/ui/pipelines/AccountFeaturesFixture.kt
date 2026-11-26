package com.slopus.happy.ui.pipelines

import com.slopus.happy.agent.AccountFeature
import com.slopus.happy.agent.AccountFeaturesApi
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

/**
 * The account features routes of the fixture's in-memory server: one
 * feature, Pipelines. A change journals `account.features.updated` to the
 * person ([journal]); [change] is another of the person's apps changing it,
 * [quiet] without the event reaching this one (its next pipeline read is
 * refused instead).
 */
internal class FakeAccountFeatures(private val journal: (List<AccountFeature>) -> Unit) : AccountFeaturesApi {
    @Volatile var enabled = true
        private set

    private fun list() = listOf(AccountFeature(AccountFeature.PIPELINES, "Pipelines", enabled))

    override suspend fun features(): List<AccountFeature> {
        delay(300)
        return list()
    }

    fun change(enabled: Boolean, quiet: Boolean = false) {
        // Setting what it already is changes nothing and announces nothing.
        if (this.enabled == enabled) return
        this.enabled = enabled
        if (!quiet) journal(list())
    }

}

/**
 * [backend]'s pipelines as the server serves them to a person who turned
 * them off: every route refused, as [com.slopus.happy.pipelines.ClusterPipelines]
 * reads its `403 feature_not_installed` ([turnedOff], then [PipelinesTurnedOff]).
 */
internal class FeatureGatedPipelines(
    private val backend: PipelinesBackend,
    private val features: FakeAccountFeatures,
    private val turnedOff: () -> Unit,
) : PipelinesBackend {
    private suspend fun <T> gated(read: suspend () -> T): T {
        if (!features.enabled) {
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

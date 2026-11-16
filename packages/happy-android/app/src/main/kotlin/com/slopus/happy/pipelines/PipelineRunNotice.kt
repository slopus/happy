package com.slopus.happy.pipelines

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement

/**
 * A run's result as the cluster tells the agent that started it: a message's
 * `metadata.pipelineRun` (happy-cluster API.md, "Runs"). Drawn from this
 * alone; the run itself is read only when the notice is opened.
 */
@Immutable
data class PipelineRunNotice(
    val runId: String,
    val pipelineId: String,
    val pipelineName: String,
    /** Null where the cluster left it out. */
    val version: Int?,
    val state: PipelineRunState,
    /** Failed runs only: the failed nodes and their codes as the cluster wrote them (`build: exception`), shown as sent. */
    val summary: String?,
) {
    companion object {
        /** Null where it isn't one: no run, no pipeline, or a state this app doesn't know. */
        fun parse(json: JsonElement?): PipelineRunNotice? {
            val notice = json.obj ?: return null
            val runId = notice["runId"].str?.takeIf { it.isNotEmpty() } ?: return null
            val pipelineId = notice["pipelineId"].str?.takeIf { it.isNotEmpty() } ?: return null
            return PipelineRunNotice(
                runId = runId,
                pipelineId = pipelineId,
                pipelineName = notice["pipelineName"].str?.takeIf { it.isNotBlank() } ?: pipelineId,
                version = notice["version"].num?.toInt(),
                state = PipelineRunState.of(notice["state"].str) ?: return null,
                summary = notice["summary"].str?.trim()?.takeIf { it.isNotEmpty() },
            )
        }
    }
}

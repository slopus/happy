package com.slopus.happy.genui

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.plugins.InstallationStatus
import com.slopus.happy.plugins.PluginInstallation
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** One installation a setup report names, as the server answered it. */
@Immutable
data class ReportedInstallation(val id: String, val label: String?, val toolPrefix: String?)

/** What the server took from a setup report: the plugin, its active installations, and the message it sent the origin agent. */
@Immutable
data class PluginReported(val pluginId: String?, val installations: List<ReportedInstallation>, val messageId: String?)

/** How the actions route answered a setup report. */
@Immutable
sealed interface PluginReportAnswer {
    /** `201`, or `200` for a retry or an element this person already reported: the element is done. */
    data class Reported(val reported: PluginReported) : PluginReportAnswer

    /** `409 not_set_up`: the server sees no active installation yet. Nothing changes; a later sighting sends again. */
    data object NotSetUp : PluginReportAnswer

    /** `404`, `409 no_origin` or any other refusal: this tap never reports. */
    data object Refused : PluginReportAnswer

    /** Unreachable, or the server failed: send again under the same ID. */
    data object Retry : PluginReportAnswer
}

/**
 * Telling a version's origin agent that the plugin a `plugin` element
 * opened is set up (happy-cluster API.md "Gen UI actions", plugin setup).
 * A tap only opens the plugin's page; when the page it opened sees an
 * active installation of that plugin, the element is submitted once, by
 * its render key alone: never the action or the plugin's ID.
 */
object GenUiPluginReport {
    /**
     * Whether a tap on a `plugin` element reports: only a version of an
     * artifact (not direct Gen UI) with a live [origin] agent, on a computer
     * whose health says both `plugins` and `artifactPluginActions`.
     */
    fun applies(capabilities: GenUiCapabilities, artifact: Boolean, origin: Boolean): Boolean =
        artifact && origin && capabilities.plugins && capabilities.artifactPluginActions

    /** Whether [installations] hold an active installation of [pluginId] (a Happy Cloud plugin's ID is its catalog key). */
    fun setUp(installations: List<PluginInstallation>, pluginId: String): Boolean =
        installations.any { it.pluginKey == pluginId && it.status == InstallationStatus.Active }

    fun path(artifactId: String, version: Int, escape: (String) -> String): String = "/v0/artifacts/${escape(artifactId)}/versions/$version/actions"

    /** The report: the submission [id], the same on every retry, and the element's render key. No `secret`. */
    fun body(id: String, element: String): JsonObject = buildJsonObject {
        put("id", id)
        put("element", element)
    }

    /** The route's answer: its [status], an error's [code], and its [body]. */
    fun answer(status: Int, code: String?, body: JsonElement?): PluginReportAnswer = when {
        status in 200..299 -> PluginReportAnswer.Reported(reported(body))
        status == 409 && code == "not_set_up" -> PluginReportAnswer.NotSetUp
        status == 408 || status == 429 || status >= 500 -> PluginReportAnswer.Retry
        else -> PluginReportAnswer.Refused
    }

    /** A `200`/`201` body, read tolerantly: the server took the report whatever it says beside. */
    fun reported(body: JsonElement?): PluginReported {
        val o = body.obj
        return PluginReported(
            pluginId = o?.get("pluginId").str,
            installations = o?.get("installations").arr.orEmpty().mapNotNull { e ->
                val i = e.obj ?: return@mapNotNull null
                ReportedInstallation(i["id"].str ?: return@mapNotNull null, i["label"].str, i["toolPrefix"].str)
            },
            messageId = o?.get("messageId").str,
        )
    }
}

/**
 * One tapped `plugin` element's report, from the tap until it is done:
 * [submission] is made once and sent on every attempt, at most one attempt
 * runs at a time, and once the server took it (or refused it for good)
 * nothing is sent again.
 */
class PluginReportRun(val artifactId: String, val version: Int, val element: String, val pluginId: String, val submission: String) {
    private var sending = false

    /** Taken or refused for good. */
    var finished = false
        private set

    /** Whether the server took it, so the element is marked done. */
    var reported = false
        private set

    /** The page saw [installations]: whether to send now (set up, not done, not on its way). */
    @Synchronized
    fun seen(installations: List<PluginInstallation>): Boolean = GenUiPluginReport.setUp(installations, pluginId) && start()

    /** A retry after [PluginReportAnswer.Retry]: whether to send now. */
    @Synchronized
    fun resend(): Boolean = start()

    private fun start(): Boolean {
        if (finished || sending) return false
        sending = true
        return true
    }

    /** The attempt ended with [answer]: whether to send again later (a [PluginReportAnswer.Retry]). */
    @Synchronized
    fun answered(answer: PluginReportAnswer): Boolean {
        sending = false
        when (answer) {
            is PluginReportAnswer.Reported -> {
                finished = true
                reported = true
            }
            PluginReportAnswer.Refused -> finished = true
            PluginReportAnswer.NotSetUp, PluginReportAnswer.Retry -> Unit
        }
        return answer == PluginReportAnswer.Retry
    }
}

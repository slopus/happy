package com.slopus.happy.ui.genui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.genui.GenUiCapabilities
import com.slopus.happy.genui.GenUiPluginReport
import com.slopus.happy.genui.PluginReportAnswer
import com.slopus.happy.genui.PluginReportRun
import com.slopus.happy.plugins.PluginInstallation
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.Collections
import java.util.WeakHashMap

/**
 * A computer's plugin setup reports (happy-cluster API.md "Gen UI
 * actions"): whether it takes them at all, health's
 * `capabilities.artifactPluginActions` (never probed), and sending one
 * through the artifact's actions route.
 */
class GenUiPluginReportApi(private val client: AgentClient) {
    private var capable by mutableStateOf(capability[client])

    /** Whether health said `artifactPluginActions`; observable, false until [check] has heard. */
    val served: Boolean get() = capable == true

    /** Whether health said it doesn't take reports; false while it hasn't answered. */
    val refused: Boolean get() = capable == false

    /** The computer's client, which a version's shared [GenUiState] is kept by. */
    internal val computer: Any get() = client

    /** Asks the computer's health once per connection; unanswered, it stays off and is asked again next time. */
    suspend fun check() {
        if (capable != null) return
        val flag = try {
            val capabilities = client.health()["capabilities"] as? JsonObject
            (capabilities?.get("artifactPluginActions") as? JsonPrimitive)?.takeIf { !it.isString }?.content == "true"
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return
        }
        capability[client] = flag
        capable = flag
    }

    /** Sends [run] once; an unreachable computer or a failed answer is [PluginReportAnswer.Retry]. */
    suspend fun submit(run: PluginReportRun): PluginReportAnswer = try {
        val answer = client.send("POST", GenUiPluginReport.path(run.artifactId, run.version, AgentClient::escape), GenUiPluginReport.body(run.submission, run.element))
        GenUiPluginReport.answer(answer.status, null, runCatching { AgentClient.json.parseToJsonElement(answer.text) }.getOrNull())
    } catch (e: CancellationException) {
        throw e
    } catch (e: AgentApiException) {
        GenUiPluginReport.answer(e.status, e.code, e.body)
    } catch (_: Exception) {
        PluginReportAnswer.Retry
    }

    companion object {
        /** What each computer's health said of `artifactPluginActions`, for as long as its client lives. */
        private val capability: MutableMap<AgentClient, Boolean> = Collections.synchronizedMap(WeakHashMap())
    }
}

/**
 * Every tapped `plugin` element's report waiting for its plugin to be set
 * up, for the process. A tap [begin]s one and hands its token to the
 * plugin page it opens; that page, while on the stack, tells [seen] what
 * it reads. Sending runs here, not in the page, so leaving the page
 * doesn't cut a report short. A second tap on an element that hasn't
 * reported reuses its run, and so its submission ID.
 */
object GenUiPluginReports {
    private class Entry(val api: GenUiPluginReportApi, val run: PluginReportRun, val state: GenUiState)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** By token (the submission ID), the latest [KEPT]. */
    private val runs = object : LinkedHashMap<String, Entry>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?) = size > KEPT
    }

    /** Taken or refused reports leave at once; this bounds taps whose plugin is never set up. */
    private const val KEPT = 256
    private const val ATTEMPTS = 20
    private const val MAX_DELAY = 60_000L

    /** [element] of [artifactId]'s [version] opened [pluginId]'s page: the token its page reports with. */
    internal fun begin(api: GenUiPluginReportApi, artifactId: String, version: Int, element: String, pluginId: String, state: GenUiState): String {
        synchronized(runs) {
            val waiting = runs.entries.firstOrNull { (_, e) ->
                e.api.computer === api.computer && e.run.artifactId == artifactId && e.run.version == version && e.run.element == element && !e.run.finished
            }
            if (waiting != null) return waiting.key
            val run = PluginReportRun(artifactId, version, element, pluginId, AgentClient.newId())
            runs[run.submission] = Entry(api, run, state)
            return run.submission
        }
    }

    /** The page opened with [token] read [installations]: an active one of its plugin sends the report. */
    fun seen(token: String, installations: List<PluginInstallation>) {
        val entry = synchronized(runs) { runs[token] } ?: return
        if (entry.run.seen(installations)) send(entry, 1)
    }

    private fun send(entry: Entry, attempt: Int) {
        scope.launch {
            // A tap before health answered began a run; one that says no reports is never sent.
            entry.api.check()
            if (!entry.api.served) {
                if (entry.api.refused) entry.run.refuse() else entry.run.answered(PluginReportAnswer.NotSetUp)
                if (entry.run.finished) synchronized(runs) { runs.remove(entry.run.submission) }
                return@launch
            }
            val answer = entry.api.submit(entry.run)
            // Marked done before the run finishes, so a tap meanwhile still finds this run and its ID.
            if (answer is PluginReportAnswer.Reported) withContext(Dispatchers.Main) { entry.state.save(entry.run.element, entry.run.pluginId) }
            val again = entry.run.answered(answer)
            if (entry.run.finished) synchronized(runs) { runs.remove(entry.run.submission) }
            if (again && attempt < ATTEMPTS) {
                val timed = entry.run.attempt
                delay(minOf(1_000L shl minOf(attempt, 6), MAX_DELAY))
                if (entry.run.resend(timed)) send(entry, attempt + 1)
            }
        }
    }
}

/**
 * The setup reports of one shown version: a tap on a `plugin` element
 * begins one where [GenUiPluginReport.applies] (an artifact version with a
 * live origin, a computer that says `artifactPluginActions`) and the
 * element isn't done in [state] yet.
 */
@Stable
class GenUiPluginReporter internal constructor(
    private val api: GenUiPluginReportApi,
    private val artifactId: String,
    private val version: Int,
    private val state: GenUiState,
) {
    /** The token for the page [element] opens on [pluginId], or null where this tap reports nothing. */
    fun begin(element: String, pluginId: String, origin: Boolean, plugins: Boolean): String? {
        // Before health has answered the tap still begins a report; sending checks again.
        val capabilities = GenUiCapabilities(plugins = plugins, artifactPluginActions = !api.refused)
        if (!GenUiPluginReport.applies(capabilities, artifact = true, origin = origin) || state.saved(element) != null) return null
        return GenUiPluginReports.begin(api, artifactId, version, element, pluginId, state)
    }
}

/** [artifactId]'s [version]'s setup reports, or null where there is no computer to report to. */
@Composable
fun rememberGenUiPluginReporter(api: GenUiPluginReportApi?, artifactId: String, version: Int, state: GenUiState): GenUiPluginReporter? {
    LaunchedEffect(api) { api?.check() }
    return remember(api, artifactId, version, state) { api?.let { GenUiPluginReporter(it, artifactId, version, state) } }
}

package com.slopus.happy.agent

import com.slopus.happy.chat.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * A Happy Cloud server's two documents every agent follows, kept in its
 * settings (`/v0/config/instructions` and `/v0/config/security`), as iOS
 * has them: anyone reads them, only those granted `policy.edit` (owners)
 * change them, and no agent does.
 */
enum class PolicyDocument(val id: String, private val key: String, val limit: Int) {
    /** AGENTS.md: the server's instructions. */
    Instructions("instructions", "instructions", 256 * 1024),
    /** SECURITY.md: its security policy. */
    Security("security", "policy", 32 * 1024);

    private val path: String get() = "/v0/config/$id"

    /** The text; a missing one reads as empty. */
    suspend fun read(client: AgentClient): String = client.decode<JsonObject>("GET", path)[key].str.orEmpty()

    /** Replaces the text; answers it as the server kept it. */
    suspend fun write(client: AgentClient, text: String): String =
        client.decode<JsonObject>("PUT", path, buildJsonObject { put(key, text) })[key].str ?: text

    companion object {
        fun of(id: String?): PolicyDocument? = entries.firstOrNull { it.id == id }

        /**
         * Whether a server serves the documents from its settings: one whose
         * permission catalog has `policy.edit`, granted to the person or not,
         * as desktop and iOS tell. One that doesn't (deployed before) keeps
         * them in its Policy vault.
         */
        fun served(permissions: ServerPermissions): Boolean = permissions.knows(Permission.POLICY_EDIT)
    }
}

/**
 * One document as its page edits it: read at once, and again on
 * `config.updated` and every reconnect while nothing typed waits
 * ([typing]); saved with the server's word on why not.
 */
class PolicyDocumentSource(
    private val read: suspend () -> String,
    private val write: suspend (String) -> String,
    events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
    /** Whether something typed waits to be saved; a read then leaves it be. */
    var typing: () -> Boolean = { false },
) {
    enum class Problem { NotAllowed, TooLong, Failed }

    data class State(
        /** The text as the server last had it; null until read. */
        val saved: String? = null,
        val failed: Boolean = false,
        val saving: Boolean = false,
        val problem: Problem? = null,
    )

    private val state = MutableStateFlow(State())
    val current: StateFlow<State> = state.asStateFlow()

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { if ((it.type == "config.updated" || it.type == AgentEvent.HELLO) && !typing() && !state.value.saving) load() }
        }
        load()
    }

    fun load() {
        state.value = state.value.copy(failed = false)
        scope.launch {
            try {
                val text = read()
                state.value = state.value.copy(saved = text, failed = false)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (state.value.saved == null) state.value = state.value.copy(failed = true)
            }
        }
    }

    /** Saves [text]; true once the server kept it. */
    suspend fun save(text: String): Boolean {
        if (state.value.saving) return false
        state.value = state.value.copy(saving = true, problem = null)
        val problem = try {
            state.value = state.value.copy(saved = write(text))
            null
        } catch (e: CancellationException) {
            state.value = state.value.copy(saving = false)
            throw e
        } catch (e: AgentApiException) {
            when (e.status) {
                403 -> Problem.NotAllowed
                400, 413 -> Problem.TooLong
                else -> Problem.Failed
            }
        } catch (_: Exception) {
            Problem.Failed
        }
        state.value = state.value.copy(saving = false, problem = problem)
        return problem == null
    }

    fun clearProblem() {
        if (state.value.problem != null) state.value = state.value.copy(problem = null)
    }
}

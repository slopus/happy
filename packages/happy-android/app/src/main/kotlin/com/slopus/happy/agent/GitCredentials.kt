package com.slopus.happy.agent

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.obj
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

/**
 * Whether the person has GitHub linked on a Happy Cloud server (cluster
 * `GET /v0/git/credentials?host=github.com`, values never sent): their own
 * credential first, else the team's, by what it names.
 */
sealed interface GithubLink {
    data object Reading : GithubLink
    data object None : GithubLink
    /** [account] is the credential's username, else its name; null where it names neither. */
    data class Linked(val account: String?) : GithubLink

    companion object {
        /** A `{credentials}` list for github.com. */
        fun of(answer: JsonObject): GithubLink {
            val credentials = answer["credentials"].arr.orEmpty().mapNotNull { it.obj }
            val credential = credentials.firstOrNull { it["shared"].bool == false } ?: credentials.firstOrNull() ?: return None
            return Linked(credential["username"].str?.takeIf { it.isNotBlank() } ?: credential["name"].str?.takeIf { it.isNotBlank() })
        }
    }
}

/**
 * [GithubLink] as a widget follows it: read when first asked for, and again
 * on every `gitCredential.*` event and reconnect, so a device sign-in the
 * server finishes shows as linked.
 */
class GithubLinkSource(
    private val read: suspend () -> GithubLink,
    private val events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
) {
    private val state = MutableStateFlow<GithubLink>(GithubLink.Reading)
    private var started = false

    fun follow(): StateFlow<GithubLink> {
        val fresh = synchronized(this) { !started.also { started = true } }
        if (fresh) {
            scope.launch(start = CoroutineStart.UNDISPATCHED) {
                events.collect { if (it.type == AgentEvent.HELLO || it.type.startsWith("gitCredential.")) reload() }
            }
            scope.launch { reload() }
        }
        return state.asStateFlow()
    }

    private suspend fun reload() {
        state.value = try {
            read()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // A read that fails keeps what was shown; never read, it is not linked as far as this widget can tell.
            state.value.takeIf { it is GithubLink.Linked } ?: GithubLink.None
        }
    }

    companion object {
        suspend fun read(client: AgentClient): GithubLink =
            GithubLink.of(client.decode<JsonObject>("GET", "/v0/git/credentials?host=github.com"))
    }
}

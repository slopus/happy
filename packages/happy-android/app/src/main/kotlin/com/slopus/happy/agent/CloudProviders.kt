package com.slopus.happy.agent

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.chat.strings
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * One credential in a connection, as `GET /v0/cloud/providers` shows it to
 * someone who may see them: its vendor and kind, and whether it serves.
 */
data class CloudCredential(
    val id: String,
    val vendor: String,
    val kind: String,
    val label: String?,
    val enabled: Boolean,
    /** `invalid` when the vendor refused it last; anything else serves. */
    val state: String?,
) {
    val needsAttention: Boolean get() = state == "invalid"
}

/**
 * A connection a Happy Cloud server's models run on (onboarding contract,
 * `GET /v0/cloud/providers`): [id] is what a mode sends as its
 * `providerId`, exactly (`operator:<vendor>` for Happy (free), a vendor's id
 * for the team's default, `private` for the person's own, or a named one's).
 */
data class CloudConnection(
    val id: String,
    val name: String,
    /** `team` or `private`. */
    val scope: String,
    /** `operator` (Happy (free)) or `tenant`. */
    val source: String,
    val vendors: List<String>,
    val models: List<String>,
    val credentialCount: Int,
    /** Listed only where the person may see them: their own, or the team's with providers.manage. */
    val credentials: List<CloudCredential>,
    /** Whether it serves at all; a server that doesn't say yet goes by whether it has models. */
    val enabled: Boolean,
) {
    val included: Boolean get() = source == "operator"
    val private: Boolean get() = scope == "private"

    companion object {
        const val PRIVATE = "private"

        fun parse(json: JsonObject): CloudConnection? {
            val id = json["id"].str ?: return null
            val models = json["models"].strings.orEmpty()
            return CloudConnection(
                id = id,
                name = json["name"].str.orEmpty(),
                scope = json["scope"].str ?: "team",
                source = json["source"].str ?: "tenant",
                vendors = json["vendors"].strings.orEmpty(),
                models = models,
                credentialCount = json["credentialCount"].num?.toInt() ?: 0,
                credentials = json["credentials"].arr.orEmpty().mapNotNull { it.obj }.mapNotNull { c ->
                    CloudCredential(
                        id = c["id"].str ?: c["credentialId"].str ?: return@mapNotNull null,
                        vendor = c["vendor"].str.orEmpty(),
                        kind = c["kind"].str ?: "api_key",
                        label = c["label"].str,
                        enabled = c["enabled"].bool != false,
                        state = c["state"].str,
                    )
                },
                // #8: the server will always send it; until then, a connection with nothing to run is off.
                enabled = json["enabled"].bool ?: models.isNotEmpty(),
            )
        }
    }
}

/** Why a credential, a sign-in or a code didn't go: the server's own [kind] and words. */
class CloudProviderException(val kind: String, override val message: String) : Exception(message)

/**
 * A subscription sign-in under way (onboarding contract §4/§5, the
 * `/v0/provider-clis` operation): a ChatGPT device code to enter at [url],
 * or a Claude page at [url] whose code is pasted back ([acceptsCode]). The
 * tokens stay on the server.
 */
data class CloudSignIn(
    val id: String,
    /** `codex` or `claude`. */
    val cli: String,
    val status: Status,
    val url: String? = null,
    val userCode: String? = null,
    val acceptsCode: Boolean = false,
    val expiresAt: Long? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
) {
    enum class Status { Running, Waiting, Succeeded, Failed, Cancelled }

    val finished: Boolean get() = status == Status.Succeeded || status == Status.Failed || status == Status.Cancelled

    companion object {
        /** The operation in a `{providerCli}` answer (or the object itself); null when it has none. */
        fun parse(json: JsonObject): CloudSignIn? {
            val cli = json["providerCli"].obj ?: json
            val operation = cli["operation"].obj ?: return null
            val authorization = operation["authorization"].obj
            val error = operation["error"].obj
            return CloudSignIn(
                id = operation["id"].str ?: return null,
                cli = cli["id"].str.orEmpty(),
                status = when (operation["status"].str) {
                    "waiting" -> Status.Waiting
                    "succeeded" -> Status.Succeeded
                    "failed" -> Status.Failed
                    "cancelled" -> Status.Cancelled
                    else -> Status.Running
                },
                url = authorization?.get("url").str,
                userCode = authorization?.get("userCode").str,
                acceptsCode = authorization?.get("acceptsCode").bool == true,
                expiresAt = authorization?.get("expiresAt").num?.toLong(),
                errorCode = error?.get("code").str,
                errorMessage = error?.get("message").str ?: operation["message"].str.takeIf { error != null },
            )
        }
    }
}

/** Where something added is kept: the person's own connection, or the team's default for its vendor. */
enum class CloudDestination(val id: String) {
    Private("private"),
    Team("team");

    companion object {
        fun of(id: String?): CloudDestination? = entries.firstOrNull { it.id == id }
    }
}

/**
 * Adding AI providers to a Happy Cloud server (onboarding contract): the
 * connections, an API key or Claude setup token checked and stored in one,
 * and the subscription sign-ins. Every secret goes to the server once and
 * is never read back.
 */
object CloudProviders {
    const val OPENAI = "openai"
    const val ANTHROPIC = "anthropic"
    /** A Claude subscription's credentials, setup tokens among them. */
    const val CLAUDE_CODE = "claude-code"
    const val CODEX = "codex"
    const val CLAUDE = "claude"

    suspend fun list(client: AgentClient): List<CloudConnection> =
        client.decode<JsonObject>("GET", "/v0/cloud/providers")["providers"].arr.orEmpty().mapNotNull { it.obj }.mapNotNull(CloudConnection::parse)

    /**
     * Checks [secret] (an API key, or a Claude setup token as `oauth_token`)
     * and stores it in connection [destination]; a failed check is a
     * [CloudProviderException] in the server's words.
     */
    suspend fun addCredential(client: AgentClient, destination: String, vendor: String, kind: String, secret: String) {
        refusals {
            client.send(
                "POST",
                "/v0/cloud/providers/${AgentClient.escape(destination)}/credentials",
                buildJsonObject {
                    put("vendor", vendor)
                    put("kind", kind)
                    put("secret", secret)
                },
            )
        }
    }

    /**
     * Which subscription sign-ins this server runs: `codex` and `claude`, as
     * `GET /v0/provider-clis` lists them. None where it answers 404 or 501
     * (not mounted yet, or no Claude service): the buttons are left out.
     */
    suspend fun signIns(client: AgentClient): Set<String> = try {
        client.decode<JsonObject>("GET", "/v0/provider-clis")["providerClis"].arr.orEmpty().mapNotNull { it.obj?.get("id").str }.toSet()
    } catch (e: AgentApiException) {
        if (e.status == 404 || e.status == 501) emptySet() else throw e
    }

    /** The CLI a vendor signs in with: `codex` for ChatGPT, `claude` for Claude. */
    fun cli(vendor: String): String = if (vendor == OPENAI) CODEX else CLAUDE

    /** Starts [vendor]'s sign-in into [destination]: a device code for ChatGPT, a browser page and a pasted code for Claude. */
    suspend fun startSignIn(client: AgentClient, vendor: String, destination: CloudDestination): CloudSignIn = refusals {
        val cli = cli(vendor)
        val answer = client.decode<JsonObject>(
            "POST",
            "/v0/provider-clis/$cli/sign-in",
            buildJsonObject {
                put("method", if (cli == CODEX) "device" else "browser")
                put("target", buildJsonObject {
                    if (destination == CloudDestination.Private) put("scope", "private")
                    else put("providerId", if (cli == CODEX) "codex" else "claude-code")
                })
                put("mutationId", AgentClient.newId())
            },
        )
        CloudSignIn.parse(answer) ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }

    /** [cli]'s operation as it stands now; null when it has none. */
    suspend fun signIn(client: AgentClient, cli: String): CloudSignIn? = refusals {
        CloudSignIn.parse(client.decode<JsonObject>("GET", "/v0/provider-clis/$cli"))
    }

    /** Claude's pasted code, which the server exchanges itself; never stored or logged here. */
    suspend fun sendCode(client: AgentClient, code: String): CloudSignIn? = refusals {
        CloudSignIn.parse(
            client.decode<JsonObject>(
                "POST",
                "/v0/provider-clis/$CLAUDE/sign-in/code",
                buildJsonObject {
                    put("code", code.trim())
                    put("mutationId", AgentClient.newId())
                },
            ),
        )
    }

    suspend fun cancel(client: AgentClient, cli: String) {
        client.send("POST", "/v0/provider-clis/$cli/cancel", buildJsonObject { put("mutationId", AgentClient.newId()) })
    }

    /** The connection a credential of [vendor] goes to in [destination]: `private`, or the team's container for that vendor. */
    fun container(destination: CloudDestination, vendor: String): String =
        if (destination == CloudDestination.Private) CloudConnection.PRIVATE else vendor

    /** Events after which the connections may have changed: a credential stored or removed, a sign-in done, and every reconnect. */
    fun changes(event: AgentEvent): Boolean = event.type == AgentEvent.HELLO || event.type == "config.updated" || event.type == "provider_cli.updated"

    /** A refusal that names its kind, as a [CloudProviderException]; the rest as they are. */
    private inline fun <T> refusals(block: () -> T): T = try {
        block()
    } catch (e: AgentApiException) {
        val error = (e.body as? JsonObject)?.get("error")
        val kind = (error as? JsonObject)?.get("code").str ?: (error as? JsonObject)?.get("kind").str ?: e.code
        val message = (error as? JsonObject)?.get("message").str ?: e.message
        if (kind != null && !message.isNullOrBlank() && (e.status in 400..499 || e.status == 501)) throw CloudProviderException(kind, message) else throw e
    }
}

/**
 * A server's connections as a screen shows them: read at once, and again on
 * every event that may change them ([CloudProviders.changes]); with the
 * sign-ins the server runs, which are read once.
 */
class CloudProvidersSource(
    private val read: suspend () -> List<CloudConnection>,
    private val readSignIns: suspend () -> Set<String>,
    events: kotlinx.coroutines.flow.SharedFlow<AgentEvent>,
    private val scope: kotlinx.coroutines.CoroutineScope,
) {
    sealed interface State {
        data object Loading : State
        data class Loaded(val connections: List<CloudConnection>) : State
        data object Failed : State
    }

    private val state = kotlinx.coroutines.flow.MutableStateFlow<State>(State.Loading)
    val connections: kotlinx.coroutines.flow.StateFlow<State> = state

    private val signInState = kotlinx.coroutines.flow.MutableStateFlow<Set<String>>(emptySet())
    /** `codex` and `claude` where the server runs those sign-ins; empty until known, and where it runs none. */
    val signIns: kotlinx.coroutines.flow.StateFlow<Set<String>> = signInState

    init {
        scope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
            events.collect { if (CloudProviders.changes(it)) reload() }
        }
        scope.launch { reload() }
        scope.launch {
            signInState.value = try {
                readSignIns()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                emptySet()
            }
        }
    }

    fun retry() {
        scope.launch { reload() }
    }

    private suspend fun reload() {
        state.value = try {
            State.Loaded(read())
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            state.value.takeIf { it is State.Loaded } ?: State.Failed
        }
    }
}

/**
 * One subscription sign-in from start to its end, as its screen follows
 * it: started, then read every [pollMillis] until it succeeds, fails or is
 * cancelled. Left before then, [close] cancels it on the server.
 */
class CloudSignInRun(
    private val client: AgentClient,
    private val scope: kotlinx.coroutines.CoroutineScope,
    val vendor: String,
    private val destination: CloudDestination,
    private val pollMillis: Long = 3_000,
) {
    sealed interface State {
        data object Starting : State
        /** The code to enter at [url] (ChatGPT), or the page whose code is pasted here (Claude, [acceptsCode]). */
        data class Waiting(val url: String?, val userCode: String?, val acceptsCode: Boolean, val sendingCode: Boolean = false) : State
        data object Done : State
        /** [code] is the server's error code (`expired`, `sign_in_failed`, …), [message] its words. */
        data class Failed(val code: String?, val message: String?) : State
    }

    private val state = kotlinx.coroutines.flow.MutableStateFlow<State>(State.Starting)
    val current: kotlinx.coroutines.flow.StateFlow<State> = state
    private val cli = CloudProviders.cli(vendor)
    private var operation: String? = null
    private var job: kotlinx.coroutines.Job? = null

    /** Starts it, or again after a failure. */
    fun start() {
        job?.cancel()
        state.value = State.Starting
        job = scope.launch {
            try {
                val started = CloudProviders.startSignIn(client, vendor, destination)
                operation = started.id
                show(started)
                while (state.value !is State.Done && state.value !is State.Failed) {
                    kotlinx.coroutines.delay(pollMillis)
                    CloudProviders.signIn(client, cli)?.takeIf { it.id == operation }?.let(::show)
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: CloudProviderException) {
                state.value = State.Failed(e.kind, e.message)
            } catch (_: Exception) {
                state.value = State.Failed(null, null)
            }
        }
    }

    /** Claude's pasted code; what comes of it arrives as the sign-in goes on. */
    fun sendCode(code: String) {
        val waiting = state.value as? State.Waiting ?: return
        if (code.isBlank() || waiting.sendingCode) return
        state.value = waiting.copy(sendingCode = true)
        scope.launch {
            try {
                CloudProviders.sendCode(client, code)?.takeIf { it.id == operation }?.let(::show)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: CloudProviderException) {
                state.value = State.Failed(e.kind, e.message)
            } catch (_: Exception) {
                (state.value as? State.Waiting)?.let { state.value = it.copy(sendingCode = false) }
            }
        }
    }

    /** Leaves it: one not yet finished is cancelled on the server. */
    fun close() {
        job?.cancel()
        val unfinished = operation != null && state.value !is State.Done && state.value !is State.Failed
        if (unfinished) scope.launch(kotlinx.coroutines.NonCancellable) {
            try {
                CloudProviders.cancel(client, cli)
            } catch (_: Exception) {
            }
        }
    }

    private fun show(signIn: CloudSignIn) {
        state.value = when (signIn.status) {
            CloudSignIn.Status.Succeeded -> State.Done
            CloudSignIn.Status.Failed -> State.Failed(signIn.errorCode, signIn.errorMessage)
            CloudSignIn.Status.Cancelled -> State.Failed("cancelled", signIn.errorMessage)
            // Exchanging a pasted code: the page stays as it is, its Connect still busy.
            CloudSignIn.Status.Running -> state.value as? State.Waiting ?: State.Starting
            CloudSignIn.Status.Waiting -> State.Waiting(signIn.url, signIn.userCode, signIn.acceptsCode)
        }
    }
}

package com.slopus.happy.agent

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
 * One assistant's program on the computer (API.md "Provider CLIs", `GET
 * /v0/provider-clis/:cliId`): whether it's installed, what installing
 * would run, whether it's signed in, and the install or sign-in under way.
 * The daemon never sends a credential.
 */
data class ProviderCli(
    val id: String,
    val name: String,
    val installed: Boolean,
    val installedVersion: String?,
    /** What installing runs, and the host it downloads from; null where the vendor offers no installer here. */
    val installer: Installer?,
    val signIn: SignIn,
    val email: String?,
    val plan: String?,
    val operation: Operation?,
    /** A UUIDv7 minted on every change: of two copies, the greater is newer. */
    val version: String,
) {
    data class Installer(val command: String, val sourceHost: String)

    enum class SignIn { SignedIn, SignedOut, Unknown }

    data class Operation(
        /** `install` or `sign_in`. */
        val kind: String,
        val status: Status,
        val message: String?,
        val url: String?,
        val userCode: String?,
        val acceptsCode: Boolean,
        val errorMessage: String?,
    ) {
        enum class Status { Running, Waiting, Succeeded, Failed, Cancelled }

        val busy: Boolean get() = status == Status.Running || status == Status.Waiting
    }

    companion object {
        /** A `{providerCli}` answer or event, or the object itself; null for anything else. */
        fun parse(json: JsonObject): ProviderCli? {
            val cli = json["providerCli"].obj ?: json
            val installation = cli["installation"].obj
            val installer = cli["installer"].obj
            val signIn = cli["signIn"].obj
            val account = signIn?.get("account").obj
            val operation = cli["operation"].obj
            val authorization = operation?.get("authorization").obj
            return ProviderCli(
                id = cli["id"].str ?: return null,
                name = cli["name"].str ?: cli["id"].str.orEmpty(),
                installed = installation?.get("status").str == "installed",
                installedVersion = installation?.get("version").str,
                installer = installer?.let { Installer(it["command"].str ?: return@let null, it["sourceHost"].str.orEmpty()) },
                signIn = when (signIn?.get("status").str) {
                    "signed_in" -> SignIn.SignedIn
                    "signed_out" -> SignIn.SignedOut
                    else -> SignIn.Unknown
                },
                email = account?.get("email").str,
                plan = account?.get("plan").str,
                operation = operation?.let { o ->
                    Operation(
                        kind = o["kind"].str.orEmpty(),
                        status = when (o["status"].str) {
                            "waiting" -> Operation.Status.Waiting
                            "succeeded" -> Operation.Status.Succeeded
                            "failed" -> Operation.Status.Failed
                            "cancelled" -> Operation.Status.Cancelled
                            else -> Operation.Status.Running
                        },
                        message = o["message"].str,
                        url = authorization?.get("url").str,
                        userCode = authorization?.get("userCode").str,
                        acceptsCode = authorization?.get("acceptsCode").bool == true,
                        errorMessage = o["error"].obj?.get("message").str,
                    )
                },
                version = cli["version"].str.orEmpty(),
            )
        }

        /** Of [held] and [incoming] for one id, the newer: the greater version. */
        fun newer(held: ProviderCli?, incoming: ProviderCli): ProviderCli =
            if (held == null || incoming.version >= held.version) incoming else held
    }
}

/**
 * The assistants' programs as chat UI shows them, one id at a time: read
 * when first asked for and on every reconnect, and replaced by each
 * `provider_cli.updated` that is newer. A server that runs none (`404`, or
 * `501` in team mode) is [State.Unsupported].
 */
class ProviderCliSource(
    private val read: suspend (String) -> ProviderCli?,
    events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
) {
    sealed interface State {
        data object Reading : State
        data class Read(val cli: ProviderCli) : State
        data object Unsupported : State
        data object Failed : State
    }

    private val states = HashMap<String, MutableStateFlow<State>>()

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { event ->
                when (event.type) {
                    AgentEvent.HELLO -> synchronized(states) { states.keys.toList() }.forEach(::reload)
                    "provider_cli.updated" -> ProviderCli.parse(event.data)?.let { cli ->
                        val state = synchronized(states) { states[cli.id] } ?: return@let
                        state.value = State.Read(ProviderCli.newer((state.value as? State.Read)?.cli, cli))
                    }
                }
            }
        }
    }

    /** [id]'s program, live; read the first time it's asked for. */
    fun follow(id: String): StateFlow<State> {
        var fresh = false
        val state = synchronized(states) {
            states.getOrPut(id) { fresh = true; MutableStateFlow(State.Reading) }
        }
        if (fresh) reload(id)
        return state.asStateFlow()
    }

    private fun reload(id: String) {
        val state = synchronized(states) { states[id] } ?: return
        scope.launch {
            state.value = try {
                read(id)?.let { cli -> State.Read(ProviderCli.newer((state.value as? State.Read)?.cli, cli)) } ?: State.Failed
            } catch (e: CancellationException) {
                throw e
            } catch (e: AgentApiException) {
                if (e.status == 404 || e.status == 501) State.Unsupported else state.value.takeIf { it is State.Read } ?: State.Failed
            } catch (_: Exception) {
                state.value.takeIf { it is State.Read } ?: State.Failed
            }
        }
    }

    companion object {
        suspend fun read(client: AgentClient, id: String): ProviderCli? =
            ProviderCli.parse(client.decode<JsonObject>("GET", "/v0/provider-clis/${AgentClient.escape(id)}"))
    }
}

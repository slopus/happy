package com.slopus.happy.agent

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.chat.strings
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Where an account's credential comes from (happy-agent API.md, "Provider sign-in"). */
enum class CredentialSource {
    /** One this installation owns: signed in here, or a saved setup token. */
    Internal,

    /** The machine's own: the vendor's sign-in for the agent's user, or its environment. */
    System,

    /** One configuration names; also any source this build doesn't know. */
    Configured;

    companion object {
        fun of(wire: String?): CredentialSource = when (wire) {
            "internal" -> Internal
            "system" -> System
            else -> Configured
        }
    }
}

/** An account's `credential` in `GET /v0/config`: where it comes from, the sign-ins it takes, and whether it takes a pasted token. */
@Immutable
data class ProviderCredential(val source: CredentialSource, val methods: List<String>, val acceptsToken: Boolean) {
    companion object {
        fun parse(json: JsonObject?): ProviderCredential? = json?.let {
            ProviderCredential(CredentialSource.of(it["source"].str), it["methods"].strings.orEmpty(), it["acceptsToken"].bool == true)
        }
    }
}

/**
 * One `codex`, `claude` or `grok` account of `GET /v0/config` that can sign
 * in, with [signedOut] from `GET /v0/usage`'s `signIn` (whether its
 * credential works now; `credential` says only where it comes from).
 */
@Immutable
data class ProviderAccount(
    val id: String,
    /** The account's own name; null where configuration gives none. */
    val name: String?,
    /** The assistant that signs it in: `codex`, `claude` or `grok`. */
    val type: String,
    val credential: ProviderCredential,
    val signedOut: Boolean = false,
)

/** The page a sign-in waits on: a device code to enter at [url], or ([acceptsCode]) a page whose code is pasted back. */
@Immutable
data class SignInAuthorization(val method: String, val url: String, val userCode: String?, val acceptsCode: Boolean, val expiresAt: Long?)

/** The `sign_in` operation of a provider sign-in object (the provider-CLI operation). */
@Immutable
data class SignInOperation(
    val id: String,
    val status: Status,
    val authorization: SignInAuthorization?,
    /** `expired`, `sign_in_failed`, `interrupted`, `save_failed`, …; null unless it failed. */
    val errorCode: String? = null,
    /** The agent's own words for the failure, shown as they came. */
    val errorMessage: String? = null,
) {
    enum class Status { Running, Waiting, Succeeded, Failed, Cancelled }

    val finished: Boolean get() = status == Status.Succeeded || status == Status.Failed || status == Status.Cancelled

    companion object {
        fun parse(json: JsonObject?): SignInOperation? {
            val operation = json ?: return null
            val authorization = operation["authorization"].obj
            val error = operation["error"].obj
            return SignInOperation(
                id = operation["id"].str ?: return null,
                status = when (operation["status"].str) {
                    "waiting" -> Status.Waiting
                    "succeeded" -> Status.Succeeded
                    "failed" -> Status.Failed
                    "cancelled" -> Status.Cancelled
                    else -> Status.Running
                },
                authorization = authorization?.let { a ->
                    a["url"].str?.let { url ->
                        SignInAuthorization(a["method"].str.orEmpty(), url, a["userCode"].str, a["acceptsCode"].bool == true, a["expiresAt"].num?.toLong())
                    }
                },
                errorCode = error?.get("code").str,
                errorMessage = error?.get("message").str,
            )
        }
    }
}

/**
 * One account's sign-in into a credential this installation owns (API.md,
 * "The provider sign-in object"). Events carry the whole object; of two,
 * the one with the greater [version] (a UUIDv7) is current.
 */
@Immutable
data class ProviderSignIn(
    val providerId: String,
    val cliId: String,
    /** Whether the vendor's program is installed where the agent runs; signing in needs it. */
    val installed: Boolean,
    val credential: ProviderCredential,
    /** The installation's own sign-in, where the vendor reveals it. */
    val email: String? = null,
    val plan: String? = null,
    val operation: SignInOperation? = null,
    val version: String,
) {
    /** Whether this replaces [other]: there is none, or this one's version is greater. */
    fun newerThan(other: ProviderSignIn?): Boolean = other == null || version > other.version

    companion object {
        /** The object in a `{providerSignIn}` answer or event, or the object itself; null for anything else. */
        fun parse(json: JsonObject?): ProviderSignIn? {
            val root = json?.get("providerSignIn").obj ?: json ?: return null
            val account = root["account"].obj
            return ProviderSignIn(
                providerId = root["providerId"].str ?: return null,
                cliId = root["cliId"].str.orEmpty(),
                installed = root["installed"].bool != false,
                credential = ProviderCredential.parse(root["credential"].obj) ?: return null,
                email = account?.get("email").str,
                plan = account?.get("plan").str,
                operation = SignInOperation.parse(root["operation"].obj),
                version = root["version"].str ?: return null,
            )
        }
    }
}

/** Why the agent refused a sign-in, a code, a cancel or a token. */
enum class ProviderSignInRefusal {
    /** `403 forbidden`: in team mode only the team owner may. */
    Forbidden,

    /** `409 not_installed`: the vendor's program is missing. */
    NotInstalled,

    /** `409 not_supported`: the account can't sign in, or take a token. */
    NotSupported,

    /** `400 invalid_request`: a method it doesn't offer, or a malformed token. */
    Invalid,

    /** `409 conflict`: no sign-in waits for a code. */
    Conflict,

    /** Anything else the agent said no to. */
    Other,
}

/** [refusal] with the agent's own words ([said]) and, where the answer carried it, the account's sign-in as it is now. */
class ProviderSignInException(val refusal: ProviderSignInRefusal, val said: String?, val current: ProviderSignIn? = null) : Exception(said)

/** The routes of provider sign-in, so a screen can be shown over an agent or a fixture. */
interface ProviderSignInBackend {
    /** Every account that can sign in, in configuration's order. */
    suspend fun accounts(): List<ProviderAccount>

    suspend fun read(providerId: String): ProviderSignIn

    /** Starts [method]'s sign-in, or joins the one running. */
    suspend fun start(providerId: String, method: String?): ProviderSignIn

    /** The code Claude's page showed; never kept here. */
    suspend fun sendCode(providerId: String, code: String): ProviderSignIn

    suspend fun cancel(providerId: String): ProviderSignIn

    /** A Claude setup token, saved as the account's own credential; never kept here. */
    suspend fun saveToken(providerId: String, token: String): ProviderSignIn
}

/**
 * Provider sign-in on a Happy Agent (API.md, "Provider sign-in"): offered
 * where health says `capabilities.providerSignIn`. Codes and tokens go to
 * the agent once and are never logged, kept or read back.
 */
object ProviderSignIns {
    const val UPDATED = "provider_sign_in.updated"
    const val DEVICE = "device"
    const val BROWSER = "browser"

    /** The assistants whose accounts sign in. */
    val TYPES = setOf("codex", "claude", "grok")

    /**
     * The method a phone signs [cliId]'s account in with: a device code
     * wherever the account offers one; Claude's browser page, whose code is
     * pasted back. Codex's and Grok's browser page finishes only on the
     * agent's machine, so neither is ever offered here: null.
     */
    fun phoneMethod(cliId: String, credential: ProviderCredential): String? = when {
        DEVICE in credential.methods -> DEVICE
        cliId == "claude" && BROWSER in credential.methods -> BROWSER
        else -> null
    }

    /** `GET /v0/config`'s accounts that can sign in, with `GET /v0/usage`'s word on which are signed out. */
    fun accounts(config: JsonObject, usage: JsonObject?): List<ProviderAccount> {
        val root = config["config"].obj ?: config
        val signedOut = usage?.get("providers").arr.orEmpty().mapNotNull { it.obj }
            .filter { it["signIn"].str == "signed_out" }.mapNotNull { it["providerId"].str }.toSet()
        return root["providers"].obj.orEmpty().mapNotNull { (id, value) ->
            val provider = value.obj ?: return@mapNotNull null
            val type = provider["type"].str?.takeIf { it in TYPES } ?: return@mapNotNull null
            val credential = ProviderCredential.parse(provider["credential"].obj) ?: return@mapNotNull null
            ProviderAccount(id, provider["name"].str?.takeIf(String::isNotBlank), type, credential, id in signedOut)
        }
    }

    /** The object an event carries, where it is a provider sign-in's. */
    fun updated(event: AgentEvent): ProviderSignIn? = if (event.type == UPDATED) ProviderSignIn.parse(event.data) else null

    /** Events after which the accounts may have changed: configuration, and every reconnect. */
    fun changes(event: AgentEvent): Boolean = event.type == AgentEvent.HELLO || event.type == "config.updated"
}

/** [ProviderSignInBackend] over an agent connection. */
class AgentProviderSignIns(private val client: AgentClient) : ProviderSignInBackend {
    override suspend fun accounts(): List<ProviderAccount> {
        val config = client.decode<JsonObject>("GET", "/v0/config")
        // Whether a credential works is extra: without usage, nothing reads as signed out.
        val usage = try {
            client.decode<JsonObject>("GET", "/v0/usage")
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        return ProviderSignIns.accounts(config, usage)
    }

    override suspend fun read(providerId: String): ProviderSignIn = call("GET", providerId, "/sign-in", null)

    override suspend fun start(providerId: String, method: String?): ProviderSignIn = call("POST", providerId, "/sign-in", buildJsonObject {
        method?.let { put("method", it) }
        put("mutationId", AgentClient.newId())
    })

    override suspend fun sendCode(providerId: String, code: String): ProviderSignIn = call("POST", providerId, "/sign-in/code", buildJsonObject {
        put("code", code.trim())
        put("mutationId", AgentClient.newId())
    })

    override suspend fun cancel(providerId: String): ProviderSignIn =
        call("POST", providerId, "/sign-in/cancel", buildJsonObject { put("mutationId", AgentClient.newId()) })

    override suspend fun saveToken(providerId: String, token: String): ProviderSignIn = call("PUT", providerId, "/token", buildJsonObject {
        put("token", token)
        put("mutationId", AgentClient.newId())
    })

    private suspend fun call(method: String, providerId: String, route: String, body: JsonObject?): ProviderSignIn {
        val answer = try {
            client.decode<JsonObject>(method, "/v0/providers/${AgentClient.escape(providerId)}$route", body)
        } catch (e: AgentApiException) {
            throw refusal(e) ?: e
        }
        return ProviderSignIn.parse(answer) ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }

    /** A refusal the contract names, with the object a `409` carries; null for the rest. */
    private fun refusal(e: AgentApiException): ProviderSignInException? {
        val kind = when {
            e.status == 403 && e.code == "forbidden" -> ProviderSignInRefusal.Forbidden
            e.status == 409 && e.code == "not_installed" -> ProviderSignInRefusal.NotInstalled
            e.status == 409 && e.code == "not_supported" -> ProviderSignInRefusal.NotSupported
            e.status == 409 && e.code == "conflict" -> ProviderSignInRefusal.Conflict
            e.status == 400 -> ProviderSignInRefusal.Invalid
            e.status in 400..499 -> ProviderSignInRefusal.Other
            else -> return null
        }
        return ProviderSignInException(kind, e.message?.takeIf(String::isNotBlank), ProviderSignIn.parse(e.body.obj))
    }
}

package com.slopus.happy.ui.connection

import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Debug builds only: a Happy Agent's provider sign-in routes in memory, as
 * happy-agent PR #176's API.md states them (statuses, error codes, the
 * object and `provider_sign_in.updated`), so the real client and pages run
 * against the contract without a vendor. No real account is ever signed in.
 *
 * Accounts: `codex` (system login, device or browser), `claude_work`
 * (Happy's own, ada@example.com on Max, takes a token), `grok` (config
 * file, signed out). [scene] picks how they answer: `normal` waits on the
 * device code; `success` signs Codex in after 5 s; `failure` lets it expire
 * after 3 s; `owner` refuses every change as a team member's; `missing` has
 * Grok's program missing. Claude's pasted code `fail` fails; any other
 * signs in. A token must start `sk-ant-oat01-`.
 */
class ProviderSignInDaemon(private val scene: String, private val scope: CoroutineScope) : Transport {
    private class Account(
        val id: String,
        val type: String,
        val name: String,
        var source: String,
        val methods: List<String>,
        val acceptsToken: Boolean,
        val installed: Boolean = true,
        var email: String? = null,
        var plan: String? = null,
        var signedOut: Boolean = false,
        var operation: JsonObject? = null,
        var version: String = "",
    )

    private val accounts = listOf(
        Account("codex", "codex", "Codex", "system", listOf("device", "browser"), acceptsToken = false),
        Account("claude_work", "claude", "Claude (work)", "internal", listOf("browser"), acceptsToken = true, email = "ada@example.com", plan = "Max"),
        Account("grok", "grok", "Grok", "configured", listOf("device"), acceptsToken = false, installed = scene != "missing", signedOut = true),
    )
    private var clock = 0L
    private var operations = 0
    private val jobs = HashMap<String, Job>()
    private val eventFlow = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<AgentEvent> = eventFlow

    init {
        accounts.forEach(::bump)
    }

    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
        delay(250)
        val json = body?.let { Json.parseToJsonElement(it.decodeToString()).jsonObject }
        synchronized(this) {
            if (method == "GET" && path == "/v0/config") return ok(config())
            if (method == "GET" && path == "/v0/usage") return ok(usage())
            val match = ROUTE.matchEntire(path) ?: return error(404, "not_found", "Not found")
            val account = accounts.firstOrNull { it.id == match.groupValues[1] } ?: return error(404, "not_found", "No such account")
            val route = match.groupValues[2]
            if (method != "GET" && scene == "owner") return error(403, "forbidden", "Only the team owner can change provider sign-ins.")
            return when ("$method $route") {
                "GET /sign-in" -> ok(answer(account))
                "POST /sign-in" -> start(account, json?.get("method")?.jsonPrimitive?.content)
                "POST /sign-in/code" -> code(account, json?.get("code")?.jsonPrimitive?.content.orEmpty())
                "POST /sign-in/cancel" -> {
                    if (account.operation?.status() in UNFINISHED) finish(account, "cancelled", null)
                    ok(answer(account))
                }
                "PUT /token" -> token(account, json?.get("token")?.jsonPrimitive?.content.orEmpty())
                else -> error(404, "not_found", "Not found")
            }
        }
    }

    override suspend fun close() {}

    private fun start(account: Account, method: String?): TransportResponse {
        val chosen = method ?: account.methods.first()
        if (chosen !in account.methods) return error(400, "invalid_request", "Unknown sign-in method.")
        if (!account.installed) return error(409, "not_installed", "${account.type} is not installed.", answer(account))
        // A second start joins the one running.
        if (account.operation?.status() in UNFINISHED) return ok(answer(account))
        val id = "op_${++operations}"
        account.operation = operation(id, "running", null, null)
        bump(account)
        jobs[account.id] = scope.launch {
            delay(700)
            val url = if (account.type == "claude") "https://claude.ai/oauth/authorize?code=true" else "https://auth.openai.com/codex/device"
            val code = if (chosen == "device") "K7QF-9WXM" else null
            synchronized(this@ProviderSignInDaemon) {
                account.operation = operation(id, "waiting", authorization(chosen, url, code, acceptsCode = account.type == "claude"), null)
                bump(account)
            }
            when (scene) {
                "success" -> if (account.type != "claude") {
                    delay(5_000)
                    synchronized(this@ProviderSignInDaemon) {
                        account.source = "internal"
                        account.email = "ada@example.com"
                        account.plan = "Pro"
                        account.signedOut = false
                        finish(account, "succeeded", null)
                    }
                    eventFlow.tryEmit(AgentEvent(null, "config.updated", JsonObject(emptyMap())))
                }
                "failure" -> if (account.type != "claude") {
                    delay(3_000)
                    synchronized(this@ProviderSignInDaemon) {
                        finish(account, "failed", "expired" to "The device code expired before the sign-in finished.")
                    }
                }
            }
        }
        return ok(answer(account))
    }

    private fun code(account: Account, code: String): TransportResponse {
        val operation = account.operation
        val waiting = operation?.status() == "waiting" && operation["authorization"]?.let { it as? JsonObject }?.get("acceptsCode")?.jsonPrimitive?.content == "true"
        if (!waiting || code.isBlank()) return error(409, "conflict", "No sign-in is waiting for a code.", answer(account))
        val id = operation!!["id"]!!.jsonPrimitive.content
        account.operation = operation(id, "running", operation["authorization"] as JsonObject, null)
        bump(account)
        scope.launch {
            delay(1_500)
            synchronized(this@ProviderSignInDaemon) {
                if (code == "fail") {
                    finish(account, "failed", "sign_in_failed" to "Claude Code couldn't exchange the code: invalid_grant.")
                } else {
                    account.source = "internal"
                    account.email = "ada@example.com"
                    account.plan = "Max"
                    finish(account, "succeeded", null)
                }
            }
        }
        return ok(answer(account))
    }

    private fun token(account: Account, token: String): TransportResponse {
        if (account.type != "claude") return error(409, "not_supported", "Only Claude accounts take a setup token.")
        if (!token.filterNot(Char::isWhitespace).startsWith("sk-ant-oat01-")) return error(400, "invalid_request", "That isn't a Claude setup token. It starts with sk-ant-oat01-.")
        account.source = "internal"
        account.email = null
        account.plan = null
        account.signedOut = false
        bump(account)
        eventFlow.tryEmit(AgentEvent(null, "config.updated", JsonObject(emptyMap())))
        return ok(answer(account))
    }

    private fun finish(account: Account, status: String, error: Pair<String, String>?) {
        val operation = account.operation ?: return
        jobs.remove(account.id)?.takeIf { status == "cancelled" }?.cancel()
        account.operation = operation(operation["id"]!!.jsonPrimitive.content, status, operation["authorization"] as? JsonObject, error)
        bump(account)
    }

    /** A new version, and the event that carries it. */
    private fun bump(account: Account) {
        clock += 1
        account.version = "0199%04x-0000-7000-8000-%012x".format(0x1f3a, clock)
        eventFlow.tryEmit(AgentEvent(null, "provider_sign_in.updated", answer(account)))
    }

    private fun credential(account: Account) = buildJsonObject {
        put("source", account.source)
        put("methods", buildJsonArray { account.methods.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
        put("acceptsToken", account.acceptsToken)
    }

    private fun answer(account: Account) = buildJsonObject {
        putJsonObject("providerSignIn") {
            put("providerId", account.id)
            put("cliId", account.type)
            put("installed", account.installed)
            put("credential", credential(account))
            if (account.source == "internal" && (account.email != null || account.plan != null)) {
                putJsonObject("account") {
                    put("email", account.email)
                    put("plan", account.plan)
                }
            } else {
                put("account", JsonNull)
            }
            put("operation", account.operation ?: JsonNull)
            put("version", account.version)
            put("updatedAt", 1_764_000_000_000 + clock)
        }
    }

    private fun config() = buildJsonObject {
        putJsonObject("config") {
            putJsonObject("providers") {
                for (account in accounts) putJsonObject(account.id) {
                    put("type", account.type)
                    put("name", account.name)
                    put("enabled", true)
                    put("models", buildJsonArray {})
                    put("credential", credential(account))
                }
                // Nothing to sign in to: left out of the page.
                putJsonObject("bedrock") {
                    put("type", "bedrock")
                    put("enabled", true)
                    put("models", buildJsonArray {})
                }
            }
        }
    }

    private fun usage() = buildJsonObject {
        put("providers", buildJsonArray {
            for (account in accounts) add(buildJsonObject {
                put("providerId", account.id)
                put("signIn", if (account.signedOut) "signed_out" else "signed_in")
            })
        })
    }

    private fun operation(id: String, status: String, authorization: JsonObject?, error: Pair<String, String>?) = buildJsonObject {
        put("id", id)
        put("kind", "sign_in")
        put("status", status)
        put("message", status)
        put("authorization", authorization ?: JsonNull)
        put("output", buildJsonArray {})
        put("error", error?.let { (code, message) -> buildJsonObject { put("code", code); put("message", message) } } ?: JsonNull)
        put("startedAt", 1_764_000_000_000)
        put("finishedAt", if (status in UNFINISHED) JsonNull else kotlinx.serialization.json.JsonPrimitive(1_764_000_100_000))
    }

    private fun authorization(method: String, url: String, userCode: String?, acceptsCode: Boolean) = buildJsonObject {
        put("method", method)
        put("url", url)
        put("userCode", userCode)
        put("openedByProgram", false)
        put("acceptsCode", acceptsCode)
        put("expiresAt", 1_764_000_900_000)
    }

    private fun JsonObject.status() = get("status")?.jsonPrimitive?.content

    private fun ok(body: JsonObject) = TransportResponse(200, mapOf("content-type" to "application/json"), body.toString().toByteArray())

    private fun error(status: Int, code: String, message: String, extra: JsonObject? = null) = TransportResponse(
        status,
        mapOf("content-type" to "application/json"),
        JsonObject(mapOf("error" to kotlinx.serialization.json.JsonPrimitive(message), "code" to kotlinx.serialization.json.JsonPrimitive(code)) + extra.orEmpty()).toString().toByteArray(),
    )

    private companion object {
        val ROUTE = Regex("^/v0/providers/([^/]+)(/sign-in|/sign-in/code|/sign-in/cancel|/token)$")
        val UNFINISHED = setOf("running", "waiting")
    }
}

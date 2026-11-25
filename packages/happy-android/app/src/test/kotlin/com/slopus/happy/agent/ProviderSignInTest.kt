package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Provider sign-in (happy-agent PR #176, API.md "Provider sign-in") against a fake agent serving the contract's bodies. */
@OptIn(ExperimentalCoroutinesApi::class)
class ProviderSignInTest {
    /** Answers by "METHOD path", in turn where a route lists several; records each request with its body. */
    private class Agent(answers: Map<String, List<Pair<Int, String>>>) : Transport {
        private val queues = answers.mapValues { ArrayDeque(it.value) }.toMutableMap()
        val asked = mutableListOf<String>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += listOfNotNull("$method $path", body?.decodeToString()).joinToString(" ")
            val queue = queues["$method $path"]
            val (status, text) = (if (queue != null && queue.size > 1) queue.removeFirst() else queue?.firstOrNull()) ?: (404 to """{"error":"Not found","code":"not_found"}""")
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject

    /** API.md's example object, with [source], [operation] and [version] as asked. */
    private fun signIn(
        version: String = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
        source: String = "internal",
        operation: String = "null",
        account: String = """{"email":"ada@example.com","plan":"Pro"}""",
        installed: Boolean = true,
    ) = """{"providerSignIn":{"providerId":"codex_work","cliId":"codex","installed":$installed,
        "credential":{"source":"$source","methods":["device","browser"],"acceptsToken":false},
        "account":$account,"operation":$operation,"version":"$version","updatedAt":1755400000000}}"""

    private fun operation(id: String = "op1", status: String, authorization: String = "null", error: String = "null") =
        """{"id":"$id","kind":"sign_in","status":"$status","message":"…","authorization":$authorization,"output":[],"error":$error,"startedAt":1,"finishedAt":null}"""

    private val device = """{"method":"device","url":"https://auth.openai.com/codex/device","userCode":"K7QF-9WXM","openedByProgram":false,"acceptsCode":false,"expiresAt":1755400900000}"""
    private val claudePage = """{"method":"browser","url":"https://claude.ai/oauth/authorize","userCode":null,"openedByProgram":false,"acceptsCode":true,"expiresAt":1755400900000}"""
    private val codexBrowser = """{"method":"browser","url":"http://localhost:1455/auth","userCode":null,"openedByProgram":true,"acceptsCode":false,"expiresAt":1755400900000}"""

    @Test
    fun configsAccountsThatSignInCarryWhereTheirCredentialComesFrom() {
        val config = json(
            """{"config":{"providers":{
              "codex":{"type":"codex","enabled":true,"models":[],"credential":{"source":"system","methods":["device","browser"],"acceptsToken":false}},
              "claude_work":{"type":"claude","name":"Claude (work)","credential":{"source":"internal","methods":["browser"],"acceptsToken":true}},
              "grok":{"type":"grok","name":" ","credential":{"source":"vault","methods":["device"],"acceptsToken":false}},
              "old_codex":{"type":"codex"},
              "bedrock":{"type":"bedrock","credential":{"source":"system","methods":[],"acceptsToken":false}}}}}""",
        )
        val usage = json("""{"providers":[{"providerId":"grok","signIn":"signed_out"},{"providerId":"codex","signIn":"signed_in"}]}""")
        val accounts = ProviderSignIns.accounts(config, usage)
        // An entry without `credential` (an older agent) and a type with nothing to sign in to are left out.
        assertEquals(listOf("codex", "claude_work", "grok"), accounts.map { it.id })
        assertEquals(listOf(CredentialSource.System, CredentialSource.Internal, CredentialSource.Configured), accounts.map { it.credential.source })
        assertEquals(listOf(null, "Claude (work)", null), accounts.map { it.name })
        assertEquals(listOf(false, true, false), accounts.map { it.credential.acceptsToken })
        assertEquals(listOf(false, false, true), accounts.map { it.signedOut })
        // Without usage, nothing reads as signed out.
        assertTrue(ProviderSignIns.accounts(config, null).none { it.signedOut })
    }

    @Test
    fun aPhoneSignsInWithADeviceCodeOrClaudesPageNeverCodexsOrGroksBrowser() {
        fun credential(vararg methods: String) = ProviderCredential(CredentialSource.System, methods.toList(), acceptsToken = false)
        assertEquals("device", ProviderSignIns.phoneMethod("codex", credential("device", "browser")))
        assertEquals("device", ProviderSignIns.phoneMethod("grok", credential("browser", "device")))
        assertEquals("browser", ProviderSignIns.phoneMethod("claude", credential("browser")))
        assertNull(ProviderSignIns.phoneMethod("codex", credential("browser")))
        assertNull(ProviderSignIns.phoneMethod("grok", credential("browser")))
        assertNull(ProviderSignIns.phoneMethod("codex", credential()))
    }

    @Test
    fun theObjectReadsAsTheContractWritesIt() {
        val parsed = ProviderSignIn.parse(json(signIn(operation = operation(status = "waiting", authorization = device))))!!
        assertEquals("codex_work", parsed.providerId)
        assertEquals("codex", parsed.cliId)
        assertEquals(CredentialSource.Internal, parsed.credential.source)
        assertEquals("ada@example.com", parsed.email)
        assertEquals("Pro", parsed.plan)
        assertEquals(SignInOperation.Status.Waiting, parsed.operation!!.status)
        assertEquals(SignInAuthorization("device", "https://auth.openai.com/codex/device", "K7QF-9WXM", false, 1755400900000), parsed.operation!!.authorization)
        val failed = ProviderSignIn.parse(json(signIn(account = "null", operation = operation(status = "failed", error = """{"code":"save_failed","message":"Couldn't write runtime.toml."}"""))))!!
        assertNull(failed.email)
        assertEquals("save_failed", failed.operation!!.errorCode)
        assertEquals("Couldn't write runtime.toml.", failed.operation!!.errorMessage)
        // A greater UUIDv7 is newer.
        val older = parsed.copy(version = "01991f3a-5c1e-7000-8000-000000000001")
        assertTrue(parsed.newerThan(older))
        assertFalse(older.newerThan(parsed))
        assertTrue(parsed.newerThan(null))
    }

    @Test
    fun routesAndBodiesAreTheContractsAndCarryNoSecretBack() = runBlocking {
        val agent = Agent(
            mapOf(
                "GET /v0/providers/codex_work/sign-in" to listOf(200 to signIn()),
                "POST /v0/providers/codex_work/sign-in" to listOf(200 to signIn(operation = operation(status = "running"))),
                "POST /v0/providers/claude%20work/sign-in/code" to listOf(200 to signIn()),
                "POST /v0/providers/codex_work/sign-in/cancel" to listOf(200 to signIn(operation = operation(status = "cancelled"))),
                "PUT /v0/providers/claude%20work/token" to listOf(200 to signIn()),
            ),
        )
        val backend = AgentProviderSignIns(AgentClient(agent, "t"))
        backend.read("codex_work")
        assertEquals(SignInOperation.Status.Running, backend.start("codex_work", "device").operation!!.status)
        backend.sendCode("claude work", "  the-code\n")
        backend.cancel("codex_work")
        backend.saveToken("claude work", "sk-ant-oat01-abc")
        assertEquals("GET /v0/providers/codex_work/sign-in", agent.asked[0])
        fun body(at: Int) = json(agent.asked[at].substringAfter(" {").let { "{$it" })
        assertEquals("device", body(1)["method"]!!.toString().trim('"'))
        assertTrue(body(1).containsKey("mutationId"))
        assertTrue(agent.asked[2].startsWith("POST /v0/providers/claude%20work/sign-in/code "))
        assertEquals("the-code", body(2)["code"]!!.toString().trim('"'))
        assertTrue(agent.asked[3].startsWith("POST /v0/providers/codex_work/sign-in/cancel "))
        assertTrue(agent.asked[4].startsWith("PUT /v0/providers/claude%20work/token "))
        assertEquals("sk-ant-oat01-abc", body(4)["token"]!!.toString().trim('"'))
        // No method: the agent picks.
        val joined = Agent(mapOf("POST /v0/providers/x/sign-in" to listOf(200 to signIn())))
        AgentProviderSignIns(AgentClient(joined, "t")).start("x", null)
        assertFalse(json("{" + joined.asked[0].substringAfter(" {")).containsKey("method"))
    }

    @Test
    fun refusalsAreTypedWithTheObjectA409Carries() = runBlocking {
        val notInstalled = JsonObject(json(signIn(installed = false)) + json("""{"error":"codex is not installed","code":"not_installed"}"""))
        val agent = Agent(
            mapOf(
                "POST /v0/providers/a/sign-in" to listOf(
                    403 to """{"error":"Only the team owner may.","code":"forbidden"}""",
                    409 to notInstalled.toString(),
                    409 to """{"error":"bedrock cannot sign in","code":"not_supported"}""",
                    400 to """{"error":"method must be one of device","code":"invalid_request"}""",
                ),
                "POST /v0/providers/a/sign-in/code" to listOf(409 to """{"error":"Nothing is waiting for a code.","code":"conflict"}"""),
            ),
        )
        val backend = AgentProviderSignIns(AgentClient(agent, "t"))
        suspend fun refusal(call: suspend () -> Unit): ProviderSignInException {
            try {
                call()
            } catch (e: ProviderSignInException) {
                return e
            }
            fail("not refused")
            throw AssertionError()
        }
        assertEquals(ProviderSignInRefusal.Forbidden, refusal { backend.start("a", "device") }.refusal)
        val missing = refusal { backend.start("a", "device") }
        assertEquals(ProviderSignInRefusal.NotInstalled, missing.refusal)
        assertEquals(false, missing.current!!.installed)
        assertEquals(ProviderSignInRefusal.NotSupported, refusal { backend.start("a", "device") }.refusal)
        val invalid = refusal { backend.start("a", "browser") }
        assertEquals(ProviderSignInRefusal.Invalid, invalid.refusal)
        assertEquals("method must be one of device", invalid.said)
        assertEquals(ProviderSignInRefusal.Conflict, refusal { backend.sendCode("a", "c") }.refusal)
    }

    @Test
    fun usageSaysWhenEachAccountWasUsedAndHowItsLoginRefreshes() {
        val config = json(
            """{"config":{"providers":{
              "codex":{"type":"codex","enabled":false,"credential":{"source":"system","methods":["device"],"acceptsToken":false}},
              "claude":{"type":"claude","credential":{"source":"internal","methods":["browser"],"acceptsToken":true}},
              "grok":{"type":"grok","credential":{"source":"internal","methods":["device"],"acceptsToken":false}}}}}""",
        )
        val usage = json(
            """{"providers":[
              {"providerId":"codex","signIn":"signed_in","refreshedAt":90,"usage":{"planName":"Plus"},"lastUsedAt":80,
               "login":{"refreshedAt":70,"expiresAt":900,"refreshError":{"status":503,"code":null,"permanent":false,"since":50,"at":60}}},
              {"providerId":"claude","signIn":"unknown","lastUsedAt":null,"login":null},
              {"providerId":"grok","signIn":"signed_in","refreshedAt":90}]}""",
        )
        val (codex, claude, grok) = ProviderSignIns.accounts(config, usage)
        assertFalse(codex.enabled)
        assertEquals("Plus", codex.plan)
        assertEquals(80L, codex.lastUsedAt)
        assertEquals(AccountLogin(70, 900, LoginRefreshError(503, null, permanent = false, since = 50, at = 60)), codex.login)
        assertTrue(codex.loginReported)
        // Both fields present but empty: still a newer agent's answer.
        assertTrue(claude.enabled)
        assertEquals("unknown", claude.signIn)
        assertNull(claude.login)
        assertTrue(claude.loginReported)
        // An older agent: neither field, only when usage looked.
        assertFalse(grok.loginReported)
        assertEquals(90L, grok.checkedAt)
    }

    @Test
    fun anAccountsStatusIsTheFirstThatApplies() {
        val now = 1_000_000_000L
        val hour = 3_600_000L
        val credential = ProviderCredential(CredentialSource.Internal, listOf("device"), acceptsToken = false)
        val system = credential.copy(source = CredentialSource.System)
        val working = ProviderAccount("a", null, "codex", credential, signIn = "signed_in", lastUsedAt = now - 1, login = AccountLogin(now - 2, now + 30 * hour, null), loginReported = true)
        fun transient(since: Long = now - hour) = LoginRefreshError(503, null, permanent = false, since = since, at = now - 5)
        fun of(account: ProviderAccount, with: ProviderCredential = credential) = AccountStatus.of(account, with, now)

        assertEquals(AccountStatus(AccountDot.Green, AccountLine.Healthy(false, now - 1, now - 2)), of(working))
        assertEquals(AccountStatus(AccountDot.Green, AccountLine.Healthy(true, now - 1, now - 2)), of(working, system))
        // Not known to work, nor not to.
        assertEquals(AccountDot.Grey, of(working.copy(signIn = "unknown")).dot)
        assertEquals(AccountDot.Grey, of(working.copy(signIn = null)).dot)
        // Off first, whatever else is wrong.
        assertEquals(AccountStatus(AccountDot.Grey, AccountLine.Off), of(working.copy(enabled = false, signIn = "signed_out")))
        assertEquals(AccountStatus(AccountDot.Red, AccountLine.NeedsSignIn(null)), of(working.copy(signIn = "signed_out")))
        val permanent = LoginRefreshError(400, "invalid_grant", permanent = true, since = now - 50 * hour, at = now - 5)
        assertEquals(AccountStatus(AccountDot.Red, AccountLine.NeedsSignIn(now - 50 * hour)), of(working.copy(login = AccountLogin(null, null, permanent))))
        // A transient error: its code, else its HTTP status; the expiry only within a day.
        assertEquals(AccountStatus(AccountDot.Amber, AccountLine.RefreshFailed("HTTP 503", now - 5)), of(working.copy(login = AccountLogin(null, now + 30 * hour, transient()))))
        assertEquals(
            AccountStatus(AccountDot.Amber, AccountLine.RefreshFailed("server_error", now - 5, expiresAt = now + 3 * hour)),
            of(working.copy(login = AccountLogin(null, now + 3 * hour, transient().copy(code = "server_error")))),
        )
        assertEquals(AccountLine.RefreshFailed(null, now - 5), of(working.copy(login = AccountLogin(null, null, transient().copy(status = null)))).line)
        // A login running out with nothing failing is no warning, nor one that needs signing in anyway.
        assertEquals(AccountLine.Healthy(false, now - 1, now - 2), of(working.copy(login = AccountLogin(now - 2, now + hour, null))).line)
        assertEquals(AccountLine.NeedsSignIn(now - 50 * hour), of(working.copy(login = AccountLogin(null, now + hour, permanent))).line)
        // An older agent: when usage looked, and its signIn's dot.
        assertEquals(AccountStatus(AccountDot.Green, AccountLine.Checked(true, 77)), of(ProviderAccount("a", null, "codex", system, signIn = "signed_in", checkedAt = 77), system))
    }

    @Test
    fun switchingAnAccountShowsAtOnceAndARefusalPutsItBack() = runTest {
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 16)
        val backend = Backend(mutableMapOf("codex_work" to parsed("v1")))
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
        val accounts = ProviderAccounts(backend, events, scope)
        val following = accounts.follow()
        advanceUntilIdle()
        backend.asked.clear()
        backend.accountList = backend.accountList.map { it.copy(enabled = false) }
        accounts.setEnabled("codex_work", false)
        advanceUntilIdle()
        // Configuration is read again; the objects aren't.
        assertEquals(listOf("enabled codex_work false", "accounts"), backend.asked)
        assertFalse((accounts.accounts.value as ProviderAccountsState.Loaded).accounts.single().enabled)
        backend.refuse = ProviderSignInException(ProviderSignInRefusal.Forbidden, "Only the team owner may.")
        try {
            accounts.setEnabled("codex_work", true)
            fail("not refused")
        } catch (_: ProviderSignInException) {
        }
        assertFalse((accounts.accounts.value as ProviderAccountsState.Loaded).accounts.single().enabled)
        assertTrue(accounts.ownerOnly.value)
        // Usage changing reads the accounts alone.
        advanceUntilIdle()
        backend.asked.clear()
        events.emit(AgentEvent(null, "provider.usage.updated", JsonObject(emptyMap())))
        advanceUntilIdle()
        assertEquals(listOf("accounts"), backend.asked)
        following.close()
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    }

    @Test
    fun aStepIsTheOperationThisPageStartedNeverAnOlderResult() {
        fun of(op: String?, opId: String? = "op1", sent: Boolean = false) =
            SignInStep.of(op?.let { ProviderSignIn.parse(json(signIn(operation = it))) }, opId, sent)
        // An older operation's result on the object is not this sign-in's.
        assertEquals(SignInStep.Starting, of(operation(id = "op0", status = "failed", error = """{"code":"expired","message":"x"}""")))
        assertEquals(SignInStep.Starting, of(operation(status = "succeeded"), opId = null))
        assertEquals(SignInStep.Starting, of(operation(status = "running")))
        assertEquals(SignInStep.Device("https://auth.openai.com/codex/device", "K7QF-9WXM"), of(operation(status = "waiting", authorization = device)))
        assertEquals(SignInStep.PasteCode("https://claude.ai/oauth/authorize", checking = false), of(operation(status = "waiting", authorization = claudePage)))
        assertEquals(SignInStep.PasteCode("https://claude.ai/oauth/authorize", checking = true), of(operation(status = "waiting", authorization = claudePage), sent = true))
        // Exchanging the pasted code.
        assertEquals(SignInStep.PasteCode("https://claude.ai/oauth/authorize", checking = true), of(operation(status = "running", authorization = claudePage)))
        assertEquals(SignInStep.OnComputer("http://localhost:1455/auth"), of(operation(status = "waiting", authorization = codexBrowser)))
        assertEquals(SignInStep.Done("ada@example.com", "Pro"), of(operation(status = "succeeded")))
        assertEquals(SignInStep.Cancelled, of(operation(status = "cancelled")))
        assertEquals(
            SignInStep.Failed(SignInFailure.Expired, "The code expired."),
            of(operation(status = "failed", error = """{"code":"expired","message":"The code expired."}""")),
        )
        assertEquals(SignInFailure.SaveFailed, (of(operation(status = "failed", error = """{"code":"save_failed","message":"x"}""")) as SignInStep.Failed).failure)
        assertEquals(SignInFailure.Failed, (of(operation(status = "failed", error = """{"code":"interrupted","message":"x"}""")) as SignInStep.Failed).failure)
    }

    /** A backend that answers from [answers] and counts what was asked. */
    private class Backend(var answers: MutableMap<String, ProviderSignIn>, var refuse: ProviderSignInException? = null) : ProviderSignInBackend {
        val asked = mutableListOf<String>()
        var accountList = listOf(ProviderAccount("codex_work", null, "codex", ProviderCredential(CredentialSource.System, listOf("device"), false)))
        override suspend fun accounts() = accountList.also { asked += "accounts" }
        override suspend fun read(providerId: String) = answers.getValue(providerId).also { asked += "read $providerId" }
        override suspend fun start(providerId: String, method: String?): ProviderSignIn {
            asked += "start $providerId $method"
            refuse?.let { throw it }
            return answers.getValue(providerId)
        }
        override suspend fun sendCode(providerId: String, code: String) = answers.getValue(providerId).also { asked += "code" }
        override suspend fun cancel(providerId: String) = answers.getValue(providerId).also { asked += "cancel $providerId" }
        override suspend fun saveToken(providerId: String, token: String): ProviderSignIn {
            asked += "token"
            refuse?.let { throw it }
            return answers.getValue(providerId)
        }
        override suspend fun setEnabled(providerId: String, enabled: Boolean) {
            asked += "enabled $providerId $enabled"
            refuse?.let { throw it }
        }
    }

    private fun parsed(version: String, op: String = "null", source: String = "system") =
        ProviderSignIn.parse(json(signIn(version = version, operation = op, source = source)))!!

    private fun event(signIn: String) = AgentEvent(null, ProviderSignIns.UPDATED, json(signIn))

    @Test
    fun eventsAndAnswersKeepTheGreaterVersionAndReadsFollowTheConfiguration() = runTest {
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 16)
        val backend = Backend(mutableMapOf("codex_work" to parsed("v2")))
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
        val accounts = ProviderAccounts(backend, events, scope)
        advanceUntilIdle()
        // Nothing is read until a page follows.
        assertTrue(backend.asked.isEmpty())
        val following = accounts.follow()
        advanceUntilIdle()
        assertEquals(listOf("accounts", "read codex_work"), backend.asked)
        assertEquals(ProviderAccountsState.Loaded(backend.accountList), accounts.accounts.value)
        assertEquals("v2", accounts.signIns.value["codex_work"]!!.version)
        // An older event is dropped; a newer one replaces.
        events.emit(event(signIn(version = "v1", source = "internal")))
        advanceUntilIdle()
        assertEquals("v2", accounts.signIns.value["codex_work"]!!.version)
        events.emit(event(signIn(version = "v3", source = "internal")))
        advanceUntilIdle()
        assertEquals(CredentialSource.Internal, accounts.signIns.value["codex_work"]!!.credential.source)
        // config.updated and a reconnect read again while followed, and not after.
        backend.asked.clear()
        events.emit(AgentEvent(null, "config.updated", JsonObject(emptyMap())))
        advanceUntilIdle()
        assertEquals(listOf("accounts", "read codex_work"), backend.asked)
        following.close()
        backend.asked.clear()
        events.emit(AgentEvent(null, AgentEvent.HELLO, JsonObject(emptyMap())))
        advanceUntilIdle()
        assertTrue(backend.asked.isEmpty())
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    }

    @Test
    fun aForbiddenChangeMakesTheAccountsTheOwnersAlone() = runTest {
        val backend = Backend(mutableMapOf("codex_work" to parsed("v1")), refuse = ProviderSignInException(ProviderSignInRefusal.Forbidden, "Only the team owner may."))
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
        val accounts = ProviderAccounts(backend, MutableSharedFlow(), scope)
        assertFalse(accounts.ownerOnly.value)
        val run = ProviderSignInRun(accounts, "codex_work", scope)
        run.start("device")
        advanceUntilIdle()
        assertTrue(accounts.ownerOnly.value)
        assertEquals(SignInStep.Failed(SignInFailure.OwnerOnly, "Only the team owner may."), run.step.value)
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    }

    @Test
    fun aRunFollowsItsOperationAndLeavingCancelsItOnlyWhileUnfinished() = runTest {
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 16)
        val backend = Backend(mutableMapOf("codex_work" to parsed("v2", operation(status = "running"))))
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
        val leaving = CoroutineScope(StandardTestDispatcher(testScheduler))
        val accounts = ProviderAccounts(backend, events, scope)
        val run = ProviderSignInRun(accounts, "codex_work", scope, leaving)
        run.start("device")
        advanceUntilIdle()
        assertEquals("start codex_work device", backend.asked.single())
        assertEquals(SignInStep.Starting, run.step.value)
        events.emit(event(signIn(version = "v3", operation = operation(status = "waiting", authorization = device))))
        advanceUntilIdle()
        assertEquals(SignInStep.Device("https://auth.openai.com/codex/device", "K7QF-9WXM"), run.step.value)
        // Left while waiting: cancelled on the agent.
        run.close()
        advanceUntilIdle()
        assertEquals("cancel codex_work", backend.asked.last())
        // Finished: leaving sends nothing.
        backend.asked.clear()
        events.emit(event(signIn(version = "v4", operation = operation(status = "succeeded"))))
        advanceUntilIdle()
        assertEquals(SignInStep.Done("ada@example.com", "Pro"), run.step.value)
        run.close()
        advanceUntilIdle()
        assertTrue(backend.asked.isEmpty())
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    }

    @Test
    fun theFixtureDaemonServesTheContractToTheRealClient() {
        // The debug fixture's agent answers what the live client asks (see ProviderSignInDaemon).
        val scope = CoroutineScope(kotlinx.coroutines.SupervisorJob())
        val daemon = com.slopus.happy.ui.connection.ProviderSignInDaemon("normal", scope)
        val backend = AgentProviderSignIns(AgentClient(daemon, "t"))
        runBlocking {
            val accounts = backend.accounts()
            assertEquals(listOf("codex", "claude_work", "grok"), accounts.map { it.id })
            assertEquals(true, accounts.last().signedOut)
            assertEquals(SignInOperation.Status.Running, backend.start("codex", "device").operation!!.status)
            // A second start joins.
            assertEquals(backend.read("codex").operation!!.id, backend.start("codex", "device").operation!!.id)
            try {
                backend.start("codex", "magic")
                fail("not refused")
            } catch (e: ProviderSignInException) {
                assertEquals(ProviderSignInRefusal.Invalid, e.refusal)
            }
            try {
                backend.saveToken("claude_work", "not-a-token")
                fail("not refused")
            } catch (e: ProviderSignInException) {
                assertEquals(ProviderSignInRefusal.Invalid, e.refusal)
            }
            assertEquals(CredentialSource.Internal, backend.saveToken("claude_work", " sk-ant-oat01-x ").credential.source)
            assertEquals(SignInOperation.Status.Cancelled, backend.cancel("codex").operation!!.status)
            backend.setEnabled("grok", false)
            assertFalse(backend.accounts().last().enabled)
        }
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    }

    @Test
    fun theFixtureDaemonsStatesSceneHasEveryLineAndItsLegacySceneNone() {
        val scope = CoroutineScope(kotlinx.coroutines.SupervisorJob())
        fun accounts(scene: String) = runBlocking { AgentProviderSignIns(AgentClient(com.slopus.happy.ui.connection.ProviderSignInDaemon(scene, scope), "t")).accounts() }
        val now = System.currentTimeMillis()
        val lines = accounts("states").map { AccountStatus.of(it, it.credential, now).line::class.simpleName }.toSet()
        assertEquals(setOf("Off", "NeedsSignIn", "RefreshFailed", "Healthy"), lines)
        assertTrue(accounts("legacy").none { it.loginReported })
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    }
}

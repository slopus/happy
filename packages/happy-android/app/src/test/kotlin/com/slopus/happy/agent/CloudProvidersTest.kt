package com.slopus.happy.agent

import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.ModeCatalog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Adding AI providers to a Happy Cloud server (onboarding contract v1), against a fake server. */
@OptIn(ExperimentalCoroutinesApi::class)
class CloudProvidersTest {
    /** Answers by "METHOD path", in turn where a route lists several answers; records each request and its body. */
    private class Server(answers: Map<String, List<Pair<Int, String>>>) : Transport {
        private val queues = answers.mapValues { ArrayDeque(it.value) }.toMutableMap()
        val asked = mutableListOf<Pair<String, JsonObject?>>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path" to body?.let { Json.parseToJsonElement(it.decodeToString()).jsonObject }
            val queue = queues["$method $path"]
            val (status, text) = (if (queue != null && queue.size > 1) queue.removeFirst() else queue?.firstOrNull()) ?: (404 to """{"error":"Not found","code":"not_found"}""")
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    private val listing = """{"providers":[
        {"id":"operator:openai","name":"Happy (free)","scope":"team","source":"operator","vendors":["openai"],"models":["openai/gpt-6.1-terra"],"enabled":true,"credentialCount":0},
        {"id":"private","name":"Personal","scope":"private","source":"tenant","vendors":["codex"],"models":["openai/gpt-6.1-terra"],"credentialCount":2,
         "credentials":[{"id":"k1","vendor":"codex","kind":"oauth","label":"ChatGPT Pro","enabled":true,"state":"ready"},
                        {"id":"k2","vendor":"anthropic","kind":"api_key","label":"Old key","enabled":true,"state":"invalid"}]},
        {"id":"anthropic","name":"Anthropic","scope":"team","source":"tenant","vendors":[],"models":[],"credentialCount":1}]}"""

    private fun operation(status: String, authorization: String = "null", error: String = "null") =
        """{"providerCli":{"id":"codex","operation":{"id":"q1","kind":"sign_in","status":"$status","message":"m","authorization":$authorization,"error":$error}}}"""

    private val device = """{"method":"device","url":"https://auth.openai.com/codex/device","userCode":"ABCD-1234","acceptsCode":false,"expiresAt":1755400600000}"""

    @Test
    fun connectionsListAsTheServerNamesThem() = runBlocking {
        val connections = CloudProviders.list(AgentClient(Server(mapOf("GET /v0/cloud/providers" to listOf(200 to listing))), "t"))
        assertEquals(listOf("operator:openai", "private", "anthropic"), connections.map { it.id })
        assertTrue(connections[0].included)
        assertTrue(connections[1].private)
        assertTrue(connections[1].credentials[1].needsAttention)
        // No `enabled` yet: a connection with nothing to run is off.
        assertTrue(connections[1].enabled)
        assertFalse(connections[2].enabled)
    }

    @Test
    fun aKeyGoesToItsDestinationAndARefusalSaysWhy() = runBlocking {
        val server = Server(
            mapOf(
                "POST /v0/cloud/providers/private/credentials" to listOf(201 to """{"providerId":"private","credentialId":"k3","duplicate":false}"""),
                "POST /v0/cloud/providers/openai/credentials" to listOf(422 to """{"error":"The vendor rejected the credential.","code":"credential_check_failed"}"""),
            ),
        )
        val client = AgentClient(server, "t")
        CloudProviders.addCredential(client, CloudProviders.container(CloudDestination.Private, "anthropic"), "anthropic", "api_key", "sk-ant-x")
        assertEquals("""{"vendor":"anthropic","kind":"api_key","secret":"sk-ant-x"}""", server.asked.single().second.toString())
        try {
            CloudProviders.addCredential(client, CloudProviders.container(CloudDestination.Team, "openai"), "openai", "api_key", "sk-x")
            fail()
        } catch (e: CloudProviderException) {
            assertEquals("credential_check_failed", e.kind)
            assertEquals("The vendor rejected the credential.", e.message)
        }
    }

    @Test
    fun whatMayBeAddedIsTheServersWordElseTheListedSignIns() = runBlocking {
        val said = AgentClient(Server(mapOf("GET /v0/cloud/providers" to listOf(200 to """{"providers":[],"capabilities":{"apiKeys":true,"claudeSetupToken":true,"codexSignIn":false,"claudeSignIn":true}}"""))), "t")
        assertEquals(CloudCapabilities(apiKeys = true, claudeSetupToken = true, codexSignIn = false), CloudProviders.capabilities(said))
        val silent = AgentClient(
            Server(
                mapOf(
                    "GET /v0/cloud/providers" to listOf(200 to listing),
                    "GET /v0/provider-clis" to listOf(200 to """{"providerClis":[{"id":"codex"},{"id":"claude"}]}"""),
                ),
            ),
            "t",
        )
        assertEquals(CloudCapabilities(apiKeys = true, claudeSetupToken = false, codexSignIn = true), CloudProviders.capabilities(silent))
    }

    @Test
    fun signInsNotMountedYetOfferNone() = runBlocking {
        val client = AgentClient(Server(mapOf("GET /v0/provider-clis" to listOf(501 to """{"error":"machine local","code":"machine_local"}"""))), "t")
        assertEquals(emptySet<String>(), CloudProviders.signIns(client))
        val live = AgentClient(Server(mapOf("GET /v0/provider-clis" to listOf(200 to """{"providerClis":[{"id":"codex"},{"id":"claude"}]}"""))), "t")
        assertEquals(setOf("codex", "claude"), CloudProviders.signIns(live))
    }

    @Test
    fun chatGptsDeviceSignInShowsTheCodeThenFollowsItToTheEnd() = runTest {
        val server = Server(
            mapOf(
                "POST /v0/provider-clis/codex/sign-in" to listOf(200 to operation("waiting", device)),
                // A read lost while the browser is up (the app in the background) is read again.
                "GET /v0/provider-clis/codex" to listOf(200 to operation("waiting", device), 503 to """{"error":"Unavailable","code":"unavailable"}""", 200 to operation("succeeded")),
            ),
        )
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val run = CloudSignInRun(AgentClient(server, "t"), scope, CloudProviders.OPENAI, CloudDestination.Team, pollMillis = 3_000)
        run.start()
        runCurrent()
        assertEquals(CloudSignInRun.State.Waiting("https://auth.openai.com/codex/device", "ABCD-1234", acceptsCode = false), run.current.value)
        val start = server.asked.first().second!!
        assertEquals("device", start["method"].toString().trim('"'))
        assertEquals("""{"providerId":"codex"}""", start["target"].toString())
        advanceTimeBy(3_001)
        assertTrue(run.current.value is CloudSignInRun.State.Waiting)
        advanceTimeBy(3_001)
        assertTrue(run.current.value is CloudSignInRun.State.Waiting)
        advanceTimeBy(3_001)
        assertEquals(CloudSignInRun.State.Done, run.current.value)
        run.close()
        runCurrent()
        // Done: nothing is cancelled.
        assertTrue(server.asked.none { it.first.endsWith("/cancel") })
        scope.cancel()
    }

    @Test
    fun claudesPastedCodeGoesToTheServerAndAnExpiredOneSaysSo() = runTest {
        val browser = """{"method":"browser","url":"https://claude.com/cai/oauth/authorize?x=1","userCode":null,"acceptsCode":true,"expiresAt":1}"""
        val server = Server(
            mapOf(
                "POST /v0/provider-clis/claude/sign-in" to listOf(200 to operation("waiting", browser)),
                "GET /v0/provider-clis/claude" to listOf(200 to operation("waiting", browser)),
                "POST /v0/provider-clis/claude/sign-in/code" to listOf(200 to operation("failed", error = """{"code":"expired","message":"The sign-in code expired. Start again."}""")),
            ),
        )
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val run = CloudSignInRun(AgentClient(server, "t"), scope, CloudProviders.ANTHROPIC, CloudDestination.Private)
        run.start()
        runCurrent()
        assertTrue((run.current.value as CloudSignInRun.State.Waiting).acceptsCode)
        assertEquals("""{"scope":"private"}""", server.asked.first().second!!["target"].toString())
        assertEquals("browser", server.asked.first().second!!["method"].toString().trim('"'))
        run.sendCode("  pasted-code \n")
        runCurrent()
        val code = server.asked.first { it.first.endsWith("/sign-in/code") }.second!!
        assertEquals("pasted-code", code["code"].toString().trim('"'))
        assertEquals(CloudSignInRun.State.Failed("expired", "The sign-in code expired. Start again."), run.current.value)
        scope.cancel()
    }

    @Test
    fun leavingASignInUnderWayCancelsIt() = runTest {
        val server = Server(
            mapOf(
                "POST /v0/provider-clis/codex/sign-in" to listOf(200 to operation("waiting", device)),
                "POST /v0/provider-clis/codex/cancel" to listOf(200 to operation("cancelled")),
            ),
        )
        val page = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val leaving = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val run = CloudSignInRun(AgentClient(server, "t"), page, CloudProviders.OPENAI, CloudDestination.Private, leaving = leaving)
        run.start()
        runCurrent()
        // As a page goes: its effects end, then its scope.
        run.close()
        page.cancel()
        runCurrent()
        assertTrue(server.asked.any { it.first == "POST /v0/provider-clis/codex/cancel" })
        leaving.cancel()
    }

    @Test
    fun theModelPickerOffersConnectionsAndSendsTheirIds() {
        val config = Json.parseToJsonElement(
            """{"config":{"models":{"openai/gpt-6.1-terra":{"name":"GPT-6.1 Terra","efforts":["low","medium"],"defaultEffort":"medium"}},
               "providers":{"openai":{"type":"openai","models":[{"id":"openai/gpt-6.1-terra"}]}},
               "defaults":{"providerId":"operator:openai","modelId":"openai/gpt-6.1-terra"}}}""",
        ).jsonObject
        val connections = Json.parseToJsonElement(listing).jsonObject["providers"]!!.let { it as kotlinx.serialization.json.JsonArray }.map { CloudConnection.parse(it.jsonObject)!! }
        val catalog = ModeCatalog.withConnections(ModeCatalog.parse(config), connections)
        assertEquals(listOf("operator:openai", "private", "anthropic"), catalog.providers.map { it.id })
        assertEquals("GPT-6.1 Terra", catalog.provider("private")!!.models.single().name)
        assertTrue(catalog.provider("anthropic")!!.isDisabled)
        val picked = catalog.pick(catalog.defaults!!, "private", "openai/gpt-6.1-terra")
        assertEquals("private", picked.providerId)
        assertEquals("medium", picked.effort)
    }

    @Test
    fun aGrokKeyGoesToGroksTeamContainer() = runBlocking {
        val server = Server(mapOf("POST /v0/cloud/providers/grok/credentials" to listOf(201 to """{"providerId":"grok","credentialId":"k4"}""")))
        CloudProviders.addCredential(AgentClient(server, "t"), CloudProviders.container(CloudDestination.Team, CloudProviders.GROK), CloudProviders.GROK, "api_key", "xai-x")
        assertEquals("POST /v0/cloud/providers/grok/credentials" to """{"vendor":"grok","kind":"api_key","secret":"xai-x"}""", server.asked.single().let { it.first to it.second.toString() })
    }

    @Test
    fun anEndpointIsSuggestedAnIdAndCheckedAsTheServerWould() {
        assertEquals("acme-vllm", CustomProvider.idFor("Acme vLLM"))
        assertEquals("llm-box", CustomProvider.idFor("  42 LLM box!! "))
        assertEquals("", CustomProvider.idFor("123"))
        assertEquals(32, CustomProvider.idFor("a".repeat(40)).length)
        val good = CustomProvider("Acme vLLM", "acme", "https://llm.example.com/v1", "llama-4-70b, qwen-3 llama-4-70b", "sk-x")
        assertEquals(null, good.problem())
        assertEquals(listOf("llama-4-70b", "qwen-3"), good.modelIds)
        assertEquals(CustomProvider.Problem.Name, good.copy(name = " ").problem())
        assertEquals(CustomProvider.Problem.Id, good.copy(id = "Acme").problem())
        assertEquals(CustomProvider.Problem.Id, good.copy(id = "a").problem())
        assertEquals(CustomProvider.Problem.BaseUrl, good.copy(baseUrl = "http://llm.example.com/v1").problem())
        assertEquals(CustomProvider.Problem.Models, good.copy(models = " , ").problem())
        assertEquals(CustomProvider.Problem.ApiKey, good.copy(apiKey = " ").problem())
    }

    @Test
    fun anEndpointIsDefinedWithItsKeyButNeverOverATakenId() = runBlocking {
        val draft = CustomProvider("Acme vLLM", "acme", " https://llm.example.com/v1 ", "llama-4-70b, qwen-3", "sk-own")
        val server = Server(mapOf("PUT /v0/providers/acme" to listOf(200 to """{"providerId":"acme","type":"openai_compatible"}""")))
        CloudProviders.defineCustom(AgentClient(server, "t"), draft)
        assertEquals(listOf("GET /v0/providers/acme", "PUT /v0/providers/acme"), server.asked.map { it.first })
        val body = server.asked.last().second!!
        assertEquals(
            """{"name":"Acme vLLM","baseUrl":"https://llm.example.com/v1","protocol":"openai_responses","models":[{"id":"llama-4-70b"},{"id":"qwen-3"}],"apiKey":"sk-own"}""",
            JsonObject(body - "mutationId").toString(),
        )
        val taken = Server(mapOf("GET /v0/providers/acme" to listOf(200 to """{"providerId":"acme"}""")))
        try {
            CloudProviders.defineCustom(AgentClient(taken, "t"), draft)
            fail()
        } catch (e: CloudProviderException) {
            assertEquals(CustomProvider.EXISTS, e.kind)
        }
        assertEquals(listOf("GET /v0/providers/acme"), taken.asked.map { it.first })
        val refused = Server(mapOf("PUT /v0/providers/acme" to listOf(400 to """{"error":{"code":"invalid","message":"`baseUrl` must not be a private address."}}""")))
        try {
            CloudProviders.defineCustom(AgentClient(refused, "t"), draft)
            fail()
        } catch (e: CloudProviderException) {
            assertEquals("`baseUrl` must not be a private address.", e.message)
        }
    }
}

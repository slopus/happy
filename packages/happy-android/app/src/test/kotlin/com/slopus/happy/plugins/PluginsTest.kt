package com.slopus.happy.plugins

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

/** A Happy Cloud server's plugins (happy-cluster API.md, "Plugins"), against a fake server. */
@OptIn(ExperimentalCoroutinesApi::class)
class PluginsTest {
    /** Answers by "METHOD path", in turn where a route lists several; records each request with its body. */
    private class Server(answers: Map<String, List<Pair<Int, String>>>) : Transport {
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

    private val catalog = """{"plugins":[
        {"id":"linear","name":"Linear","description":"Issues.","version":"1.0.0","image":null,"tools":[],"auth":{"required":false,"methods":[]}},
        {"id":"github","name":"GitHub","description":"Repositories and pull requests.","version":"2.1.0",
         "image":{"digest":"sha256:ab","mime":"image/png","thumbhash":"3OcRJYB4d3h/iIeHeEh3eIhw+j2w"},
         "tools":[{"name":"list_repos","summary":"Lists repositories."}],
         "auth":{"required":true,"methods":[
           {"id":"install","label":"Install the GitHub App","type":"oauth","scopes":["repo"]},
           {"id":"token","label":"Personal access token","type":"fields","fields":[{"key":"token","label":"Token","help":"Starts with ghp_.","required":true,"secret":true,"multiline":false}]},
           {"id":"later","label":"Future","type":"passkey"}]}}]}"""

    private val installations = """{"installations":[
        {"id":"i1","plugin":"github","pluginName":"GitHub","ordinal":1,"label":null,"status":"not_configured","reason":null,"authMethod":null,"toolPrefix":"plugin_github_","image":null,"available":true},
        {"id":"i2","plugin":"github","pluginName":"GitHub","ordinal":2,"label":"Acme","status":"not_configured","reason":"method_unavailable","authMethod":"install","toolPrefix":"plugin_github_2_","image":null,"available":true},
        {"id":"i3","plugin":"jira","pluginName":null,"ordinal":1,"label":null,"status":"active","reason":null,"authMethod":"key","toolPrefix":"plugin_jira_","image":null,"available":false}]}"""

    private fun backend(server: Server, canManage: Boolean = true) = ClusterPlugins(AgentClient(server, "t", cloud = true)) { canManage }

    @Test
    fun theCatalogAndInstallationsReadAsTheServerSaysThem() = runBlocking {
        val snapshot = backend(Server(mapOf("GET /v0/plugins" to listOf(200 to catalog), "GET /v0/plugins/installations" to listOf(200 to installations))))
            .read()!!
        assertEquals(listOf("GitHub", "Linear"), snapshot.plugins.map { it.name })
        val github = snapshot.plugin("github")!!
        assertEquals(PluginImage("/v0/plugins/images/sha256%3Aab", "3OcRJYB4d3h/iIeHeEh3eIhw+j2w"), github.image)
        assertEquals(listOf(PluginTool("list_repos", "Lists repositories.")), github.tools)
        // An auth method this app doesn't know is left out.
        assertEquals(
            listOf(
                PluginAuthMethod.OAuth("install", "Install the GitHub App", listOf("repo")),
                PluginAuthMethod.Fields("token", "Personal access token", listOf(PluginField("token", "Token", "Starts with ghp_.", true, true, false))),
            ),
            github.authMethods,
        )
        assertEquals(
            listOf(InstallationStatus.NeedsSetup, InstallationStatus.MethodUnavailable, InstallationStatus.Active),
            snapshot.installations.map { it.status },
        )
        assertEquals(listOf("GitHub", "GitHub", "jira"), snapshot.installations.map { it.name })
        assertEquals(listOf(true, true, false), snapshot.installations.map { it.available })
        assertEquals(listOf("linear"), snapshot.available.map { it.key })
        assertEquals(true, snapshot.canManage)
    }

    @Test
    fun aMemberWhoMayNotReadInstallationsSeesTheCatalogAlone() = runBlocking {
        val server = Server(
            mapOf(
                "GET /v0/plugins" to listOf(200 to catalog),
                "GET /v0/plugins/installations" to listOf(403 to """{"error":"This needs the mcp.manage permission.","code":"forbidden"}"""),
            ),
        )
        val snapshot = backend(server, canManage = false).read()!!
        assertEquals(emptyList<PluginInstallation>(), snapshot.installations)
        assertEquals(false, snapshot.canManage)
        assertEquals(2, snapshot.available.size)
    }

    @Test
    fun theInstallationsListSaysWhoMayManageWhenItCan() = runBlocking {
        val server = Server(
            mapOf("GET /v0/plugins" to listOf(200 to catalog), "GET /v0/plugins/installations" to listOf(200 to """{"installations":[],"canManage":false}""")),
        )
        assertEquals(false, backend(server, canManage = true).read()!!.canManage)
    }

    @Test
    fun aServerWithoutPluginsSaysSo() = runBlocking {
        assertNull(backend(Server(mapOf("GET /v0/plugins" to listOf(501 to """{"error":"No.","code":"unsupported"}""")))).read())
        assertNull(backend(Server(emptyMap())).read())
    }

    @Test
    fun writesSendWhatTheApiAsks() = runBlocking {
        val server = Server(
            mapOf(
                "POST /v0/plugins/installations" to listOf(201 to """{"installation":{"id":"i9","plugin":"github"}}"""),
                "POST /v0/plugins/installations/i9/configure" to listOf(200 to """{"installation":{"id":"i9","plugin":"github","status":"active"}}"""),
                "POST /v0/plugins/installations/i9/connect" to listOf(200 to """{"authorizeUrl":"https://github.com/apps/happy/installations/new?state=s"}"""),
                "POST /v0/plugins/installations/i9/disconnect" to listOf(200 to """{"installation":{"id":"i9","plugin":"github"},"removed":["s1"]}"""),
                "DELETE /v0/plugins/installations/i9" to listOf(200 to """{"deleted":true,"secretsDeleted":1,"cleanedUpOutside":true}"""),
            ),
        )
        val plugins = backend(server)
        val github = ClusterPlugins.plugin(kotlinx.serialization.json.Json.parseToJsonElement("""{"id":"github"}""") as JsonObject)!!
        assertEquals("i9", plugins.install(github))
        plugins.configure("i9", "token", mapOf("token" to "ghp_x"))
        assertEquals("https://github.com/apps/happy/installations/new?state=s", plugins.connect("i9", "install"))
        plugins.disconnect("i9", "s1")
        plugins.disconnect("i9")
        plugins.remove("i9")
        assertEquals(
            listOf(
                """POST /v0/plugins/installations {"plugin":"github"}""",
                """POST /v0/plugins/installations/i9/configure {"method":"token","values":{"token":"ghp_x"}}""",
                """POST /v0/plugins/installations/i9/connect {"method":"install"}""",
                """POST /v0/plugins/installations/i9/disconnect {"secretId":"s1"}""",
                """POST /v0/plugins/installations/i9/disconnect {}""",
                "DELETE /v0/plugins/installations/i9",
            ),
            server.asked,
        )
    }

    @Test
    fun refusalsSayWhyInTypedReasons() = runBlocking {
        val server = Server(
            mapOf(
                "POST /v0/plugins/installations/i1/configure" to listOf(422 to """{"error":"Some fields were refused.","code":"invalid_fields","fields":{"token":"GitHub didn't accept this token."}}"""),
                "POST /v0/plugins/installations/i1/connect" to listOf(
                    501 to """{"error":"No connect host.","code":"unsupported"}""",
                    200 to """{"authorizeUrl":"http://evil.example/"}""",
                ),
                "POST /v0/plugins/installations" to listOf(403 to """{"error":"This needs the mcp.manage permission.","code":"forbidden"}"""),
                "DELETE /v0/plugins/installations/gone" to listOf(404 to """{"error":"Not found","code":"not_found"}"""),
            ),
        )
        val plugins = backend(server)
        suspend fun refusal(block: suspend () -> Unit): PluginRefusal = try {
            block()
            fail("not refused")
            error("unreachable")
        } catch (e: PluginsException) {
            e.refusal
        }
        assertEquals(PluginRefusal.Fields(mapOf("token" to "GitHub didn't accept this token.")), refusal { plugins.configure("i1", "token", mapOf("token" to "bad")) })
        assertEquals(PluginRefusal.Unsupported, refusal { plugins.connect("i1", "install") })
        // Only an https page is opened.
        assertEquals(PluginRefusal.Failed, refusal { plugins.connect("i1", "install") })
        val github = ClusterPlugins.plugin(kotlinx.serialization.json.Json.parseToJsonElement("""{"id":"github"}""") as JsonObject)!!
        assertEquals(PluginRefusal.Forbidden, refusal { plugins.install(github) })
        // Removing one already gone is done.
        plugins.remove("gone")
    }

    @Test
    fun theSourceReadsAgainOnChangesAndAfterWrites() = runTest {
        val server = Server(
            mapOf(
                "GET /v0/plugins" to listOf(200 to catalog),
                "GET /v0/plugins/installations" to listOf(200 to """{"installations":[]}""", 200 to installations),
                "POST /v0/plugins/installations" to listOf(201 to """{"installation":{"id":"i9","plugin":"linear"}}"""),
            ),
        )
        val events = MutableSharedFlow<AgentEvent>()
        val source = PluginsSource(backend(server), events, backgroundScope)
        assertEquals(PluginsState.Loading, source.state.value)
        runCurrent()
        assertEquals(0, (source.state.value as PluginsState.Loaded).snapshot.installations.size)
        events.emit(AgentEvent("c1", "plugins.changed", JsonObject(mapOf())))
        runCurrent()
        assertEquals(3, (source.state.value as PluginsState.Loaded).snapshot.installations.size)
        events.emit(AgentEvent("c2", "skills.updated", JsonObject(mapOf())))
        runCurrent()
        assertEquals(2, server.asked.count { it == "GET /v0/plugins" })
        val linear = (source.state.value as PluginsState.Loaded).snapshot.plugin("linear")!!
        assertEquals("i9", source.write { install(linear) })
        runCurrent()
        assertEquals(3, server.asked.count { it == "GET /v0/plugins" })
    }
}

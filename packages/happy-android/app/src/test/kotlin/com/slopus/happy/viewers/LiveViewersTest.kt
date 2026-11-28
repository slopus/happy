package com.slopus.happy.viewers

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.SyncPhase
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.ByteSource
import com.slopus.happy.connection.HttpResponseParser
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.TailcatHttp
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.connection.TransportStream
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.Socket
import java.net.URI

/**
 * Two people's [AgentSession]s against a real team-mode Happy Agent, the
 * whole wire: the hello's stream, `PUT /v0/viewers/streams/:streamId` and
 * `viewers.updated`. Runs only with `HAPPY_VIEWERS_ENV` naming the JSON the
 * daemon's live fixture writes (happy-agent `viewers-live-serve.local.ts`:
 * `httpUrl`, `aliceToken`, `bobToken`, `aliceId`, `bobId`, `agentId`,
 * `surfaceId`); each step is printed.
 */
@RunWith(AndroidJUnit4::class)
class LiveViewersTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After
    fun tearDown() = scope.cancel()

    /** Plain HTTP/1.1 to the fixture's loopback port, framed by the app's own head writer and parsers. */
    private class PlainTransport(private val host: String, private val port: Int) : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
            runInterruptible(Dispatchers.IO) {
                Socket(host, port).use { socket ->
                    socket.getOutputStream().write(TailcatHttp.requestHead(method, path, port, credential, body, headers, "$host:$port") + (body ?: ByteArray(0)))
                    val parser = HttpResponseParser()
                    val input = socket.getInputStream()
                    val buffer = ByteArray(65536)
                    var response: TransportResponse? = null
                    while (response == null) {
                        val count = input.read(buffer)
                        response = parser.append(if (count < 0) ByteArray(0) else buffer.copyOf(count), eof = count < 0)
                    }
                    response
                }
            }

        override suspend fun stream(path: String, credential: String, headers: Map<String, String>, silenceMillis: Long): TransportStream {
            val socket = runInterruptible(Dispatchers.IO) { Socket(host, port) }
            socket.getOutputStream().write(TailcatHttp.requestHead("GET", path, port, credential, null, headers + ("Accept" to "text/event-stream"), "$host:$port"))
            return TransportStream.open(object : ByteSource {
                private val buffer = ByteArray(65536)
                override suspend fun read(): ByteArray = runInterruptible(Dispatchers.IO) {
                    val count = socket.getInputStream().read(buffer)
                    if (count < 0) ByteArray(0) else buffer.copyOf(count)
                }
                override fun close() = socket.close()
            })
        }

        override suspend fun close() {}
    }

    private suspend fun <T> eventually(what: String, read: () -> T, check: (T) -> Boolean): T {
        withTimeout(20_000) { while (!check(read())) kotlinx.coroutines.delay(50) }
        return read().also { println("ok  $what: $it") }
    }

    @Test
    fun twoPeopleSeeEachOtherArriveAndLeave(): Unit = runBlocking {
        val envFile = System.getenv("HAPPY_VIEWERS_ENV")
        assumeTrue("HAPPY_VIEWERS_ENV names the live fixture's JSON", envFile != null)
        val env = Json.parseToJsonElement(File(envFile!!).readText()).jsonObject
        fun field(name: String) = env[name]!!.jsonPrimitive.content
        val url = URI(field("httpUrl"))
        val secrets = context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val registry = context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val transport = { _: AgentConnectionCredentials -> PlainTransport(url.host, url.port) }
        val connections = AgentConnections(ExpoSecureStore(secrets, SoftwareKeys(), keychainService = AgentConnections.KEYCHAIN_SERVICE), registry, makeTransport = transport)
        val aliceId = connections.add(AgentConnectionCredentials("alice", url.port, "dv-alice", field("aliceToken")), "Team").id
        val bobId = connections.add(AgentConnectionCredentials("bob", url.port, "dv-bob", field("bobToken")), "Team").id
        val alice = AgentSession(aliceId, connections, null, MutableStateFlow(true), scope, transport)
        val bob = AgentSession(bobId, connections, null, MutableStateFlow(true), scope, transport)
        eventually("alice verified", { alice.phase.value }) { it == SyncPhase.Verified }
        eventually("bob verified", { bob.phase.value }) { it == SyncPhase.Verified }

        for (target in listOf(ViewerTarget.agent(field("agentId")), ViewerTarget.surface(field("surfaceId")))) {
            println("--- $target")
            val aliceViews = scope.launch { alice.viewers.view(target) }
            eventually("alice is served", { alice.viewers.availability.value }) { it == ViewersAvailability.Served }
            eventually("alice has an answer", { alice.viewers.lists.value[target] }) { it != null }
            val bobViews = scope.launch { bob.viewers.view(target) }
            val bobHere = eventually("alice hears bob arrive", { alice.viewers.lists.value[target]?.firstOrNull { it.userId == field("bobId") } }) { it?.here == true }
            eventually("bob's answer has alice here", { bob.viewers.lists.value[target]?.firstOrNull { it.userId == field("aliceId") } }) { it?.here == true }
            assertEquals(ViewerTier.Here, ViewerTier.of(bobHere!!, System.currentTimeMillis()))
            bobViews.cancel()
            val bobGone = eventually("alice hears bob leave", { alice.viewers.lists.value[target]?.firstOrNull { it.userId == field("bobId") } }) { it?.here == false }
            assertEquals(ViewerTier.Recent, ViewerTier.of(bobGone!!, System.currentTimeMillis()))
            aliceViews.cancel()
            kotlinx.coroutines.delay(Viewers.SETTLE_MILLIS * 3)
        }
        alice.close()
        bob.close()
    }
}

package com.slopus.happy.net

import com.slopus.happy.testing.cancelAndAwait
import com.slopus.happy.testing.FakeHappyServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.random.Random

class SocketIoProtocolTest {
    @Test
    fun engineIoPacketsRoundTrip() {
        val open = EngineIoPacket.decode("""0{"sid":"abc","upgrades":[],"pingInterval":15000,"pingTimeout":45000,"maxPayload":8388608}""")
        assertEquals(EngineIoPacket.Open(EngineIoHandshake("abc", 15_000, 45_000, 8_388_608)), open)
        assertEquals(EngineIoPacket.Ping, EngineIoPacket.decode("2"))
        assertEquals("3", EngineIoPacket.Pong.encode())
        assertEquals(EngineIoPacket.Message("40"), EngineIoPacket.decode("440"))
        assertNull(EngineIoPacket.decode("0not json"))
        assertNull(EngineIoPacket.decode(""))
    }

    @Test
    fun socketIoEventsAcksAndConnect() {
        val auth = buildJsonObject { put("token", "t"); put("clientType", "user-scoped") }
        assertEquals("""0{"token":"t","clientType":"user-scoped"}""", SocketIoPacket.Connect(auth).encode())
        assertEquals("""2["app-state",{"state":"active"}]""", SocketIoPacket.Event("app-state", listOf(buildJsonObject { put("state", "active") })).encode())
        assertEquals("""212["rpc-call",{"method":"m"}]""", SocketIoPacket.Event("rpc-call", listOf(buildJsonObject { put("method", "m") }), ackId = 12).encode())

        val event = SocketIoPacket.decode("""2["update",{"id":"u","seq":1}]""") as SocketIoPacket.Event
        assertEquals("update", event.name)
        assertEquals(JsonPrimitive("u"), event.arguments.single().jsonObject["id"])
        assertEquals(SocketIoPacket.Ack(7, listOf(buildJsonObject { put("ok", true) })), SocketIoPacket.decode("""37[{"ok":true}]"""))
        assertEquals(SocketIoPacket.Connect(buildJsonObject { put("sid", "x") }), SocketIoPacket.decode("""0{"sid":"x"}"""))
        assertEquals(SocketIoPacket.Disconnect, SocketIoPacket.decode("1"))
        // The default namespace may be spelled out; other namespaces and binary packets are not ours.
        assertEquals("update", (SocketIoPacket.decode("""2/,["update",{}]""") as SocketIoPacket.Event).name)
        assertNull(SocketIoPacket.decode("""2/admin,["update",{}]"""))
        assertNull(SocketIoPacket.decode("""51-["upload",{"_placeholder":true,"num":0}]"""))
        assertNull(SocketIoPacket.decode("""2[1,2]"""))
    }

    @Test
    fun theUrlIsTheServerOriginWithTheUpdatesPath() {
        assertEquals(
            "https://api.example.com/v1/updates/?EIO=4&transport=websocket",
            SocketIoUrl.create("https://api.example.com/some/path?x=1")!!.toString(),
        )
        assertNull(SocketIoUrl.create("not a url"))
    }

    @Test
    fun backoffIsSocketIoClientsOneToFiveSeconds() {
        val delays = (1..10).map { socketIoBackoff(it, Random(1)) }
        assertTrue(delays.all { it in 0..5_000 })
        assertTrue(socketIoBackoff(1, Random(2)) in 500..1_500)
        assertTrue(socketIoBackoff(8, Random(3)) in 2_500..5_000)
    }
}

class SocketIoClientTest {
    private lateinit var server: FakeHappyServer
    private lateinit var scope: CoroutineScope
    private var token = ""

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        token = server.token
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    @After
    fun tearDown() {
        scope.cancelAndAwait()
        server.close()
    }

    private fun client(delay: Long = 50) = SocketIoClient(
        client = OkHttpClient(),
        url = { SocketIoUrl.create(server.url) },
        scope = scope,
        headers = mapOf("X-Happy-Client" to "android/test"),
        reconnectDelayMs = { delay },
        auth = {
            buildJsonObject {
                put("token", token)
                put("clientType", "user-scoped")
            }
        },
    )

    @Test
    fun connectsWithTheAuthPayloadAndDeliversEventsInOrder() = runBlocking {
        val client = client()
        client.connect()
        withTimeout(5_000) { client.status.first { it == ConnectionStatus.CONNECTED } }
        assertEquals(SocketEvent.Connected, client.events.receive())
        assertEquals("user-scoped", server.socketAuths.single()["clientType"]!!.jsonPrimitive.content)
        assertEquals("android/test", server.requestsTo("/v1/updates/").single().headers["X-Happy-Client"])

        repeat(3) { server.emitEphemeral(buildJsonObject { put("type", "activity"); put("n", it) }) }
        val received = (0 until 3).map { (client.events.receive() as SocketEvent.Message).payload!!.jsonObject["n"]!!.jsonPrimitive.content }
        assertEquals(listOf("0", "1", "2"), received)
        client.disconnect()
        assertEquals(ConnectionStatus.DISCONNECTED, client.status.value)
    }

    @Test
    fun answersPingsSoTheServerKeepsTheSocket() = runBlocking {
        server.pingIntervalMs = 100
        val client = client()
        client.connect()
        withTimeout(5_000) { client.status.first { it == ConnectionStatus.CONNECTED } }
        server.sockets.single().send("2")
        // A pong comes back as Engine.IO packet 3; the fake only records Socket.IO events, so check the link survives.
        assertTrue(client.emit("app-state", buildJsonObject { put("state", "active") }))
        assertEquals("active", server.awaitEvent("app-state")!!.jsonObject["state"]!!.jsonPrimitive.content)
        client.disconnect()
    }

    @Test
    fun acknowledgedCallsGetTheirAnswer() = runBlocking {
        server.rpc["m1:echo"] = { params -> params }
        val client = client()
        client.connect()
        val answer = client.emitWithAck("rpc-call", buildJsonObject { put("method", "m1:echo"); put("params", "hello") }, 5_000)
        assertEquals(buildJsonObject { put("ok", true); put("result", "hello") }, answer.single())
        client.disconnect()
    }

    @Test
    fun anUnansweredCallTimesOutInsteadOfWaitingForever() = runBlocking {
        server.silentRpc += "m1:slow"
        val client = client()
        client.connect()
        withTimeout(5_000) { client.status.first { it == ConnectionStatus.CONNECTED } }
        val error = runCatching { client.emitWithAck("rpc-call", buildJsonObject { put("method", "m1:slow") }, 300) }.exceptionOrNull()
        assertTrue(error is SocketIoException)
        client.disconnect()
    }

    @Test
    fun aCallInFlightFailsWhenTheConnectionDrops() = runBlocking {
        server.silentRpc += "m1:slow"
        val client = client(delay = 60_000)
        client.connect()
        withTimeout(5_000) { client.status.first { it == ConnectionStatus.CONNECTED } }
        val call = scope.async { runCatching { client.emitWithAck("rpc-call", buildJsonObject { put("method", "m1:slow") }, 10_000) } }
        server.awaitEvent("rpc-call")
        server.dropSockets()
        val error = withTimeout(5_000) { call.await() }.exceptionOrNull()
        assertTrue("$error", error is SocketIoException)
        client.disconnect()
    }

    @Test
    fun reconnectsAfterADropAndSaysSoAgain() = runBlocking {
        val client = client()
        client.connect()
        assertEquals(SocketEvent.Connected, withTimeout(5_000) { client.events.receive() })
        server.dropSockets()
        assertEquals(SocketEvent.Connected, withTimeout(5_000) { client.events.receive() })
        assertEquals(2, server.socketAuths.size)
        client.disconnect()
    }

    @Test
    fun aRefusedHandshakeIsAnErrorAndIsRetried() = runBlocking {
        token = "wrong"
        val client = client()
        client.connect()
        withTimeout(5_000) { client.status.first { it == ConnectionStatus.ERROR } }
        token = server.token
        withTimeout(5_000) { client.status.first { it == ConnectionStatus.CONNECTED } }
        client.disconnect()
    }

    @Test
    fun aSilentServerIsDetectedByTheHeartbeatWatchdog() = runBlocking {
        server.pingIntervalMs = 200
        server.pingTimeoutMs = 200
        val client = client(delay = 60_000)
        client.connect()
        withTimeout(5_000) { client.status.first { it == ConnectionStatus.CONNECTED } }
        // The fake never pings: after interval + timeout without a packet the client gives up on the link.
        withTimeout(5_000) { client.status.first { it != ConnectionStatus.CONNECTED } }
        client.disconnect()
    }

    @Test
    fun emitWhileDisconnectedIsNotBuffered() {
        val client = client()
        assertEquals(false, client.emit("app-state", JsonObject(emptyMap())))
        assertThrows(SocketIoException::class.java) {
            runBlocking { client.emitWithAck("rpc-call", JsonObject(emptyMap()), 100) }
        }
    }
}

package com.slopus.happy.sync

import com.slopus.happy.testing.cancelAndAwait
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.net.SocketIoClient
import com.slopus.happy.net.SocketIoUrl
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** apiSocket.ts sessionRPC / machineRPC: sealing, the ack timeout, and how answers read. */
@RunWith(AndroidJUnit4::class)
class RpcClientTest {
    private lateinit var h: AccountHarness
    private lateinit var scope: CoroutineScope
    private lateinit var rpc: RpcClient
    private val server get() = h.server

    @Before
    fun setUp() {
        h = AccountHarness()
        server.addSession("s1", updatedAt = 100)
        server.addMachine("m1")
        h.startAndSync()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val socket = SocketIoClient(
            client = OkHttpClient(),
            url = { SocketIoUrl.create(server.url) },
            scope = scope,
            headers = emptyMap(),
            reconnectDelayMs = { 50 },
            auth = { buildJsonObject { put("token", server.token); put("clientType", "user-scoped") } },
        )
        socket.connect()
        rpc = RpcClient(socket, h.store, h.account.decoder, timeoutMs = 300)
    }

    @After
    fun tearDown() {
        scope.cancelAndAwait()
        h.close()
    }

    private suspend fun expectFailure(message: String, call: suspend () -> Unit) {
        try {
            call()
            fail("expected \"$message\"")
        } catch (e: RpcException) {
            assertEquals(message, e.message)
        }
    }

    @Test
    fun paramsAndResultTravelSealedWithTheRecordsDataKey() = runBlocking {
        var opened: JsonElement? = null
        server.rpc["s1:echo"] = { params ->
            // What crosses the server is ciphertext, never the JSON itself.
            check(params is JsonPrimitive && params.isString)
            opened = server.openRpc("s1", params)
            server.sealRpc("s1", buildJsonObject { put("ok", "yes") })
        }
        server.rpc["m1:echo"] = { params -> server.sealRpc("m1", server.openRpc("m1", params)) }
        val params = buildJsonObject { put("a", 1) }
        assertEquals(buildJsonObject { put("ok", "yes") }, rpc.sessionRpc("s1", "echo", params))
        assertEquals(params, opened)
        assertEquals(params, rpc.machineRpc("m1", "echo", params))
    }

    @Test
    fun aFalsyOrUnreadableAnswerIsNull() = runBlocking {
        server.rpc["s1:false"] = { server.sealRpc("s1", JsonPrimitive(false)) }
        server.rpc["s1:empty"] = { server.sealRpc("s1", JsonPrimitive("")) }
        server.rpc["s1:garbage"] = { JsonPrimitive("bm90IGEgYm94") }
        assertNull(rpc.sessionRpc("s1", "false", JsonObject(emptyMap())))
        assertNull(rpc.sessionRpc("s1", "empty", JsonObject(emptyMap())))
        assertNull(rpc.sessionRpc("s1", "garbage", JsonObject(emptyMap())))
    }

    @Test
    fun anUnansweredCallIsGoneAfterTheTimeout() = runBlocking {
        server.silentRpc += "s1:slow"
        expectFailure("The computer did not respond") { rpc.sessionRpc("s1", "slow", JsonObject(emptyMap())) }
    }

    @Test
    fun aRecordWithoutAKeyIsRefusedBeforeSending() = runBlocking {
        expectFailure("Session encryption not found for nope") { rpc.sessionRpc("nope", "x", JsonObject(emptyMap())) }
        expectFailure("Machine encryption not found for nope") { rpc.machineRpc("nope", "x", JsonObject(emptyMap())) }
    }

    @Test
    fun theServersRefusalIsTheError() = runBlocking {
        expectFailure("RPC method not available") { rpc.sessionRpc("s1", "missing", JsonObject(emptyMap())) }
    }
}

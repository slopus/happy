package com.slopus.happy.sync

import com.slopus.happy.crypto.PayloadCipher
import com.slopus.happy.data.HappyStore
import com.slopus.happy.net.SocketIoClient
import com.slopus.happy.net.SocketIoException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import java.io.IOException

/** An RPC that could not be completed: not sent, not answered, refused, or answered with something unreadable. */
class RpcException(message: String) : IOException(message)

/**
 * The transport underneath [SessionOps] and [MachineOps] (apiSocket.ts
 * sessionRPC, machineRPC, emitWithAck): an `rpc-call` over the updates
 * socket, routed by the server to whichever daemon or session registered
 * `<id>:<method>`. Params and result are sealed with the session's or
 * machine's data key, end to end; the server sees only ciphertext.
 */
class RpcClient(
    private val socket: SocketIoClient,
    private val store: HappyStore,
    private val decoder: RecordDecoder,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val timeoutMs: Long = RPC_ACK_TIMEOUT_MS,
) {
    suspend fun sessionRpc(sessionId: String, method: String, params: JsonElement): JsonElement? {
        val cipher = withContext(io) { store.session(sessionId)?.let { decoder.cipher(it.wrappedDataKey) } }
            ?: throw RpcException("Session encryption not found for $sessionId")
        return call(cipher, "$sessionId:$method", params)
    }

    suspend fun machineRpc(machineId: String, method: String, params: JsonElement): JsonElement? {
        val cipher = withContext(io) { store.machine(machineId)?.let { decoder.cipher(it.wrappedDataKey) } }
            ?: throw RpcException("Machine encryption not found for $machineId")
        return call(cipher, "$machineId:$method", params)
    }

    /** A plain acknowledged event (`update-metadata`, `machine-update-metadata`): the server's first ack argument. */
    suspend fun emitWithAck(event: String, payload: JsonElement): JsonElement =
        try {
            socket.emitWithAck(event, payload, timeoutMs).firstOrNull() ?: JsonNull
        } catch (_: SocketIoException) {
            throw RpcException("Not connected to the server")
        }

    private suspend fun call(cipher: PayloadCipher, method: String, params: JsonElement): JsonElement? {
        val sealed = withContext(io) { cipher.encryptToBase64(params) }
        val answer = try {
            socket.emitWithAck("rpc-call", buildJsonObject {
                put("method", method)
                put("params", sealed)
            }, timeoutMs).firstOrNull() as? JsonObject
        } catch (_: SocketIoException) {
            // Not answered within the server's own worst case: the call is gone.
            throw RpcException("The computer did not respond")
        } ?: throw RpcException("RPC call failed")
        if ((answer["ok"] as? JsonPrimitive)?.booleanOrNull != true) {
            throw RpcException((answer["error"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() } ?: "RPC call failed")
        }
        val result = (answer["result"] as? JsonPrimitive)?.contentOrNull ?: return null
        // decryptRaw: an answer that does not open, or a falsy one, is null.
        return withContext(io) { cipher.decryptFromBase64(result) }?.takeUnless(::isFalsy)
    }

    /** `decrypted[0] || null`: false, 0, "" and null all read as no answer. */
    private fun isFalsy(value: JsonElement): Boolean = value is JsonNull || (value is JsonPrimitive && if (value.isString) {
        value.content.isEmpty()
    } else {
        value.booleanOrNull == false || value.doubleOrNull == 0.0
    })

    companion object {
        /** apiSocket.ts: past the server's 15 s reconnect grace plus its 30 s call, the call is gone. */
        const val RPC_ACK_TIMEOUT_MS = 50_000L
    }
}

package com.slopus.happy.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

// The server runs Socket.IO 4: Engine.IO protocol 4 carrying Socket.IO
// protocol 5, here over WebSocket only. These are the text packets a
// user-scoped client on the default namespace sends and receives. Happy does
// not use binary packets; they are not parsed.

/** The Engine.IO `open` packet: the server's heartbeat contract. */
@Serializable
data class EngineIoHandshake(
    val sid: String,
    val pingInterval: Long,
    val pingTimeout: Long,
    val maxPayload: Long? = null,
)

sealed interface EngineIoPacket {
    data class Open(val handshake: EngineIoHandshake) : EngineIoPacket
    data object Close : EngineIoPacket
    data object Ping : EngineIoPacket
    data object Pong : EngineIoPacket
    data class Message(val payload: String) : EngineIoPacket
    data object Noop : EngineIoPacket

    fun encode(): String = when (this) {
        is Open -> "0" + HappyJson.encodeToString(EngineIoHandshake.serializer(), handshake)
        Close -> "1"
        Ping -> "2"
        Pong -> "3"
        is Message -> "4$payload"
        Noop -> "6"
    }

    companion object {
        fun decode(text: String): EngineIoPacket? {
            if (text.isEmpty()) return null
            val rest = text.substring(1)
            return when (text[0]) {
                '0' -> try {
                    Open(HappyJson.decodeFromString(EngineIoHandshake.serializer(), rest))
                } catch (_: SerializationException) {
                    null
                } catch (_: IllegalArgumentException) {
                    null
                }
                '1' -> Close
                '2' -> Ping
                '3' -> Pong
                '4' -> Message(rest)
                '6' -> Noop
                else -> null
            }
        }
    }
}

sealed interface SocketIoPacket {
    /** Client to server: the auth payload. Server to client: `{"sid": …}`. */
    data class Connect(val payload: JsonElement?) : SocketIoPacket
    data object Disconnect : SocketIoPacket
    data class Event(val name: String, val arguments: List<JsonElement>, val ackId: Long? = null) : SocketIoPacket
    data class Ack(val id: Long, val arguments: List<JsonElement>) : SocketIoPacket
    data class ConnectError(val payload: JsonElement?) : SocketIoPacket

    fun encode(): String = when (this) {
        is Connect -> "0" + (payload?.toString() ?: "")
        Disconnect -> "1"
        is Event -> "2" + (ackId?.toString() ?: "") + JsonArray(listOf(JsonPrimitive(name)) + arguments)
        is Ack -> "3$id" + JsonArray(arguments)
        is ConnectError -> "4" + (payload?.toString() ?: "")
    }

    companion object {
        /**
         * Parses the payload of an Engine.IO message. Packets for another
         * namespace, binary packets and malformed JSON yield null.
         */
        fun decode(text: String): SocketIoPacket? {
            if (text.isEmpty()) return null
            val type = text[0]
            var index = 1
            if (index < text.length && text[index] == '/') {
                val comma = text.indexOf(',', index)
                if (comma < 0 || text.substring(index, comma) != "/") return null
                index = comma + 1
            }
            val digitsStart = index
            while (index < text.length && text[index].isDigit()) index++
            val ackId = if (index > digitsStart) text.substring(digitsStart, index).toLongOrNull() ?: return null else null
            val body = text.substring(index)
            val json = if (body.isEmpty()) {
                null
            } else {
                try {
                    HappyJson.parseToJsonElement(body)
                } catch (_: SerializationException) {
                    return null
                } catch (_: IllegalArgumentException) {
                    return null
                }
            }
            return when (type) {
                '0' -> Connect(json)
                '1' -> Disconnect
                '2' -> {
                    val items = json as? JsonArray ?: return null
                    val name = (items.firstOrNull() as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
                    Event(name, items.drop(1), ackId)
                }
                '3' -> {
                    val items = json as? JsonArray ?: return null
                    Ack(ackId ?: return null, items)
                }
                '4' -> ConnectError(json)
                else -> null
            }
        }
    }
}

/**
 * The WebSocket URL of a Happy server's updates socket: the server's origin,
 * path `/v1/updates/`, and the Engine.IO query. Like socket.io-client, the
 * server URL's own path is ignored (socket.io treats it as a namespace).
 */
object SocketIoUrl {
    fun create(serverUrl: String, path: String = "/v1/updates/"): HttpUrl? {
        val base = serverUrl.toHttpUrlOrNull() ?: return null
        // OkHttp takes ws(s) URLs as http(s) and upgrades the request itself.
        return base.newBuilder()
            .encodedPath(path)
            .query(null)
            .fragment(null)
            .addQueryParameter("EIO", "4")
            .addQueryParameter("transport", "websocket")
            .build()
    }
}

package com.slopus.happy.agent

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * One frame of the agent's journal (API.md, "The event envelope"): its
 * [cursor], [type] and [data], the envelope's `payload`. The first frame of
 * every connection is `hello` (its data: `cursor`, `gap`, `resumed`,
 * `daemonId`), with no cursor of its own; after a `hello` a reader catches
 * up whatever it shows.
 */
data class AgentEvent(val cursor: String?, val type: String, val data: JsonObject) {
    /** The conversation the event is about, where it names one. */
    val agentId: String?
        get() = data.string("agentId")
            ?: (data["agent"] as? JsonObject)?.string("id")
            ?: (data["question"] as? JsonObject)?.string("agentId")
            ?: (data["process"] as? JsonObject)?.string("agentId")
            ?: (data["message"] as? JsonObject)?.string("agentId")

    companion object {
        const val HELLO = "hello"
    }
}

/** The `hello` frame's facts. */
data class AgentHello(val cursor: String?, val gap: Boolean, val resumed: Boolean, val daemonId: String?) {
    companion object {
        fun of(event: AgentEvent) = AgentHello(
            cursor = event.data.string("cursor"),
            gap = event.data["gap"]?.toString() == "true",
            resumed = event.data["resumed"]?.toString() == "true",
            daemonId = event.data.string("daemonId"),
        )
    }
}

/**
 * Server-Sent Events framing (the WHATWG rules the daemon writes to):
 * lines end in LF, CRLF or CR; a blank line ends a frame; `:` lines are
 * comments (heartbeats). Bytes may split anywhere, inside a character too.
 */
class ServerSentEventParser {
    class Frame(val id: String?, val event: String, val data: String)

    private val pending = java.io.ByteArrayOutputStream()
    private var lastWasCr = false
    private var id: String? = null
    private var event: String? = null
    private val data = StringBuilder()
    private var hasData = false

    fun append(bytes: ByteArray): List<Frame> {
        val frames = ArrayList<Frame>()
        for (byte in bytes) {
            when (byte) {
                LF -> {
                    if (lastWasCr) lastWasCr = false else line(frames)
                }
                CR -> {
                    lastWasCr = true
                    line(frames)
                }
                else -> {
                    lastWasCr = false
                    pending.write(byte.toInt())
                    if (pending.size() > MAX_LINE) throw IllegalStateException("Event line too long")
                }
            }
        }
        return frames
    }

    private fun line(frames: MutableList<Frame>) {
        val text = pending.toString(Charsets.UTF_8.name())
        pending.reset()
        if (text.isEmpty()) {
            if (hasData) frames += Frame(id, event ?: "message", data.toString())
            event = null
            data.setLength(0)
            hasData = false
            return
        }
        if (text.startsWith(":")) return
        val colon = text.indexOf(':')
        val field = if (colon < 0) text else text.substring(0, colon)
        var value = if (colon < 0) "" else text.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "id" -> if (!value.contains('\u0000')) id = value
            "event" -> event = value
            "data" -> {
                if (hasData) data.append('\n')
                data.append(value)
                hasData = true
            }
        }
    }

    private companion object {
        const val LF: Byte = '\n'.code.toByte()
        const val CR: Byte = '\r'.code.toByte()
        const val MAX_LINE = 8 * 1024 * 1024
    }
}

/**
 * A frame as an [AgentEvent]: `hello`'s data is the hello itself; every
 * other frame's data is an envelope whose `payload` becomes [AgentEvent.data].
 * A frame that isn't JSON is dropped.
 */
internal fun ServerSentEventParser.Frame.toAgentEvent(): AgentEvent? = try {
    val body = AgentClient.json.parseToJsonElement(data).jsonObject
    if (event == AgentEvent.HELLO) {
        AgentEvent(null, AgentEvent.HELLO, body)
    } else {
        val payload = body["payload"] as? JsonObject ?: JsonObject(emptyMap())
        AgentEvent(body.string("cursor"), body.string("type") ?: event, payload)
    }
} catch (_: Exception) {
    null
}

package io.elevenlabs.network

import android.util.Log
import io.elevenlabs.models.ConversationEvent
import io.elevenlabs.models.ConversationMode
import io.elevenlabs.models.ConversationStatus
import io.elevenlabs.models.OutgoingEvent
import com.google.gson.*
import com.google.gson.reflect.TypeToken

/**
 * JSON event processing for real-time conversation protocol
 *
 * This object handles parsing incoming events from ElevenLabs servers and
 * serializing outgoing user actions and responses. It provides robust
 * error handling for malformed messages.
 */
object ConversationEventParser {

    private val gson = GsonBuilder()
        .setFieldNamingPolicy(FieldNamingPolicy.LOWER_CASE_WITH_UNDERSCORES)
        .create()

    /**
     * Parse an incoming JSON event string into a ConversationEvent
     *
     * @param json The JSON string to parse
     * @return ConversationEvent instance or null if parsing fails
     */
    fun parseIncomingEvent(json: String): ConversationEvent? {
        return try {
            val jsonObject = JsonParser.parseString(json).asJsonObject
            val eventType = getEventType(jsonObject)

            when (eventType) {
                "conversation_initiation_metadata" -> parseConversationInitiationMetadata(jsonObject)
                "audio" -> parseAudio(jsonObject)
                "agent_response" -> parseAgentResponse(jsonObject)
                "agent_response_correction" -> parseAgentResponseCorrection(jsonObject)
                "user_transcript" -> parseUserTranscript(jsonObject)
                "tentative_user_transcript" -> parseTentativeUserTranscript(jsonObject)
                "agent_chat_response_part" -> parseAgentChatResponsePart(jsonObject)
                "internal_tentative_agent_response" -> parseTentativeAgentResponse(jsonObject)
                "agent_response_metadata" -> parseAgentResponseMetadata(jsonObject)
                "client_tool_call", "agent_tool_request" -> parseClientToolCall(jsonObject)
                "agent_tool_response" -> parseAgentToolResponse(jsonObject)
                "vad_score" -> parseVadScore(jsonObject)
                "interruption" -> parseInterruption(jsonObject)
                "audio_alignment" -> parseAudioAlignment(jsonObject)
                "ping" -> parsePing(jsonObject)
                "error" -> parseError(jsonObject)
                else -> {
                    handleParsingError(json, IllegalArgumentException("Unknown event type: $eventType"))
                    null
                }
            }
        } catch (e: Exception) {
            handleParsingError(json, e)
            null
        }
    }

    /**
     * Parse ping event
     * Matches payload: {"ping_event":{"event_id":3,"ping_ms":null},"type":"ping"}
     */
    private fun parsePing(jsonObject: JsonObject): ConversationEvent.Ping {
        val ping = jsonObject.getAsJsonObject("ping_event")
        val eventId = ping?.get("event_id")?.asInt ?: 0
        val pingMs = ping?.get("ping_ms")?.let { if (it.isJsonNull) null else it.asLong }
        return ConversationEvent.Ping(eventId = eventId, pingMs = pingMs)
    }

    /**
     * Serialize an outgoing event to JSON string
     *
     * @param event The event to serialize
     * @return JSON string representation of the event
     */
    fun serializeOutgoingEvent(event: OutgoingEvent): String {
        return gson.toJson(event)
    }

    /**
     * Extract the event type from a JSON object
     */
    private fun getEventType(jsonObject: JsonObject): String? {
        return jsonObject.get("type")?.asString
    }

    /** Extracts an optional `event_id`, or null when absent/JSON null. */
    private fun JsonObject?.parseEventId(): Int? {
        val element = this?.get("event_id") ?: return null
        return if (element.isJsonNull) null else element.asInt
    }

    /**
     * Parse agent response event
     */
    private fun parseAgentResponse(jsonObject: JsonObject): ConversationEvent.AgentResponse {
        val obj = jsonObject.getAsJsonObject("agent_response_event")
        val content = obj?.get("agent_response")?.asString ?: ""
        return ConversationEvent.AgentResponse(
            agentResponse = content,
            eventId = obj.parseEventId()
        )
    }

    /**
     * Parse user transcript event
     */
    private fun parseUserTranscript(jsonObject: JsonObject): ConversationEvent.UserTranscript {
        val obj = jsonObject.getAsJsonObject("user_transcription_event")
        val content = obj?.get("user_transcript")?.asString ?: ""
        return ConversationEvent.UserTranscript(
            userTranscript = content,
            eventId = obj.parseEventId()
        )
    }

    /**
     * Parse client tool call event
     * Handles both "client_tool_call" and "agent_tool_request" event formats
     */
    private fun parseClientToolCall(jsonObject: JsonObject): ConversationEvent.ClientToolCall {
        // Payloads can be nested under "client_tool_call", "agent_tool_request", or be flat
        val obj = jsonObject.getAsJsonObject("client_tool_call")
            ?: jsonObject.getAsJsonObject("agent_tool_request")
            ?: jsonObject

        val parametersJson = obj.get("parameters")?.asJsonObject
        val parameters = mutableMapOf<String, Any>()

        parametersJson?.entrySet()?.forEach { entry ->
            parameters[entry.key] = when {
                entry.value.isJsonPrimitive -> {
                    val primitive = entry.value.asJsonPrimitive
                    when {
                        primitive.isString -> primitive.asString
                        primitive.isNumber -> primitive.asNumber
                        primitive.isBoolean -> primitive.asBoolean
                        else -> primitive.asString
                    }
                }
                entry.value.isJsonArray -> gson.fromJson(entry.value, List::class.java)
                entry.value.isJsonObject -> gson.fromJson(entry.value, Map::class.java)
                else -> entry.value.toString()
            }
        }

        // Determine expects_response value
        // - If explicitly set in payload, use that value
        // - If not present, default to true for client tools (most client tools expect responses)
        // 
        // Rationale: The server may not include expects_response in the payload even when the tool
        // configuration has expects_response: true. Since the primary purpose of client tools is to
        // execute on the client and return results to the agent, defaulting to true is the safer choice.
        // Tools that don't expect responses (fire-and-forget) should explicitly set expects_response: false.
        val expectsResponseElement = obj.get("expects_response")
        val expectsResponse = if (expectsResponseElement != null && !expectsResponseElement.isJsonNull) {
            expectsResponseElement.asBoolean
        } else {
            // Default to true when not specified - client tools typically expect responses
            true
        }

        return ConversationEvent.ClientToolCall(
            toolName = obj.get("tool_name")?.asString ?: "",
            parameters = parameters,
            toolCallId = obj.get("tool_call_id")?.asString ?: "",
            expectsResponse = expectsResponse,
        )
    }

    private fun parseAgentResponseCorrection(jsonObject: JsonObject): ConversationEvent.AgentResponseCorrection {
        val obj = jsonObject.getAsJsonObject("agent_response_correction_event") ?: jsonObject
        val original = obj.get("original_agent_response")?.asString ?: ""
        val corrected = obj.get("corrected_agent_response")?.asString ?: ""
        return ConversationEvent.AgentResponseCorrection(
            originalAgentResponse = original,
            correctedAgentResponse = corrected,
            eventId = obj.parseEventId()
        )
    }

    private fun parseAgentToolResponse(jsonObject: JsonObject): ConversationEvent.AgentToolResponse {
        val obj = jsonObject.getAsJsonObject("agent_tool_response") ?: jsonObject
        return ConversationEvent.AgentToolResponse(
            toolName = obj.get("tool_name")?.asString ?: "",
            toolCallId = obj.get("tool_call_id")?.asString ?: "",
            toolType = obj.get("tool_type")?.asString ?: "",
            isError = obj.get("is_error")?.asBoolean ?: false
        )
    }

    private fun parseAudio(jsonObject: JsonObject): ConversationEvent {
        val obj = jsonObject.getAsJsonObject("audio_event") ?: jsonObject
        val hasAlignment = obj.has("alignment") && !obj.get("alignment").isJsonNull
        val hasB64 = obj.has("audio_base64") || obj.has("audio_base_64")

        return if (hasAlignment && !hasB64) {
            // Treat as alignment-only payload forwarded on 'audio' type
            val mapType = object : com.google.gson.reflect.TypeToken<Map<String, Any>>() {}.type
            val alignmentMap: Map<String, Any> = gson.fromJson(obj, mapType)
            ConversationEvent.AudioAlignment(alignment = alignmentMap)
        } else {
            val b64 = when {
                obj.has("audio_base64") -> obj.get("audio_base64")?.asString ?: ""
                obj.has("audio_base_64") -> obj.get("audio_base_64")?.asString ?: ""
                else -> ""
            }
            val eventId = obj.get("event_id")?.asInt ?: 0
            ConversationEvent.Audio(
                eventId = eventId,
                audioBase64 = b64
            )
        }
    }

    private fun parseConversationInitiationMetadata(jsonObject: JsonObject): ConversationEvent.ConversationInitiationMetadata {
        val obj = jsonObject.getAsJsonObject("conversation_initiation_metadata") ?: jsonObject
        return ConversationEvent.ConversationInitiationMetadata(
            conversationId = obj.get("conversation_id")?.asString ?: "",
            agentOutputAudioFormat = obj.get("agent_output_audio_format")?.asString ?: "",
            userInputAudioFormat = obj.get("user_input_audio_format")?.asString ?: ""
        )
    }

    private fun logAgentToolResponse(jsonObject: JsonObject) {
        try {
            Log.d("ConversationEventParser", "Agent tool response: ${jsonObject}")
        } catch (_: Exception) { }
    }

    /**
     * Parse VAD score event
     * Matches payload: {"type":"vad_score","vad_score_event":{"vad_score":0.95}}
     */
    private fun parseVadScore(jsonObject: JsonObject): ConversationEvent.VadScore {
        val obj = jsonObject.getAsJsonObject("vad_score_event") ?: jsonObject
        val score = obj.get("vad_score")?.asFloat ?: 0.0f

        return ConversationEvent.VadScore(
            score = score,
        )
    }

    private fun parseInterruption(jsonObject: JsonObject): ConversationEvent.Interruption {
        val obj = jsonObject.getAsJsonObject("interruption_event")
        val id = obj?.get("event_id")?.asInt ?: 0
        return ConversationEvent.Interruption(eventId = id)
    }

    /**
     * Parse explicit audio alignment events.
     *
     * Matches payload:
     * {
     *   "type": "audio_alignment",
     *   "audio_alignment_event": {
     *     "event_id": 19,
     *     "alignment": {
     *       "chars": ["I", "'", " ", "d", ...],
     *       "char_start_times_ms": [0.0, 104.0, ...],
     *       "char_durations_ms": [104.0, 82.0, ...]
     *     }
     *   }
     * }
     *
     * If the nested object is not present, falls back to the whole object (minus type).
     * The alignment is exposed as a Map<String, Any> to remain flexible.
     */
    private fun parseAudioAlignment(jsonObject: JsonObject): ConversationEvent.AudioAlignment {
        val content = jsonObject.getAsJsonObject("audio_alignment_event") ?: jsonObject.deepCopy().apply { remove("type") }
        val mapType = object : TypeToken<Map<String, Any>>() {}.type
        val alignmentMap: Map<String, Any> = gson.fromJson(content, mapType)
        return ConversationEvent.AudioAlignment(alignment = alignmentMap)
    }

    /**
     * Parse agent response metadata event.
     * Supports nested 'agent_response_metadata_event' or flat object with 'type' removed.
     */
    private fun parseAgentResponseMetadata(jsonObject: JsonObject): ConversationEvent.AgentResponseMetadata {
        val content = jsonObject.getAsJsonObject("agent_response_metadata_event")
            ?: jsonObject.deepCopy().apply { remove("type") }
        val mapType = object : com.google.gson.reflect.TypeToken<Map<String, Any>>() {}.type
        val meta: Map<String, Any> = gson.fromJson(content, mapType)
        return ConversationEvent.AgentResponseMetadata(metadata = meta)
    }

    /**
     * Parse streaming agent chat response part
     * Matches payloads like:
     * {"text_response_part":{"text":"","type":"start"},"type":"agent_chat_response_part"}
     * {"text_response_part":{"text":"Hello","type":"delta"},"type":"agent_chat_response_part"}
     * {"text_response_part":{"text":"","type":"stop"},"type":"agent_chat_response_part"}
     */
    private fun parseAgentChatResponsePart(jsonObject: JsonObject): ConversationEvent.AgentChatResponsePart {
        val obj = jsonObject.getAsJsonObject("text_response_part") ?: JsonObject()
        val text = obj.get("text")?.asString ?: ""
        val type = obj.get("type")?.asString ?: ""
        return ConversationEvent.AgentChatResponsePart(
            partType = type,
            text = text,
            eventId = obj.parseEventId()
        )
    }

    /**
     * Parse tentative agent response (internal)
     * {"tentative_agent_response_internal_event":{"tentative_agent_response":"..."}, "type":"internal_tentative_agent_response"}
     */
    private fun parseTentativeAgentResponse(jsonObject: JsonObject): ConversationEvent.TentativeAgentResponse {
        val obj = jsonObject.getAsJsonObject("tentative_agent_response_internal_event") ?: JsonObject()
        val text = obj.get("tentative_agent_response")?.asString ?: ""
        return ConversationEvent.TentativeAgentResponse(tentativeAgentResponse = text)
    }

    /**
     * Parse tentative user transcript
     * {"tentative_user_transcription_event":{"user_transcript":"...", "event_id":15}, "type":"tentative_user_transcript"}
     */
    private fun parseTentativeUserTranscript(jsonObject: JsonObject): ConversationEvent.TentativeUserTranscript {
        val obj = jsonObject.getAsJsonObject("tentative_user_transcription_event") ?: JsonObject()
        val text = obj.get("user_transcript")?.asString ?: ""
        val eventId = obj.get("event_id")?.let { if (it.isJsonNull) null else it.asInt }
        return ConversationEvent.TentativeUserTranscript(
            userTranscript = text,
            eventId = eventId
        )
    }

    /**
     * Parse error event from server
     * Supports both nested error_event and flat structure:
     * {"type":"error","error_event":{"code":1011,"message":"..."}}
     * {"type":"error","code":1011,"message":"..."}
     */
    private fun parseError(jsonObject: JsonObject): ConversationEvent.ServerError {
        val errorEvent = jsonObject.getAsJsonObject("error_event")
        val code = errorEvent?.get("code")?.asInt
            ?: jsonObject.get("code")?.asInt
            ?: 1011
        val message = errorEvent?.get("message")?.let { if (it.isJsonNull) null else it.asString }
            ?: jsonObject.get("message")?.let { if (it.isJsonNull) null else it.asString }
        return ConversationEvent.ServerError(code = code, message = message)
    }

    /**
     * Handle parsing errors
     */
    private fun handleParsingError(json: String, error: Exception) {
        Log.d("ConversationEventParser", "Failed to parse conversation event: ${error.message}")
        Log.d("ConversationEventParser", "JSON: $json")
    }
}
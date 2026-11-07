package com.slopus.happy.call

import io.elevenlabs.models.ConversationEvent
import io.elevenlabs.network.ConversationEventParser
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The vendored SDK's reading of a hosted agent's tool calls, as the call's tools take them. */
class ElevenLabsEventsTest {
    @Test
    fun aClientToolCallKeepsItsParameters() {
        val event = ConversationEventParser.parseIncomingEvent(
            """{"type":"client_tool_call","client_tool_call":{"tool_name":"navigate","tool_call_id":"t1","event_id":3,"parameters":{"to":"happy://conversation/s3","focusRevision":0}}}""",
        ) as ConversationEvent.ClientToolCall
        assertEquals("navigate", event.toolName)
        assertEquals(JsonObject(mapOf("to" to JsonPrimitive("happy://conversation/s3"), "focusRevision" to JsonPrimitive(0))), event.parameters.toJson())
    }

    /** Sent ahead of the call itself and with no parameters: answered, it beat the real call with an empty one. */
    @Test
    fun anAgentToolRequestIsNotACall() {
        assertNull(ConversationEventParser.parseIncomingEvent(
            """{"type":"agent_tool_request","agent_tool_request":{"tool_name":"navigate","tool_call_id":"t1","tool_type":"client","event_id":3}}""",
        ))
    }

    /** The agent leaves the room 50 ms after this: read raw, it says the agent hung up before the leaving does. */
    @Test
    fun endCallsResponseIsAHangUp() {
        assertTrue(ElevenLabsCallConnection.hangsUp(
            """{"agent_tool_response":{"tool_name":"end_call","tool_call_id":"t9","tool_type":"system","is_error":false,"event_id":36,"status":"success"},"type":"agent_tool_response"}""",
        ))
        assertFalse(ElevenLabsCallConnection.hangsUp(
            """{"agent_tool_request":{"tool_name":"end_call","tool_call_id":"t9","tool_type":"system","event_id":36},"type":"agent_tool_request"}""",
        ))
        assertFalse(ElevenLabsCallConnection.hangsUp(
            """{"agent_response_event":{"agent_response":"I can end_call now","event_id":4},"type":"agent_response"}""",
        ))
    }
}

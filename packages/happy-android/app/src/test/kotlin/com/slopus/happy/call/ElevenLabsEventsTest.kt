package com.slopus.happy.call

import io.elevenlabs.models.ConversationEvent
import io.elevenlabs.network.ConversationEventParser
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The vendored SDK's reading of a hosted agent's tool calls, as the call's tools take them. */
class ElevenLabsEventsTest {
    @Test
    fun aClientToolCallKeepsItsParameters() {
        val event = ConversationEventParser.parseIncomingEvent(
            """{"type":"client_tool_call","client_tool_call":{"tool_name":"openSession","tool_call_id":"t1","event_id":3,"parameters":{"targetRef":"s3","focusRevision":0}}}""",
        ) as ConversationEvent.ClientToolCall
        assertEquals("openSession", event.toolName)
        assertEquals(JsonObject(mapOf("targetRef" to JsonPrimitive("s3"), "focusRevision" to JsonPrimitive(0))), event.parameters.toJson())
    }

    /** Sent ahead of the call itself and with no parameters: answered, it beat the real call with an empty one. */
    @Test
    fun anAgentToolRequestIsNotACall() {
        assertNull(ConversationEventParser.parseIncomingEvent(
            """{"type":"agent_tool_request","agent_tool_request":{"tool_name":"openSession","tool_call_id":"t1","tool_type":"client","event_id":3}}""",
        ))
    }
}

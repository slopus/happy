package com.slopus.happy.calendar

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.chat.obj
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Calendar mutation routes. A stale If-Match remains a conflict for the editor to show. */
internal class CalendarRoutes(private val client: AgentClient) {
    suspend fun save(surfaceId: String, event: CalendarEvent?, id: String, draft: CalendarDraft): CalendarEvent {
        require(draft.valid)
        val path = path(surfaceId) + if (event == null) "" else "/${AgentClient.escape(event.id)}"
        val fields = draft.json() + ("mutationId" to JsonPrimitive(AgentClient.newId())) + if (event == null) mapOf("id" to JsonPrimitive(id)) else emptyMap()
        val answer = client.send(if (event == null) "POST" else "PATCH", path, JsonObject(fields), event?.let { mapOf("If-Match" to it.version) }.orEmpty())
        return CalendarEvent.parse(AgentClient.json.parseToJsonElement(answer.text).obj?.get("event"))
            ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }

    suspend fun delete(event: CalendarEvent) {
        client.send("DELETE", "${path(event.surfaceId)}/${AgentClient.escape(event.id)}",
            JsonObject(mapOf("mutationId" to JsonPrimitive(AgentClient.newId()))), mapOf("If-Match" to event.version))
    }

    private fun path(surfaceId: String) = "/v0/surfaces/calendar/${AgentClient.escape(surfaceId)}"
}
package com.slopus.happy.chat

import com.slopus.happy.chat.NormalizedMessage.AgentContent
import com.slopus.happy.chat.NormalizedMessage.Body
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

// Builders for the reducer and normalizer tests: one line per normalized
// message, so the ported happy-app spec cases stay readable.

fun json(text: String): JsonElement = Json.parseToJsonElement(text)

fun userMsg(id: String, text: String, localId: String? = null, createdAt: Long = 0, meta: String? = null) =
    NormalizedMessage(id, localId, createdAt, Body.User(text), meta = meta?.let { MessageMeta.of(json(it)) })

fun agentMsg(id: String, createdAt: Long, vararg content: AgentContent, sidechain: Boolean = false, usage: UsageData? = null, turn: String? = null) =
    NormalizedMessage(id, null, createdAt, Body.Agent(content.toList()), isSidechain = sidechain, usage = usage, turn = turn)

fun text(text: String, uuid: String = "uuid", parent: String? = null) = AgentContent.Text(text, uuid, parent)

fun toolUse(id: String, name: String, input: String = "{}", uuid: String = "uuid-$id", parent: String? = null, description: String? = null) =
    AgentContent.ToolUse(id, name, null, json(input), description, uuid, parent)

fun toolResult(id: String, content: JsonElement?, isError: Boolean = false, uuid: String = "result-$id", parent: String? = null) =
    AgentContent.ToolResult(id, content, isError, uuid, parent)

fun toolResult(id: String, content: String, isError: Boolean = false) = toolResult(id, JsonPrimitive(content), isError)

fun eventMsg(id: String, event: AgentEvent, createdAt: Long = 0) = NormalizedMessage(id, null, createdAt, Body.Event(event))

fun agentState(text: String): AgentState = AgentState.parse(json(text))!!

/** The reducer's internal tool row for a tool id. */
internal fun ReducerState.toolRow(toolId: String) = messages.getValue(toolIdToMessageId.getValue(toolId))

fun ReducerState.reduce(vararg messages: NormalizedMessage, agentState: AgentState? = null) = reduce(messages.toList(), agentState)

val ChatMessage.tool: ToolCall get() = (this as ChatMessage.ToolCallMessage).tool

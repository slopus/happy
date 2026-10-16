package com.slopus.happy.chat

import com.slopus.happy.chat.NormalizedMessage.AgentContent

/**
 * Links sidechain messages (a sub-agent's conversation) to the message whose
 * Task/Agent tool call started them: a port of happy-app's
 * sync/reducer/reducerTracer.ts.
 *
 * A Task call is indexed by its prompt; a sidechain root whose prompt matches
 * takes the Task message's id as its sidechain id, and its descendants (by
 * parent uuid) inherit it. Session-protocol sidechains name their owner by
 * subagent id, which is matched against the tool-call id or the call's
 * `input.sessionSubagent`. Children that arrive before their parent wait as
 * orphans and are released when it does.
 */
class TracerState {
    internal val promptToTaskId = HashMap<String, String>()
    internal val uuidToSidechainId = HashMap<String, String>()
    internal val toolCallToMessageId = HashMap<String, String>()
    internal val orphanMessages = HashMap<String, MutableList<NormalizedMessage>>()
    internal val processedIds = HashSet<String>()
}

/** A normalized message and, for sidechain content, the id of the message that owns it. */
data class TracedMessage(val message: NormalizedMessage, val sidechainId: String? = null)

private val UUID_LIKE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

private fun NormalizedMessage.firstUuid(): String? = agentContent.firstOrNull()?.uuid?.takeIf { it.isNotEmpty() }

private fun NormalizedMessage.firstParentUuid(): String? = agentContent.firstOrNull()?.parentUUID

private fun AgentContent.ToolUse.parentIds(): List<String> {
    val subagent = input.obj?.get("sessionSubagent").str
    return if (!subagent.isNullOrEmpty() && subagent != id) listOf(id, subagent) else listOf(id)
}

internal fun isSubagentToolCall(name: String) = name == "Task" || name == "Agent"

private fun processOrphans(state: TracerState, parentUuid: String, sidechainId: String): List<TracedMessage> {
    val orphans = state.orphanMessages.remove(parentUuid) ?: return emptyList()
    val results = ArrayList<TracedMessage>()
    for (orphan in orphans) {
        val uuid = orphan.firstUuid()
        state.processedIds.add(orphan.id)
        if (uuid != null) state.uuidToSidechainId[uuid] = sidechainId
        results.add(TracedMessage(orphan, sidechainId))
        if (uuid != null) results.addAll(processOrphans(state, uuid, sidechainId))
    }
    return results
}

fun traceMessages(state: TracerState, messages: List<NormalizedMessage>): List<TracedMessage> {
    val results = ArrayList<TracedMessage>()
    for (message in messages) {
        if (message.id in state.processedIds) continue

        for (content in message.agentContent) {
            if (content !is AgentContent.ToolUse) continue
            for (parentId in content.parentIds()) {
                state.toolCallToMessageId[parentId] = message.id
                // Session-protocol children can arrive before their tool call.
                results.addAll(processOrphans(state, parentId, message.id))
            }
            if (isSubagentToolCall(content.name)) {
                val prompt = content.input.obj?.get("prompt")
                if (prompt != null) {
                    // A non-string prompt can never match a sidechain root's.
                    prompt.str?.let { state.promptToTaskId[it] = message.id }
                }
            }
        }

        if (!message.isSidechain) {
            state.processedIds.add(message.id)
            results.add(TracedMessage(message))
            continue
        }

        val uuid = message.firstUuid()
        val parentUuid = message.firstParentUuid()
        val rootTaskId = message.agentContent.firstNotNullOfOrNull { content ->
            (content as? AgentContent.Sidechain)?.prompt?.takeIf { it.isNotEmpty() }?.let { state.promptToTaskId[it] }
        }

        if (rootTaskId != null && uuid != null) {
            state.processedIds.add(message.id)
            state.uuidToSidechainId[uuid] = rootTaskId
            results.add(TracedMessage(message, rootTaskId))
            results.addAll(processOrphans(state, uuid, rootTaskId))
        } else if (parentUuid != null) {
            val parentSidechainId = state.uuidToSidechainId[parentUuid] ?: state.toolCallToMessageId[parentUuid]
            if (parentSidechainId != null) {
                state.processedIds.add(message.id)
                if (uuid != null) state.uuidToSidechainId[uuid] = parentSidechainId
                results.add(TracedMessage(message, parentSidechainId))
                if (uuid != null) results.addAll(processOrphans(state, uuid, parentSidechainId))
            } else if (!UUID_LIKE.matches(parentUuid)) {
                // A subagent id with no known owner: show it standalone rather
                // than orphan it forever.
                state.processedIds.add(message.id)
                results.add(TracedMessage(message))
            } else {
                state.orphanMessages.getOrPut(parentUuid) { ArrayList() }.add(message)
            }
        } else {
            state.processedIds.add(message.id)
            results.add(TracedMessage(message))
        }
    }
    return results
}

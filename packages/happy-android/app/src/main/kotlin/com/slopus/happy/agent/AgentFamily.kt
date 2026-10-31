package com.slopus.happy.agent

import androidx.compose.runtime.Immutable

/**
 * Where a conversation sits in home's tree, as its page draws it (iOS's
 * `Family.of`): nested, its parent, itself among its nearest siblings
 * ([around] either side, the window kept full at the ends), and its own
 * children under it, at most [children]; at the top level, itself over its
 * children alone. Alone, it has no family worth a card: empty.
 */
object AgentFamily {
    /** One row of the family's card, [depth] levels in from the card's edge. */
    @Immutable
    data class Member(val row: AgentFeedRow.Conversation, val depth: Int, val self: Boolean)

    fun of(agentId: String, rows: List<AgentFeedRow>, around: Int = 2, children: Int = 8): List<Member> {
        val conversations = rows.filterIsInstance<AgentFeedRow.Conversation>()
        val self = conversations.firstOrNull { it.agentId == agentId } ?: return emptyList()
        val own = conversations.filter { it.parentId == agentId }.take(maxOf(0, children))
        val family = ArrayList<Member>()
        val parent = self.parentId?.let { id -> conversations.firstOrNull { it.agentId == id } }
        if (parent == null) {
            family += Member(self, 0, self = true)
            own.forEach { family += Member(it, 1, self = false) }
        } else {
            family += Member(parent, 0, self = false)
            val siblings = conversations.filter { it.parentId == parent.agentId }
            val at = siblings.indexOfFirst { it.agentId == agentId }.coerceAtLeast(0)
            val width = 2 * around + 1
            val lower = maxOf(0, minOf(at - around, siblings.size - width))
            for (sibling in siblings.subList(lower, minOf(siblings.size, lower + width))) {
                val isSelf = sibling.agentId == agentId
                family += Member(sibling, 1, isSelf)
                if (isSelf) own.forEach { family += Member(it, 2, self = false) }
            }
        }
        return if (family.size > 1) family else emptyList()
    }
}

package com.slopus.happy.analytics

import com.slopus.happy.agent.AgentCatalog
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Who a Happy Agent conversation is with, as `message_sent` and
 * `chat_failure_shown` say it (desktop's `activityAddress`): a bot's own
 * conversation is the bot, or the Chief of Staff; anything else is a
 * session, [taskDepth] below the top.
 */
data class ChatAddress(val target: ChatTarget, val chiefOfStaff: Boolean, val taskDepth: Int?) {
    companion object {
        fun of(catalog: AgentCatalog, agentId: String): ChatAddress {
            val bot = catalog.bots.values.firstOrNull { (it["agent"] as? JsonObject)?.text("id") == agentId }
            if (bot != null) {
                val chief = bot.text("systemKey") == "chief_of_staff"
                return ChatAddress(if (chief) ChatTarget.ChiefOfStaff else ChatTarget.Bot, chief, 0)
            }
            var depth = 0
            var parent = catalog.agents[agentId]?.text("parentAgentId")
            while (parent != null) {
                if (++depth > MAX_DEPTH) return ChatAddress(ChatTarget.Session, false, null)
                parent = catalog.agents[parent]?.text("parentAgentId")
            }
            return ChatAddress(ChatTarget.Session, false, depth.takeIf { agentId in catalog.agents })
        }

        private const val MAX_DEPTH = 32

        private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}

package com.slopus.happy.chat

import com.slopus.happy.chat.NormalizedMessage.AgentContent

private val LIMIT_REACHED = Regex("^Claude AI usage limit reached\\|(\\d+)\\z")

/**
 * Messages that render as a centered event instead of their content
 * (sync/reducer/messageToEvent.ts): Claude's usage-limit text, a title
 * change, and entering plan mode.
 */
fun parseMessageAsEvent(msg: NormalizedMessage): AgentEvent? {
    if (msg.isSidechain) return null
    for (content in msg.agentContent) {
        if (content is AgentContent.Text) {
            LIMIT_REACHED.find(content.text)?.groupValues?.get(1)?.toLongOrNull()?.let {
                return AgentEvent.LimitReached(it)
            }
        }
        if (content is AgentContent.ToolUse && content.name == "mcp__happy__change_title") {
            val title = content.input.obj?.get("title").str
            if (title != null) return AgentEvent.Message("Title changed to \"$title\"")
        }
        if (content is AgentContent.ToolUse && (content.name == "EnterPlanMode" || content.name == "enter_plan_mode")) {
            return AgentEvent.Message("Entering plan mode")
        }
    }
    return null
}

/**
 * The last explicit plan-mode transition in a batch (messagePlanMode.ts):
 * true after EnterPlanMode, false after ExitPlanMode, null if neither.
 */
fun messagePlanMode(messages: List<NormalizedMessage>): Boolean? {
    var planMode: Boolean? = null
    for (message in messages) {
        for (content in message.agentContent) {
            if (content !is AgentContent.ToolUse) continue
            if (content.name == "EnterPlanMode" || content.name == "enter_plan_mode") planMode = true
            if (content.name == "ExitPlanMode" || content.name == "exit_plan_mode") planMode = false
        }
    }
    return planMode
}

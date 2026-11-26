package com.slopus.happy.conversation

import java.net.URLEncoder

/**
 * A bug report for a message that couldn't be shown: a new issue on the
 * tracker Settings' Report an Issue opens, prefilled with where it was
 * (the server, the agent, the message) and the check's short reason. The
 * person reads it before sending; it never holds what the message said.
 */
object UndisplayableReport {
    const val NEW_ISSUE_URL = "https://github.com/slopus/happy/issues/new"

    /** The longest reason the report carries. */
    private const val PROBLEM_LIMIT = 300

    fun url(server: String?, agentId: String, row: ConversationRow.Undisplayable, app: String): String =
        "$NEW_ISSUE_URL?title=${encode("Android: a message failed to display")}&body=${encode(body(server, agentId, row, app))}"

    fun body(server: String?, agentId: String, row: ConversationRow.Undisplayable, app: String): String = buildString {
        appendLine("A message in a Happy Agent conversation failed to display.")
        appendLine()
        appendLine("- Server: ${server ?: "paired agent"}")
        appendLine("- Agent: $agentId")
        appendLine("- Message: ${row.messageId}")
        appendLine("- Error: ${row.problem.take(PROBLEM_LIMIT)}")
        append("- App: Android $app")
    }

    private fun encode(text: String) = URLEncoder.encode(text, "UTF-8").replace("+", "%20")
}

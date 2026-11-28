package com.slopus.happy.conversation

import java.net.URLEncoder

/**
 * A bug report for a message that couldn't be shown: a new issue on the
 * tracker Settings' Report an Issue opens, prefilled with where it was
 * (the server, the agent, the message) and the check's short reason. The
 * person reads it before sending; it never holds what the message said:
 * an ID that doesn't look like one ([ID]) is left out, and the address is
 * at most [URL_LIMIT] long.
 */
object UndisplayableReport {
    const val NEW_ISSUE_URL = "https://github.com/slopus/happy/issues/new"

    /** The longest address the report opens; the reason, then the server, give way first. */
    const val URL_LIMIT = 2000

    /** An ID as servers write them (a CUID2, a UUID); anything else came from somewhere it shouldn't. */
    private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")

    private const val TITLE = "Android: a message failed to display"

    fun url(server: String?, agentId: String, row: ConversationRow.Undisplayable, app: String): String {
        var problem = row.problem
        var host = server
        while (true) {
            val url = "$NEW_ISSUE_URL?title=${encode(TITLE)}&body=${encode(body(host, agentId, row.messageId, problem, app))}"
            if (url.length <= URL_LIMIT) return url
            when {
                problem.isNotEmpty() -> problem = problem.dropLast(maxOf(1, problem.length / 4))
                host != null -> host = null
                else -> return url.take(URL_LIMIT)
            }
        }
    }

    fun body(server: String?, agentId: String, row: ConversationRow.Undisplayable, app: String): String =
        body(server, agentId, row.messageId, row.problem, app)

    private fun body(server: String?, agentId: String, messageId: String, problem: String, app: String): String = buildString {
        appendLine("A message in a Happy Agent conversation failed to display.")
        appendLine()
        appendLine("- Server: ${server ?: "paired agent"}")
        appendLine("- Agent: ${shown(agentId)}")
        appendLine("- Message: ${shown(messageId)}")
        appendLine("- Error: $problem")
        append("- App: Android $app")
    }

    /** [id] where it looks like an ID; a placeholder's own (`<run>:<index>`) and anything else isn't said. */
    internal fun shown(id: String) = if (ID.matches(id)) id else "(not shown)"

    private fun encode(text: String) = URLEncoder.encode(text, "UTF-8").replace("+", "%20")
}

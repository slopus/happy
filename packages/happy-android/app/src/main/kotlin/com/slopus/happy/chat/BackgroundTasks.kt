package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonElement

// Background work a Claude Code session started besides its own turn: commands
// started with run_in_background, background subagents and watchers. happy-cli
// (packages/happy-cli/src/claude) sends no session envelope for the SDK's
// task_started / task_progress / task_notification system messages
// (sessionProtocolMapper.ts drops every `system` message), so the two things
// that do reach the app are the tool call that started a task (its
// `run_in_background` input, with the command and description) and the
// `<task-notification>` envelope Claude Code writes into the conversation when
// the task ends (happy-wire controlMessages.ts). That is what this builds task
// state from; there is no live progress (see AGENTS.md, "Background tasks").

private const val TASK_NOTIFICATION_OPEN = "<task-notification>"
private const val TASK_NOTIFICATION_CLOSE = "</task-notification>"

/** How a background task was started, for its glyph and its words. */
enum class BackgroundTaskKind { Command, Subagent, Other }

/** Where a background task stands. [Running] is `Running` until a notification says otherwise. */
enum class BackgroundTaskStatus {
    Running, Completed, Failed, Cancelled;

    companion object {
        /** A notification's `<status>` (Claude Code: completed, failed, killed, stopped…). */
        fun of(raw: String?): BackgroundTaskStatus {
            return when (raw?.trim()?.lowercase()) {
                null, "" -> Completed
                "failed", "error", "errored" -> Failed
                "cancelled", "canceled", "stopped", "aborted", "killed", "interrupted" -> Cancelled
                else -> Completed
            }
        }
    }
}

/**
 * One background task of a session, as far as the protocol carries it. A task
 * started with `run_in_background` has its command and description from the
 * tool call; its id, status and summary come from the notification that ends
 * it, matched by the quoted description in that notification's summary. A task
 * only ever seen by its notification (a session opened after it started) has
 * no [startedAt] and no [command].
 */
@Immutable
data class BackgroundTask(
    /** Stable key for the list: the tool call's `call:<id>`, else the notification's `task:<id>`. */
    val id: String,
    val kind: BackgroundTaskKind,
    val title: String,
    /** The Bash command, when the task is a background command. */
    val command: String? = null,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val status: BackgroundTaskStatus = BackgroundTaskStatus.Running,
    /** The notification's `<summary>`: how it ended, or what the notification knew. */
    val summary: String? = null,
    /** The notification's `<output-file>`, where a background command's output was written. */
    val outputFile: String? = null,
    val subagentTokens: Long? = null,
    val toolUses: Long? = null,
    /** The notification's `<task-id>`, once one has named this task. */
    val taskId: String? = null,
) {
    val isRunning: Boolean get() = status == BackgroundTaskStatus.Running
}

/**
 * A `<task-notification>` envelope: what Claude Code writes into the
 * conversation when a background task ends (happy-wire controlMessages.ts).
 * The fields are optional because the producer writes fewer of them for some
 * kinds (a command has no `<result>`, a subagent has no `<output-file>`).
 */
@Immutable
data class BackgroundTaskNotification(
    val taskId: String? = null,
    val rawStatus: String? = null,
    val summary: String? = null,
    val result: String? = null,
    val outputFile: String? = null,
    val subagentTokens: Long? = null,
    val toolUses: Long? = null,
) {
    val status: BackgroundTaskStatus get() = BackgroundTaskStatus.of(rawStatus)

    /** The name the summary quotes: `Background command "npm run build" completed (exit code 0)`. */
    val quotedTitle: String?
        get() = summary?.let { QUOTED.find(it) }?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.isNotEmpty() }

    companion object {
        private val TAGS = listOf("task-id", "status", "summary", "result", "output-file", "subagent_tokens", "tool_uses")

        /** One envelope's body (the tags between `<task-notification>` and its close). */
        fun parse(body: String): BackgroundTaskNotification? {
            val fields = TAGS.associateWith { tag -> text(body, tag) }
            val notification = BackgroundTaskNotification(
                taskId = fields["task-id"],
                rawStatus = fields["status"],
                summary = fields["summary"],
                result = fields["result"],
                outputFile = fields["output-file"],
                subagentTokens = fields["subagent_tokens"]?.toLongOrNull(),
                toolUses = fields["tool_uses"]?.toLongOrNull(),
            )
            // An empty wrapper says nothing; leaving it out keeps a stray
            // `<task-notification></task-notification>` from closing a task.
            if (notification.taskId == null && notification.summary == null && notification.rawStatus == null) return null
            return notification
        }

        private fun text(body: String, tag: String): String? {
            val match = Regex("<$tag>(.*?)</$tag>", RegexOption.DOT_MATCHES_ALL).find(body) ?: return null
            return match.groupValues[1].trim().takeIf { it.isNotEmpty() }
        }
    }
}

private val QUOTED = Regex("\"([^\"]+)\"")

/**
 * The complete leading `<task-notification>` envelopes of [text] and what is
 * left of it (happy-wire controlMessages.ts). Incomplete wrappers and tags
 * written inline by a person are left where they are.
 */
fun takeLeadingTaskNotifications(text: String): Pair<List<BackgroundTaskNotification>, String> {
    var remainder = text.trimStart()
    val notifications = ArrayList<BackgroundTaskNotification>()
    var stripped = false
    while (remainder.startsWith(TASK_NOTIFICATION_OPEN)) {
        val end = leadingTaskNotificationEnd(remainder) ?: break
        val body = remainder.substring(TASK_NOTIFICATION_OPEN.length, end - TASK_NOTIFICATION_CLOSE.length)
        BackgroundTaskNotification.parse(body)?.let(notifications::add)
        stripped = true
        remainder = remainder.substring(end).trimStart()
    }
    return notifications to if (stripped) remainder else text
}

/** The offset just past the first leading wrapper's closing tag, or null if it never closes. */
private fun leadingTaskNotificationEnd(text: String): Int? {
    var depth = 1
    var cursor = TASK_NOTIFICATION_OPEN.length
    while (depth > 0) {
        val nextOpen = text.indexOf(TASK_NOTIFICATION_OPEN, cursor)
        val nextClose = text.indexOf(TASK_NOTIFICATION_CLOSE, cursor)
        if (nextClose == -1) return null
        if (nextOpen != -1 && nextOpen < nextClose) {
            depth += 1
            cursor = nextOpen + TASK_NOTIFICATION_OPEN.length
        } else {
            depth -= 1
            cursor = nextClose + TASK_NOTIFICATION_CLOSE.length
        }
    }
    return cursor
}

/**
 * The tasks of one session, kept as the reducer folds its records: a tool call
 * that asked to run in the background starts one, a task notification ends it.
 * A notification is joined to its call by the description its summary quotes;
 * when nothing quotes it and one task alone is still running, that one is taken
 * as its end. Feed records in order ([start] before [notify] for the same
 * record batch).
 */
internal class BackgroundTaskTracker {
    private val tasks = LinkedHashMap<String, BackgroundTask>()
    /** Notification task ids already applied, so a repeated envelope updates nothing twice. */
    private val keyByTaskId = HashMap<String, String>()
    private val pendingStops = HashMap<String, Long>()
    /** Notifications without a task id, by their content, so a repeat adds no second row. */
    private val anonymous = HashSet<String>()
    private var nextAnonymous = 0L

    val snapshot: List<BackgroundTask> get() = tasks.values.toList()

    fun start(callId: String, name: String, input: JsonElement?, at: Long) {
        val args = input.obj ?: return
        val normalizedName = name.trim().lowercase()
        // Claude Code sends no <task-notification> for a task it stops, so the
        // stop call itself ends the task it names.
        if (normalizedName in STOP_TOOLS) {
            val stoppedId = (args["task_id"].str ?: args["shell_id"].str)?.trim()?.takeIf { it.isNotEmpty() } ?: return
            stop(stoppedId, at)
            return
        }
        // Monitor tool always runs in background, no flag needed
        val isMonitor = normalizedName == "monitor"
        val runsInBackground = args["run_in_background"].bool == true || isMonitor
        if (!runsInBackground) return
        val key = "call:$callId"
        if (key in tasks) return
        val command = args["command"].str?.trim()?.takeIf { it.isNotEmpty() }
        val description = args["description"].str?.trim()?.takeIf { it.isNotEmpty() }
        val prompt = args["prompt"].str?.trim()?.takeIf { it.isNotEmpty() }
        val title = description ?: prompt ?: command?.substringBefore('\n')?.trim()?.take(TITLE_LIMIT) ?: name
        tasks[key] = BackgroundTask(id = key, kind = kindOf(name), title = title, command = command, startedAt = at)
    }

    /** Ends the running task Claude Code knows as [taskId], if it is one we track. */
    fun stop(taskId: String, at: Long) {
        // A history replay reduces every tool call before any result, so the
        // stop can come before the result that names its task: hold it.
        val key = keyByTaskId[taskId] ?: run { pendingStops[taskId] = at; return }
        val task = tasks[key] ?: return
        if (!task.isRunning) return
        tasks[key] = task.copy(status = BackgroundTaskStatus.Cancelled, finishedAt = at)
    }

    fun result(callId: String, resultText: String?) {
        val key = "call:$callId"
        val task = tasks[key] ?: return
        if (resultText == null) return
        // Extract task ID from Claude Code's result text:
        // - Bash: "Command running in background with ID: b6h0hc9m1."
        // - Agent: "agentId: a5a83112e6d5e344f"
        // - Monitor: "Monitor started (task b6rr103fb, timeout 1800000ms)."
        val bashMatch = BASH_TASK_ID.find(resultText)
        val agentMatch = AGENT_ID.find(resultText)
        val monitorMatch = MONITOR_TASK_ID.find(resultText)
        val taskId = bashMatch?.groupValues?.get(1)
            ?: monitorMatch?.groupValues?.get(1)
            ?: agentMatch?.groupValues?.get(1)
        if (taskId != null) {
            keyByTaskId[taskId] = key
            tasks[key] = task.copy(taskId = taskId)
            pendingStops.remove(taskId)?.let { stoppedAt -> stop(taskId, stoppedAt) }
        }
        // Extract output file for Bash commands
        val outputFileMatch = OUTPUT_FILE.find(resultText)
        val outputFile = outputFileMatch?.groupValues?.get(1)
        if (outputFile != null) {
            tasks[key] = tasks.getValue(key).copy(outputFile = outputFile)
        }
    }

    fun notify(notification: BackgroundTaskNotification, at: Long) {
        val taskId = notification.taskId
        if (taskId != null) {
            keyByTaskId[taskId]?.let { key -> tasks[key]?.let { tasks[key] = it.ended(notification, at) } ; return }
        } else {
            val fingerprint = "${notification.rawStatus}|${notification.summary}|${notification.result}"
            if (!anonymous.add(fingerprint)) return
        }
        val running = tasks.values.filter { it.isRunning }
        val key = running.firstOrNull { it.matches(notification) }?.id ?: running.singleOrNull()?.id
        if (key == null) {
            val created = fromNotification(notification, at)
            tasks[created.id] = created
            if (taskId != null) keyByTaskId[taskId] = created.id
            return
        }
        tasks[key] = tasks.getValue(key).ended(notification, at)
        if (taskId != null) keyByTaskId[taskId] = key
    }

    private fun fromNotification(notification: BackgroundTaskNotification, at: Long): BackgroundTask {
        val key = notification.taskId?.let { "task:$it" } ?: "task:anonymous-${nextAnonymous++}"
        val summary = notification.summary
        return BackgroundTask(
            id = key,
            kind = kindOfSummary(summary),
            title = notification.quotedTitle ?: summary ?: notification.taskId.orEmpty(),
            finishedAt = at,
            status = notification.status,
            summary = summary?.takeIf { it != notification.quotedTitle },
            outputFile = notification.outputFile,
            subagentTokens = notification.subagentTokens,
            toolUses = notification.toolUses,
            taskId = notification.taskId,
        )
    }

    private fun BackgroundTask.matches(notification: BackgroundTaskNotification): Boolean {
        val quoted = notification.quotedTitle ?: return false
        if (sameText(title, quoted)) return true
        return command != null && sameText(command, quoted)
    }

    private fun BackgroundTask.ended(notification: BackgroundTaskNotification, at: Long): BackgroundTask = copy(
        status = notification.status,
        finishedAt = at,
        summary = notification.summary,
        outputFile = notification.outputFile ?: outputFile,
        subagentTokens = notification.subagentTokens ?: subagentTokens,
        toolUses = notification.toolUses ?: toolUses,
        taskId = notification.taskId ?: taskId,
    )

    companion object {
        private const val TITLE_LIMIT = 80

        // Regexes to extract task IDs from Claude Code's tool result text.
        // Bash: "Command running in background with ID: b6h0hc9m1."
        /** Claude Code's tools that stop a background task by id (TaskStop; KillShell/KillBash before it). */
        private val STOP_TOOLS = setOf("taskstop", "killshell", "killbash")
        private val BASH_TASK_ID = Regex("""Command running in background with ID:\s*([a-z0-9]+)\.""")
        // Agent: "agentId: a5a83112e6d5e344f"
        private val AGENT_ID = Regex("""agentId:\s*([a-z0-9]+)""")
        // Monitor: "Monitor started (task b6rr103fb, timeout 1800000ms)."
        private val MONITOR_TASK_ID = Regex("""Monitor started \(task\s+([a-z0-9]+),""")
        // Output file: "Output is being written to: /path/to/file"
        private val OUTPUT_FILE = Regex("""Output is being written to:\s*(\S+?)\.?(?=\s|$)""")

        private fun kindOf(tool: String): BackgroundTaskKind {
            return when (tool.trim().lowercase()) {
                "bash", "shell", "command", "run_command", "execute" -> BackgroundTaskKind.Command
                "task", "agent" -> BackgroundTaskKind.Subagent
                "monitor" -> BackgroundTaskKind.Other
                else -> BackgroundTaskKind.Other
            }
        }

        private fun kindOfSummary(summary: String?): BackgroundTaskKind {
            val text = summary?.trim()?.lowercase() ?: return BackgroundTaskKind.Other
            return when {
                text.startsWith("background command") || text.startsWith("command ") -> BackgroundTaskKind.Command
                text.startsWith("agent") || text.startsWith("subagent") || text.startsWith("background agent") -> BackgroundTaskKind.Subagent
                else -> BackgroundTaskKind.Other
            }
        }

        /**
         * The CLI cuts a tool title at 77 characters with "..."; either side may
         * be the cut one, so a long prefix counts as the same text.
         */
        private fun sameText(a: String, b: String): Boolean {
            val left = normalize(a)
            val right = normalize(b)
            if (left.isEmpty() || right.isEmpty()) return false
            if (left == right) return true
            val (shorter, longer) = if (left.length <= right.length) left to right else right to left
            return shorter.length >= 24 && longer.startsWith(shorter)
        }

        private fun normalize(text: String): String {
            return text.trim().removeSuffix("...").trim().lowercase().replace(Regex("\\s+"), " ")
        }
    }
}

/**
 * What the session screen lists, in the order it lists it: running first
 * (oldest first), then the most recently finished (newest first), at most
 * [finishedLimit] of those.
 */
fun backgroundTasksForDisplay(tasks: List<BackgroundTask>, finishedLimit: Int = 10): List<BackgroundTask> {
    val running = tasks.filter { it.isRunning }.sortedBy { it.startedAt ?: Long.MAX_VALUE }
    val finished = tasks.filterNot { it.isRunning }.sortedByDescending { it.finishedAt ?: it.startedAt ?: 0 }
    return running + finished.take(finishedLimit)
}

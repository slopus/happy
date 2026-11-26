package com.slopus.happy.chat

import com.slopus.happy.chat.NormalizedMessage.Body
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Background tasks of a Happy CLI (relay) session: what the tool call that
 * started one carries (`run_in_background`), what Claude Code's
 * `<task-notification>` envelope says when it ends, and how the reducer joins
 * the two. The CLI sends no envelope for the SDK's task_started /
 * task_progress system messages, so there is no live progress to test.
 */
class BackgroundTaskTest {
    private fun notificationText(vararg lines: String) = buildString {
        append("<task-notification>\n")
        for (line in lines) append(line).append('\n')
        append("</task-notification>")
    }

    private fun notification(status: String, summary: String, id: String = "b123", extra: String = "") =
        notificationText("<task-id>$id</task-id>", "<status>$status</status>", "<summary>$summary</summary>", extra)

    /** A user-role session envelope carrying [text], as ChatNormalizer reads it. */
    private fun normalized(id: String, at: Long, text: String): NormalizedMessage {
        val envelope = buildJsonObject {
            put("id", id)
            put("time", at)
            put("role", "user")
            put("ev", buildJsonObject { put("t", "text"); put("text", text) })
        }
        val record = buildJsonObject { put("role", "session"); put("content", envelope) }
        return ChatNormalizer.normalize(id, null, at, record)!!
    }

    private fun startCall(
        callId: String = "call-1",
        at: Long = 100,
        input: String = """{"command":"npm run build","description":"Build the app","run_in_background":true}""",
        name: String = "Bash",
    ) = agentMsg("m-$callId", at, toolUse(callId, name, input))

    @Test
    fun `a notification keeps its fields and the text after it`() {
        val text = notification(
            "completed",
            "Background command \"npm run build\" completed (exit code 0)",
            extra = "<output-file>/tmp/b123.output</output-file><usage><subagent_tokens>29207</subagent_tokens><tool_uses>14</tool_uses></usage>",
        ) + "\nContinue with the fix"
        val (notifications, visible) = takeLeadingTaskNotifications(text)
        val parsed = notifications.single()
        assertEquals("b123", parsed.taskId)
        assertEquals(BackgroundTaskStatus.Completed, parsed.status)
        assertEquals("Background command \"npm run build\" completed (exit code 0)", parsed.summary)
        assertEquals("npm run build", parsed.quotedTitle)
        assertEquals("/tmp/b123.output", parsed.outputFile)
        assertEquals(29207L, parsed.subagentTokens)
        assertEquals(14L, parsed.toolUses)
        assertEquals("Continue with the fix", visible)
        assertEquals("Continue with the fix", stripLeadingTaskNotificationWrappers(text))
    }

    @Test
    fun `incomplete and inline wrappers are left alone`() {
        val malformed = "<task-notification>unfinished"
        assertEquals(emptyList<BackgroundTaskNotification>(), takeLeadingTaskNotifications(malformed).first)
        assertEquals(malformed, takeLeadingTaskNotifications(malformed).second)
        val inline = "Explain <task-notification> wrappers"
        assertEquals(inline, takeLeadingTaskNotifications(inline).second)
    }

    @Test
    fun `the normalizer keeps control-only notifications off the chat`() {
        val message = normalized("n", 200, notification("completed", "Background command \"ls\" completed"))
        assertEquals(Body.Control, message.body)
        assertEquals("b123", message.taskNotifications.single().taskId)
        // A notification with real words after it is still the person's message.
        val followup = normalized("n2", 201, notification("completed", "Background command \"ls\" completed") + "\nNext please")
        assertEquals(Body.User("Next please"), followup.body)
        assertEquals(1, followup.taskNotifications.size)
        // The older plain user record takes the same path.
        val legacy = ChatNormalizer.normalize(
            "l", null, 1,
            buildJsonObject {
                put("role", "user")
                put("content", buildJsonObject { put("type", "text"); put("text", notification("completed", "Background command \"ls\" completed")) })
            },
        )!!
        assertEquals(Body.Control, legacy.body)
        assertEquals(1, legacy.taskNotifications.size)
    }

    @Test
    fun `a background bash call is running with its command and description`() {
        val state = ReducerState()
        state.reduce(startCall())
        val task = state.backgroundTasks.single()
        assertEquals(BackgroundTaskKind.Command, task.kind)
        assertEquals("Build the app", task.title)
        assertEquals("npm run build", task.command)
        assertEquals(100L, task.startedAt)
        assertTrue(task.isRunning)
    }

    @Test
    fun `a foreground call is no task`() {
        val state = ReducerState()
        state.reduce(startCall(input = """{"command":"ls","description":"List"}"""))
        state.reduce(startCall(callId = "call-2", input = """{"command":"ls","run_in_background":false}"""))
        assertEquals(emptyList<BackgroundTask>(), state.backgroundTasks)
    }

    @Test
    fun `the completion notification joins its task and ends it`() {
        val state = ReducerState()
        state.reduce(startCall())
        val result = state.reduce(
            normalized(
                "n", 200,
                notification("completed", "Background command \"Build the app\" completed (exit code 0)", extra = "<output-file>/tmp/b123.output</output-file>"),
            ),
        )
        // The notification's own record never becomes a chat row.
        assertEquals(emptyList<ChatMessage>(), result.messages)
        val task = state.backgroundTasks.single()
        assertEquals("call:call-1", task.id)
        assertEquals(BackgroundTaskStatus.Completed, task.status)
        assertEquals(200L, task.finishedAt)
        assertEquals("Background command \"Build the app\" completed (exit code 0)", task.summary)
        assertEquals("/tmp/b123.output", task.outputFile)
        assertEquals("b123", task.taskId)
    }

    @Test
    fun `a long command still joins its notification`() {
        val state = ReducerState()
        val command = "sleep 5 && " + "echo step; ".repeat(12) + "echo done-now"
        state.reduce(startCall(input = """{"command":"$command","run_in_background":true}"""))
        state.reduce(normalized("n", 200, notification("completed", "Background command \"$command\" completed (exit code 0)")))
        assertEquals(BackgroundTaskStatus.Completed, state.backgroundTasks.single().status)
    }

    @Test
    fun `failed and cancelled notifications say so`() {
        val state = ReducerState()
        state.reduce(startCall())
        state.reduce(normalized("n", 200, notification("killed", "Background command \"Build the app\" was killed")))
        assertEquals(BackgroundTaskStatus.Cancelled, state.backgroundTasks.single().status)

        val other = ReducerState()
        other.reduce(startCall())
        other.reduce(normalized("n", 200, notification("failed", "Background command \"Build the app\" failed (exit code 1)")))
        assertEquals(BackgroundTaskStatus.Failed, other.backgroundTasks.single().status)
    }

    @Test
    fun `a notification with no starting call still lists its task`() {
        val state = ReducerState()
        state.reduce(normalized("n", 200, notification("completed", "Agent \"Research the API\" completed", id = "agent-9")))
        val task = state.backgroundTasks.single()
        assertEquals("task:agent-9", task.id)
        assertEquals(BackgroundTaskKind.Subagent, task.kind)
        assertEquals("Research the API", task.title)
        assertEquals(BackgroundTaskStatus.Completed, task.status)
        assertNull(task.startedAt)
        assertEquals(200L, task.finishedAt)
    }

    @Test
    fun `a TaskStop call ends the task it names`() {
        val state = ReducerState()
        state.reduce(startCall(callId = "call-1", at = 100))
        state.reduce(startCall(callId = "call-2", at = 110, input = """{"command":"sleep 600","run_in_background":true}"""))
        state.reduce(agentMsg("r1", 120, toolResult("call-1", "Command running in background with ID: bi08ajid4.")))
        state.reduce(agentMsg("r2", 130, toolResult("call-2", "Command running in background with ID: bn1k57g03.")))
        state.reduce(agentMsg("s1", 300, toolUse("stop-1", "TaskStop", """{"task_id":"bi08ajid4"}""")))

        val stopped = state.backgroundTasks.first { it.id == "call:call-1" }
        assertEquals(BackgroundTaskStatus.Cancelled, stopped.status)
        assertEquals(300L, stopped.finishedAt)
        assertTrue(state.backgroundTasks.first { it.id == "call:call-2" }.isRunning)
    }

    @Test
    fun `a stop in the same history batch as its result still ends the task`() {
        val state = ReducerState()
        // A replay reduces every tool call before any result, so the stop is seen first.
        state.reduce(listOf(
            startCall(callId = "call-1", at = 100),
            agentMsg("r1", 120, toolResult("call-1", "Command running in background with ID: bi08ajid4.")),
            agentMsg("s1", 300, toolUse("stop-1", "TaskStop", """{"task_id":"bi08ajid4"}""")),
        ))

        val task = state.backgroundTasks.single()
        assertEquals(BackgroundTaskStatus.Cancelled, task.status)
        assertEquals(300L, task.finishedAt)
    }

    @Test
    fun `stopping an unknown or already finished task changes nothing`() {
        val state = ReducerState()
        state.reduce(startCall(callId = "call-1", at = 100))
        state.reduce(agentMsg("r1", 120, toolResult("call-1", "Command running in background with ID: bi08ajid4.")))
        state.reduce(listOf(normalized("n", 200, notification("completed", "Background command \"Build the app\" completed", id = "bi08ajid4"))))
        state.reduce(agentMsg("s1", 300, toolUse("stop-1", "TaskStop", """{"task_id":"bi08ajid4"}""")))
        state.reduce(agentMsg("s2", 310, toolUse("stop-2", "TaskStop", """{"task_id":"nosuch"}""")))

        val task = state.backgroundTasks.single()
        assertEquals(BackgroundTaskStatus.Completed, task.status)
        assertEquals(200L, task.finishedAt)
    }

    @Test
    fun `a repeated notification adds no second task`() {
        val state = ReducerState()
        state.reduce(startCall())
        val text = notification("completed", "Background command \"Build the app\" completed")
        val message = normalized("n", 200, text)
        state.reduce(listOf(message))
        val tasksAfterFirst = state.backgroundTasks
        // The reducers' own guard: the same record again is ignored.
        state.reduce(listOf(message))
        assertEquals(tasksAfterFirst, state.backgroundTasks)
        // A different record repeating the same task id keeps one task, updated in place.
        state.reduce(listOf(normalized("n2", 210, text)))
        assertEquals(1, state.backgroundTasks.size)
        assertEquals(BackgroundTaskStatus.Completed, state.backgroundTasks.single().status)
    }

    @Test
    fun `the display puts running tasks first, oldest first, then the newest finished`() {
        val runningOld = BackgroundTask("call:a", BackgroundTaskKind.Command, "Old", startedAt = 10)
        val runningNew = BackgroundTask("call:b", BackgroundTaskKind.Command, "New", startedAt = 30)
        val finishedOlder = BackgroundTask("task:c", BackgroundTaskKind.Command, "Older", finishedAt = 40, status = BackgroundTaskStatus.Completed)
        val finishedNewer = BackgroundTask("task:d", BackgroundTaskKind.Command, "Newer", finishedAt = 60, status = BackgroundTaskStatus.Failed)
        val order = backgroundTasksForDisplay(listOf(finishedNewer, runningNew, finishedOlder, runningOld)).map { it.title }
        assertEquals(listOf("Old", "New", "Newer", "Older"), order)
        assertEquals(1, backgroundTasksForDisplay(listOf(finishedNewer, finishedOlder), finishedLimit = 1).size)
    }

    @Test
    fun `status words map the notification's vocabulary`() {
        assertEquals(BackgroundTaskStatus.Completed, BackgroundTaskStatus.of("completed"))
        assertEquals(BackgroundTaskStatus.Failed, BackgroundTaskStatus.of("failed"))
        assertEquals(BackgroundTaskStatus.Cancelled, BackgroundTaskStatus.of("stopped"))
        assertEquals(BackgroundTaskStatus.Cancelled, BackgroundTaskStatus.of("killed"))
        assertEquals(BackgroundTaskStatus.Completed, BackgroundTaskStatus.of(null))
    }

    @Test
    fun `tool result with bash task id links exactly to the right task`() {
        val state = ReducerState()
        // Start two background tasks
        state.reduce(startCall(callId = "call-1", at = 100, input = """{"command":"npm test","description":"Run tests","run_in_background":true}"""))
        state.reduce(startCall(callId = "call-2", at = 110, input = """{"command":"npm build","description":"Build app","run_in_background":true}"""))

        // Add tool results with task IDs
        state.reduce(agentMsg("m-result-1", 150, toolResult("call-1", "Command running in background with ID: task123. Output is being written to: /tmp/task123.output")))
        state.reduce(agentMsg("m-result-2", 160, toolResult("call-2", "Command running in background with ID: task456. Output is being written to: /tmp/task456.output")))

        // Both tasks should still be running
        assertEquals(2, state.backgroundTasks.filter { it.isRunning }.size)
        val task1 = state.backgroundTasks.first { it.id == "call:call-1" }
        val task2 = state.backgroundTasks.first { it.id == "call:call-2" }
        assertEquals("task123", task1.taskId)
        assertEquals("task456", task2.taskId)
        assertEquals("/tmp/task123.output", task1.outputFile)
        assertEquals("/tmp/task456.output", task2.outputFile)

        // Send notification for task456 only
        state.reduce(normalized("n", 200, notification("completed", "Background command \"Build app\" completed (exit code 0)", id = "task456")))

        // Only task2 should be completed, task1 still running
        val updatedTask1 = state.backgroundTasks.first { it.id == "call:call-1" }
        val updatedTask2 = state.backgroundTasks.first { it.id == "call:call-2" }
        assertTrue(updatedTask1.isRunning)
        assertEquals(BackgroundTaskStatus.Completed, updatedTask2.status)
        assertEquals(200L, updatedTask2.finishedAt)
    }

    @Test
    fun `the output file stops at the path in Claude Code's real result text`() {
        val state = ReducerState()
        state.reduce(startCall(callId = "call-1", at = 100, input = """{"command":"sleep 60","run_in_background":true}"""))
        state.reduce(agentMsg("m-result-1", 150, toolResult("call-1", "Command running in background with ID: b6h0hc9m1. Output is being written to: /tmp/claude-1000/tasks/b6h0hc9m1.output. You will be notified when it completes.")))

        val task = state.backgroundTasks.single()
        assertEquals("b6h0hc9m1", task.taskId)
        assertEquals("/tmp/claude-1000/tasks/b6h0hc9m1.output", task.outputFile)
    }

    @Test
    fun `tool result with agent id links to agent task`() {
        val state = ReducerState()
        state.reduce(startCall(callId = "agent-1", at = 100, name = "Agent", input = """{"prompt":"Research the API","description":"Research","run_in_background":true}"""))
        state.reduce(agentMsg("m-result", 150, toolResult("agent-1", "agentId: a5a83112e6d5e344f")))

        val task = state.backgroundTasks.single()
        assertEquals("call:agent-1", task.id)
        assertEquals("a5a83112e6d5e344f", task.taskId)
        assertTrue(task.isRunning)

        // Notification with the agent id
        state.reduce(normalized("n", 200, notification("completed", "Agent \"Research\" completed", id = "a5a83112e6d5e344f")))

        val updated = state.backgroundTasks.single()
        assertEquals(BackgroundTaskStatus.Completed, updated.status)
        assertEquals("call:agent-1", updated.id)
    }

    @Test
    fun `monitor tool tracks as background task with correct id`() {
        val state = ReducerState()
        // Monitor tool doesn't have run_in_background flag but should be tracked
        state.reduce(startCall(callId = "mon-1", at = 100, name = "Monitor", input = """{"description":"Watch the build"}"""))
        state.reduce(agentMsg("m-result", 150, toolResult("mon-1", "Monitor started (task b6rr103fb, timeout 1800000ms).")))

        val task = state.backgroundTasks.single()
        assertEquals("call:mon-1", task.id)
        assertEquals(BackgroundTaskKind.Other, task.kind)
        assertEquals("Watch the build", task.title)
        assertEquals("b6rr103fb", task.taskId)
        assertTrue(task.isRunning)

        // Notification with the monitor task id
        state.reduce(normalized("n", 200, notification("completed", "Monitor task completed", id = "b6rr103fb")))

        val updated = state.backgroundTasks.single()
        assertEquals(BackgroundTaskStatus.Completed, updated.status)
    }

    @Test
    fun `fallback heuristic still works when no task id in result`() {
        val state = ReducerState()
        // Start a task but don't provide a task ID in the result
        state.reduce(startCall(callId = "call-1", at = 100, input = """{"command":"npm test","description":"Run tests","run_in_background":true}"""))
        state.reduce(agentMsg("m-result", 150, toolResult("call-1", "Starting background command...")))

        val task = state.backgroundTasks.single()
        assertEquals("call:call-1", task.id)
        assertNull(task.taskId) // No task ID extracted
        assertTrue(task.isRunning)

        // Notification without task-id tag but matching description
        val notificationWithoutId = notificationText(
            "<status>completed</status>",
            "<summary>Background command \"Run tests\" completed (exit code 0)</summary>",
        )
        state.reduce(normalized("n", 200, notificationWithoutId))

        // Should still match by description heuristic
        val updated = state.backgroundTasks.single()
        assertEquals(BackgroundTaskStatus.Completed, updated.status)
        assertEquals("call:call-1", updated.id)
    }

    @Test
    fun `fallback to single running task when no match found`() {
        val state = ReducerState()
        state.reduce(startCall(callId = "call-1", at = 100, input = """{"command":"npm test","description":"Run tests","run_in_background":true}"""))
        // No result, so no task ID

        // Notification with different description and no task-id
        val notificationWithoutId = notificationText(
            "<status>completed</status>",
            "<summary>Background command completed</summary>",
        )
        state.reduce(normalized("n", 200, notificationWithoutId))

        // Should match the single running task as fallback
        val updated = state.backgroundTasks.single()
        assertEquals(BackgroundTaskStatus.Completed, updated.status)
    }

    @Test
    fun `two tasks with one command are ended each by its own tool use id`() {
        val state = ReducerState()
        val command = "until grep -q DONE /tmp/and-build-status 2>/dev/null; do sleep 10; done; cat /tmp/and-build-status"
        val summary = "Background command \"$command\" completed (exit code 0)"
        // No result text ever names either task's id: the CLI's tool-call-end carries none.
        state.reduce(startCall(callId = "call-1", at = 100, input = """{"command":"$command","run_in_background":true}"""))
        state.reduce(startCall(callId = "call-2", at = 110, input = """{"command":"$command","run_in_background":true}"""))
        assertEquals(2, state.backgroundTasks.count { it.isRunning })

        state.reduce(normalized("n1", 200, notification(
            "completed", summary, id = "bl81y653t", extra = "<tool-use-id>call-1</tool-use-id>",
        )))
        state.reduce(normalized("n2", 210, notification(
            "completed", summary, id = "bl81y653u", extra = "<tool-use-id>call-2</tool-use-id>",
        )))

        assertEquals(2, state.backgroundTasks.size)
        assertEquals(0, state.backgroundTasks.count { it.isRunning })
        val first = state.backgroundTasks.first { it.id == "call:call-1" }
        val second = state.backgroundTasks.first { it.id == "call:call-2" }
        assertEquals(BackgroundTaskStatus.Completed, first.status)
        assertEquals(BackgroundTaskStatus.Completed, second.status)
        assertEquals(200L, first.finishedAt)
        assertEquals(210L, second.finishedAt)
        assertEquals("bl81y653t", first.taskId)
        assertEquals("bl81y653u", second.taskId)
    }

    @Test
    fun `an escaped summary still joins its task by the quoted title`() {
        val state = ReducerState()
        val watched = "until grep -q DONE /tmp/and-build-status 2>/dev/null; do sleep 10; done"
        state.reduce(startCall(callId = "call-1", at = 100, input = """{"command":"sleep 600","run_in_background":true}"""))
        state.reduce(startCall(callId = "call-2", at = 110, input = """{"command":"$watched","run_in_background":true}"""))

        // No tool-use-id and no task-id: only the quoted, escaped command can join it.
        state.reduce(normalized("n", 200, notificationText(
            "<status>completed</status>",
            "<summary>Background command \"until grep -q DONE /tmp/and-build-status 2&gt;/dev/null; do sleep 10; done\" completed (exit code 0)</summary>",
        )))

        assertEquals(BackgroundTaskStatus.Completed, state.backgroundTasks.first { it.id == "call:call-2" }.status)
        assertTrue(state.backgroundTasks.first { it.id == "call:call-1" }.isRunning)
        assertEquals(2, state.backgroundTasks.size)
    }

    @Test
    fun `a notification for an already ended task adds no row`() {
        val state = ReducerState()
        state.reduce(startCall(callId = "call-1", at = 100))
        state.reduce(normalized("n1", 200, notification(
            "completed", "Background command \"Build the app\" completed", id = "b1", extra = "<tool-use-id>call-1</tool-use-id>",
        )))
        // Another envelope naming the same call must not make a second, finished task.
        state.reduce(normalized("n2", 210, notification(
            "completed", "Background command \"Build the app\" completed", id = "b2", extra = "<tool-use-id>call-1</tool-use-id>",
        )))

        assertEquals(1, state.backgroundTasks.size)
        val task = state.backgroundTasks.single()
        assertEquals("call:call-1", task.id)
        assertEquals(200L, task.finishedAt)
    }

    @Test
    fun `parse keeps the tool use id and decodes xml entities`() {
        val text = notificationText(
            "<task-id>bl81y653t</task-id>",
            "<tool-use-id>toolu_bdrk_01Pmx6aokGBJLQr7yhRvv48n</tool-use-id>",
            "<status>completed</status>",
            "<summary>Background command \"a &lt;b&gt; &amp;&amp; c &#39;d&#39; &apos;e&apos; 2&gt;/dev/null\" completed</summary>",
        )
        val parsed = takeLeadingTaskNotifications(text).first.single()
        assertEquals("toolu_bdrk_01Pmx6aokGBJLQr7yhRvv48n", parsed.toolUseId)
        assertEquals("Background command \"a <b> && c 'd' 'e' 2>/dev/null\" completed", parsed.summary)
    }
}

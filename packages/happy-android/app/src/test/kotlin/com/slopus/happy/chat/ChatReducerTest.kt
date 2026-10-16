package com.slopus.happy.chat

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** happy-app's sync/reducer/reducer.spec.ts, case for case where the case still applies. */
class ChatReducerTest {
    private val state = ReducerState(now = { 999_999 })

    // user message handling

    @Test fun `processes user messages with localId`() {
        val result = state.reduce(userMsg("msg1", "Hello", localId = "local123", createdAt = 1000))
        val message = result.messages.single() as ChatMessage.UserText
        assertEquals("Hello", message.text)
        assertEquals("local123", message.localId)
        assertTrue("local123" in state.localIds)
    }

    @Test fun `deduplicates user messages by localId`() {
        assertEquals(1, state.reduce(userMsg("msg1", "First", localId = "local123", createdAt = 1000)).messages.size)
        assertEquals(0, state.reduce(userMsg("msg2", "Second", localId = "local123", createdAt = 2000)).messages.size)
    }

    @Test fun `deduplicates user messages by id when there is no localId`() {
        assertEquals(1, state.reduce(userMsg("msg1", "First", createdAt = 1000)).messages.size)
        assertEquals(0, state.reduce(userMsg("msg1", "Second", createdAt = 2000)).messages.size)
    }

    @Test fun `processes several user messages in order`() {
        val result = state.reduce(
            userMsg("msg1", "First", localId = "local123", createdAt = 1000),
            userMsg("msg2", "Second", localId = "local456", createdAt = 2000),
            userMsg("msg3", "Third", createdAt = 3000),
        )
        assertEquals(listOf("First", "Second", "Third"), result.messages.map { (it as ChatMessage.UserText).text })
    }

    // agent text

    @Test fun `processes agent text`() {
        val result = state.reduce(agentMsg("agent1", 1000, text("Hello from Claude!")))
        assertEquals("Hello from Claude!", (result.messages.single() as ChatMessage.AgentText).text)
    }

    @Test fun `thinking renders in italics and is flagged`() {
        val result = state.reduce(agentMsg("a", 1000, NormalizedMessage.AgentContent.Thinking("hmm", "u", null)))
        val message = result.messages.single() as ChatMessage.AgentText
        assertEquals("*hmm*", message.text)
        assertTrue(message.isThinking)
    }

    @Test fun `updates latest usage from agent messages`() {
        val usage = UsageData(inputTokens = 1200, outputTokens = 80, cacheCreationInputTokens = 40, cacheReadInputTokens = 500)
        val result = state.reduce(agentMsg("agent-usage-1", 1000, text("Hello with usage"), usage = usage))
        assertEquals(ContextUsage(1200, 80, 40, 500, 1740), result.usage)
    }

    @Test fun `updates latest usage from usage-only agent messages`() {
        val usage = UsageData(inputTokens = 1200, outputTokens = 80, cacheCreationInputTokens = 40, cacheReadInputTokens = 500)
        val result = state.reduce(agentMsg("agent-usage-only-1", 1000, usage = usage))
        assertEquals(0, result.messages.size)
        assertEquals(ContextUsage(1200, 80, 40, 500, 1740), result.usage)
    }

    @Test fun `keeps the context window from usage data`() {
        val usage = UsageData(inputTokens = 10422, outputTokens = 2140, cacheReadInputTokens = 113536, contextWindow = 258400.0)
        val result = state.reduce(agentMsg("w", 1000, usage = usage))
        assertEquals(ContextUsage(10422, 2140, 0, 113536, 123958, 258400), result.usage)
    }

    @Test fun `processes several text blocks in one agent message`() {
        val result = state.reduce(agentMsg("agent1", 1000, text("Part 1"), text("Part 2")))
        assertEquals(listOf("Part 1", "Part 2"), result.messages.map { (it as ChatMessage.AgentText).text })
    }

    @Test fun `handles interleaved user and agent messages`() {
        val result = state.reduce(
            userMsg("user1", "Question 1", localId = "local1", createdAt = 1000),
            agentMsg("agent1", 2000, text("Answer 1")),
            userMsg("user2", "Question 2", localId = "local2", createdAt = 3000),
            agentMsg("agent2", 4000, text("Answer 2")),
        )
        assertEquals(
            listOf("Question 1", "Answer 1", "Question 2", "Answer 2"),
            result.messages.map { (it as? ChatMessage.UserText)?.text ?: (it as ChatMessage.AgentText).text },
        )
    }

    // edge cases

    @Test fun `does not duplicate agent messages applied several times`() {
        val message = agentMsg("agent1", 1000, text("Hello world!"))
        assertEquals(1, state.reduce(message).messages.size)
        assertEquals(0, state.reduce(message).messages.size)
        assertEquals(0, state.reduce(message).messages.size)
    }

    @Test fun `unsupported records become one placeholder row each`() {
        val record = NormalizedMessage("old", null, 1000, NormalizedMessage.Body.Unsupported("agent.output.assistant"))
        val result = state.reduce(record)
        assertEquals(ChatMessage.Unsupported(result.messages.single().id, 1000, "agent.output.assistant"), result.messages.single())
        assertEquals(0, state.reduce(record).messages.size)
    }

    // AgentState permissions

    @Test fun `creates tool messages for pending permission requests`() {
        val result = state.reduce(agentState = agentState("""{"requests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls -la"},"createdAt":1000}}}"""))
        val tool = result.messages.single().tool
        assertEquals("tool-1", tool.callId)
        assertEquals("Bash", tool.name)
        assertEquals(ToolState.Running, tool.state)
        assertEquals(ToolPermission("tool-1", PermissionStatus.Pending), tool.permission)
    }

    @Test fun `updates permission status for completed requests`() {
        assertEquals(1, state.reduce(agentState = agentState(PENDING_LS)).messages.size)
        val result = state.reduce(
            agentState = agentState("""{"completedRequests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls -la"},"createdAt":1000,"completedAt":2000,"status":"denied","reason":"User denied permission"}}}"""),
        )
        val tool = result.messages.single().tool
        assertEquals(ToolState.Error, tool.state)
        assertEquals(PermissionStatus.Denied, tool.permission?.status)
        assertEquals("User denied permission", tool.permission?.reason)
    }

    @Test fun `matches incoming tool calls to approved permission messages`() {
        val approved = agentState(APPROVED_LS_LA)
        assertEquals(1, state.reduce(agentState = approved).messages.size)
        val result = state.reduce(agentMsg("msg-1", 3000, toolUse("tool-1", "Bash", """{"command":"ls -la"}""")), agentState = approved)
        val tool = result.messages.single().tool
        assertEquals("tool-1", tool.callId)
        assertEquals(PermissionStatus.Approved, tool.permission?.status)
        assertEquals(ToolState.Running, tool.state)
    }

    @Test fun `merges the real tool call's args into the matched permission message`() {
        val fileChanges = """{"src/example.ts":{"modify":{"old_content":"before","new_content":"after"}}}"""
        val approved = agentState("""{"completedRequests":{"tool-1":{"tool":"CodexPatch","arguments":{"fileChanges":$fileChanges},"createdAt":1000,"completedAt":2000,"status":"approved"}}}""")
        state.reduce(agentState = approved)
        val result = state.reduce(
            agentMsg("msg-1", 3000, toolUse("tool-1", "CodexPatch", """{"auto_approved":false,"changes":$fileChanges}""", description = "Apply patch to 1 file")),
            agentState = approved,
        )
        val tool = result.messages.single().tool
        assertEquals(json("""{"auto_approved":false,"changes":$fileChanges,"fileChanges":$fileChanges}"""), tool.input)
        assertEquals(3000L, tool.startedAt)
    }

    @Test fun `matches tool calls by id regardless of arguments`() {
        assertEquals(2, state.reduce(agentState = agentState("""{"requests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls -la"},"createdAt":1000},"tool-2":{"tool":"Bash","arguments":{"command":"pwd"},"createdAt":2000}}}""")).messages.size)
        val approved = agentState("""{"completedRequests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls -la"},"createdAt":1000,"completedAt":3000,"status":"approved"},"tool-2":{"tool":"Bash","arguments":{"command":"pwd"},"createdAt":2000,"completedAt":3000,"status":"approved"}}}""")
        state.reduce(agentState = approved)
        val result = state.reduce(agentMsg("msg-1", 4000, toolUse("tool-1", "Bash", """{"command":"pwd"}""")), agentState = approved)
        assertEquals(json("""{"command":"ls -la"}"""), result.messages.single().tool.input)
        assertEquals(2, state.toolIdToMessageId.size)
    }

    @Test fun `a tool call with a new id does not take over an existing permission row`() {
        val approved = agentState("""{"completedRequests":{"tool-old":{"tool":"Bash","arguments":{"command":"ls"},"createdAt":1000,"completedAt":2000,"status":"approved"},"tool-new":{"tool":"Bash","arguments":{"command":"ls"},"createdAt":3000,"completedAt":4000,"status":"approved"}}}""")
        assertEquals(2, state.reduce(agentState = approved).messages.size)
        val result = state.reduce(agentMsg("msg-1", 5000, toolUse("tool-1", "Bash", """{"command":"ls"}""")), agentState = approved)
        assertEquals(1, result.messages.size)
        assertEquals(3, state.toolIdToMessageId.size)
        assertNull(state.toolRow("tool-new").tool?.startedAt)
        assertNull(state.toolRow("tool-old").tool?.startedAt)
    }

    @Test fun `does not create duplicates when called twice with the same agent state`() {
        val s = agentState("""{"requests":{"tool-pending":{"tool":"Read","arguments":{"file":"test.txt"},"createdAt":1000}},"completedRequests":{"tool-completed":{"tool":"Write","arguments":{"file":"output.txt","content":"hello"},"createdAt":2000,"completedAt":3000,"status":"approved"}}}""")
        assertEquals(2, state.reduce(agentState = s).messages.size)
        assertEquals(0, state.reduce(agentState = s).messages.size)
        val result = state.reduce(userMsg("msg-1", "Hello", createdAt = 4000), agentState = s)
        assertTrue(result.messages.single() is ChatMessage.UserText)
        assertEquals(2, state.toolIdToMessageId.size)
    }

    @Test fun `a tool call arriving with its completed permission takes the call's timestamp`() {
        val result = state.reduce(agentMsg("tool-msg-1", 5000, toolUse("tool-1", "Bash", """{"command":"ls"}""")), agentState = agentState(APPROVED_LS))
        val message = result.messages.single() as ChatMessage.ToolCallMessage
        assertEquals(5000L, message.createdAt)
        assertEquals("tool-1", message.tool.permission?.id)
        assertEquals(PermissionStatus.Approved, message.tool.permission?.status)
    }

    @Test fun `keeps the request's timestamp when the request comes before the tool call`() {
        assertEquals(1, state.reduce(agentState = agentState(PENDING_LS_SHORT)).messages.size)
        val row = state.toolRow("tool-1")
        assertEquals(1000L, row.createdAt)
        assertNull(row.realID)
        assertEquals(1, state.reduce(agentState = agentState(APPROVED_LS)).messages.size)
        assertEquals(1, state.reduce(agentMsg("tool-msg-1", 5000, toolUse("tool-1", "Bash", """{"command":"ls"}""")), agentState = agentState(APPROVED_LS)).messages.size)
        val final = state.toolRow("tool-1")
        assertEquals(row.id, final.id)
        assertEquals(1000L, final.createdAt)
        assertEquals("tool-msg-1", final.realID)
        assertEquals(5000L, final.tool?.startedAt)
        assertEquals(PermissionStatus.Approved, final.tool?.permission?.status)
    }

    @Test fun `separate permission rows for the same tool with different arguments`() {
        val s = agentState("""{"completedRequests":{"tool-ls":{"tool":"Bash","arguments":{"command":"ls -la"},"createdAt":1000,"completedAt":2000,"status":"approved"},"tool-pwd":{"tool":"Bash","arguments":{"command":"pwd"},"createdAt":1500,"completedAt":2000,"status":"approved"}}}""")
        assertEquals(2, state.reduce(agentState = s).messages.size)
        val ls = state.toolRow("tool-ls").id
        val pwd = state.toolRow("tool-pwd").id
        assertNotEquals(ls, pwd)
        assertEquals(1, state.reduce(agentMsg("msg-1", 3000, toolUse("tool-pwd", "Bash", """{"command":"pwd"}""")), agentState = s).messages.size)
        assertEquals(1, state.reduce(agentMsg("msg-2", 4000, toolUse("tool-ls", "Bash", """{"command":"ls -la"}""")), agentState = s).messages.size)
        assertEquals(ls, state.toolRow("tool-ls").id)
        assertEquals(4000L, state.toolRow("tool-ls").tool?.startedAt)
        assertEquals(3000L, state.toolRow("tool-pwd").tool?.startedAt)
        assertEquals(2, state.toolIdToMessageId.size)
    }

    @Test fun `updates the permission row when the tool call has its id`() {
        val result = state.reduce(agentMsg("tool-msg-1", 2000, toolUse("tool-1", "Bash", """{"command":"pwd"}""")), agentState = agentState(PENDING_LS))
        val message = result.messages.single() as ChatMessage.ToolCallMessage
        assertEquals("tool-1", message.tool.permission?.id)
        assertEquals(PermissionStatus.Pending, message.tool.permission?.status)
        assertEquals(json("""{"command":"ls -la"}"""), message.tool.input)
        assertEquals(1000L, message.createdAt)
        val rowId = state.toolRow("tool-1").id
        val result2 = state.reduce(agentMsg("tool-msg-2", 4000, toolUse("tool-1", "Bash", """{"command":"ls -la"}""")), agentState = agentState(APPROVED_LS_LA))
        assertEquals(PermissionStatus.Approved, result2.messages.single().tool.permission?.status)
        assertEquals(rowId, state.toolRow("tool-1").id)
    }

    @Test fun `full permission lifecycle - pending, approved, running, completed`() {
        val pending = state.reduce(agentState = agentState("""{"requests":{"tool-1":{"tool":"Read","arguments":{"file":"/test.txt"},"createdAt":1000}}}""")).messages.single().tool
        assertEquals(ToolState.Running, pending.state)
        assertEquals(PermissionStatus.Pending, pending.permission?.status)
        val approved = agentState("""{"completedRequests":{"tool-1":{"tool":"Read","arguments":{"file":"/test.txt"},"createdAt":1000,"completedAt":2000,"status":"approved"}}}""")
        val afterApproval = state.reduce(agentState = approved).messages.single().tool
        assertEquals(PermissionStatus.Approved, afterApproval.permission?.status)
        assertEquals(ToolState.Running, afterApproval.state)
        assertEquals(3000L, state.reduce(agentMsg("msg-1", 3000, toolUse("tool-1", "Read", """{"file":"/test.txt"}""")), agentState = approved).messages.single().tool.startedAt)
        val done = state.reduce(agentMsg("msg-2", 4000, toolResult("tool-1", "File contents")), agentState = approved).messages.single().tool
        assertEquals(ToolState.Completed, done.state)
        assertEquals(JsonPrimitive("File contents"), done.result)
        assertEquals(4000L, done.completedAt)
    }

    @Test fun `denied and canceled permissions become errors with their reasons`() {
        assertEquals(2, state.reduce(agentState = agentState("""{"requests":{"tool-deny":{"tool":"Write","arguments":{"file":"/secure.txt"},"createdAt":1000},"tool-cancel":{"tool":"Delete","arguments":{"file":"/important.txt"},"createdAt":1500}}}""")).messages.size)
        val result = state.reduce(agentState = agentState("""{"completedRequests":{"tool-deny":{"tool":"Write","arguments":{"file":"/secure.txt"},"createdAt":1000,"completedAt":2000,"status":"denied","reason":"Unauthorized access"},"tool-cancel":{"tool":"Delete","arguments":{"file":"/important.txt"},"createdAt":1500,"completedAt":2500,"status":"canceled","reason":"User canceled"}}}"""))
        val denied = result.messages.first { it.tool.name == "Write" }.tool
        assertEquals(ToolState.Error, denied.state)
        assertEquals(PermissionStatus.Denied, denied.permission?.status)
        assertEquals(json("""{"error":"Unauthorized access"}"""), denied.result)
        val canceled = result.messages.first { it.tool.name == "Delete" }.tool
        assertEquals(PermissionStatus.Canceled, canceled.permission?.status)
        assertEquals(json("""{"error":"User canceled"}"""), canceled.result)
    }

    @Test fun `a tool result arriving before its call is ignored`() {
        assertEquals(0, state.reduce(agentMsg("msg-1", 1000, toolResult("tool-1", "Success"))).messages.size)
        val call = state.reduce(agentMsg("msg-2", 2000, toolUse("tool-1", "Test", """{"test":true}"""))).messages.single().tool
        assertEquals(ToolState.Running, call.state)
        assertNull(call.result)
        val done = state.reduce(agentMsg("msg-3", 3000, toolResult("tool-1", "Success"))).messages.single().tool
        assertEquals(ToolState.Completed, done.state)
        assertEquals(JsonPrimitive("Success"), done.result)
    }

    @Test fun `interleaved messages from several sources`() {
        val s = agentState("""{"requests":{"tool-1":{"tool":"Bash","arguments":{"command":"echo"},"createdAt":1500}},"completedRequests":{"tool-2":{"tool":"Read","arguments":{"file":"test.txt"},"createdAt":500,"completedAt":1000,"status":"approved"}}}""")
        val result = state.reduce(
            listOf(
                userMsg("user-1", "Do something", localId = "local-1", createdAt = 1000),
                agentMsg("agent-1", 2000, text("I will help you")),
                agentMsg("tool-1", 3000, toolUse("tool-new", "Write", """{"file":"output.txt"}""")),
            ),
            s,
        )
        assertEquals(5, result.messages.size)
        assertEquals(3, result.messages.count { it is ChatMessage.ToolCallMessage })
        assertTrue(result.messages.any { it is ChatMessage.ToolCallMessage && it.tool.permission?.status == PermissionStatus.Pending })
        assertTrue(result.messages.any { it is ChatMessage.ToolCallMessage && it.tool.permission?.status == PermissionStatus.Approved })
    }

    @Test fun `a second result for the same tool does not override the first`() {
        state.reduce(agentMsg("msg-1", 1000, toolUse("tool-1", "Test")))
        assertEquals(ToolState.Completed, state.reduce(agentMsg("msg-2", 2000, toolResult("tool-1", "First result"))).messages.single().tool.state)
        assertEquals(0, state.reduce(agentMsg("msg-3", 3000, toolResult("tool-1", "Should not override", isError = true))).messages.size)
        assertEquals(JsonPrimitive("First result"), state.toolRow("tool-1").tool?.result)
    }

    @Test fun `a permission change after the tool started is ignored`() {
        state.reduce(agentState = agentState(APPROVED_LS))
        state.reduce(agentMsg("msg-1", 3000, toolUse("tool-1", "Bash", """{"command":"ls"}""")), agentState = agentState(APPROVED_LS))
        val result = state.reduce(agentState = agentState("""{"completedRequests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls"},"createdAt":1000,"completedAt":4000,"status":"denied","reason":"Changed mind"}}}"""))
        assertEquals(0, result.messages.size)
        assertEquals(ToolState.Running, state.toolRow("tool-1").tool?.state)
        assertEquals(PermissionStatus.Approved, state.toolRow("tool-1").tool?.permission?.status)
    }

    @Test fun `empty or null agent state changes nothing`() {
        assertEquals(0, state.reduce(agentState = null).messages.size)
        assertEquals(0, state.reduce(agentState = agentState("{}")).messages.size)
        assertEquals(0, state.reduce(agentState = agentState("""{"requests":null,"completedRequests":null}""")).messages.size)
    }

    @Test fun `keeps correct state across many operations`() {
        for (i in 0 until 10) {
            assertEquals(1, state.reduce(userMsg("user-$i", "Message $i", localId = "local-$i", createdAt = i * 1000L)).messages.size)
            assertEquals(1, state.reduce(agentState = agentState("""{"requests":{"perm-$i":{"tool":"Test","arguments":{"index":$i},"createdAt":${i * 1000 + 100}}}}""")).messages.size)
            state.reduce(agentState = agentState("""{"completedRequests":{"perm-$i":{"tool":"Test","arguments":{"index":$i},"createdAt":${i * 1000 + 100},"completedAt":${i * 1000 + 200},"status":"approved"}}}"""))
        }
        assertEquals(20, state.messages.size)
        assertEquals(10, state.toolIdToMessageId.size)
        assertEquals(10, state.localIds.size)
        assertEquals(0, state.reduce(userMsg("user-0", "Duplicate", localId = "local-0")).messages.size)
        assertEquals(20, state.messages.size)
    }

    @Test fun `matches permissions when tool messages load before agent state`() {
        assertEquals(1, state.reduce(agentMsg("msg-1", 1000, toolUse("tool-1", "Bash", """{"command":"ls -la"}"""))).messages.size)
        assertEquals(1, state.reduce(agentState = agentState(PENDING_LS)).messages.size)
        assertEquals(1, state.messages.size)
        assertEquals(ToolPermission("tool-1", PermissionStatus.Pending), state.toolRow("tool-1").tool?.permission)
    }

    @Test fun `matches permissions when tool messages load after agent state`() {
        state.reduce(agentState = agentState(PENDING_LS))
        assertEquals(1, state.reduce(agentMsg("msg-1", 1000, toolUse("tool-1", "Bash", """{"command":"ls -la"}""")), agentState = agentState(PENDING_LS)).messages.size)
        assertEquals(1, state.messages.size)
        assertEquals(PermissionStatus.Pending, state.toolRow("tool-1").tool?.permission?.status)
        assertEquals(1000L, state.toolRow("tool-1").tool?.startedAt)
    }

    @Test fun `does not downgrade an approved permission to pending when agent state has both`() {
        val both = agentState("""{"requests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls -la"},"createdAt":1000}},"completedRequests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls -la"},"createdAt":1000,"completedAt":2000,"status":"approved"}}}""")
        assertEquals(1, state.reduce(agentMsg("msg-1", 1500, toolUse("tool-1", "Bash", """{"command":"ls -la"}""")), agentState = both).messages.size)
        assertEquals(PermissionStatus.Approved, state.toolRow("tool-1").tool?.permission?.status)
    }

    @Test fun `tool loaded first, then agent state with a denied permission`() {
        state.reduce(agentMsg("msg-1", 1500, toolUse("tool-1", "Bash", """{"command":"rm -rf /"}""")))
        val result = state.reduce(agentState = agentState("""{"completedRequests":{"tool-1":{"tool":"Bash","arguments":{"command":"rm -rf /"},"createdAt":1000,"completedAt":2000,"status":"denied","reason":"Dangerous command"}}}"""))
        assertEquals(1, result.messages.size)
        val tool = state.toolRow("tool-1").tool!!
        assertEquals(PermissionStatus.Denied, tool.permission?.status)
        assertEquals(ToolState.Error, tool.state)
        assertEquals(2000L, tool.completedAt)
        assertEquals(json("""{"error":"Dangerous command"}"""), tool.result)
    }

    @Test fun `tool loaded first, then agent state with an approved permission keeps it running`() {
        state.reduce(agentMsg("msg-1", 1500, toolUse("tool-1", "Bash", """{"command":"ls -la"}""")))
        assertNull(state.toolRow("tool-1").tool?.permission)
        assertEquals(1, state.reduce(agentState = agentState(APPROVED_LS_LA)).messages.size)
        assertEquals(PermissionStatus.Approved, state.toolRow("tool-1").tool?.permission?.status)
        assertEquals(ToolState.Running, state.toolRow("tool-1").tool?.state)
    }

    @Test fun `a finished tool keeps its outcome whatever the permission says`() {
        state.reduce(agentMsg("msg-1", 1500, toolUse("tool-1", "Bash", """{"command":"rm"}""")), agentMsg("msg-2", 2000, toolResult("tool-1", "file removed")))
        state.reduce(agentState = agentState("""{"completedRequests":{"tool-1":{"tool":"Bash","arguments":{"command":"rm"},"createdAt":1000,"completedAt":1400,"status":"denied","reason":"Dangerous operation"}}}"""))
        val tool = state.toolRow("tool-1").tool!!
        assertEquals(PermissionStatus.Denied, tool.permission?.status)
        assertEquals("Dangerous operation", tool.permission?.reason)
        assertEquals(ToolState.Completed, tool.state)
        assertEquals(JsonPrimitive("file removed"), tool.result)

        val other = ReducerState()
        other.reduce(agentMsg("msg-1", 1500, toolUse("tool-1", "Bash", """{"command":"cat"}""")), agentMsg("msg-2", 2000, toolResult("tool-1", "File not found", isError = true)))
        other.reduce(agentState = agentState("""{"completedRequests":{"tool-1":{"tool":"Bash","arguments":{"command":"cat"},"createdAt":1000,"completedAt":1400,"status":"approved"}}}"""))
        assertEquals(ToolState.Error, other.toolRow("tool-1").tool?.state)
        assertEquals(PermissionStatus.Approved, other.toolRow("tool-1").tool?.permission?.status)
        assertEquals(JsonPrimitive("File not found"), other.toolRow("tool-1").tool?.result)
    }

    @Test fun `retroactively matches permissions to tools reduced without agent state`() {
        val first = state.reduce(agentMsg("msg-1", 2000, toolUse("tool-1", "Bash", """{"command":"echo hello"}""")))
        assertNull(first.messages.single().tool.permission)
        val second = state.reduce(agentState = agentState("""{"requests":{"tool-1":{"tool":"Bash","arguments":{"command":"echo hello"},"createdAt":1000}}}"""))
        assertEquals(ToolPermission("tool-1", PermissionStatus.Pending), second.messages.single().tool.permission)
        assertEquals(first.messages.single().id, second.messages.single().id)
        assertEquals(1, state.messages.size)
    }

    @Test fun `messages load, then agent state, then a new message`() {
        val first = state.reduce(
            userMsg("user-1", "Please list files", localId = "local-1", createdAt = 1000),
            agentMsg("tool-msg-1", 2000, toolUse("tool-1", "Bash", """{"command":"ls -la"}""", description = "List files")),
            agentMsg("result-1", 3000, toolResult("tool-1", "file1.txt\nfile2.txt")),
        )
        val tool = first.messages.first { it is ChatMessage.ToolCallMessage }.tool
        assertNull(tool.permission)
        assertEquals(ToolState.Completed, tool.state)
        val s = agentState("""{"completedRequests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls -la"},"createdAt":1500,"completedAt":1800,"status":"approved"}}}""")
        val second = state.reduce(agentState = s)
        assertEquals(PermissionStatus.Approved, second.messages.single().tool.permission?.status)
        assertEquals(ToolState.Completed, second.messages.single().tool.state)
        assertTrue(state.reduce(userMsg("user-2", "Thanks!", localId = "local-2", createdAt = 4000), agentState = s).messages.single() is ChatMessage.UserText)
    }

    @Test fun `scoped permission ids join their tool call by toolUseId and answer with the request id`() {
        val s = agentState("""{"requests":{"agent1:toolu_1":{"tool":"Bash","arguments":{"command":"ls"},"createdAt":1000,"toolUseId":"toolu_1"}}}""")
        state.reduce(agentMsg("msg-1", 2000, toolUse("toolu_1", "Bash", """{"command":"ls"}""")), agentState = s)
        assertEquals(1, state.messages.size)
        assertEquals("agent1:toolu_1", state.toolRow("toolu_1").tool?.permission?.id)
    }

    @Test fun `allowTools is read as allowedTools`() {
        state.reduce(agentState = agentState("""{"completedRequests":{"p":{"tool":"Bash","arguments":{},"status":"approved","allowTools":["Bash(ls:*)"],"decision":"approved_for_session"}}}"""))
        val permission = state.toolRow("p").tool?.permission
        assertEquals(listOf("Bash(ls:*)"), permission?.allowedTools)
        assertEquals(PermissionDecision.ApprovedForSession, permission?.decision)
    }

    // session protocol lifecycle and subagent sidechains

    @Test fun `ready events set hasReadyEvent without a visible row`() {
        val result = state.reduce(eventMsg("ready-1", AgentEvent.Ready, 1000))
        assertEquals(0, result.messages.size)
        assertTrue(result.hasReadyEvent)
    }

    @Test fun `hides turn-start lifecycle messages`() {
        assertEquals(0, state.reduce(eventMsg("turn-start-1", AgentEvent.Message("Turn started"), 1000)).messages.size)
    }

    @Test fun `nests subagent-linked sidechain messages under their tool call`() {
        val result = state.reduce(
            agentMsg("parent-msg", 1000, toolUse("tool-parent", "Task", """{"prompt":"Inspect auth flow"}""")),
            agentMsg("child-msg", 1100, text("Subagent output", "child-uuid", "tool-parent"), sidechain = true),
        )
        val parent = result.messages.single() as ChatMessage.ToolCallMessage
        assertEquals("Subagent output", (parent.children.single() as ChatMessage.AgentText).text)
    }

    @Test fun `nests Agent sidechains via sessionSubagent and drops the echoed prompt`() {
        val prompt = "Add translations for switchMachinesHint"
        val result = state.reduce(
            agentMsg("agent-parent-msg", 1000, toolUse("tool-agent-parent", "Agent", """{"description":"$prompt","prompt":"$prompt","sessionSubagent":"session-subagent-1"}""", description = prompt)),
            agentMsg("agent-prompt-echo", 1100, text(prompt, "agent-prompt-uuid", "session-subagent-1"), sidechain = true),
            agentMsg("agent-child-tool", 1200, toolUse("tool-read-child", "Read", """{"file_path":"/tmp/example.ts"}""", parent = "session-subagent-1"), sidechain = true),
        )
        val parent = result.messages.single() as ChatMessage.ToolCallMessage
        assertEquals("Agent", parent.tool.name)
        assertEquals("Read", parent.children.single().tool.name)
    }

    @Test fun `nests CodexSubagent sidechains via sessionSubagent`() {
        val result = state.reduce(
            agentMsg("codex-parent", 1000, toolUse("collab-parent", "CodexSubagent", """{"tool":"spawnAgent","prompt":"Inspect auth flow","sessionSubagent":"session-subagent-codex-1"}""")),
            agentMsg("codex-child", 1100, text("found auth handler", "codex-child-uuid", "session-subagent-codex-1"), sidechain = true),
        )
        val parent = result.messages.single() as ChatMessage.ToolCallMessage
        assertEquals("found auth handler", (parent.children.single() as ChatMessage.AgentText).text)
    }

    @Test fun `sidechain children that arrive before their call wait for it`() {
        assertEquals(0, state.reduce(agentMsg("child", 1100, text("early", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"), sidechain = true)).messages.size)
        assertEquals(0, state.reduce(agentMsg("other", 1200, text("orphan", "33333333-3333-4333-8333-333333333333", "11111111-1111-4111-8111-111111111111"), sidechain = true)).messages.size)
        val result = state.reduce(agentMsg("parent", 1000, toolUse("22222222-2222-4222-8222-222222222222", "Task", """{"prompt":"go"}""")))
        val parent = result.messages.single() as ChatMessage.ToolCallMessage
        assertEquals(listOf("early", "orphan"), parent.children.map { (it as ChatMessage.AgentText).text })
    }

    // TodoWrite latestTodos

    @Test fun `does not update todos from a running TodoWrite input`() {
        val result = state.reduce(agentMsg("todo-call-only", 1000, toolUse("tool-todos", "TodoWrite", """{"todos":[{"content":"Do the thing","status":"pending"}]}""")))
        assertNull(result.todos)
    }

    @Test fun `updates todos from a successful TodoWrite result`() {
        val result = state.reduce(
            agentMsg("todo-call", 1000, toolUse("tool-success", "TodoWrite", """{"todos":[{"content":"Old task state","status":"pending"}]}""")),
            agentMsg("todo-result", 1010, toolResult("tool-success", json("""{"oldTodos":[],"newTodos":[{"content":"New authoritative task state","status":"completed"}]}"""))),
        )
        assertEquals(listOf(TodoItem("New authoritative task state", "completed")), result.todos)
    }

    @Test fun `ignores malformed TodoWrite input that later fails validation`() {
        val result = state.reduce(
            agentMsg("bad-todo-call", 1000, toolUse("tool-bad", "TodoWrite", """{"todos":"[{\"content\":\"Broken\",\"status\":\"pending\"}]"}""")),
            agentMsg("bad-todo-result", 1010, toolResult("tool-bad", "InputValidationError", isError = true)),
        )
        assertNull(result.todos)
    }

    // events

    @Test fun `context reset clears todos and usage and still shows the event`() {
        state.reduce(agentMsg("a", 1000, text("x"), usage = UsageData(10, 5)))
        val result = state.reduce(eventMsg("reset", AgentEvent.Message("Context was reset"), 2000))
        assertEquals(AgentEvent.Message("Context was reset"), (result.messages.single() as ChatMessage.Event).event)
        assertEquals(emptyList<TodoItem>(), result.todos)
        assertEquals(ContextUsage(0, 0, 0, 0, 0), result.usage)
    }

    @Test fun `title changes and plan mode render as events`() {
        val result = state.reduce(
            agentMsg("t", 1000, toolUse("c1", "mcp__happy__change_title", """{"title":"New title"}""")),
            agentMsg("p", 2000, toolUse("c2", "EnterPlanMode")),
            agentMsg("l", 3000, text("Claude AI usage limit reached|1700000000")),
        )
        assertEquals(
            listOf(AgentEvent.Message("Title changed to \"New title\""), AgentEvent.Message("Entering plan mode"), AgentEvent.LimitReached(1700000000)),
            result.messages.map { (it as ChatMessage.Event).event },
        )
    }

    @Test fun `snapshot is newest first and leaves sidechain children nested`() {
        state.reduce(
            userMsg("u", "hi", createdAt = 1000),
            agentMsg("parent", 2000, toolUse("tool-parent", "Task", """{"prompt":"p"}""")),
            agentMsg("child", 2100, text("child", "c", "tool-parent"), sidechain = true),
            agentMsg("a", 3000, text("done")),
        )
        val snapshot = state.snapshot()
        assertEquals(3, snapshot.size)
        assertEquals("done", (snapshot[0] as ChatMessage.AgentText).text)
        assertTrue(snapshot[1] is ChatMessage.ToolCallMessage)
        assertEquals("hi", (snapshot[2] as ChatMessage.UserText).text)
        assertFalse(snapshot.any { it is ChatMessage.AgentText && it.text == "child" })
    }

    private companion object {
        const val PENDING_LS = """{"requests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls -la"},"createdAt":1000}}}"""
        const val PENDING_LS_SHORT = """{"requests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls"},"createdAt":1000}}}"""
        const val APPROVED_LS = """{"completedRequests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls"},"createdAt":1000,"completedAt":2000,"status":"approved"}}}"""
        const val APPROVED_LS_LA = """{"completedRequests":{"tool-1":{"tool":"Bash","arguments":{"command":"ls -la"},"createdAt":1000,"completedAt":2000,"status":"approved"}}}"""
    }
}

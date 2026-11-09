package com.slopus.happy.conversation

import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.diff.DiffLineType
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.diff.PatchParser
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A Happy Agent tool call read for its screen (API.md "Message content",
 * "Presentation"; happy-agent-client messages.ts): the typed presentation
 * with its hunks and sources, the review, raw data bounded and read whole
 * on demand, and its arguments read as fields rather than JSON.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ToolCallsTest {
    private fun block(json: String) = Block.parse(Json.parseToJsonElement(json)) as Block.ToolCall

    private val edit = """{
        "type":"tool_call","id":"c1","name":"apply_patch","status":"completed",
        "elevated":true,
        "review":{"outcome":"allowed","reason":"The person asked for it.","risk":"high","userAuthorization":"high"},
        "presentation":{"type":"file_diff","omittedFiles":2,"files":[
          {"path":"sources/auth/login.ts","kind":"update","added":2,"deleted":1,"language":"typescript","omittedLines":7,"hunks":[
            {"oldStart":12,"newStart":12,"lines":[
              {"kind":"context","text":"function go(user) {"},
              {"kind":"delete","text":"  return legacyLogin(user);"},
              {"kind":"add","text":"  const session = login(user);"},
              {"kind":"add","text":"  return session;"}
            ]}
          ]},
          {"path":"notes.md","kind":"add","added":1,"deleted":0,"hunks":[{"oldStart":0,"newStart":1,"lines":[{"kind":"add","text":"# Notes"}]}]}
        ]}
    }"""

    @Test fun `a file diff keeps its hunks, language and what it left out`() {
        val call = block(edit)
        val diff = call.presentation as Presentation.FileDiff
        assertEquals(2, diff.omittedFiles)
        val login = diff.files[0]
        assertEquals("typescript", login.language)
        assertEquals(7, login.omittedLines)
        assertEquals(12, login.hunks.single().oldStart)
        assertEquals(listOf("context", "delete", "add", "add"), login.hunks.single().lines.map { it.kind })
        assertEquals(ToolReview("allowed", "The person asked for it.", "high", "high", null), call.review)
        assertEquals(true, call.elevated)
    }

    @Test fun `hunks become a patch whose lines are numbered from each hunk's starts`() {
        val diff = block(edit).presentation as Presentation.FileDiff
        val file = PatchParser.parse(ToolPatch.of(diff.files[0])).single()
        assertEquals("sources/auth/login.ts", file.path)
        assertEquals(FileChangeKind.Modified, file.kind)
        val lines = file.hunks.single().lines
        assertEquals(listOf(DiffLineType.Ctx, DiffLineType.Del, DiffLineType.Add, DiffLineType.Add), lines.map { it.type })
        assertEquals(listOf(12, 13, null, null), lines.map { it.oldNo })
        assertEquals(listOf(12, null, 13, 14), lines.map { it.newNo })

        val built = com.slopus.happy.diff.DiffSource.Patch(ToolPatch.of(diff.files[0])).build().files.single()
        assertEquals("a hunk bar and four lines", 5, built.rows.size)
        assertEquals(2, built.additions)

        val added = PatchParser.parse(ToolPatch.of(diff.files[1])).single()
        assertEquals(FileChangeKind.Added, added.kind)
        assertEquals("notes.md", added.path)
        assertEquals(1, added.hunks.single().lines.single().newNo)
    }

    @Test fun `a line with a newline in it stays one line of its hunk`() {
        val file = Presentation.FileDiff.File("a.txt", "update", 1, 0, listOf(Presentation.FileDiff.Hunk(1, 1, listOf(Presentation.FileDiff.Line("add", "one\ntwo")))))
        assertEquals(1, PatchParser.parse(ToolPatch.of(file)).single().hunks.single().lines.size)
    }

    @Test fun `an unproven review says why and claims no risk`() {
        val call = block("""{"type":"tool_call","id":"c","name":"exec_command","status":"failed","elevated":false,"review":{"outcome":"unproven","kind":"timed_out","reason":"No answer."}}""")
        assertEquals(ToolReview("unproven", "No answer.", null, null, "timed_out"), call.review)
        assertEquals(false, call.elevated)
    }

    @Test fun `a search keeps its sources`() {
        val call = block("""{"type":"tool_call","id":"c","name":"codex_web_search","status":"completed","presentation":{"type":"search","target":"web","query":"thumbhash","sources":[{"title":"Spec","url":"https://evanw.github.io/thumbhash/"}]}}""")
        assertEquals(listOf(Presentation.Search.Source("Spec", "https://evanw.github.io/thumbhash/")), (call.presentation as Presentation.Search).sources)
    }

    @Test fun `raw strings past the limit are cut and say so`() {
        val long = "x".repeat(ToolData.LIMIT + 10)
        val call = block("""{"type":"tool_call","id":"c","name":"mystery","status":"completed","arguments":{"a":"short"},"result":{"output":"$long"}}""")
        assertTrue(call.cut)
        val output = (call.result as JsonObject)["output"] as JsonPrimitive
        assertEquals(ToolData.LIMIT + ToolData.MARK.length, output.content.length)
        assertFalse(block("""{"type":"tool_call","id":"c","name":"mystery","status":"completed","arguments":{"a":"short"}}""").cut)
    }

    @Test fun `kept history writes the hunks, sources and review, and a presented call's result is read again`() {
        val call = block(edit).copy(result = buildJsonObject { put("output", "Done") })
        val message = Message("m1", "agent", 1, listOf(call))
        val back = Message.parse(KeptConversation.messageJson(message))!!.content.single() as Block.ToolCall
        assertEquals(call.presentation, back.presentation)
        assertEquals(call.review, back.review)
        assertEquals(true, back.elevated)
        assertNull(back.result)
        val plain = block("""{"type":"tool_call","id":"c","name":"mystery","status":"completed","arguments":{"a":1},"result":{"rows":[1,2]}}""")
        val plainBack = Message.parse(KeptConversation.messageJson(Message("m2", "agent", 1, listOf(plain))))!!.content.single() as Block.ToolCall
        assertEquals(plain.result, plainBack.result)
    }

    @Test fun `kinds follow the presentation, then the vendors' and modules' names`() {
        assertEquals(ToolKind.Terminal, ToolKind.of("Bash", Presentation.Command("ls", null)))
        assertEquals(ToolKind.FileEdit, ToolKind.of("Edit", Presentation.FileDiff(emptyList())))
        assertEquals(ToolKind.Plan, ToolKind.of("update_plan", null))
        assertEquals(ToolKind.Plan, ToolKind.of("todo_write", null))
        assertEquals(ToolKind.Subagent, ToolKind.of("spawn_subagent", null))
        assertEquals(ToolKind.Subagent, ToolKind.of("create_agent", null))
        assertEquals(ToolKind.WebPage, ToolKind.of("WebFetch", null))
        assertEquals(ToolKind.Question, ToolKind.of("request_user_input", null))
        assertEquals(ToolKind.Message, ToolKind.of("send_agent_message", null))
        assertEquals(ToolKind.ToolCall, ToolKind.of("mcp__linear__create_issue", null))
    }

    @Test fun `a plan reads its steps from codex's plan and grok's todos`() {
        val codex = ToolPlan.of("update_plan", Json.parseToJsonElement("""{"explanation":"First pass","plan":[{"step":"Read","status":"completed"},{"step":"Fix","status":"in_progress"},{"step":"Test","status":"pending"}]}"""))!!
        assertEquals("First pass", codex.explanation)
        assertEquals(listOf(ToolPlan.Status.Done, ToolPlan.Status.Active, ToolPlan.Status.Pending), codex.items.map { it.status })
        val grok = ToolPlan.of("todo_write", Json.parseToJsonElement("""{"merge":false,"todos":[{"id":"1","content":"Ship","status":"cancelled"}]}"""))!!
        assertEquals(listOf(ToolPlan.Item("Ship", ToolPlan.Status.Cancelled)), grok.items)
        val hint = ToolHint.of(Block.ToolCall("c", "update_plan", "completed", null, Json.parseToJsonElement("""{"plan":[{"step":"a","status":"completed"},{"step":"b","status":"pending"}]}""")))
        assertEquals(ToolHint.Plan(1, 2), hint)
        assertEquals(ToolHint.Fetch("example.com/docs"), ToolHint.of(Block.ToolCall("c", "web_fetch", "running", null, Json.parseToJsonElement("""{"url":"https://example.com/docs/"}"""))))
    }

    @Test fun `arguments read as fields, known keys first, long text as a block, links and paths marked`() {
        val value = ToolValue.of(
            Json.parseToJsonElement(
                """{"zeta":true,"file_path":"src/a.ts","url":"https://happy.engineering","body":"line one\nline two","nested":{"deep":{"deeper":1}},"tags":["a","b"],"empty":""}""",
            ),
        ) as ToolValue.Fields
        assertEquals(listOf("file_path", "url", "body", "nested", "tags", "zeta"), value.fields.map { it.key })
        assertEquals("File path", value.fields[0].label)
        assertEquals(ToolValue.Text("src/a.ts", mono = true), value.fields[0].value)
        assertEquals(ToolValue.Text("https://happy.engineering", link = true), value.fields[1].value)
        assertEquals(ToolValue.Block("line one\nline two"), value.fields[2].value)
        val nested = value.fields[3].value as ToolValue.Fields
        assertTrue(nested.fields.single().value is ToolValue.Json)
        assertEquals(ToolValue.Items(listOf(ToolValue.Text("a"), ToolValue.Text("b"))), value.fields[4].value)
        assertEquals(ToolValue.Text("true"), value.fields[5].value)
    }

    @Test fun `a result unwraps its output, MCP text and JSON written as a string`() {
        assertEquals(ToolValue.Text("42 passed"), ToolValue.result(Json.parseToJsonElement("""{"output":"42 passed"}""")))
        assertEquals("hello", ToolValue.resultText(Json.parseToJsonElement("""[{"type":"text","text":"hello"}]""")))
        val parsed = ToolValue.result(Json.parseToJsonElement("""{"output":"{\"id\":\"k1\",\"ok\":true}"}""")) as ToolValue.Fields
        assertEquals(listOf("id", "ok"), parsed.fields.map { it.key })
        assertEquals(ToolValue.Text("k1", mono = true), parsed.fields[0].value)
    }

    @Test fun `a compact labeled call is found in its run and detail reads the whole call once`() = runTest {
        val requests = ArrayList<String>()
        val history = """{"runs":[
            {"id":"r1","status":"completed","messages":[{"id":"m1","role":"agent","createdAt":1,"content":[{"type":"tool_call","id":"c1","name":"Bash","status":"completed","arguments":{"description":"List files"},"presentation":{"type":"exec_command","command":"ls","output":"a"}}]}]},
            {"id":"r2","status":"completed","messages":[{"id":"m2","role":"agent","createdAt":2,"content":[{"type":"text","text":"done"}]}]}
        ],"hasMore":false}"""
        val whole = """{"runs":[{"id":"r1","status":"completed","messages":[{"id":"m1","role":"agent","createdAt":1,"content":[{"type":"tool_call","id":"c1","name":"Bash","status":"completed","arguments":{"cmd":"ls"},"result":{"output":"a"},"presentation":{"type":"exec_command","command":"ls","output":"a"}}]}]}],"hasMore":true}"""
        val request: AgentRequest = { method, path, _, _ ->
            requests += "$method $path"
            val body = when {
                path.contains("/bootstrap") -> """{"agent":{"id":"a1","workspaceId":"w1","status":"idle"},"pending":[]}"""
                path.contains("omitToolData=false") -> whole
                path.contains("/messages") -> history
                else -> "{}"
            }
            TransportResponse(200, body = body.toByteArray())
        }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = CoroutineScope(dispatcher + SupervisorJob())
        val conversation = Conversation(
            api = ConversationApi(request),
            signals = MutableSharedFlow<ConversationSignal>(),
            scope = scope,
            agentId = "a1",
            lane = dispatcher,
            io = dispatcher,
            disk = dispatcher,
        ).also { it.start() }
        advanceUntilIdle()
        val located = conversation.toolCall("c1")
        assertNotNull(located)
        assertEquals("r1", located!!.runId)
        assertEquals("r2", located.nextRunId)
        assertEquals(Json.parseToJsonElement("""{"description":"List files"}"""), located.call.arguments)

        val model = com.slopus.happy.ui.conversation.ToolCallModel(ToolCallReader(ConversationApi(request), "a1"), "c1", conversation)
        scope.launch { model.observe() }
        advanceUntilIdle()
        val full = model.state.value.call
        assertEquals(Json.parseToJsonElement("""{"cmd":"ls"}"""), full!!.arguments)
        assertEquals(1, requests.count { it.contains("omitToolData=false") })
        val asked = requests.last()
        assertTrue(asked, asked.contains("before=r2") && asked.contains("limit=1") && asked.contains("omitToolData=false"))
        assertNull(conversation.toolCall("missing"))
        scope.cancel()
    }

    @Test fun `without its run a call is looked for back from the newest page`() = runTest {
        val pages = ArrayList<String>()
        val request: AgentRequest = { _, path, _, _ ->
            pages += path
            val body = if ("before=" !in path) {
                """{"runs":[{"id":"r9","status":"completed","messages":[]}],"hasMore":true}"""
            } else {
                """{"runs":[{"id":"r3","status":"completed","messages":[{"id":"m","role":"agent","createdAt":1,"content":[{"type":"tool_call","id":"c7","name":"mystery","status":"completed","arguments":{"a":1}}]}]}],"hasMore":false}"""
            }
            TransportResponse(200, body = body.toByteArray())
        }
        val call = ToolCallReader(ConversationApi(request), "a1").read("c7")
        assertEquals("mystery", call!!.name)
        assertEquals(2, pages.size)
        assertTrue(pages[1].contains("before=r9"))
    }

    @Test fun `the screen wants the whole call only once it finished without its raw data`() {
        val presented = block("""{"type":"tool_call","id":"c","name":"Bash","status":"completed","presentation":{"type":"exec_command","command":"ls"}}""")
        assertTrue(com.slopus.happy.ui.conversation.ToolCallModel.wants(presented))
        assertFalse(com.slopus.happy.ui.conversation.ToolCallModel.wants(presented.copy(status = "running")))
        val labeled = presented.copy(arguments = Json.parseToJsonElement("""{"description":"List files"}""").jsonObject)
        assertTrue(com.slopus.happy.ui.conversation.ToolCallModel.wants(labeled))
        assertFalse(com.slopus.happy.ui.conversation.ToolCallModel.wants(labeled.copy(status = "running")))
        assertFalse(com.slopus.happy.ui.conversation.ToolCallModel.wants(labeled.copy(result = JsonObject(emptyMap()))))
        assertFalse(com.slopus.happy.ui.conversation.ToolCallModel.wants(presented.copy(presentation = null, arguments = Json.parseToJsonElement("""{"cmd":"ls"}""").jsonObject)))
        assertTrue(com.slopus.happy.ui.conversation.ToolCallModel.wants(presented.copy(arguments = JsonObject(emptyMap()), cut = true)))
    }
}

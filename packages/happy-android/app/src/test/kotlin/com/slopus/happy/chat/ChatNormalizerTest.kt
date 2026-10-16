package com.slopus.happy.chat

import com.slopus.happy.chat.NormalizedMessage.AgentContent
import com.slopus.happy.chat.NormalizedMessage.Body
import com.slopus.happy.data.MessageRecord
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The session-protocol part of happy-app's sync/typesRaw.spec.ts, plus the retired kinds. */
class ChatNormalizerTest {
    private fun normalize(raw: String, id: String = "db-1", localId: String? = null, createdAt: Long = 1) =
        ChatNormalizer.normalize(id, localId, createdAt, json(raw))

    /** An agent-wrapped session envelope, as typesRaw.spec.ts builds them. */
    private fun envelope(data: String) = normalize("""{"role":"agent","content":{"type":"session","data":$data}}""")

    private val NormalizedMessage.content get() = (body as Body.Agent).content

    @Test fun `text events become agent text`() {
        val n = envelope("""{"id":"env-1","time":1,"role":"agent","turn":"turn-1","ev":{"t":"text","text":"hello session"}}""")!!
        assertEquals("env-1", n.id)
        assertEquals(1L, n.createdAt)
        assertEquals(AgentContent.Text("hello session", "env-1", null), n.content.single())
        assertEquals("turn-1", n.turn)
    }

    @Test fun `keeps usage for context tracking`() {
        val n = envelope("""{"id":"e","time":1,"role":"agent","turn":"t","usage":{"input_tokens":1200,"cache_creation_input_tokens":40,"cache_read_input_tokens":500,"output_tokens":80},"ev":{"t":"text","text":"x"}}""")!!
        assertEquals(UsageData(1200, 80, 40, 500), n.usage)
    }

    @Test fun `usage-only service envelopes need no turn and carry no content`() {
        val n = envelope("""{"id":"e","time":1,"role":"agent","usage":{"input_tokens":1200,"output_tokens":80},"ev":{"t":"service","text":""}}""")!!
        assertEquals(emptyList<AgentContent>(), n.content)
        assertEquals(UsageData(1200, 80), n.usage)
    }

    @Test fun `direct session-role envelopes`() {
        val n = normalize("""{"role":"session","content":{"id":"env-1-direct","time":1,"role":"agent","turn":"turn-1","ev":{"t":"text","text":"hello direct"}}}""")!!
        assertEquals("env-1-direct", n.id)
        assertEquals(AgentContent.Text("hello direct", "env-1-direct", null), n.content.single())
        val wrapped = normalize("""{"role":"session","content":{"type":"session","data":{"id":"w","time":1,"role":"agent","turn":"t","ev":{"t":"text","text":"wrapped"}}}}""")!!
        assertEquals(AgentContent.Text("wrapped", "w", null), wrapped.content.single())
    }

    @Test fun `thinking text events`() {
        val n = envelope("""{"id":"env-2","time":1,"role":"agent","turn":"turn-1","ev":{"t":"text","text":"thinking...","thinking":true}}""")!!
        assertEquals(AgentContent.Thinking("thinking...", "env-2", null), n.content.single())
    }

    @Test fun `user text envelopes and legacy user text`() {
        val n = normalize("""{"role":"session","content":{"id":"env-user","time":1,"role":"user","ev":{"t":"text","text":"modern user envelope"}}}""")!!
        assertEquals(Body.User("modern user envelope"), n.body)
        val legacy = normalize("""{"role":"user","content":{"type":"text","text":"legacy user message"},"meta":{"displayText":"shown","sentFrom":"android"}}""")!!
        assertEquals(Body.User("legacy user message"), legacy.body)
        assertEquals("shown", legacy.meta?.displayText)
        assertEquals("android", legacy.meta?.sentFrom)
    }

    @Test fun `drops control-only task notifications and keeps the text after one`() {
        val notification = "<task-notification>\n<task-id>agent-123</task-id>\n<status>completed</status>\n</task-notification>"
        val quoted = JsonPrimitive(notification).toString()
        assertNull(normalize("""{"role":"session","content":{"id":"u","time":1,"role":"user","codexItemId":"c","ev":{"t":"text","text":$quoted}}}"""))
        assertNull(normalize("""{"role":"session","content":{"id":"a","time":1,"role":"agent","turn":"t","ev":{"t":"text","text":$quoted}}}"""))
        val followup = normalize("""{"role":"session","content":{"id":"f","time":1,"role":"user","ev":{"t":"text","text":"<task-notification>internal</task-notification>\nContinue with the fix"}}}""")!!
        assertEquals(Body.User("Continue with the fix"), followup.body)
    }

    @Test fun `service events are visible agent text`() {
        val n = envelope("""{"id":"s","time":1,"role":"agent","turn":"t","ev":{"t":"service","text":"**Service:** Connection restored"}}""")!!
        assertEquals(AgentContent.Text("**Service:** Connection restored", "s", null), n.content.single())
    }

    @Test fun `tool-call lifecycle events`() {
        val start = envelope("""{"id":"env-3","time":1,"role":"agent","turn":"turn-1","ev":{"t":"tool-call-start","call":"call-1","name":"CodexBash","title":"Run `ls`","description":"Run command","args":{"command":"ls"}}}""")!!
        assertEquals(
            AgentContent.ToolUse("call-1", "CodexBash", "Run `ls`", json("""{"command":"ls"}"""), "Run command", "env-3", null),
            start.content.single(),
        )
        val end = envelope("""{"id":"env-4","time":1,"role":"agent","turn":"turn-1","ev":{"t":"tool-call-end","call":"call-1"}}""")!!
        assertEquals(AgentContent.ToolResult("call-1", null, false, "env-4", null), end.content.single())
        val failed = envelope("""{"id":"env-5","time":1,"role":"agent","turn":"turn-1","ev":{"t":"tool-call-end","call":"call-1","result":"boom","isError":true}}""")!!
        assertEquals(AgentContent.ToolResult("call-1", JsonPrimitive("boom"), true, "env-5", null), failed.content.single())
    }

    @Test fun `turn-end is a ready event and turn-start is dropped`() {
        assertNull(envelope("""{"id":"e5","time":1,"role":"agent","turn":"turn-5","ev":{"t":"turn-start"}}"""))
        val end = envelope("""{"id":"env-6","time":1,"role":"agent","turn":"turn-5","ev":{"t":"turn-end","status":"completed"}}""")!!
        assertEquals("env-6", end.id)
        assertEquals(Body.Event(AgentEvent.Ready), end.body)
        assertEquals("turn-5", end.turn)
    }

    @Test fun `file events become a completed file tool`() {
        val file = envelope("""{"id":"env-file-1","time":1,"role":"agent","turn":"t","ev":{"t":"file","ref":"upload-file-1","name":"report.pdf","size":1234}}""")!!
        val call = file.content[0] as AgentContent.ToolUse
        assertEquals("file", call.name)
        assertEquals(json("""{"ref":"upload-file-1","name":"report.pdf","size":1234}"""), call.input)
        assertEquals("Attached file: report.pdf", call.description)
        assertEquals(AgentContent.ToolResult(call.id, null, false, "env-file-1:result", "env-file-1"), file.content[1])

        val image = envelope("""{"id":"env-file-2","time":1,"role":"agent","turn":"t","ev":{"t":"file","ref":"u2","name":"photo.png","size":4567,"image":{"width":800,"height":600,"thumbhash":"abc"}}}""")!!
        val imageCall = image.content[0] as AgentContent.ToolUse
        assertEquals(json("""{"ref":"u2","name":"photo.png","size":4567,"image":{"width":800,"height":600,"thumbhash":"abc"}}"""), imageCall.input)
        assertEquals("Attached image: photo.png (800x600)", imageCall.description)

        assertNull(envelope("""{"id":"e","time":1,"role":"agent","turn":"t","ev":{"t":"file","ref":"u3","name":"broken.bin"}}"""))
    }

    @Test fun `subagent-linked messages are sidechain messages`() {
        val n = envelope("""{"id":"env-7","time":1,"role":"agent","turn":"turn-2","subagent":"tz4a98xxat96iws9zmbrgj3a","ev":{"t":"text","text":"subagent output"}}""")!!
        assertTrue(n.isSidechain)
        assertEquals("tz4a98xxat96iws9zmbrgj3a", n.content.single().parentUUID)
    }

    @Test fun `drops start and stop lifecycle markers`() {
        assertNull(envelope("""{"id":"s","time":1,"role":"agent","turn":"t","subagent":"tz4a98xxat96iws9zmbrgj3a","ev":{"t":"start","title":"Research agent"}}"""))
        assertNull(envelope("""{"id":"s","time":1,"role":"agent","turn":"t","subagent":"tz4a98xxat96iws9zmbrgj3a","ev":{"t":"stop"}}"""))
    }

    @Test fun `malformed current records are dropped, as happy-app drops them`() {
        // A subagent id that is not a cuid2.
        assertNull(envelope("""{"id":"e","time":1,"role":"agent","turn":"t","subagent":"toolu_provider_id","ev":{"t":"text","text":"x"}}"""))
        // A tool-call-start missing its required fields.
        assertNull(envelope("""{"id":"env-8","time":1,"role":"agent","ev":{"t":"tool-call-start","call":"call-1","name":"Bash"}}"""))
        // Agent text without a turn.
        assertNull(envelope("""{"id":"env-9","time":1,"role":"agent","ev":{"t":"text","text":"missing turn"}}"""))
        // turn-end without a status.
        assertNull(envelope("""{"id":"env-10","time":1,"role":"agent","turn":"turn-5","ev":{"t":"turn-end"}}"""))
        // A service event from the user role.
        assertNull(envelope("""{"id":"env-11","time":1,"role":"user","ev":{"t":"service","text":"not allowed"}}"""))
    }

    @Test fun `acceptance receipts belong to no turn`() {
        val n = envelope("""{"id":"env-accepted-1","time":4200,"role":"agent","ev":{"t":"user-message-accepted","id":"agent-message-1","ref":"server-message-1","runId":"run-1"}}""")!!
        assertEquals(4200L, n.createdAt)
        assertEquals(Body.Event(AgentEvent.UserMessageAccepted("server-message-1")), n.body)
    }

    @Test fun `carries the turn id on agent rows`() {
        val text = envelope("""{"id":"a","time":10,"role":"agent","turn":"turn-a","ev":{"t":"text","text":"hello"}}""")
        val tool = envelope("""{"id":"b","time":11,"role":"agent","turn":"turn-a","ev":{"t":"tool-call-start","call":"call-1","name":"Read","title":"Read","description":"Read a file","args":{}}}""")
        val ready = envelope("""{"id":"c","time":12,"role":"agent","turn":"turn-a","ev":{"t":"turn-end","status":"completed"}}""")
        assertEquals(listOf("turn-a", "turn-a", "turn-a"), listOf(text?.turn, tool?.turn, ready?.turn))
    }

    @Test fun `carries the author of a user message`() {
        val other = envelope("""{"id":"x","time":10,"role":"user","author":{"id":"user-2","name":"Alex","owner":false},"ev":{"t":"text","text":"from the desktop"}}""")!!
        assertEquals(SessionAuthor("user-2", "Alex", false), other.author)
        assertNull(envelope("""{"id":"y","time":10,"role":"user","ev":{"t":"text","text":"from an older daemon"}}""")!!.author)
    }

    @Test fun `agent events`() {
        val n = normalize("""{"role":"agent","content":{"type":"event","id":"e1","data":{"type":"switch","mode":"local"}}}""")!!
        assertEquals(Body.Event(AgentEvent.Switch("local")), n.body)
        val limit = normalize("""{"role":"agent","content":{"type":"event","id":"e2","data":{"type":"limit-reached","endsAt":1700000000}}}""")!!
        assertEquals(Body.Event(AgentEvent.LimitReached(1700000000)), limit.body)
    }

    @Test fun `gemini acp records`() {
        fun acp(data: String) = normalize("""{"role":"agent","content":{"type":"acp","provider":"gemini","data":$data}}""", id = "rec")
        assertEquals(AgentContent.Text("hi", "rec", null), acp("""{"type":"message","message":"hi"}""")!!.content.single())
        assertEquals(AgentContent.Text("why", "rec", null), acp("""{"type":"reasoning","message":"why"}""")!!.content.single())
        assertEquals(AgentContent.Thinking("hmm", "rec", null), acp("""{"type":"thinking","text":"hmm"}""")!!.content.single())
        assertEquals(
            AgentContent.ToolUse("c1", "read", null, json("""{"path":"a"}"""), null, "u1", null),
            acp("""{"type":"tool-call","callId":"c1","name":"read","input":{"path":"a"},"id":"u1"}""")!!.content.single(),
        )
        assertEquals(
            AgentContent.ToolResult("c1", JsonPrimitive("ok"), true, "u2", null),
            acp("""{"type":"tool-result","callId":"c1","output":"ok","id":"u2","isError":true}""")!!.content.single(),
        )
        val edit = acp("""{"type":"file-edit","description":"Edit a","filePath":"a.ts","diff":"@@","id":"fe"}""")!!.content.single() as AgentContent.ToolUse
        assertEquals("file-edit", edit.name)
        assertEquals(json("""{"filePath":"a.ts","description":"Edit a","diff":"@@"}"""), edit.input)
        assertEquals(
            AgentContent.ToolResult("c1", JsonPrimitive("out"), false, "rec", null),
            acp("""{"type":"terminal-output","data":"out","callId":"c1"}""")!!.content.single(),
        )
        val permission = acp("""{"type":"permission-request","permissionId":"p1","toolName":"shell","description":"Run ls"}""")!!.content.single() as AgentContent.ToolUse
        assertEquals("p1", permission.id)
        assertEquals(json("{}"), permission.input)
        assertNull(acp("""{"type":"task_started","id":"t"}"""))
        assertNull(acp("""{"type":"token_count","total":5}"""))
    }

    @Test fun `retired, unknown and undecryptable records become placeholders`() {
        fun kind(raw: String) = (normalize(raw)!!.body as Body.Unsupported).kind
        assertEquals("agent.output.assistant", kind("""{"role":"agent","content":{"type":"output","data":{"type":"assistant","message":{"role":"assistant","model":"m","content":[]}}}}"""))
        assertEquals("agent.codex.message", kind("""{"role":"agent","content":{"type":"codex","data":{"type":"message","message":"hi"}}}"""))
        assertEquals("agent.acp.codex", kind("""{"role":"agent","content":{"type":"acp","provider":"codex","data":{"type":"message","message":"hi"}}}"""))
        assertEquals("robot", kind("""{"role":"robot","content":{}}"""))
        val record = MessageRecord("s", 1, "m1", null, null, 5, 5)
        assertEquals(Body.Unsupported("undecryptable"), ChatNormalizer.normalize(record)!!.body)
        assertEquals(Body.Unsupported("undecryptable"), ChatNormalizer.normalize(record.copy(contentJson = "not json"))!!.body)
    }

    @Test fun `strips only complete leading task notifications`() {
        assertEquals("", stripLeadingTaskNotificationWrappers("<task-notification>x</task-notification>"))
        assertEquals("after", stripLeadingTaskNotificationWrappers("  <task-notification>a<task-notification>b</task-notification></task-notification>\nafter"))
        assertEquals("<task-notification>open", stripLeadingTaskNotificationWrappers("<task-notification>open"))
        assertEquals("text <task-notification>x</task-notification>", stripLeadingTaskNotificationWrappers("text <task-notification>x</task-notification>"))
    }

    @Test fun `plan mode follows the last transition in a batch`() {
        fun call(name: String) = agentMsg("m-$name", 0, toolUse("c-$name", name))
        assertEquals(true, messagePlanMode(listOf(call("EnterPlanMode"))))
        assertEquals(false, messagePlanMode(listOf(call("EnterPlanMode"), call("ExitPlanMode"))))
        assertEquals(true, messagePlanMode(listOf(call("exit_plan_mode"), call("enter_plan_mode"))))
        assertNull(messagePlanMode(listOf(call("Read"), userMsg("u", "hi"))))
    }
}

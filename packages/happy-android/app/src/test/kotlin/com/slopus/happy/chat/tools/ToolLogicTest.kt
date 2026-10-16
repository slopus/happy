package com.slopus.happy.chat.tools

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.PermissionDecision
import com.slopus.happy.chat.PermissionStatus
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolPermission
import com.slopus.happy.chat.ToolState
import com.slopus.happy.text.plural
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Ports of toolDisplay, knownTools, codexPatchEntry and PermissionFooter behaviour. */
@RunWith(AndroidJUnit4::class)
class ToolLogicTest {
    private val resources = ApplicationProvider.getApplicationContext<android.content.Context>().resources
    private val text = object : ToolText {
        override fun string(id: Int, vararg args: Any) = resources.getString(id, *args)
        override fun plural(id: Int, count: Int, vararg args: Any) = resources.plural(id, count, *args)
    }

    private fun json(s: String): JsonElement = Json.parseToJsonElement(s)

    private fun tool(
        name: String,
        input: String? = null,
        state: ToolState = ToolState.Completed,
        result: String? = null,
        permission: ToolPermission? = null,
        description: String? = null,
        title: String? = null,
    ) = ToolCall(
        name = name, title = title, state = state, input = input?.let(::json), createdAt = 0, description = description,
        result = result?.let(::json), permission = permission,
    )

    private fun message(tool: ToolCall, children: List<ChatMessage> = emptyList()) = ChatMessage.ToolCallMessage("m", 0, tool, children)

    @Test
    fun activityLabels() {
        assertEquals("npm test", toolActivityLabel(tool("Bash", """{"command":"npm test"}"""), text))
        assertEquals("git status", toolActivityLabel(tool("exec_command", """{"cmd":["bash","-lc","git status"]}"""), text))
        assertEquals("Read: /a/b.kt", toolActivityLabel(tool("Read", """{"file_path":"/a/b.kt"}"""), text))
        assertEquals("Edited: x.ts +1", toolActivityLabel(tool("apply_patch", """{"changes":{"x.ts":{"type":"update"},"y.ts":{"type":"add"}}}"""), text))
        assertEquals("Reading shell output (7)", toolActivityLabel(tool("BashOutput", """{"bash_id":"7"}"""), text))
        assertEquals("Start collaborator: Fix it", toolActivityLabel(tool("create_agent", """{"title":"Fix it"}"""), text))
        assertEquals("MCP: Linear Create Issue", toolActivityLabel(tool("mcp__linear__create_issue"), text))
        // A description that adds something wins over the category verb.
        assertEquals("Look for todos", toolActivityLabel(tool("Grep", """{"pattern":"TODO"}""", description = "Look for todos"), text))
    }

    @Test
    fun knownToolTitlesAreRelativeToTheSession() {
        val p = presentTool(message(tool("Edit", """{"file_path":"/repo/src/a.kt","old_string":"a","new_string":"b"}""")), text, false, null, "/repo")!!
        assertEquals("src/a.kt", p.title)
        assertEquals(ToolIcon.Edit, p.icon)
        assertFalse(p.compact)
        assertEquals(ToolViewKind.Edit, p.view)
        val multi = presentTool(
            message(tool("MultiEdit", """{"file_path":"/repo/a.kt","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"d"}]}""")),
            text, false, null, "/repo",
        )!!
        assertEquals("a.kt (2 edits)", multi.title)
    }

    @Test
    fun compactRowsAndHiddenTools() {
        assertNull(presentTool(message(tool("ToolSearch")), text, false, null, null))
        // Terminal tools are always rows; compact mode shrinks everything but questions.
        assertTrue(presentTool(message(tool("Bash", """{"command":"ls"}""")), text, false, null, null)!!.compact)
        assertTrue(presentTool(message(tool("Edit", """{"file_path":"a","old_string":"","new_string":""}""")), text, true, null, null)!!.compact)
        assertFalse(presentTool(message(tool("AskUserQuestion", """{"questions":[]}""")), text, true, null, null)!!.compact)
        // Unknown tools have no view: compact unless their approval needs the arguments.
        assertTrue(presentTool(message(tool("frobnicate")), text, false, null, null)!!.compact)
        val pending = presentTool(message(tool("frobnicate", permission = ToolPermission("p", PermissionStatus.Pending))), text, false, null, null)!!
        assertFalse(pending.compact)
        assertTrue(pending.needsApprovalInput)
        // MCP tools are minimal with the puzzle glyph.
        val mcp = presentTool(message(tool("mcp__x__y")), text, false, null, null)!!
        assertEquals(ToolIcon.Mcp, mcp.icon)
        assertTrue(mcp.compact)
    }

    @Test
    fun statusIcons() {
        assertEquals(ToolStatusIcon.Running, presentTool(message(tool("Edit", "{}", ToolState.Running)), text, false, null, null)!!.statusIcon)
        assertEquals(ToolStatusIcon.None, presentTool(message(tool("TodoWrite", """{"todos":[{"content":"a","status":"pending"}]}""", ToolState.Running)), text, false, null, null)!!.statusIcon)
        assertEquals(ToolStatusIcon.Error, presentTool(message(tool("Edit", "{}", ToolState.Error, "\"boom\"")), text, false, null, null)!!.statusIcon)
        val refused = presentTool(message(tool("Edit", "{}", ToolState.Error, "\"<tool_use_error>File missing</tool_use_error>\"")), text, false, null, null)!!
        assertEquals(ToolStatusIcon.Removed, refused.statusIcon)
        assertTrue(refused.compact)
        val denied = presentTool(message(tool("Edit", "{}", permission = ToolPermission("p", PermissionStatus.Denied))), text, false, null, null)!!
        assertEquals(ToolStatusIcon.Removed, denied.statusIcon)
    }

    @Test
    fun taskIsMinimalUntilAChildStarts() {
        val task = tool("Task", """{"description":"Explore"}""", ToolState.Running)
        assertTrue(presentTool(message(task), text, false, null, null)!!.compact)
        val child = message(tool("Read", """{"file_path":"/x"}"""))
        val p = presentTool(message(task, listOf(child)), text, false, null, null)!!
        assertFalse(p.compact)
        assertEquals("Explore", p.title)
        assertEquals(listOf("Read: /x" to ToolState.Completed), taskChildTools(message(task, listOf(child)), text))
    }

    @Test
    fun patchChangesFromEveryShape() {
        val envelope = "*** Begin Patch\n*** Update File: src/a.ts\n@@ fun\n-old\n+new\n*** Add File: b.ts\n+hello\n*** End Patch"
        val changes = patchChanges(Json.parseToJsonElement(Json.encodeToString(mapOf("patch" to envelope, "workdir" to "/repo"))))!!
        assertEquals(listOf("/repo/src/a.ts", "/repo/b.ts"), changes.keys.toList())
        assertEquals(PatchInput.Pair("fun\nold", "fun\nnew"), patchInput(changes.getValue("/repo/src/a.ts")))
        assertEquals(PatchInput.Pair("", "hello"), patchInput(changes.getValue("/repo/b.ts")))
        val list = patchChanges(json("""{"changes":[{"path":"c.ts","kind":{"type":"add"},"content":"x"}]}"""))!!
        assertEquals(PatchInput.Pair("", "x"), patchInput(list.getValue("c.ts")))
        val unified = patchChanges(json("""{"changes":{"d.ts":{"type":"update","unified_diff":"@@ -1 +1 @@\n-a\n+b"}}}"""))!!
        assertTrue(patchInput(unified.getValue("d.ts")) is PatchInput.Patch)
        // Two edits to one file cannot be a map: the raw envelope is kept instead.
        assertNull(parseApplyPatchEnvelope("*** Begin Patch\n*** Update File: a\n+x\n*** Update File: a\n+y\n*** End Patch"))
    }

    @Test
    fun claudePermissionButtons() {
        val pending = ToolPermission("r", PermissionStatus.Pending)
        val edit = permissionOptions(pending, "Edit", null, "claude")
        assertEquals(listOf(PermissionChoice.Allow, PermissionChoice.AllowAllEdits, PermissionChoice.Deny), edit.map { it.choice })
        assertEquals("acceptEdits", edit[1].answer.mode)
        assertEquals("acceptEdits", edit[1].mode)
        val plan = permissionOptions(pending, "ExitPlanMode", null, "claude")
        assertEquals(
            listOf(PermissionChoice.Allow, PermissionChoice.AllowAllEdits, PermissionChoice.AllowEverything, PermissionChoice.Deny),
            plan.map { it.choice },
        )
        assertEquals("default", plan[0].mode)
        val bash = permissionOptions(pending, "Bash", json("""{"command":"rm -rf build"}"""), "claude")
        assertEquals(listOf("Bash(rm -rf build)"), bash.first { it.choice == PermissionChoice.AllowForTool }.answer.allowedTools)

        val approvedForTool = ToolPermission("r", PermissionStatus.Approved, allowedTools = listOf("Bash(rm -rf build)"))
        val choice = answeredChoice(approvedForTool, "Bash", json("""{"command":"rm -rf build"}"""), "claude")
        assertEquals(PermissionChoice.AllowForTool, choice)
        val states = bash.map { permissionOptionState(it, approvedForTool, choice) }
        assertEquals(
            listOf(PermissionOptionState.Inactive, PermissionOptionState.Selected, PermissionOptionState.Inactive),
            states,
        )
    }

    @Test
    fun codexPermissionButtons() {
        val options = permissionOptions(ToolPermission("r", PermissionStatus.Pending), "CodexBash", null, "claude")
        assertEquals(listOf(PermissionChoice.CodexAllow, PermissionChoice.CodexAllowForSession, PermissionChoice.CodexAbort), options.map { it.choice })
        assertEquals(PermissionDecision.Abort, options[2].answer.decision)
        assertFalse(options[2].answer.approved)
        val aborted = ToolPermission("r", PermissionStatus.Denied, decision = PermissionDecision.Abort)
        assertEquals(PermissionChoice.CodexAbort, answeredChoice(aborted, "CodexBash", null, "codex"))
        val approved = ToolPermission("r", PermissionStatus.Approved)
        assertEquals(PermissionChoice.CodexAllow, answeredChoice(approved, "x", null, "codex"))
    }

    @Test
    fun todosPreferTheResult() {
        val t = tool("TodoWrite", """{"todos":[{"content":"a","status":"pending"}]}""", result = """{"newTodos":[{"content":"b","status":"completed"}]}""")
        assertEquals(listOf(TodoItem("b", "completed", null)), todoItems(message(t)))
    }
}

package com.slopus.happy.conversation

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.*
import org.junit.Test

class ToolSummaryTest {
    private fun summary(name: String, arguments: String) = ToolSummary.of(name, Json.parseToJsonElement(arguments))

    @Test fun descriptionWinsOverNamedFallbacksAndPayloads() {
        assertEquals("Calculate the answer", summary("python", """{"code":"print(42)","description":"  Calculate\n the\tanswer  "}"""))
        assertEquals("Research permissions", summary("create_task", """{"description":"Research permissions","name":"Old label","text":"Long task body"}"""))
        assertEquals("Update status", summary("update_todo", """{"description":"Update status","id":"opaque","text":"Long body"}"""))
        assertEquals("Report results", summary("send_agent_message", """{"description":"Report results","explanation":"Older label","text":"Message body"}"""))
    }

    @Test fun namedLabelFallbacksAreToolSpecificAndIgnoreBlankOrNonStringFields() {
        val cases = listOf(
            Triple("create_agent", """{"description":" ","title":"Account research"}""", "Account research"),
            Triple("send_bot_message", """{"description":17,"explanation":"Report tests"}""", "Report tests"),
            Triple("set_title", """{"title":"Wrong field","name":"Account research"}""", "Account research"),
            Triple("create_bot", """{"name":" ","username":"helper"}""", "helper"),
            Triple("read_vault_file", """{"path":"docs/guide.md"}""", "docs/guide.md"),
            Triple("glob_vault", """{"pattern":"**/*.md"}""", "**/*.md"),
            Triple("web_search", """{"query":"Android testing"}""", "Android testing"),
            Triple("web_fetch", """{"url":"https://example.com/docs"}""", "https://example.com/docs"),
        )
        for ((tool, args, label) in cases) assertEquals(tool, label, summary(tool, args))
        assertNull(summary("unknown_tool", """{"name":"opaque","title":"unrelated","text":"body"}"""))
        assertNull(summary("python", """{"description":false}"""))
        assertNull(summary("python", """{"description":"\t\n"}"""))
        assertNull(summary("python", "[]"))
        assertNull(ToolSummary.of("python", null))
        // Existing specialized plan/skill labels remain the fallback, not arbitrary arguments.
        assertNull(summary("update_plan", """{"explanation":"Plan body","plan":[]}"""))
        assertNull(summary("read_skill", """{"name":"dev"}"""))
    }

    @Test fun unicodeWhitespaceAndTruncationNeverSplitSurrogatePairs() {
        val emoji = "😀"
        val result = ToolSummary.of("python", buildJsonObject { put("description", JsonPrimitive(emoji.repeat(121))) })!!
        assertEquals(emoji.repeat(120), result)
        assertEquals(120, result.codePointCount(0, result.length))
        assertEquals("Inspect account state", ToolSummary.normalize("\u00a0Inspect\u2028account\u0085state\uFEFF"))
    }

    @Test fun mcpSemanticDescriptionsAreNeverBuiltinLabels() {
        for (name in listOf("mcp__github__create_issue", "mcp__observatory__native_name_with__delimiters_0123456789abcdef")) {
            assertNull(summary(name, """{"description":"Semantic body","title":"Issue title","name":"Remote input"}"""))
        }
    }

    @Test fun projectionRetainsSummaryAlongsidePresentationAndCallIdentity() {
        val presentation = Presentation.FileDiff(listOf(Presentation.FileDiff.File("a.kt", "update", 3, 1), Presentation.FileDiff.File("b.kt", "add", 2, 0)))
        val call = Block.ToolCall("call", "apply_patch", "failed", presentation, Json.parseToJsonElement("""{"description":"Update account settings"}"""))
        val row = ConversationRowBuilder.build(Message("m", "agent", 1, listOf(call)), "agent", null, false).single() as ConversationRow.Tool
        assertEquals("Update account settings", row.tool.summary)
        assertEquals("call", row.tool.id)
        assertEquals(presentation, row.tool.presentation)
        assertTrue(row.tool.failed)
    }
}
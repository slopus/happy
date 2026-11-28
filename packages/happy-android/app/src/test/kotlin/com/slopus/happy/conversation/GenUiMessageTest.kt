package com.slopus.happy.conversation

import com.slopus.happy.genui.Action
import com.slopus.happy.genui.GenUiMessage
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class GenUiMessageTest {
    @Test fun canonicalDocumentSurvivesHistoryAndFoldedTurnsWithoutArtifactLookup() {
        val document = Json.parseToJsonElement(File("src/debug/assets/genui/fixtures/01-stats.json").readText())
        val wire = buildJsonObject { put("type", "gen_ui"); put("document", document) }
        val presentation = Presentation.parse(wire) as Presentation.GenUi
        val message = Message("m", "agent", 0, listOf(Block.ToolCall("call", "gen_ui", "completed", presentation)))
        val restored = Message.parse(KeptConversation.messageJson(message))!!
        assertEquals(presentation, (restored.content.single() as Block.ToolCall).presentation)
        var artifactReads = 0
        val builder = ConversationRowBuilder().apply { pages = { artifactReads++ } }
        val row = builder.rows(restored, "origin", null, false).single() as ConversationRow.GenUi
        assertTrue(row.document.drawable)
        assertEquals(0, artifactReads)
        assertTrue(row.tool.isResult)
        assertFalse(ToolSections.joins(ConversationRow.Tool("tool", "call", row.tool)))
        val step = ConversationRow.Tool("step", "step", ToolUse("read", "completed"))
        val answer = ConversationRow.Text("answer", "Done", emptyList())
        val end = ConversationRow.TurnEnd("end", "run", "completed", 10, 2, "Done")
        for (grouped in listOf(false, true)) {
            assertTrue(TurnFold.fold("run", listOf(step, row, answer, end), open = false, grouped = grouped).contains(row))
        }
        assertNull(Presentation.parse(buildJsonObject { put("type", "ui"); put("document", document) }))
    }

    @Test fun malformedAndFutureDocumentsKeepFallbackAndNeverGainAuthority() {
        assertFalse(GenUiMessage.document(JsonPrimitive("broken")).drawable)
        assertEquals("Gen UI", GenUiMessage.document(Json.parseToJsonElement("""{"genuiRender":1}""")).fallback)
        val future = GenUiMessage.document(Json.parseToJsonElement("""{"genuiRender":2,"fallback":"Future summary"}"""))
        assertFalse(future.drawable)
        assertEquals("Future summary", future.fallback)
        assertTrue(GenUiMessage.enables(Action.Message("Continue")))
        assertTrue(GenUiMessage.enables(Action.Copy("Copy")))
        assertTrue(GenUiMessage.enables(Action.Open("https://example.com")))
        assertFalse(GenUiMessage.enables(Action.Open("javascript:alert(1)")))
        assertFalse(GenUiMessage.enables(Action.Open("file:///secret")))
        assertFalse(GenUiMessage.enables(Action.Plugin("p")))
        // Where the computer reports `capabilities.plugins`, a plugin opens its page.
        assertTrue(GenUiMessage.enables(Action.Plugin("p"), plugins = true))
        assertFalse(GenUiMessage.enables(Action.Unsupported("future"), plugins = true))
        assertFalse(GenUiMessage.enables(Action.Unsupported("future")))
        for (url in listOf("https:example.com", " https://example.com", "https://user:pass@example.com", "https://example.com\\evil", "https://example.com/\n")) {
            assertFalse(url, GenUiMessage.enables(Action.Open(url)))
        }
    }

    @Test fun messageBoundsAndImageRefusal() {
        fun document(elements: JsonObject) = GenUiMessage.document(buildJsonObject {
            put("genuiRender", 1); put("fallback", "Summary"); put("root", "root"); put("elements", elements)
        })
        val text = Json.parseToJsonElement("""{"type":"text","props":{"spans":[{"text":"Hello"}]}}""")
        assertFalse(document(JsonObject((0..4000).associate { "e$it" to text })).drawable)
        assertFalse(document(JsonObject(mapOf("root" to Json.parseToJsonElement("""{"type":"image","props":{"file":"https://example.com/private.png"}}""")))).drawable)
        val large = buildJsonObject { put("type", "code"); put("props", buildJsonObject { put("text", "x".repeat(4 * 1024 * 1024)) }) }
        val fallback = document(JsonObject(mapOf("root" to large)))
        assertFalse(fallback.drawable)
        assertEquals("Summary", fallback.fallback)
    }
}
package com.slopus.happy.conversation.ui

import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.Message
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Chat UI as the transcript's rows ([ConversationRow.Ui]): one a component, drawn whole or as its fallback line. */
class UiRowsTest {
    private fun rows(content: String) = ConversationRowBuilder.build(
        Message.parse(Json.parseToJsonElement("""{"id":"m1","role":"agent","createdAt":1,"metadata":{},"content":[$content]}"""))!!,
        "a1", null, streaming = false,
    )

    private fun block(vararg components: String) = """{"type":"ui","ui":{"id":"u1","components":[${components.joinToString(",")}]}}"""

    private fun shown(vararg components: String, items: String = "") =
        """{"type":"tool_call","id":"c1","name":"show_ui","status":"completed","presentation":{"type":"ui","ui":{"id":"u2","components":[${components.joinToString(",")}]},"items":[$items]}}"""

    @Test fun `a ui block's components are rows top to bottom, each named as a press names it`() {
        val rows = rows("""{"type":"text","text":"Here."},${block(TREE, SIGN_IN)}""")
        val ui = rows.filterIsInstance<ConversationRow.Ui>()
        assertEquals(listOf("m1:1:files", "m1:1:claude"), ui.map { it.key })
        assertEquals(listOf(UiOffer("m1", "u1", "files"), UiOffer("m1", "u1", "claude")), ui.map { it.offer })
        assertEquals(UiComponent.FileTree("files", "2 files", listOf("src/a.ts", "src/b.ts")), ui[0].component)
        assertEquals("a type this build doesn't draw is its fallback line", UiComponent.Other("claude", "Sign in to Claude in Happy on your computer"), ui[1].component)
        assertEquals("under the words", rows.indexOfFirst { it is ConversationRow.Text } + 1, rows.indexOf(ui[0]))
    }

    @Test fun `a known type whose props do not fit is its fallback line`() {
        val row = rows(block("""{"id":"files","type":"file_tree","fallback":"2 files","props":{"paths":[]}}""")).single() as ConversationRow.Ui
        assertEquals(UiComponent.Other("files", "2 files"), row.component)
    }

    @Test fun `a component with nothing to draw, not even a fallback, has no row`() {
        val rows = rows(block("""{"id":"x","type":"phone_app","fallback":"","props":{}}""", TREE))
        assertEquals(listOf("m1:0:files"), rows.map { it.key })
    }

    @Test fun `what show_ui showed stands in its call's place, with no tool line`() {
        val rows = rows("""{"type":"text","text":"Here."},${shown(TREE)}""")
        assertTrue(rows.none { it is ConversationRow.Tool })
        val ui = rows.filterIsInstance<ConversationRow.Ui>().single()
        assertEquals("m1:1:files", ui.key)
        assertEquals(UiOffer("m1", "u2", "files"), ui.offer)
    }

    @Test fun `a show_ui call that shows nothing here is its tool line`() {
        val rows = rows(shown("""{"id":"x","type":"phone_app","fallback":"","props":{}}"""))
        assertEquals(1, rows.size)
        assertEquals("show_ui", (rows.single() as ConversationRow.Tool).name)
    }

    @Test fun `a ui block that does not decode is skipped, and its message's other blocks stay`() {
        val rows = rows("""{"type":"text","text":"Here."},{"type":"ui","ui":{"components":[$TREE]}},${block(TREE)}""")
        assertEquals(listOf("m1:0", "m1:2:files"), rows.map { it.key })
    }

    private companion object {
        const val TREE = """{"id":"files","type":"file_tree","fallback":"2 files","props":{"paths":["src/a.ts","src/b.ts"]}}"""
        const val SIGN_IN = """{"id":"claude","type":"provider_sign_in","fallback":"Sign in to Claude in Happy on your computer","props":{"provider":"claude"}}"""
    }
}

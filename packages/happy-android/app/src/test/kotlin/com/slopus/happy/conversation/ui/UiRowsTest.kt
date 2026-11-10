package com.slopus.happy.conversation.ui

import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.MediaRef
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

    @Test fun `a media component is one row of the items it names, in its order, each with its label`() {
        val rows = rows(shown(media("""{"mediaIndex":1,"label":"After"},{"mediaIndex":0}"""), TREE, items = "$PICTURE,$REPORT"))
        assertEquals(listOf("m1:0:pics", "m1:0:files"), rows.map { it.key })
        val row = rows[0] as ConversationRow.UiMedia
        assertEquals(listOf(MediaRef("c1", 1, MediaItem("document", "Report.pdf", "application/pdf")), MediaRef("c1", 0, MediaItem("image", "a.png", "image/png", 1600.0, 900.0))), row.items)
        assertEquals(listOf("After", null), row.labels)
    }

    @Test fun `a media component is drawn whole or not at all`() {
        val fallback = UiComponent.Other("pics", "2 images")
        // An index past the call's items: nothing of it is drawn, though one item is there.
        assertEquals(fallback, (rows(shown(media("""{"mediaIndex":0},{"mediaIndex":2}"""), items = "$PICTURE,$REPORT")).single() as ConversationRow.Ui).component)
        // An item that doesn't read holds its place, and is no item.
        assertEquals(fallback, (rows(shown(media("""{"mediaIndex":1}"""), items = "$PICTURE,7")).single() as ConversationRow.Ui).component)
        // Only a show_ui call carries items: in a block there are none to name.
        assertEquals(fallback, (rows(block(media("""{"mediaIndex":0}"""))).single() as ConversationRow.Ui).component)
        // Props that don't fit.
        assertEquals(fallback, (rows(shown("""{"id":"pics","type":"media","fallback":"2 images","props":{"items":[]}}""", items = PICTURE)).single() as ConversationRow.Ui).component)
    }

    private fun media(items: String) = """{"id":"pics","type":"media","fallback":"2 images","props":{"items":[$items]}}"""

    private companion object {
        const val PICTURE = """{"kind":"image","name":"a.png","mimeType":"image/png","width":1600,"height":900}"""
        const val REPORT = """{"kind":"document","name":"Report.pdf","mimeType":"application/pdf"}"""
        const val TREE = """{"id":"files","type":"file_tree","fallback":"2 files","props":{"paths":["src/a.ts","src/b.ts"]}}"""
        const val SIGN_IN = """{"id":"claude","type":"provider_sign_in","fallback":"Sign in to Claude in Happy on your computer","props":{"provider":"claude"}}"""
    }
}

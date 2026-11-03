package com.slopus.happy.conversation

import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.references.HappyReferences
import com.slopus.happy.references.References
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * A conversation's rows read their Happy references by name (iOS
 * ChatPlanner's `HappyReferences.markdown` and `plain`): an agent's words
 * with links to what they name, the person's as words, a tag still
 * streaming held back, and a message that names something built again
 * when what it names is read.
 */
class ConversationReferencesTest {
    private val report = References(artifacts = mapOf("r1" to References.Artifact.Active("Q3 revenue report", "markdown", 2)))

    private fun spans(row: ConversationRow) = ((row as ConversationRow.Text).blocks.single() as MarkdownBlock.Text).content

    @Test fun `an agent's words link what they name and read as names when copied`() {
        val message = Message("m", "agent", 1, listOf(Block.Text("See <happy-artifact id=\"r1\"/> for the numbers.")))
        val row = ConversationRowBuilder.build(message, "a1", null, false, references = report).single() as ConversationRow.Text
        assertEquals("See Q3 revenue report for the numbers.", row.text)
        val link = spans(row).single { it.url != null }
        assertEquals("Q3 revenue report", link.text)
        assertEquals(HappyReferences.Reference("artifact", "r1"), HappyReferences.reference(link.url!!))
        // Without references the tag stays as written.
        assertEquals("See <happy-artifact id=\"r1\"/> for the numbers.", (ConversationRowBuilder.build(message, "a1", null, false).single() as ConversationRow.Text).text)
    }

    @Test fun `what the person and other agents wrote`() {
        val mine = Message("u", "user", 1, listOf(Block.Text("Open <happy-artifact id=\"r1\"/>")))
        assertEquals("Open Q3 revenue report", (ConversationRowBuilder.build(mine, "a1", null, false, references = report).single() as ConversationRow.User).text)
        val other = Message("o", "agent", 1, listOf(Block.Text("Message from agent x9: Done: <happy-artifact id=\"r1\"/>")), senderAgentId = "x9")
        val row = ConversationRowBuilder.build(other, "a1", null, false, references = report).single() as ConversationRow.Collaborator
        assertEquals("Done: Q3 revenue report", row.text)
        assertEquals("Q3 revenue report", (row.blocks.single() as MarkdownBlock.Text).content.single { it.url != null }.text)
    }

    @Test fun `a tag still streaming is held back`() {
        val message = Message("m", "agent", 1, listOf(Block.Text("Started <happy-agent id=\"a")))
        val builder = ConversationRowBuilder().apply { references = References() }
        val row = builder.rows(message, "a1", null, streaming = true).single() as ConversationRow.Text
        assertEquals("Started", row.live!!.content.value.text.trim())
    }

    @Test fun `a message that names something is built again when it is read, and only that one`() {
        val names = Message("m1", "agent", 1, listOf(Block.Text("See <happy-artifact id=\"r1\"/>.")))
        val plain = Message("m2", "agent", 2, listOf(Block.Text("Nothing named here.")))
        val asked = ArrayList<String>()
        val builder = ConversationRowBuilder().apply {
            references = References()
            named = { asked += it }
        }
        val reading = builder.rows(names, "a1", null, false)
        val plainRows = builder.rows(plain, "a1", null, false)
        assertEquals("its words are handed on to be read", listOf("See <happy-artifact id=\"r1\"/>."), asked)
        assertEquals("See artifact.", (reading.single() as ConversationRow.Text).text)
        assertSame("unchanged, it is not built again", reading, builder.rows(names, "a1", null, false))
        builder.references = report
        val read = builder.rows(names, "a1", null, false)
        assertNotSame(reading, read)
        assertEquals("See Q3 revenue report.", (read.single() as ConversationRow.Text).text)
        assertSame("words that name nothing keep their rows", plainRows, builder.rows(plain, "a1", null, false))
    }

    @Test fun `an HTML artifact a call shows at its latest version is read, and drawn inline once it asks to be`() {
        fun call(id: String, shows: String?, type: String = "html") = Block.ToolCall("c-$id", "create_artifact", "completed", Presentation.Artifact(id, type, "Waveform", 2, shows))
        val message = Message("m", "agent", 1, listOf(call("p1", "latest"), call("p2", null), call("p3", "latest", "markdown")))
        val asked = ArrayList<List<String>>()
        val builder = ConversationRowBuilder().apply {
            references = References()
            pages = { asked += it }
        }
        val before = builder.rows(message, "a1", null, false).map { (it as ConversationRow.Artifact).page }
        assertEquals("only an HTML artifact that follows its latest version is asked about", listOf(listOf("p1")), asked)
        assertEquals(listOf(null, null, null), before)
        val page = References.Page(2, "index.html")
        builder.references = References(
            artifacts = mapOf("p1" to References.Artifact.Active("Waveform", "html", 2), "p2" to References.Artifact.Active("Waveform", "html", 2)),
            pages = mapOf("p1" to page, "p2" to page),
        )
        val after = builder.rows(message, "a1", null, false).map { (it as ConversationRow.Artifact).page }
        assertEquals("a call pinned to its version stays a card", listOf(page, null, null), after)
        assertEquals("read, it isn't asked about again", 1, asked.size)
    }
}

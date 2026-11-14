package com.slopus.happy.conversation

import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.MarkdownSpan
import com.slopus.happy.chat.markdown.SpanStyle
import com.slopus.happy.references.HappyReferences
import com.slopus.happy.references.References
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Share links and Happy links in what agents and people say, as every client
 * reads them now: a Happy link reads as the current name of what it names,
 * whatever its label, or its placeholder where this connection doesn't hold
 * it, and keeps the address it was written with; a bare link is its address;
 * what a link opens, and whether it shimmers, is read from that address where
 * it is drawn ([References.resolve], [References.busy]); and what is copied
 * is exactly what was written. Nothing shown or copied is ever another scheme.
 */
class ConversationShareLinksTest {
    private val instance = "k3x9q2m7p0a4b8c1d5e6f7g2"
    private val other = "m1n2b3v4c5x6z7l8k9j0h1g2"
    private val here = { id: String -> id == instance }
    private val references = References(
        agents = mapOf("t1" to References.Entity("Ship the release", "t1")),
        workspaces = mapOf("w1" to References.Entity("Ship the release", "t1")),
        artifacts = mapOf("r1" to References.Artifact.Active("Q3 revenue report", "markdown", 2), "gone" to References.Artifact.Missing),
        surfaces = mapOf("sf2" to "Groceries"),
    )

    private fun share(rest: String, on: String = instance) = "https://link.happy.page/#1/$on/$rest"

    private fun row(text: String, references: References? = this.references): ConversationRow.Text {
        val message = Message("m", "agent", 1, listOf(Block.Text(text)))
        return ConversationRowBuilder.build(message, "a1", null, false, references = references, here = here).single() as ConversationRow.Text
    }

    private fun spans(row: ConversationRow.Text) = (row.blocks.single() as MarkdownBlock.Text).content

    private fun List<MarkdownSpan>.words() = joinToString("") { it.text }

    /** Nothing a row shows, links to or copies is a private scheme. */
    private fun assertNoPrivateScheme(row: ConversationRow.Text) {
        assertFalse(row.text, row.text.contains("happy-reference"))
        for (span in spans(row)) {
            assertFalse(span.text, span.text.contains("happy-reference"))
            assertFalse(span.url.orEmpty(), span.url.orEmpty().contains("happy-reference"))
        }
    }

    @Test fun `a share link reads as the live name, never its label`() {
        val link = share("agents/t1?as=task")
        val row = row("Read [the plan]($link) first, or []($link)")
        assertEquals(listOf("Ship the release", "Ship the release"), spans(row).filter { it.url != null }.map { it.text })
        val span = spans(row).first { it.url != null }
        assertEquals(link, span.url)
        assertEquals(HappyReferences.Reference("agent", "t1"), references.resolve(span.url!!, here))
        // What is copied is what was written.
        assertEquals("Read [the plan]($link) first, or []($link)", row.text)
        assertNoPrivateScheme(row)
    }

    @Test fun `a happy link reads as the live name too`() {
        val row = row("See [report](happy://artifacts/r1?version=2) and [x](happy://$instance/agents/t1)")
        val links = spans(row).filter { it.url != null }
        assertEquals(listOf("Q3 revenue report", "Ship the release"), links.map { it.text })
        assertEquals(listOf("happy://artifacts/r1?version=2", "happy://$instance/agents/t1"), links.map { it.url })
        assertEquals(HappyReferences.Reference("artifact", "r1", version = 2), references.resolve(links[0].url!!, here))
        assertEquals(HappyReferences.Reference("agent", "t1"), references.resolve(links[1].url!!, here))
        assertNoPrivateScheme(row)
    }

    @Test fun `a bold link is one bold link`() {
        val link = share("artifacts/r1")
        val row = row("**[X]($link)**")
        assertEquals(listOf(MarkdownSpan(setOf(SpanStyle.Bold), "Q3 revenue report", link)), spans(row))
        assertEquals("**[X]($link)**", row.text)
        assertNoPrivateScheme(row)
    }

    @Test fun `a bare share link is its address, a link that opens in the app`() {
        val link = share("agents/t1?as=task")
        val row = row("Look at $link.")
        val span = spans(row).single { it.url != null }
        assertEquals(link, span.text)
        assertEquals(link, span.url)
        assertTrue(HappyReferences.opensInApp(link))
        assertEquals("Look at $link.", row.text)
        assertNoPrivateScheme(row)
    }

    @Test fun `what this connection doesn't hold reads as its placeholder`() {
        // A session the lists don't hold, a Surface the person isn't in, an artifact that is gone, another server's:
        // a share link stays a link, which says its server isn't connected when tapped; a Happy URL is words.
        for ((url, words) in listOf(
            share("agents/s9?as=session") to "an unavailable agent",
            share("surfaces/sf1") to "an unavailable surface",
            share("artifacts/gone") to "an unavailable artifact",
            share("agents/t1", on = other) to "an unavailable agent",
            "happy://artifacts/gone" to "an unavailable artifact",
            "happy://$other/agents/t1" to "an unavailable agent",
        )) {
            val row = row("Ask [Researcher]($url)")
            assertEquals(url, "Ask $words", spans(row).words())
            assertEquals(url, if (url.startsWith("https://")) url else null, spans(row).singleOrNull { it.url != null }?.url)
            assertNull(url, references.resolve(url, here))
            assertEquals(url, "Ask [Researcher]($url)", row.text)
            assertNoPrivateScheme(row)
        }
        // Held, each resolves: a Surface, a workspace's conversation, an artifact.
        assertEquals(HappyReferences.Reference("surface", "sf2"), references.resolve(share("surfaces/sf2"), here))
        assertEquals(HappyReferences.Reference("workspace", "w1"), references.resolve("happy://workspaces/w1", here))
        // A person is a mention, not an in-app link.
        assertNull(references.copy(users = mapOf("u1" to "Steve")).resolve("happy://users/u1", here))
    }

    @Test fun `a link to a conversation at work is busy, and nothing else is`() {
        val busy = setOf("t1")
        assertTrue(references.busy(share("agents/t1?as=task"), here, busy))
        assertTrue(references.busy("happy://agents/t1", here, busy))
        assertTrue("a workspace by the conversation it holds", references.busy("happy://workspaces/w1", here, busy))
        assertFalse(references.busy("happy://agents/t1", here, emptySet()))
        assertFalse("another server's", references.busy(share("agents/t1", on = other), here, busy))
        assertFalse(references.busy("happy://artifacts/r1", here, busy))
        assertFalse(references.busy("https://example.com", here, busy))
    }

    @Test fun `a share link opens in the app on a tap and has no browser menu`() {
        val link = share("agents/t1?as=task", on = other)
        assertTrue(HappyReferences.opensInApp(link))
        assertNull(com.slopus.happy.ui.browser.Link(androidx.compose.ui.text.LinkAnnotation.Url(link)).url)
        // Anything else on the page's host is a web page like any other.
        assertEquals("https://link.happy.page/", com.slopus.happy.ui.browser.Link(androidx.compose.ui.text.LinkAnnotation.Url("https://link.happy.page/")).url)
    }

    @Test fun `a person is a mention by their name`() {
        val row = row("Ask [Bob](happy://users/u1)", references.copy(users = mapOf("u1" to "Steve")))
        assertEquals("Ask @Steve", spans(row).words())
        assertEquals("happy://users/u1", spans(row).single { it.url != null }.url)
    }

    @Test fun `a file link reads as its path and a settings button stays one`() {
        val file = spans(row("See [main](happy://agents/a1/files/src/main.ts#L4-L9)")).single { it.url != null }
        assertEquals("src/main.ts", file.text)
        assertEquals("happy://agents/a1/files/src/main.ts#L4-L9", file.url)
        val button = row("[Open providers](happy://settings/providers \"button\")").blocks.single() as MarkdownBlock.Buttons
        assertEquals("happy://settings/providers", button.links.single().url)
    }

    @Test fun `a person's own message reads its links as an agent's do`() {
        val link = share("agents/t1?as=task")
        val message = Message("m", "user", 1, listOf(Block.Text("Look at $link and [old](happy://agents/zz) for <happy-agent id=\"t1\"/>")))
        val row = ConversationRowBuilder.build(message, "a1", null, false, references = references, here = here).single() as ConversationRow.User
        val spans = (row.blocks.single() as MarkdownBlock.Text).content
        assertEquals("Look at $link and an unavailable agent for Ship the release", spans.words())
        assertEquals(listOf(link, "happy://agents/t1"), spans.mapNotNull { it.url })
        // What is copied keeps the links as written; only the tag reads as its name.
        assertEquals("Look at $link and [old](happy://agents/zz) for Ship the release", row.text)
    }

    @Test fun `a share link in code stays code`() {
        val code = row("`${share("agents/t1")}`")
        assertNull(spans(code).single().url)
    }

    @Test fun `the artifacts links name are handed on to be read`() {
        val asked = ArrayList<String>()
        val builder = ConversationRowBuilder().apply {
            references = References()
            here = this@ConversationShareLinksTest.here
            named = { asked += it }
        }
        builder.rows(Message("m", "agent", 1, listOf(Block.Text("See [](${share("artifacts/r9")}) and [it](happy://artifacts/r8)"))), "a1", null, false)
        assertEquals(listOf("See <happy-artifact id=\"r9\"/> and <happy-artifact id=\"r8\"/>"), asked)
        assertEquals(listOf("r9", "r8"), References().unread(asked.single()))
    }
}

package com.slopus.happy.conversation

import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.references.HappyReferences
import com.slopus.happy.references.References
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Share links and Happy links in what agents and people say (desktop
 * 5a4c075c's `shareLinksHere` and `messageReferencesResolve`): one naming the
 * conversation's own installation reads as the Happy link it carries, by the
 * live name of what it names where that opens and as words where it doesn't;
 * another server's share link stays a web address and its Happy link is its
 * words; and what is copied keeps the link as written.
 */
class ConversationShareLinksTest {
    private val instance = "k3x9q2m7p0a4b8c1d5e6f7g2"
    private val other = "m1n2b3v4c5x6z7l8k9j0h1g2"
    private val here = { id: String -> id == instance }
    private val references = References(
        agents = mapOf("t1" to References.Entity("Ship the release", "t1")),
        artifacts = mapOf("r1" to References.Artifact.Active("Q3 revenue report", "markdown", 2), "gone" to References.Artifact.Missing),
        surfaces = mapOf("sf2" to "Groceries"),
    )

    private fun share(rest: String, on: String = instance) = "https://link.happy.page/#1/$on/$rest"

    private fun row(text: String, references: References? = this.references): ConversationRow.Text {
        val message = Message("m", "agent", 1, listOf(Block.Text(text)))
        return ConversationRowBuilder.build(message, "a1", null, false, references = references, here = here).single() as ConversationRow.Text
    }

    private fun spans(row: ConversationRow.Text) = (row.blocks.single() as MarkdownBlock.Text).content

    @Test fun `a bare link to a task here reads as its name and opens it`() {
        val link = share("agents/t1?as=task")
        val row = row("Look at $link.")
        val span = spans(row).single { it.url != null }
        assertEquals("Ship the release", span.text)
        assertEquals(HappyReferences.Reference("agent", "t1"), HappyReferences.reference(span.url!!))
        // What is copied is what was written.
        assertEquals("Look at $link.", row.text)
    }

    @Test fun `an artifact reads as its title, at the version it pins`() {
        val span = spans(row("<${share("artifacts/r1?version=2")}>")).single { it.url != null }
        assertEquals("Q3 revenue report", span.text)
        assertEquals(HappyReferences.Reference("artifact", "r1", version = 2), HappyReferences.reference(span.url!!))
    }

    @Test fun `a Surface reads as its name and opens it`() {
        val span = spans(row("See ${share("surfaces/sf2")}")).single { it.url != null }
        assertEquals("Groceries", span.text)
        assertEquals(HappyReferences.Reference("surface", "sf2"), HappyReferences.reference(span.url!!))
    }

    @Test fun `what this phone can't open reads as words, as on desktop`() {
        // A session the lists don't hold, a Surface the person isn't in, an artifact that is gone.
        for ((rest, words) in listOf(
            "agents/s9?as=session" to "an unavailable agent",
            "surfaces/sf1" to "an unavailable surface",
            "artifacts/gone" to "an unavailable artifact",
        )) {
            val shown = spans(row("See ${share(rest)}"))
            assertTrue(rest, shown.none { it.url != null })
            assertEquals(rest, "See $words", shown.joinToString("") { it.text })
        }
        // Written as a link to itself, it names nothing either: words, not the address.
        assertEquals("See an unavailable agent", spans(row("See [${share("agents/s9")}](${share("agents/s9")})")).joinToString("") { it.text })
        // Labelled, its label.
        assertEquals("Ask Researcher", spans(row("Ask [Researcher](${share("agents/s9")})")).joinToString("") { it.text })
        // A file is its path, opening on this installation.
        val file = spans(row("See ${share("agents/a1/files/src/main.ts?lines=4-9")}")).single { it.url != null }
        assertEquals("src/main.ts", file.text)
        assertEquals("happy://agents/a1/files/src/main.ts#L4-L9", file.url)
        // Without references, it is the address it was written as.
        assertEquals(share("agents/t1"), spans(row(share("agents/t1"), references = null)).single { it.url != null }.url)
    }

    @Test fun `a share link opens in the app on a tap and has no browser menu`() {
        val link = share("agents/t1?as=task", on = other)
        assertTrue(HappyReferences.opensInApp(link))
        assertNull(com.slopus.happy.ui.browser.Link(androidx.compose.ui.text.LinkAnnotation.Url(link)).url)
        // Anything else on the page's host is a web page like any other.
        assertEquals("https://link.happy.page/", com.slopus.happy.ui.browser.Link(androidx.compose.ui.text.LinkAnnotation.Url("https://link.happy.page/")).url)
    }

    @Test fun `a labelled link reads as the live name over its label`() {
        val span = spans(row("Read [the plan](${share("agents/t1?as=bot")}) first")).single { it.url != null }
        assertEquals("Ship the release", span.text)
        assertEquals(HappyReferences.Reference("agent", "t1"), HappyReferences.reference(span.url!!))
    }

    @Test fun `a Happy link written as Markdown reads as the live name`() {
        val span = spans(row("See [report](happy://artifacts/r1?version=2) and [x](happy://$instance/agents/t1)")).filter { it.url != null }
        assertEquals(listOf("Q3 revenue report", "Ship the release"), span.map { it.text })
        assertEquals(HappyReferences.Reference("artifact", "r1", version = 2), HappyReferences.reference(span[0].url!!))
        // Another installation's is its words, opening nothing here.
        val foreign = spans(row("Ask [their bot](happy://$other/agents/t1)"))
        assertEquals("Ask their bot", foreign.joinToString("") { it.text })
        assertTrue(foreign.none { it.url != null })
        // A settings button stays one, on its Happy URL.
        val button = row("[Open providers](happy://settings/providers \"button\")").blocks.single() as MarkdownBlock.Buttons
        assertEquals("happy://settings/providers", button.links.single().url)
    }

    @Test fun `a person's own message names what it links as links`() {
        val message = Message("m", "user", 1, listOf(Block.Text("Look at ${share("agents/t1?as=task")} and [old](happy://agents/zz)")))
        val row = ConversationRowBuilder.build(message, "a1", null, false, references = references, here = here).single() as ConversationRow.User
        val spans = (row.blocks.single() as MarkdownBlock.Text).content
        assertEquals("Look at Ship the release and old", spans.joinToString("") { it.text })
        assertEquals(HappyReferences.Reference("agent", "t1"), HappyReferences.reference(spans.single { it.url != null }.url!!))
        // What is copied keeps the share link as written.
        assertEquals("Look at ${share("agents/t1?as=task")} and old", row.text)
    }

    @Test fun `another server's share link, and one in code, stay as written`() {
        val foreign = share("agents/t1", on = other)
        assertEquals(foreign, spans(row("See $foreign")).single { it.url != null }.url)
        val code = row("`${share("agents/t1")}`")
        assertNull(spans(code).single().url)
    }

    @Test fun `a share link still streaming at the end is left as it comes`() {
        val builder = ConversationRowBuilder().apply {
            references = this@ConversationShareLinksTest.references
            here = this@ConversationShareLinksTest.here
        }
        val partial = Message("m", "agent", 1, listOf(Block.Text("Opening ${share("agents/t")}")))
        val row = builder.rows(partial, "a1", null, streaming = true).single() as ConversationRow.Text
        assertEquals("Opening ${share("agents/t")}", row.live!!.content.value.text)
    }

    @Test fun `the artifacts share links name are handed on to be read`() {
        val asked = ArrayList<String>()
        val builder = ConversationRowBuilder().apply {
            references = References()
            here = this@ConversationShareLinksTest.here
            named = { asked += it }
        }
        builder.rows(Message("m", "agent", 1, listOf(Block.Text("See ${share("artifacts/r9")} and [it](happy://artifacts/r8)"))), "a1", null, false)
        assertEquals(listOf("See <happy-artifact id=\"r9\"/> and <happy-artifact id=\"r8\"/>"), asked)
        assertEquals(listOf("r9", "r8"), References().unread(asked.single()))
    }
}

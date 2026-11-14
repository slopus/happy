package com.slopus.happy.chat.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** happy-app's parseMarkdown.test.ts, parseMarkdownBlock.test.ts and linkUtils.test.ts, plus the other block kinds. */
class MarkdownParserTest {
    private fun plain(text: String, url: String? = null) = MarkdownSpan(emptySet(), text, url)
    private fun spans(text: String) = if (text.isEmpty()) emptyList() else listOf(plain(text))

    @Test fun `bullet lists across markers keep links`() {
        val blocks = parseMarkdown("* first item\n+ second item with [docs](https://example.com/docs)\n- third item with https://example.com/raw.")
        val list = blocks.single() as MarkdownBlock.BulletList
        assertEquals(3, list.items.size)
        assertEquals(MarkdownBlock.ListItem(0, listOf(plain("second item with "), plain("docs", "https://example.com/docs"))), list.items[1])
        assertEquals(
            MarkdownBlock.ListItem(0, listOf(plain("third item with "), plain("https://example.com/raw", "https://example.com/raw"), plain("."))),
            list.items[2],
        )
    }

    @Test fun `standalone images`() {
        assertEquals(
            listOf(MarkdownBlock.Image("Markdown renderable image", "data:image/png;base64,abc123")),
            parseMarkdown("![Markdown renderable image](data:image/png;base64,abc123)"),
        )
    }

    @Test fun `bare urls become links`() {
        val text = parseMarkdown("Visit https://example.com/docs for more.").single() as MarkdownBlock.Text
        assertEquals(listOf(plain("Visit "), plain("https://example.com/docs", "https://example.com/docs"), plain(" for more.")), text.content)
    }

    @Test fun `tables`() {
        assertEquals(
            listOf(MarkdownBlock.Table(listOf(spans("A"), spans("B")), listOf(listOf(spans("1"), spans("2"))))),
            parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |"),
        )
        val blankLines = parseMarkdown("| A | B |\n\n|---|---|\n\n| 1 | 2 |\n\n| 3 | 4 |").filterIsInstance<MarkdownBlock.Table>().single()
        assertEquals(listOf(listOf(spans("1"), spans("2")), listOf(spans("3"), spans("4"))), blankLines.rows)
        assertEquals(
            MarkdownBlock.Table(listOf(spans(""), spans("Header1"), spans("Header2")), listOf(listOf(spans("Row1"), spans("a"), spans("b")))),
            parseMarkdown("| | Header1 | Header2 |\n|---|---|---|\n| Row1 | a | b |").single(),
        )
        val combined = parseMarkdown("### Comparison\n\n| | Plan A | Plan B |\n\n|--|----|----|\n\n| Price | \$10/mo | \$20/mo |\n\n| Storage | 5 GB | 50 GB |\n\n| Support | Email only | 24/7 chat |")
            .filterIsInstance<MarkdownBlock.Table>().single()
        assertEquals(3, combined.headers.size)
        assertEquals(emptyList<MarkdownSpan>(), combined.headers[0])
        assertEquals(3, combined.rows.size)
        assertEquals(spans("Price"), combined.rows[0][0])
        val after = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n\nSome text after the table")
        assertEquals(1, after.count { it is MarkdownBlock.Table })
        assertEquals(1, after.count { it is MarkdownBlock.Text })
    }

    @Test fun `http links`() {
        assertTrue(isHttpMarkdownLink("http://example.com"))
        assertTrue(isHttpMarkdownLink("https://example.com/docs"))
        assertTrue(isHttpMarkdownLink(" HTTPS://example.com/docs "))
        assertFalse(isHttpMarkdownLink("mailto:test@example.com"))
        assertFalse(isHttpMarkdownLink("data:text/plain,hello"))
        assertFalse(isHttpMarkdownLink("/Users/me/project/file.ts"))
        assertFalse(isHttpMarkdownLink("packages/happy-app/index.tsx"))
    }

    @Test fun `inline styles`() {
        val text = parseMarkdown("a **bold** *it* `code` [x] end").single() as MarkdownBlock.Text
        assertEquals(
            listOf(
                plain("a "), MarkdownSpan(setOf(SpanStyle.Bold), "bold"), plain(" "), MarkdownSpan(setOf(SpanStyle.Italic), "it"),
                plain(" "), MarkdownSpan(setOf(SpanStyle.Code), "code"), plain(" "), plain("[x]"), plain(" end"),
            ),
            text.content,
        )
        // An unclosed marker runs to the end of the line.
        assertEquals(listOf(plain("x "), MarkdownSpan(setOf(SpanStyle.Bold), "open")), (parseMarkdown("x **open").single() as MarkdownBlock.Text).content)
        // Headers drop bold and italic.
        assertEquals(MarkdownBlock.Header(2, listOf(plain("Title"))), parseMarkdown("## **Title**").single())
    }

    @Test fun `links and code inside bold and italic keep the style`() {
        val share = "https://link.happy.page/#1/k3x9q2m7p0a4b8c1d5e6f7g2/artifacts/r1"
        val bold = setOf(SpanStyle.Bold)
        assertEquals(listOf(MarkdownSpan(bold, "X", share)), (parseMarkdown("**[X]($share)**").single() as MarkdownBlock.Text).content)
        assertEquals(
            listOf(plain("See "), MarkdownSpan(bold, "the "), MarkdownSpan(bold, "plan", "happy://agents/a1"), MarkdownSpan(bold, " now"), plain(".")),
            (parseMarkdown("See **the [plan](happy://agents/a1) now**.").single() as MarkdownBlock.Text).content,
        )
        assertEquals(
            listOf(MarkdownSpan(setOf(SpanStyle.Italic), "run "), MarkdownSpan(setOf(SpanStyle.Italic, SpanStyle.Code), "make")),
            (parseMarkdown("*run `make`*").single() as MarkdownBlock.Text).content,
        )
        // Italic inside bold, and a bare address in bold is a bold link.
        assertEquals(
            listOf(MarkdownSpan(bold, "a "), MarkdownSpan(setOf(SpanStyle.Bold, SpanStyle.Italic), "b")),
            (parseMarkdown("**a *b***").single() as MarkdownBlock.Text).content.filter { it.text.isNotEmpty() },
        )
        assertEquals(listOf(MarkdownSpan(bold, share, share)), (parseMarkdown("**$share**").single() as MarkdownBlock.Text).content)
        // A link with no words that nothing named shows its address.
        assertEquals(listOf(plain(share, share)), (parseMarkdown("[]($share)").single() as MarkdownBlock.Text).content)
        // A header keeps its links, without the style.
        assertEquals(MarkdownBlock.Header(2, listOf(plain("X", share))), parseMarkdown("## **[X]($share)**").single())
    }

    @Test fun `code blocks, mermaid, rules, options and numbered lists`() {
        val blocks = parseMarkdown("```kotlin\nval x = 1\n\nprintln(x)\n```\n```mermaid\ngraph TD\n```\n---\n<options>\n<option>Yes</option>\n<option>No</option>\n</options>\n1. one\n  2. two\n10. ten")
        assertEquals(MarkdownBlock.CodeBlock("kotlin", "val x = 1\n\nprintln(x)"), blocks[0])
        assertEquals(MarkdownBlock.Mermaid("graph TD"), blocks[1])
        assertEquals(MarkdownBlock.HorizontalRule, blocks[2])
        assertEquals(MarkdownBlock.Options(listOf("Yes", "No")), blocks[3])
        assertEquals(
            MarkdownBlock.NumberedList(
                listOf(
                    MarkdownBlock.NumberedItem(1, 0, spans("one")),
                    MarkdownBlock.NumberedItem(2, 1, spans("two")),
                    MarkdownBlock.NumberedItem(10, 0, spans("ten")),
                ),
            ),
            blocks[4],
        )
        assertEquals(5, blocks.size)
        assertEquals(listOf(MarkdownBlock.CodeBlock(null, "unterminated")), parseMarkdown("```\nunterminated"))
    }

    private fun button(text: String, url: String) = MarkdownSpan(emptySet(), text, url, button = true)

    @Test fun `a link's title is not its address`() {
        val text = parseMarkdown("See [docs](https://example.com/docs \"The docs\") and [wiki](https://en.wikipedia.org/wiki/Foo_(bar)).").single() as MarkdownBlock.Text
        assertEquals(listOf(plain("See "), plain("docs", "https://example.com/docs"), plain(" and "), plain("wiki", "https://en.wikipedia.org/wiki/Foo_(bar)"), plain(".")), text.content)
    }

    @Test fun `happy links titled button are lifted under their paragraph in order`() {
        for (quoted in listOf("\"button\"", "'button'", "(button)")) {
            val blocks = parseMarkdown("Add your tokens: [Providers](happy://settings/providers $quoted) or [MCP](<happy://settings/mcp> \"button\")\nNext line")
            assertEquals(
                quoted,
                listOf(
                    MarkdownBlock.Text(listOf(plain("Add your tokens: "), plain("or"))),
                    MarkdownBlock.Buttons(listOf(button("Providers", "happy://settings/providers"), button("MCP", "happy://settings/mcp"))),
                    MarkdownBlock.Text(listOf(plain("Next line"))),
                ),
                blocks,
            )
        }
    }

    @Test fun `words either side of lifted buttons keep one space`() {
        assertEquals(
            listOf(
                MarkdownBlock.Text(listOf(plain("Next: "), plain("or read "), plain("Voice", "happy://settings/voice"), plain("."))),
                MarkdownBlock.Buttons(listOf(button("Providers", "happy://settings/providers"), button("Roles", "happy://settings/roles"))),
            ),
            parseMarkdown("Next: [Providers](happy://settings/providers \"button\") [Roles](happy://settings/roles \"button\") or read [Voice](happy://settings/voice)."),
        )
    }

    @Test fun `a paragraph that is only a button leaves only the button`() {
        assertEquals(
            listOf(MarkdownBlock.Buttons(listOf(button("Q3", "happy://artifacts/r7k2m9q4w1e5t8y3u6i0o2p5")))),
            parseMarkdown("[Q3](happy://artifacts/r7k2m9q4w1e5t8y3u6i0o2p5 \"button\")"),
        )
    }

    @Test fun `buttons in a list follow the list`() {
        val blocks = parseMarkdown("- Set up [Providers](happy://settings/providers \"button\")\n- Done")
        assertEquals(
            listOf(
                MarkdownBlock.BulletList(listOf(MarkdownBlock.ListItem(0, listOf(plain("Set up"))), MarkdownBlock.ListItem(0, listOf(plain("Done"))))),
                MarkdownBlock.Buttons(listOf(button("Providers", "happy://settings/providers"))),
            ),
            blocks,
        )
    }

    @Test fun `any other title, or a web link, is an ordinary link`() {
        val text = parseMarkdown("[a](happy://settings/usage \"Button\") [b](https://example.com \"button\") [c](happy://settings/usage \"button \")").single() as MarkdownBlock.Text
        assertEquals(
            listOf(plain("a", "happy://settings/usage"), plain(" "), plain("b", "https://example.com"), plain(" "), plain("c", "happy://settings/usage")),
            text.content,
        )
    }

    @Test fun `malformed or blank settings links and malformed buttons are inert words`() {
        val text = parseMarkdown("[Billing](happy://settings/billing) [ ](happy://settings/usage \"button\") [Gone](happy://artifacts/ \"button\") [Old](happy://projects/x/settings)").single() as MarkdownBlock.Text
        assertEquals(
            listOf(plain("Billing"), plain(" "), plain(" "), plain(" "), plain("Gone"), plain(" "), plain("Old", "happy://projects/x/settings")),
            text.content,
        )
    }
}

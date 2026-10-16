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
}

package com.slopus.happy.artifacts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** iOS's `ArtifactMarkdownTests`, case for case: the same addresses resolve the same way. */
class ArtifactMarkdownTest {
    private fun file(path: String, fragment: String? = null) = ArtifactReference.File(path, fragment)
    private fun resolve(raw: String, document: String) = ArtifactMarkdown.resolve(raw, document)

    @Test fun relativePathsResolveAgainstTheDocumentsFolder() {
        assertEquals(file("images/chart.png"), resolve("images/chart.png", "index.md"))
        assertEquals(file("docs/chart.png"), resolve("chart.png", "docs/guide.md"))
        assertEquals(file("docs/deep/a/b/c.png"), resolve("a/b/c.png", "docs/deep/guide.md"))
    }

    @Test fun dotSegments() {
        assertEquals(file("images/a.png"), resolve("./images/a.png", "index.md"))
        assertEquals(file("shared/a.png"), resolve("../shared/a.png", "docs/guide.md"))
        assertEquals(file("docs/y/a.png"), resolve("./x/../y/./a.png", "docs/guide.md"))
        assertEquals(file("a.png"), resolve("../../a.png", "docs/deep/guide.md"))
    }

    @Test fun rootRelativeStaysInTheVersion() {
        assertEquals(file("images/a.png"), resolve("/images/a.png", "docs/guide.md"))
    }

    @Test fun pathsThatEscapeAreRefused() {
        val refused = listOf(
            "../a.png" to "index.md",
            "../../a.png" to "docs/guide.md",
            "a/../../b.png" to "index.md",
            "/../a.png" to "index.md",
            "%2E%2E/a.png" to "index.md",
            // An encoded separator or backslash names nothing the daemon holds.
            "..%2Fa.png" to "docs/guide.md",
            "images%2Fa.png" to "index.md",
            "images%5Ca.png" to "index.md",
            "a%00.png" to "index.md",
            "bad%zz.png" to "index.md",
            "images/" to "index.md",
            "" to "index.md",
            "." to "index.md",
            "javascript:alert(1)" to "index.md",
            "file:///etc/passwd" to "index.md",
        )
        for ((raw, document) in refused) assertEquals(raw, ArtifactReference.Refused, resolve(raw, document))
    }

    @Test fun percentEncoding() {
        assertEquals(file("images/my chart.png"), resolve("images/my%20chart.png", "index.md"))
        assertEquals(file("café.png"), resolve("caf%C3%A9.png", "index.md"))
        assertEquals(file("images/my chart.png"), resolve("<images/my chart.png>", "index.md"))
        assertEquals(file("chart(1).png"), resolve("chart%281%29.png", "index.md"))
    }

    @Test fun anchorsAndQueries() {
        assertEquals(file("guide.md", "setup"), resolve("guide.md#setup", "index.md"))
        assertEquals(file("a.png"), resolve("a.png?v=2", "index.md"))
        assertEquals(file("a.png", "x"), resolve("a.png?v=2#x", "index.md"))
        assertEquals(ArtifactReference.Fragment("results"), resolve("#results", "index.md"))
        assertEquals(ArtifactReference.Fragment("café"), resolve("#caf%C3%A9", "index.md"))
    }

    @Test fun titlesAreNotPartOfTheAddress() {
        assertEquals(file("a.png"), resolve("a.png \"A chart\"", "index.md"))
    }

    @Test fun otherSchemes() {
        assertEquals(ArtifactReference.Web("https://cdn.example.com/a.png"), resolve("https://cdn.example.com/a.png", "index.md"))
        assertEquals(ArtifactReference.Web("HTTP://cdn.example.com/a.png"), resolve("HTTP://cdn.example.com/a.png", "index.md"))
        assertEquals(ArtifactReference.Web("https://cdn.example.com/a.png"), resolve("//cdn.example.com/a.png", "index.md"))
        assertEquals(ArtifactReference.Data("data:image/png;base64,AAAA"), resolve("data:image/png;base64,AAAA", "index.md"))
        assertEquals(ArtifactReference.External("mailto:a@example.com"), resolve("mailto:a@example.com", "index.md"))
        assertEquals(ArtifactReference.Refused, resolve("https:///nohost", "index.md"))
        // A one-letter "scheme" is a path, as a drive letter would be.
        assertEquals(file("c:chart.png"), resolve("c:chart.png", "index.md"))
    }

    @Test fun prepareMovesInlinePicturesOntoTheirOwnLines() {
        val prepared = ArtifactMarkdown.prepare("Before ![one](a.png) middle ![two](b.png) after\n\n![three](c.png)")
        assertEquals("Before\n![one](a.png)\nmiddle\n![two](b.png)\nafter\n\n![three](c.png)", prepared)
        assertEquals(listOf("a.png", "b.png", "c.png"), ArtifactMarkdown.pictures(prepared))
    }

    @Test fun prepareReadsHtmlPictures() {
        val prepared = ArtifactMarkdown.prepare(
            "<p align=\"center\"><img src=\"images/logo.png\" alt=\"Logo\" width=\"200\"></p>\n" +
                "<video controls src='clip.mp4'></video>\n<source src=\"b.webm\" type=\"video/webm\">",
        )
        assertEquals(listOf("<images/logo.png>", "<clip.mp4>", "<b.webm>"), ArtifactMarkdown.pictures(prepared))
        assertTrue(prepared.contains("![Logo](<images/logo.png>)"))
        assertFalse(prepared.contains("<p"))
    }

    @Test fun prepareJoinsSoftBreaksAndKeepsCode() {
        val prepared = ArtifactMarkdown.prepare("one\ntwo ![x](a.png)\n\n```\n![not](code.png)\n```\nuse `![y](b.png)` here")
        assertEquals("one two\n![x](a.png)\n\n```\n![not](code.png)\n```\nuse `![y](b.png)` here", prepared)
        assertEquals(listOf("a.png"), ArtifactMarkdown.pictures(prepared))
    }

    @Test fun prepareLinkedPictureAndParentheses() {
        val prepared = ArtifactMarkdown.prepare("[![badge](b.svg)](https://example.com) and ![p](chart(1).png)")
        assertEquals(listOf("b.svg", "chart%281%29.png"), ArtifactMarkdown.pictures(prepared))
        assertEquals(file("chart(1).png"), resolve("chart%281%29.png", "index.md"))
    }

    @Test fun prepareLeavesTablesAlone() {
        val table = "| a | ![x](a.png) |\n| --- | --- |"
        assertEquals(table, ArtifactMarkdown.prepare(table))
    }

    @Test fun prepareLeavesFrontmatterAsWritten() {
        val front = "---\nname: x\ninput:\n  icon: ![a](a.png)\n  html: <img src=\"b.png\">\n---"
        val prepared = ArtifactMarkdown.prepare(front + "\none\ntwo ![x](c.png)")
        assertEquals(front + "\none two\n![x](c.png)", prepared)
        assertEquals(listOf("c.png"), ArtifactMarkdown.pictures(prepared))
        assertEquals(
            com.slopus.happy.chat.markdown.MarkdownBlock.CodeBlock("yaml", "name: x\ninput:\n  icon: ![a](a.png)\n  html: <img src=\"b.png\">"),
            com.slopus.happy.chat.markdown.parseMarkdownDocument(prepared).first(),
        )
    }

    @Test fun prepareJoinsAnUnclosedFrontmatterAsBefore() {
        assertEquals("---\none two", ArtifactMarkdown.prepare("---\none\ntwo"))
    }

    @Test fun prepareKeepsFrontmatterWithCrlf() {
        val prepared = ArtifactMarkdown.prepare("---\r\nname: x\r\nkind: y\r\n---\r\none\r\ntwo")
        assertEquals(
            listOf(
                com.slopus.happy.chat.markdown.MarkdownBlock.CodeBlock("yaml", "name: x\nkind: y"),
                com.slopus.happy.chat.markdown.MarkdownBlock.Text(listOf(com.slopus.happy.chat.markdown.MarkdownSpan(emptySet(), "one two"))),
            ),
            com.slopus.happy.chat.markdown.parseMarkdownDocument(prepared),
        )
    }
}

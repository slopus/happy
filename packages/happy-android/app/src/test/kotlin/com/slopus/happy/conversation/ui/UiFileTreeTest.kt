package com.slopus.happy.conversation.ui

import com.slopus.happy.conversation.ui.UiFileTree.Line
import org.junit.Assert.assertEquals
import org.junit.Test

class UiFileTreeTest {
    @Test fun `paths are lines under their folders, each folder once, in the order first named`() {
        assertEquals(
            listOf(
                Line("src", 0, true),
                Line("app", 1, true),
                Line("main.ts", 2, false),
                Line("util.ts", 2, false),
                Line("index.ts", 1, false),
                Line("README.md", 0, false),
            ),
            UiFileTree.lines(listOf("src/app/main.ts", "README.md", "src/index.ts", "src/app/util.ts")),
        )
    }

    @Test fun `a path that ends in a slash is a folder, and a leading or doubled slash names nothing`() {
        assertEquals(
            listOf(Line("docs", 0, true), Line("empty", 1, true), Line("etc", 0, true), Line("hosts", 1, false)),
            UiFileTree.lines(listOf("docs/empty/", "/etc//hosts")),
        )
    }

    @Test fun `a folder and a file of one name are two lines, and a path named twice is one`() {
        assertEquals(
            listOf(Line("build", 0, false), Line("build", 0, true), Line("out.js", 1, false)),
            UiFileTree.lines(listOf("build", "build/out.js", "build")),
        )
    }
}

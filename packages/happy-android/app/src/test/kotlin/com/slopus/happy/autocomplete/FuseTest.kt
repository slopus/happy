package com.slopus.happy.autocomplete

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Fuse port against Fuse.js 7.1.0 itself: the expected (index, score)
 * lists were produced by running fuse.js with happy-app's options from
 * suggestionCommands.ts and suggestionFile.ts on the same corpora.
 */
class FuseTest {
    private val commands = listOf(
        CommandItem("compact", "Compact the conversation history"),
        CommandItem("clear", "Clear the conversation"),
        CommandItem("goal", "Set a session goal"),
        CommandItem("mcp", "Show connected MCP servers"),
        CommandItem("skills", "Show available skills"),
        CommandItem("reset", "Reset the session"),
        CommandItem("debug", "Show debug information"),
        CommandItem("context", null),
        CommandItem("add-memory", null),
        CommandItem("release", null),
        CommandItem("agent-browser", null),
        CommandItem("control-flow", null),
        CommandItem("office-hours", null),
        CommandItem("typescript-best-practices", null),
    )

    private val paths = listOf(
        "README.md",
        "package.json",
        "src/index.ts",
        "src/main.kt",
        "src/ui/ChatComposer.kt",
        "src/ui/MarkdownView.kt",
        "src/ui/components/Avatar.kt",
        "src/sync/SessionOps.kt",
        "docs/getting-started.md",
        "docs/Release Notes.md",
        "app/build.gradle.kts",
        "app/src/main/AndroidManifest.xml",
        "scripts/release.mjs",
        ".github/workflows/ci.yml",
        "packages/happy-android/app/src/main/kotlin/com/slopus/happy/autocomplete/Fuse.kt",
    )

    private val commandFuse = Fuse(
        commands,
        listOf(FuseKey(0.7) { it.command }, FuseKey(0.3) { it.description }),
        threshold = 0.3,
        ignoreLocation = true,
        useExtendedSearch = true,
    )

    private val files = FileSearchCache.fileItems(paths)

    private val fileFuse = Fuse(
        files,
        listOf(FuseKey(0.7) { it.fileName }, FuseKey(0.3) { it.fullPath }),
        threshold = 0.3,
        ignoreLocation = true,
        useExtendedSearch = true,
    )

    private val commandResults: Map<String, List<Pair<Int, Double>>> = mapOf(
        "c" to listOf(1 to 0.0024027024985383335, 0 to 0.002818382931264455, 3 to 0.002818382931264455, 7 to 0.007943282347242817, 11 to 0.007943282347242817, 12 to 0.007943282347242817, 13 to 0.007943282347242817),
        "co" to listOf(0 to 0.002818382931264455, 7 to 0.007943282347242817, 11 to 0.007943282347242817, 1 to 0.3024823232391245, 3 to 0.35481338923357547),
        "comp" to listOf(0 to 0.002818382931264455),
        "cmpact" to listOf(0 to 0.21805770511811934),
        "clr" to listOf(),
        "sk" to listOf(4 to 0.0024027024985383335),
        "rev" to listOf(),
        "^c" to listOf(1 to 2.1521719206327232e-14, 0 to 4.948507030895403e-14, 7 to 1.1028289493045307e-11, 11 to 1.1028289493045307e-11),
        "=goal" to listOf(2 to 1.1028289493045307e-11),
        "'ear" to listOf(1 to 2.1521719206327232e-14),
        "act\$" to listOf(0 to 1.1028289493045307e-11),
        "!c" to listOf(4 to 2.1521719206327232e-14, 5 to 2.1521719206327232e-14, 6 to 2.1521719206327232e-14, 2 to 4.948507030895403e-14, 8 to 1.1028289493045307e-11, 9 to 1.1028289493045307e-11, 10 to 1.1028289493045307e-11),
        "co | sk" to listOf(4 to 0.0024027024985383335, 0 to 0.002818382931264455, 7 to 0.007943282347242817, 11 to 0.007943282347242817, 1 to 0.3024823232391245, 3 to 0.35481338923357547),
        "mcp servers" to listOf(3 to 0.35481338923357547),
        "goal set" to listOf(2 to 0.35481338923357547),
        "xyz" to listOf(),
        "session" to listOf(5 to 0.3024823232391245, 2 to 0.35481338923357547),
        "SHOW" to listOf(4 to 0.3024823232391245, 6 to 0.3024823232391245, 3 to 0.35481338923357547),
        "brwser" to listOf(10 to 0.2852949765682842),
        "best practices" to listOf(13 to 0.007943282347242817),
        "\"show av\"" to listOf(4 to 0.3024823232391245, 6 to 0.805048085468305, 3 to 0.8286856021693197),
        "typescript-best-practices-and-more-than-32" to listOf(13 to 0.7069997221664089),
    )

    private val fileResults: Map<String, List<Pair<Int, Double>>> = mapOf(
        "main" to listOf(3 to 0.0010000000000000002, 22 to 0.0010000000000000002, 30 to 0.0010000000000000002, 11 to 0.04770435256643361, 14 to 0.12589254117941673, 31 to 0.12589254117941673, 32 to 0.12589254117941673, 33 to 0.12589254117941673, 34 to 0.12589254117941673, 35 to 0.12589254117941673),
        "mn" to listOf(),
        "readme" to listOf(0 to 0.0010000000000000002),
        "src/comp" to listOf(),
        ".kt\$" to listOf(3 to 2.2204460492503175e-16, 4 to 2.2204460492503175e-16, 5 to 2.2204460492503175e-16, 6 to 2.2204460492503175e-16, 7 to 2.2204460492503175e-16, 14 to 2.2204460492503175e-16),
        "^src" to listOf(15 to 2.2204460492503175e-16, 21 to 1.1028289493045307e-11, 29 to 1.1028289493045307e-11, 2 to 2.0134092876783674e-05, 3 to 2.0134092876783674e-05, 4 to 2.0134092876783674e-05, 5 to 2.0134092876783674e-05, 6 to 2.0134092876783674e-05, 7 to 2.0134092876783674e-05, 16 to 2.0134092876783674e-05, 17 to 2.0134092876783674e-05, 18 to 2.0134092876783674e-05),
        "markdwn" to listOf(5 to 0.14285714285714288),
        "ChatComposer" to listOf(4 to 0.0010000000000000002),
        "chat comp" to listOf(4 to 0.0010000000000000002),
        "release" to listOf(12 to 0.0010000000000000002, 9 to 0.007568328950209748),
        "ui/" to listOf(16 to 1.3883793891417352e-12, 4 to 0.12589254117941673, 5 to 0.12589254117941673, 6 to 0.12589254117941673, 17 to 0.12589254117941673),
        "gradle" to listOf(10 to 0.0010000000000000002),
        "!src" to listOf(0 to 2.2204460492503175e-16, 1 to 2.2204460492503175e-16, 8 to 2.2204460492503175e-16, 10 to 2.2204460492503175e-16, 12 to 2.2204460492503175e-16, 13 to 2.2204460492503175e-16, 19 to 2.2204460492503175e-16, 20 to 2.2204460492503175e-16, 23 to 2.2204460492503175e-16, 24 to 2.2204460492503175e-16, 25 to 2.2204460492503175e-16, 26 to 2.2204460492503175e-16, 27 to 2.2204460492503175e-16, 28 to 2.2204460492503175e-16, 9 to 8.569061098350972e-12, 2 to 1.1028289493045307e-11, 3 to 1.1028289493045307e-11, 4 to 1.1028289493045307e-11, 5 to 1.1028289493045307e-11, 6 to 1.1028289493045307e-11, 7 to 1.1028289493045307e-11, 11 to 1.1028289493045307e-11, 14 to 1.1028289493045307e-11, 16 to 1.1028289493045307e-11, 17 to 1.1028289493045307e-11, 18 to 1.1028289493045307e-11, 22 to 1.1028289493045307e-11, 30 to 1.1028289493045307e-11, 31 to 1.1028289493045307e-11, 32 to 1.1028289493045307e-11, 33 to 1.1028289493045307e-11, 34 to 1.1028289493045307e-11, 35 to 1.1028289493045307e-11),
        "notes" to listOf(9 to 0.007568328950209748),
        "packages/happy-android/app/src/main/kotlin/com" to listOf(14 to 0.12589254117941673, 32 to 0.12589254117941673, 33 to 0.12589254117941673, 34 to 0.12589254117941673, 35 to 0.12589254117941673, 31 to 0.4005574068977475, 30 to 0.8124959868369371, 29 to 0.8197854194488267, 28 to 0.848411457784675, 27 to 0.8749458283513891),
        "zzz" to listOf(),
        "a" to listOf(0 to 0.0010000000000000002, 1 to 0.0010000000000000002, 3 to 0.0010000000000000002, 4 to 0.0010000000000000002, 5 to 0.0010000000000000002, 6 to 0.0010000000000000002, 8 to 0.0010000000000000002, 10 to 0.0010000000000000002, 11 to 0.0010000000000000002, 12 to 0.0010000000000000002, 20 to 0.0010000000000000002, 22 to 0.0010000000000000002, 26 to 0.0010000000000000002, 27 to 0.0010000000000000002, 28 to 0.0010000000000000002, 30 to 0.0010000000000000002, 34 to 0.0010000000000000002, 35 to 0.0010000000000000002, 9 to 0.007568328950209748, 14 to 0.12589254117941673, 21 to 0.12589254117941673, 29 to 0.12589254117941673, 31 to 0.12589254117941673, 32 to 0.12589254117941673, 33 to 0.12589254117941673),
    )

    @Test
    fun filesThenFoldersInFirstSeenOrder() {
        assertEquals(
            listOf(
                "README.md",
                "package.json",
                "src/index.ts",
                "src/main.kt",
                "src/ui/ChatComposer.kt",
                "src/ui/MarkdownView.kt",
                "src/ui/components/Avatar.kt",
                "src/sync/SessionOps.kt",
                "docs/getting-started.md",
                "docs/Release Notes.md",
                "app/build.gradle.kts",
                "app/src/main/AndroidManifest.xml",
                "scripts/release.mjs",
                ".github/workflows/ci.yml",
                "packages/happy-android/app/src/main/kotlin/com/slopus/happy/autocomplete/Fuse.kt",
                "src/",
                "src/ui/",
                "src/ui/components/",
                "src/sync/",
                "docs/",
                "app/",
                "app/src/",
                "app/src/main/",
                "scripts/",
                ".github/",
                ".github/workflows/",
                "packages/",
                "packages/happy-android/",
                "packages/happy-android/app/",
                "packages/happy-android/app/src/",
                "packages/happy-android/app/src/main/",
                "packages/happy-android/app/src/main/kotlin/",
                "packages/happy-android/app/src/main/kotlin/com/",
                "packages/happy-android/app/src/main/kotlin/com/slopus/",
                "packages/happy-android/app/src/main/kotlin/com/slopus/happy/",
                "packages/happy-android/app/src/main/kotlin/com/slopus/happy/autocomplete/",
            ),
            files.map { it.fullPath },
        )
    }

    @Test
    fun commandRankingMatchesFuseJs() = check(commandFuse, commandResults)

    @Test
    fun fileRankingMatchesFuseJs() = check(fileFuse, fileResults)

    private fun <T> check(fuse: Fuse<T>, expected: Map<String, List<Pair<Int, Double>>>) {
        for ((query, results) in expected) {
            val actual = fuse.search(query, 50)
            assertEquals("order for '$query'", results.map { it.first }, actual.map { it.index })
            results.zip(actual).forEach { (want, got) ->
                assertEquals("score of ${want.first} for '$query'", want.second, got.score, want.second * 1e-9)
            }
        }
    }
}

package com.slopus.happy.artifacts

import kotlinx.coroutines.CancellationException

/**
 * Where an app's close button sits (`<meta name="happy-app-close">`, the
 * spec's addendum): a corner in logical start and end, so right to left
 * flips it, or [None], no button (the page draws its own exit and calls
 * `happyApp.close()`; back and a swipe down from the top still leave).
 */
enum class AppClose(val value: String, val top: Boolean, val start: Boolean) {
    TopStart("top-start", true, true),
    TopEnd("top-end", true, false),
    BottomStart("bottom-start", false, true),
    BottomEnd("bottom-end", false, false),
    None("none", true, true);

    companion object {
        /** [value] as declared; anything else, or nothing, is [TopStart]. */
        fun of(value: String?): AppClose = entries.firstOrNull { it.value.equals(value?.trim(), ignoreCase = true) } ?: TopStart
    }
}

/**
 * How an HTML artifact's page asks to be shown (happy-agent's docs/DESIGN.md §1.8): a normal scrolling page, or, with
 *
 *     <meta name="happy-page-mode" content="app">
 *
 * in its `<head>`, an app: full screen, never scrolling, edge to edge,
 * with the host's close. Any other value, or no tag, is a page. App
 * implies `happy-page-width: full`, which Android already is: it centres
 * no page on a measure.
 *
 * Read from the entry's first [HEAD_BYTES] before any WebView is made, so
 * the presentation is decided before anything paints and nothing jumps.
 */
object ArtifactPageMode {
    /** How much of the entry is read for its `<head>`: far more than any head's metas sit in. */
    const val HEAD_BYTES = 64 * 1024

    private val COMMENT = Regex("<!--.*?(-->|$)", RegexOption.DOT_MATCHES_ALL)
    private val RAW_TEXT = Regex("<(script|style|template|textarea|title)\\b[^>]*>.*?(</\\1\\s*>|$)", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
    private val META = Regex("<meta\\b([^>]*)>", RegexOption.IGNORE_CASE)
    private val ATTRIBUTE = Regex("([^\\s\"'>/=]+)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?")

    /**
     * Where [html], an entry's start, puts its close button if it declares
     * `happy-page-mode: app` (as desktop's selector matches it, ASCII
     * case-insensitive); null for a page. The first of each meta counts.
     */
    fun read(html: String): AppClose? {
        val markup = html.replace(COMMENT, "").replace(RAW_TEXT, "")
        val metas = META.findAll(markup).map { meta ->
            ATTRIBUTE.findAll(meta.groupValues[1]).associate { match ->
                match.groupValues[1].lowercase() to (match.groups[2] ?: match.groups[3] ?: match.groups[4])?.value.orEmpty()
            }
        }.toList()
        fun content(name: String) = metas.firstOrNull { it["name"].equals(name, ignoreCase = true) && "content" in it }?.get("content")
        if (!content("happy-page-mode").equals("app", ignoreCase = true)) return null
        return AppClose.of(content("happy-app-close"))
    }

    /** Whether [html] declares `happy-page-mode: app`. */
    fun declaresApp(html: String): Boolean = read(html) != null

    /** Where [path] of [artifactId]'s [version] puts its close button if it is an app; null for a page, or a file that can't be read. */
    suspend fun of(files: ArtifactClient, artifactId: String, version: Int, path: String): AppClose? = try {
        val response = files.file(artifactId, version, path, "bytes=0-${HEAD_BYTES - 1}")
        // A server that ignores the range answers with the whole file.
        if (response.status in 200..299) read(String(response.body, 0, minOf(response.body.size, HEAD_BYTES), Charsets.UTF_8)) else null
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }
}

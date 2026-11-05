package com.slopus.happy.artifacts

import kotlinx.coroutines.CancellationException

/**
 * How an HTML artifact's page asks to be shown (task_206's
 * fullscreen-spec.md): a normal scrolling page, or, with
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

    /** Whether [html], an entry's start, declares `happy-page-mode: app`, as desktop's selector matches it (both ASCII case-insensitive). */
    fun declaresApp(html: String): Boolean {
        val markup = html.replace(COMMENT, "").replace(RAW_TEXT, "")
        return META.findAll(markup).any { meta ->
            val attributes = ATTRIBUTE.findAll(meta.groupValues[1]).associate { match ->
                match.groupValues[1].lowercase() to (match.groups[2] ?: match.groups[3] ?: match.groups[4])?.value.orEmpty()
            }
            attributes["name"].equals("happy-page-mode", ignoreCase = true) && attributes["content"].equals("app", ignoreCase = true)
        }
    }

    /** Whether [path] of [artifactId]'s [version] asks to be an app; a file that can't be read is a page. */
    suspend fun of(files: ArtifactClient, artifactId: String, version: Int, path: String): Boolean = try {
        val response = files.file(artifactId, version, path, "bytes=0-${HEAD_BYTES - 1}")
        // A server that ignores the range answers with the whole file.
        response.status in 200..299 && declaresApp(String(response.body, 0, minOf(response.body.size, HEAD_BYTES), Charsets.UTF_8))
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        false
    }
}

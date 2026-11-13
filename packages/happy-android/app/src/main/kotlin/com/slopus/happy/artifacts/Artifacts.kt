package com.slopus.happy.artifacts

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.genui.GEN_UI_RENDER_PATH
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * An artifact as something names it (iOS's `Artifact`): a catalog row, a
 * tool call's card, a reference in a message. [followsLatest] opens the
 * newest version; otherwise exactly [version].
 */
@Immutable
@Serializable
data class ArtifactRef(
    val id: String,
    val version: Int,
    val type: String,
    val title: String,
    val followsLatest: Boolean,
    /** A reference named this version: it opens that one, never the latest. */
    val pinned: Boolean = false,
) {
    /** Desktop's card follows the artifact from the call that created it, whose files are written after it. */
    val opensLatest: Boolean get() = followsLatest || (version == 1 && !pinned)

    companion object {
        /** A tool call's `artifact` presentation: `shows: "latest"` follows it, else it is exactly `version`. */
        fun presented(id: String, version: Int?, type: String?, title: String?, shows: String?) =
            ArtifactRef(id, version ?: 1, type ?: "unknown", title.orEmpty(), followsLatest = shows == "latest")
    }
}

/**
 * One file of an artifact version, as its manifest lists it. A picture or
 * recording may carry its ThumbHash and whether the computer keeps a still
 * [preview] of it (API.md "Media metadata and previews"); older daemons
 * send neither.
 */
@Immutable
data class ArtifactFile(val path: String, val mimeType: String, val size: Long, val thumbhash: String? = null, val preview: Boolean = false) {
    val name: String get() = path.substringAfterLast('/')
    val isVideo: Boolean get() = mimeType.startsWith("video/")
    /** A picture or a recording: shown natively, in the gallery and the viewer. */
    val isVisual: Boolean get() = mimeType.startsWith("image/") || isVideo
    val isMarkdown: Boolean get() {
        val ext = path.substringAfterLast('.', "").lowercase()
        return mimeType.startsWith("text/markdown") || ext == "md" || ext == "markdown"
    }

    /**
     * What Android's WebView draws itself: pages, text and SVG. A PDF or an
     * office file it would only download, so those open in another app.
     */
    val isWebPage: Boolean get() {
        val type = mimeType.substringBefore(';').trim().lowercase()
        val ext = path.substringAfterLast('.', "").lowercase()
        return type.startsWith("text/") || type == "application/xhtml+xml" || type == "image/svg+xml" ||
            type == "application/json" || ext in setOf("html", "htm", "xhtml", "svg", "txt", "json", "css", "js")
    }

    companion object {
        fun parse(value: JsonElement?): ArtifactFile? {
            val o = value.obj ?: return null
            return ArtifactFile(
                path = o["path"].str ?: return null,
                mimeType = o["mimeType"].str ?: "application/octet-stream",
                size = o["size"].num?.toLong() ?: 0,
                thumbhash = o["thumbhash"].str,
                preview = o["preview"].obj != null,
            )
        }
    }
}

/**
 * The picture the Feed shows for an artifact's version (API.md "Covers"):
 * one of its files, in one of the standard shapes, so a post knows its
 * height before the picture is read. Older daemons send none.
 */
@Immutable
data class ArtifactCover(
    val path: String,
    val mimeType: String,
    val aspect: Aspect,
    /** Its placeholder until the picture lands; null when the computer couldn't make one, or an older one. */
    val thumbhash: String? = null,
    /** The computer keeps a still preview of it (`preview: { width, height }`), which a list's slot reads instead of the file. */
    val preview: Boolean = false,
) {
    /** The shapes a cover comes in: 16:9 or 1:1, width over height. */
    enum class Aspect(val wire: String, val ratio: Float) {
        Wide("wide", 16f / 9f),
        Square("square", 1f),
    }

    /** A picture this phone decodes: anything else (the daemon sends none) keeps the row. */
    val drawable: Boolean get() = mimeType.substringBefore(';').trim().lowercase() in DECODED

    companion object {
        private val DECODED = setOf("image/png", "image/jpeg", "image/webp", "image/gif")

        /**
         * The wire's `cover`; null for `null` or an absent one, and for an
         * `aspect` this phone doesn't know (a newer shape, or an older daemon's
         * cover without one), which keeps the row.
         */
        fun parse(value: JsonElement?): ArtifactCover? {
            val o = value.obj ?: return null
            val path = o["path"].str?.takeIf { it.isNotEmpty() } ?: return null
            val aspect = o["aspect"].str.let { wire -> Aspect.entries.firstOrNull { it.wire == wire } } ?: return null
            return ArtifactCover(path, o["mimeType"].str.orEmpty(), aspect, o["thumbhash"].str, o["preview"].obj != null)
        }

        /** The most of a summary shown (the daemon's own limit). */
        const val SUMMARY_MAX = 5000

        /** The wire's `summary`: post-length text with its line breaks, or null for none. */
        fun summary(value: JsonElement?): String? =
            value.str?.replace("\r\n", "\n")?.trim()?.take(SUMMARY_MAX)?.takeIf { it.isNotEmpty() }

        private val BACKGROUND = Regex("^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")

        /** The wire's `background` (API.md "Backgrounds"): `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` in lower case, and nothing else. */
        fun background(value: JsonElement?): String? = value.str?.takeIf { BACKGROUND.matches(it) }?.lowercase()
    }
}

/**
 * One version of an artifact (`GET /v0/artifacts/:id/versions/:n`): its
 * entry, its files and, for an older page, the URL it runs at.
 */
@Immutable
data class ArtifactVersion(
    val artifactId: String,
    val number: Int,
    val title: String,
    val entry: ArtifactFile?,
    val files: List<ArtifactFile>,
    val liveUrl: String? = null,
    /** Its label, `major.minor` where the computer gives one (API.md "Versions"), else its number. */
    val label: String = number.toString(),
    /** When it was made; 0 where unknown. */
    val createdAt: Long = 0,
    /** Made by an agent rather than a person. */
    val byAgent: Boolean = false,
    /** The agent that made it (`createdBy` `{ kind: "agent" }`): a Gen UI version's origin. */
    val origin: String? = null,
) {
    fun file(path: String): ArtifactFile? = files.firstOrNull { it.path == path } ?: entry?.takeIf { it.path == path }

    companion object {
        private fun label(version: JsonObject): String {
            val major = version["major"].num?.toInt()
            val minor = version["minor"].num?.toInt()
            return if (major != null && minor != null) "$major.$minor" else version["number"].num?.toInt().toString()
        }

        fun parse(version: JsonObject?): ArtifactVersion? {
            version ?: return null
            val files = version["files"].arr.orEmpty().mapNotNull(ArtifactFile::parse)
            // API.md: the entry is a file object. One without its type is looked up in the manifest,
            // and bad metadata never opens another file by implication.
            val declared = version["entry"].obj
            val entry = declared?.takeIf { it["mimeType"].str != null }?.let(ArtifactFile::parse)
                ?: declared?.get("path").str?.let { path -> files.firstOrNull { it.path == path } }
            return ArtifactVersion(
                artifactId = version["artifactId"].str ?: "",
                number = version["number"].num?.toInt() ?: return null,
                title = version["title"].str.orEmpty(),
                entry = entry,
                files = files,
                liveUrl = version["live"].obj?.get("url").str,
                label = label(version),
                createdAt = version["createdAt"].num?.toLong() ?: 0,
                byAgent = version["createdBy"].obj?.get("kind").str == "agent",
                origin = version["createdBy"].obj?.takeIf { it["kind"].str == "agent" }?.get("agentId").str,
            )
        }
    }
}

/**
 * What one artifact screen shows, decided from the version alone (iOS's
 * `ArtifactViewController.load`): a page at its live URL; a Markdown
 * document; the version's pictures and recordings, or the one a link
 * opened; any other page in the browser; a file the WebView can't draw
 * handed to another app; or nothing, when the file isn't in the version.
 */
sealed interface ArtifactShow {
    data class Live(val url: String) : ArtifactShow
    data class Document(val file: ArtifactFile) : ArtifactShow
    data class Gallery(val files: List<ArtifactFile>) : ArtifactShow
    data class Page(val file: ArtifactFile) : ArtifactShow
    data class Openable(val file: ArtifactFile) : ArtifactShow
    /** A `gen_ui` version, drawn natively from the render document the computer compiled, never from its entry. */
    data class GenUi(val render: ArtifactFile) : ArtifactShow
    data object Unavailable : ArtifactShow

    companion object {
        /** [path] is the file a link opened; null for the entry. [type] is the artifact's. */
        fun of(version: ArtifactVersion, path: String? = null, type: String = ""): ArtifactShow {
            if (path == null) version.liveUrl?.let { return Live(it) }
            if (path == null && type == "gen_ui") return version.file(GEN_UI_RENDER_PATH)?.let(::GenUi) ?: Unavailable
            val entry = version.entry ?: return Unavailable
            val wanted = path ?: entry.path
            val file = version.files.firstOrNull { it.path == wanted } ?: entry.takeIf { wanted == it.path } ?: return Unavailable
            return when {
                file.isMarkdown -> Document(file)
                file.isVisual -> {
                    // An image series is all of its pictures and recordings, in the manifest's order.
                    val shown = if (file == entry) version.files.filter { it.isVisual } else listOf(file)
                    Gallery(shown.ifEmpty { listOf(file) })
                }
                file.isWebPage -> Page(file)
                else -> Openable(file)
            }
        }
    }
}

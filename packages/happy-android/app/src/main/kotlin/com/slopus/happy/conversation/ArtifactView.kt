package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonObject

/** One file of an artifact version, as its manifest lists it. */
@Immutable
data class ArtifactFile(val path: String, val mimeType: String, val size: Long)

/**
 * What this phone can make of an artifact: what it shows, or honestly that
 * it doesn't show this kind. Markdown and plain text are read here, one
 * picture or a series is shown here, a video or document is opened by
 * whatever on the phone reads it. An artifact that is a page, a sidebar, a
 * story, or a live URL is not something this build draws, and says so.
 */
@Immutable
sealed interface ArtifactView {
    data class Words(val markdown: String) : ArtifactView
    data class Pictures(val files: List<ArtifactFile>) : ArtifactView
    data class Openable(val file: ArtifactFile) : ArtifactView
    /** [kind] is the artifact's own type, so the screen can name what it is. */
    data class NotHere(val kind: String) : ArtifactView
}

/** An artifact and the version this phone is showing. */
@Immutable
data class Artifact(
    val id: String,
    val type: String,
    val title: String,
    val version: Int,
    val entry: String?,
    val files: List<ArtifactFile>,
    val live: Boolean,
    val deleted: Boolean,
) {
    val entryFile: ArtifactFile? get() = files.firstOrNull { it.path == entry }

    /** What the screen draws, before any bytes are read. */
    fun view(): ArtifactView {
        if (live) return ArtifactView.NotHere(type)
        val entry = entryFile ?: return ArtifactView.NotHere(type)
        return when (type) {
            "markdown" -> ArtifactView.Words("")
            "image" -> ArtifactView.Pictures(listOf(entry))
            "image_series" -> ArtifactView.Pictures(files.filter { it.mimeType.startsWith("image/") })
            "video", "document" -> ArtifactView.Openable(entry)
            else -> ArtifactView.NotHere(type)
        }
    }

    companion object {
        fun isDeleted(artifact: JsonObject): Boolean =
            artifact["status"].str == "deleted" || artifact["deletedAt"].num != null

        fun parse(artifact: JsonObject, version: JsonObject): Artifact? {
            val id = artifact["id"].str ?: artifact["artifactId"].str ?: return null
            val deleted = isDeleted(artifact)
            val files = version["files"].arr.orEmpty().mapNotNull { value ->
                val file = value.obj ?: return@mapNotNull null
                ArtifactFile(
                    path = file["path"].str ?: return@mapNotNull null,
                    mimeType = file["mimeType"].str ?: "application/octet-stream",
                    size = file["size"].num?.toLong() ?: 0,
                )
            }
            val live = version["live"].obj != null
            val entry = version["entry"].obj?.get("path").str
            // API.md: entry is a file object in the manifest, never its
            // first file by implication. Bad metadata must not open another file.
            if (!deleted && !live && (entry == null || files.none { it.path == entry })) return null
            return Artifact(
                id = id,
                type = artifact["type"].str ?: "",
                title = version["title"].str ?: artifact["title"].str.orEmpty(),
                version = version["number"].num?.toInt() ?: 0,
                entry = entry,
                files = files,
                live = live,
                deleted = deleted,
            )
        }
    }
}

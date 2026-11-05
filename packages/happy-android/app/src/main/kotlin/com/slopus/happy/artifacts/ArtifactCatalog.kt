package com.slopus.happy.artifacts

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.text.Normalizer
import java.time.Instant
import java.time.ZoneId

/**
 * One artifact as the catalog lists it (`GET /v0/artifacts`, the artifact
 * object; iOS's `ArtifactSummary`): what its row shows and what opens it.
 * Kept on the phone whole, in the artifact object's own shape ([json]), so
 * the list draws from disk before the computer answers.
 */
@Immutable
data class ArtifactSummary(
    val id: String,
    /** `markdown`, `html`, `image`, `image_series`, `video` or `document`; a newer daemon's type is kept as it came. */
    val type: String,
    val title: String,
    val latestVersion: Int,
    val entry: ArtifactFile?,
    val fileCount: Int = 1,
    /** A live page reached by URL, which its entry only stands in for. */
    val live: Boolean = false,
    /** Milliseconds since 1970. */
    val createdAt: Long,
    val updatedAt: Long,
    /** The latest version's cover, summary and background, where the computer has them. */
    val cover: ArtifactCover? = null,
    val summary: String? = null,
    val background: String? = null,
) {
    /** The entry is a picture or a recording: the row shows it small. */
    val showsPicture: Boolean get() = !live && entry?.isVisual == true

    /** What the artifact screen opens: always the latest version. */
    val ref: ArtifactRef get() = ArtifactRef(id, latestVersion, type, title, followsLatest = true)

    fun json(): JsonObject = buildJsonObject {
        put("id", id)
        put("type", type)
        put("title", title)
        put("latestVersion", latestVersion)
        entry?.let { file ->
            put("entry", buildJsonObject {
                put("path", file.path)
                put("mimeType", file.mimeType)
                put("size", file.size)
                file.thumbhash?.let { put("thumbhash", it) }
                if (file.preview) put("preview", buildJsonObject {})
            })
        }
        put("fileCount", fileCount)
        put("live", live)
        put("createdAt", createdAt)
        put("updatedAt", updatedAt)
        cover?.let { c ->
            put("cover", buildJsonObject {
                put("path", c.path)
                put("mimeType", c.mimeType)
                put("aspect", c.aspect.wire)
                c.thumbhash?.let { put("thumbhash", it) }
                if (c.preview) put("preview", buildJsonObject {})
            })
        }
        summary?.let { put("summary", it) }
        background?.let { put("background", it) }
    }

    companion object {
        /** An artifact object, or one [json] kept; null for a tombstone or one that can't be read. */
        fun parse(value: JsonElement?): ArtifactSummary? {
            val o = value.obj ?: return null
            val id = o["id"].str ?: return null
            if (o["status"].str == "deleted") return null
            val createdAt = o["createdAt"].num?.toLong() ?: 0
            return ArtifactSummary(
                id = id,
                type = o["type"].str.orEmpty(),
                title = o["title"].str.orEmpty(),
                latestVersion = o["latestVersion"].num?.toInt() ?: 1,
                entry = entry(o["entry"]),
                fileCount = o["fileCount"].num?.toInt() ?: 1,
                live = isLive(o["live"]),
                createdAt = createdAt,
                updatedAt = o["updatedAt"].num?.toLong() ?: createdAt,
                cover = ArtifactCover.parse(o["cover"]),
                summary = ArtifactCover.summary(o["summary"]),
                background = ArtifactCover.background(o["background"]),
            )
        }

        /** The wire's `entry`, a file object; its type may be missing. */
        internal fun entry(value: JsonElement?): ArtifactFile? {
            val o = value.obj ?: return null
            val path = o["path"].str ?: return null
            return ArtifactFile(path, o["mimeType"].str.orEmpty(), o["size"].num?.toLong() ?: 0, o["thumbhash"].str, o["preview"].obj != null)
        }

        /** `live` is `{ url, networkId }` on the wire and `true` once kept. */
        private fun isLive(value: JsonElement?): Boolean = value.obj != null || value.bool == true
    }
}

/**
 * The catalog's rules, pure (iOS's `ArtifactCatalog`): reading pages,
 * following events, ordering and searching. [ArtifactCatalogFeed] keeps
 * the list and runs them.
 */
object ArtifactCatalog {
    /** A page of `GET /v0/artifacts`: its live artifacts and the next page's cursor. */
    fun page(answer: JsonObject): Pair<List<ArtifactSummary>, String?> =
        answer["artifacts"].arr.orEmpty().mapNotNull(ArtifactSummary::parse) to answer["nextPageCursor"].str

    /** What one event does to the list. */
    sealed interface Change {
        /** Not an artifact event, or one that changes nothing kept. */
        data object None : Change
        data class Changed(val items: List<ArtifactSummary>) : Change
        /** An update to an artifact this list doesn't hold: read it. */
        data class Read(val id: String) : Change
    }

    /**
     * `artifact.created` adds its artifact, `artifact.updated` changes the
     * fields it carries, `artifact.deleted` takes it off the list.
     */
    fun apply(type: String, payload: JsonObject, list: List<ArtifactSummary>): Change {
        when (type) {
            "artifact.created" -> {
                val artifact = ArtifactSummary.parse(payload["artifact"]) ?: return Change.None
                return Change.Changed(sorted(list.filter { it.id != artifact.id } + artifact))
            }
            "artifact.updated" -> {
                val id = payload["artifactId"].str ?: return Change.None
                val index = list.indexOfFirst { it.id == id }
                if (index < 0) return Change.Read(id)
                val changes = payload["changes"].obj ?: JsonObject(emptyMap())
                if (changes["status"].str == "deleted") return Change.Changed(list.filter { it.id != id })
                val before = list[index]
                val after = before.copy(
                    title = changes["title"].str ?: before.title,
                    latestVersion = changes["latestVersion"].num?.toInt() ?: before.latestVersion,
                    entry = if ("entry" in changes) ArtifactSummary.entry(changes["entry"]) else before.entry,
                    fileCount = changes["fileCount"].num?.toInt() ?: before.fileCount,
                    live = changes["live"]?.let { it.obj != null } ?: before.live,
                    updatedAt = changes["updatedAt"].num?.toLong() ?: before.updatedAt,
                    // Present and `null` clears; absent keeps.
                    cover = if ("cover" in changes) ArtifactCover.parse(changes["cover"]) else before.cover,
                    summary = if ("summary" in changes) ArtifactCover.summary(changes["summary"]) else before.summary,
                    background = if ("background" in changes) ArtifactCover.background(changes["background"]) else before.background,
                )
                if (after == before) return Change.None
                return Change.Changed(sorted(list.toMutableList().also { it[index] = after }))
            }
            "artifact.deleted" -> {
                val id = payload["artifactId"].str ?: return Change.None
                if (list.none { it.id == id }) return Change.None
                return Change.Changed(list.filter { it.id != id })
            }
            else -> return Change.None
        }
    }

    /** Newest change first; the ID breaks ties, as the catalog's paging does. */
    fun sorted(list: List<ArtifactSummary>): List<ArtifactSummary> =
        list.sortedWith(compareByDescending<ArtifactSummary> { it.updatedAt }.thenByDescending { it.id })

    /** The artifacts whose title, or kind's name, holds every word of [query], ignoring case and accents. */
    fun matching(query: String, list: List<ArtifactSummary>, kindName: (ArtifactSummary) -> String): List<ArtifactSummary> {
        val words = query.split(Regex("\\s+")).filter { it.isNotEmpty() }.map(::fold)
        if (words.isEmpty()) return list
        return list.filter { artifact ->
            val haystack = fold(artifact.title + " " + kindName(artifact))
            words.all { it in haystack }
        }
    }

    private val marks = Regex("\\p{Mn}+")

    /** Lower case without accents: "Café" and "cafe" are one word. */
    private fun fold(text: String): String = marks.replace(Normalizer.normalize(text, Normalizer.Form.NFD), "").lowercase()

    /** The list as it is kept: `{ "artifacts": [...] }`. */
    fun kept(items: List<ArtifactSummary>): JsonObject = buildJsonObject {
        put("artifacts", buildJsonArray { items.forEach { add(it.json()) } })
    }

    /** What [kept] wrote, newest change first. */
    fun fromKept(value: JsonObject): List<ArtifactSummary> =
        sorted(value["artifacts"].arr.orEmpty().mapNotNull(ArtifactSummary::parse))
}

/**
 * When something happened, as a list groups it (iOS's `DateBucket`):
 * Today, Yesterday, the seven and thirty days before, then by month
 * (Telegram's and ChatGPT's relative buckets).
 */
sealed interface DateBucket {
    data object Today : DateBucket
    data object Yesterday : DateBucket
    data object Previous7Days : DateBucket
    data object Previous30Days : DateBucket
    /** An older month: its year and month, 1 to 12. */
    data class Month(val year: Int, val month: Int) : DateBucket

    companion object {
        /** The bucket [millis] falls in, seen from [now]. A time after now (a computer whose clock runs ahead) is today. */
        fun of(millis: Long, now: Long, zone: ZoneId): DateBucket {
            val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
            val start = { days: Long -> today.minusDays(days).atStartOfDay(zone).toInstant().toEpochMilli() }
            return when {
                millis >= start(0) -> Today
                millis >= start(1) -> Yesterday
                millis >= start(7) -> Previous7Days
                millis >= start(30) -> Previous30Days
                else -> Instant.ofEpochMilli(millis).atZone(zone).let { Month(it.year, it.monthValue) }
            }
        }

        /**
         * [items] in their order, cut where the bucket changes. Items given
         * newest first come out as the buckets do, newest first; one out of
         * order (an update arriving late) is kept with its bucket.
         */
        fun <T> group(items: List<T>, now: Long, zone: ZoneId, millis: (T) -> Long): List<Pair<DateBucket, List<T>>> {
            val groups = ArrayList<Pair<DateBucket, MutableList<T>>>()
            for (item in items) {
                val bucket = of(millis(item), now, zone)
                val group = if (groups.lastOrNull()?.first == bucket) groups.last() else groups.firstOrNull { it.first == bucket }
                if (group != null) group.second.add(item) else groups.add(bucket to mutableListOf(item))
            }
            return groups
        }
    }
}

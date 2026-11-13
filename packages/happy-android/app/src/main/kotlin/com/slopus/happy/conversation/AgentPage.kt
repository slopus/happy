package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.long
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.JsonElement
import java.net.URI
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit

// An agent's page (iOS's SessionDetail.swift and Shared.swift): what the
// bootstrap says of an agent beyond what its chat needs, and what its
// conversation shared. Pure: the screen is ui/conversation/AgentPage.kt.

/** A child agent as the page lists it: the bootstrap's `subagents[]`, newest first. */
@Immutable
data class AgentChild(
    val id: String,
    val title: String?,
    /** The daemon's status: `idle`, or what it is at. */
    val status: String,
    val archived: Boolean,
    /** Its own lifetime input and output tokens; null when none were recorded or the daemon doesn't say. */
    val tokens: Long?,
    /** A user-interactive subtask, rather than a hidden subagent. */
    val subtask: Boolean,
) {
    val running: Boolean get() = status != "idle" && !archived
}

/** A background process still running (API.md "Background processes"). */
@Immutable
data class AgentTerminal(val id: String, val command: String, val startedAt: Long?)

/** How full the root agent's context is (`context`); [window] null for a model with no known limit. */
@Immutable
data class ContextUsage(val tokens: Long, val window: Long?)

/**
 * `GET /v0/agents/:id/bootstrap` as the agent page reads it (iOS's
 * `SessionDetail`): the agent and its mode, its subtree's tokens over
 * every model, and desktop's Activity: the children at work and the
 * terminals running, then the children that have settled.
 */
@Immutable
data class AgentDetail(
    val agent: AgentInfo,
    val mode: Mode?,
    /** Input and output tokens over every model the subtree used, as desktop counts a child's; null before any was recorded. */
    val tokens: Long?,
    val context: ContextUsage?,
    val running: List<AgentChild>,
    val terminals: List<AgentTerminal>,
    val completed: List<AgentChild>,
) {
    val isQuiet: Boolean get() = running.isEmpty() && terminals.isEmpty() && completed.isEmpty()

    companion object {
        fun parse(value: JsonElement?): AgentDetail? {
            val o = value.obj ?: return null
            val agent = AgentInfo.parse(o["agent"]) ?: return null
            // Never summed across models by the daemon; the page shows one total, as desktop's child rows do.
            val models = o["usage"].obj?.values.orEmpty().flatMap { provider -> provider.obj?.values.orEmpty() }
            val tokens = if (models.isEmpty()) null else models.sumOf { model ->
                val usage = model.obj
                (usage?.get("input").num ?: 0.0) + (usage?.get("output").num ?: 0.0)
            }.toLong()
            val children = o["subagents"].arr.orEmpty().mapNotNull { child ->
                val c = child.obj ?: return@mapNotNull null
                AgentChild(
                    id = c["id"].str ?: return@mapNotNull null,
                    title = c["title"].str?.takeIf { it.isNotBlank() },
                    status = c["status"].str ?: "idle",
                    archived = c["archivedAt"].long != null,
                    tokens = c["totalTokens"].long,
                    subtask = c["subtask"].bool == true,
                )
            }
            val terminals = o["processes"].arr.orEmpty().mapNotNull { process ->
                val p = process.obj ?: return@mapNotNull null
                if (p["status"].str != "running") return@mapNotNull null
                AgentTerminal(p["id"].str ?: return@mapNotNull null, p["command"].str.orEmpty(), p["startedAt"].long)
            }
            val context = o["context"].obj?.let { c -> c["contextTokens"].long?.let { ContextUsage(it, c["contextWindow"].long) } }
            return AgentDetail(
                agent = agent,
                mode = Mode.parse(o["mode"]),
                tokens = tokens,
                context = context,
                running = children.filter { it.running },
                terminals = terminals,
                completed = children.filterNot { it.running },
            )
        }
    }
}

/** Numbers as the page's tiles say them, words left to the screen (iOS's `DetailFormat`). */
object DetailFormat {
    /** 980, 1.2K, 12K, 121M, 1.2B: tenths only under ten, never rounded up. */
    fun tokens(count: Long): String {
        val n = maxOf(0L, count)
        for ((unit, size) in listOf("B" to 1_000_000_000L, "M" to 1_000_000L, "K" to 1_000L)) {
            if (n < size) continue
            if (n >= 10 * size) return "${n / size}$unit"
            val tenths = n * 10 / size
            return (if (tenths % 10 == 0L) "${tenths / 10}" else "${tenths / 10}.${tenths % 10}") + unit
        }
        return "$n"
    }

    /** How long ago something was, in the largest whole unit. */
    sealed interface Age {
        data object JustNow : Age
        data class Minutes(val count: Int) : Age
        data class Hours(val count: Int) : Age
        data class Days(val count: Int) : Age
        data class Months(val count: Int) : Age
        data class Years(val count: Int) : Age
    }

    /** How long before [now] [since] was, both Unix milliseconds. */
    fun age(since: Long, now: Long): Age {
        val minutes = (maxOf(0L, now - since) / 60_000).toInt()
        val hours = minutes / 60
        val days = hours / 24
        return when {
            minutes < 1 -> Age.JustNow
            hours < 1 -> Age.Minutes(minutes)
            days < 1 -> Age.Hours(hours)
            days < 30 -> Age.Days(days)
            days < 365 -> Age.Months(days / 30)
            else -> Age.Years(days / 365)
        }
    }

    /** When something started, as near as a person says it. */
    enum class Started { Today, Yesterday, Weekday, ThisYear, Date }

    /** [since] in Unix milliseconds against [now], in [zone]. */
    fun started(since: Long, now: Long, zone: ZoneId = ZoneId.systemDefault()): Started {
        val date = Instant.ofEpochMilli(since).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(date, today)
        return when {
            days == 0L -> Started.Today
            days == 1L -> Started.Yesterday
            days in 2..6 -> Started.Weekday
            date.year == today.year -> Started.ThisYear
            else -> Started.Date
        }
    }
}

/** One picture, recording or file a conversation shared; [key] is the viewer's and the image cache's, the transcript's own. */
@Immutable
sealed interface SharedMedia {
    val key: String

    /** A picture sent with a message or put inline by the agent: [index] among its row's. */
    data class Picture(val rowKey: String, val index: Int, val image: Block.Image) : SharedMedia {
        override val key: String get() = ConversationViewing.pictureKey(rowKey, index)
    }

    /** What a tool presented: a picture, a recording or a file. */
    data class Presented(val ref: MediaRef) : SharedMedia {
        override val key: String get() = ConversationViewing.presentedKey(ref)
    }

    val isVideo: Boolean get() = this is Presented && ref.item.kind == "video"

    /** Opens in the viewer: a picture or a recording; a file opens elsewhere. */
    val isVisual: Boolean get() = this is Picture || (this is Presented && ref.item.isVisual)
}

/** A link written in a conversation: its Markdown text when it had one other than itself, and its host without `www.`. */
@Immutable
data class SharedLink(val url: String, val title: String?, val host: String)

/**
 * What a conversation shared, as Telegram's shared media: the pictures,
 * recordings and files it showed, and the links written in it, newest
 * first, each once. Derived from the transcript's own rows, nothing kept
 * beside it (iOS's `Shared`).
 */
@Immutable
data class Shared(val media: List<SharedMedia> = emptyList(), val links: List<SharedLink> = emptyList()) {
    val isEmpty: Boolean get() = media.isEmpty() && links.isEmpty()

    /** This, then what [older] adds: the same media or link once. */
    fun merged(older: Shared): Shared {
        val keys = media.mapTo(HashSet()) { it.key }
        val urls = links.mapTo(HashSet()) { it.url }
        return Shared(
            media + older.media.filter { keys.add(it.key) },
            links + older.links.filter { urls.add(it.url) },
        )
    }

    /** Each one once, where it first shows. */
    fun deduplicated(): Shared = Shared().merged(this)

    companion object {
        /**
         * What [rows] show, newest first as the transcript holds them: a
         * person's pictures, the agent's inline ones, what tools presented,
         * and the links in what either side wrote. Another agent's messages
         * share nothing here.
         */
        fun of(rows: List<ConversationRow>): Shared {
            val media = ArrayList<SharedMedia>()
            val links = ArrayList<SharedLink>()
            for (row in rows) {
                when (row) {
                    is ConversationRow.User -> {
                        row.pictures.forEachIndexed { index, image -> media += SharedMedia.Picture(row.key, index, image) }
                        row.files.forEach { media += SharedMedia.Presented(it) }
                        links += links(row.text)
                    }
                    is ConversationRow.Text -> links += links(row.current)
                    is ConversationRow.Picture -> media += SharedMedia.Picture(row.key, 0, row.image)
                    is ConversationRow.Media -> row.items.forEach { media += SharedMedia.Presented(it) }
                    else -> Unit
                }
            }
            return Shared(media, links).deduplicated()
        }

        /** A page of history ([messages] oldest first), drawn as the transcript draws it, newest first. */
        fun of(messages: List<Message>, agentId: String, parentAgentId: String?): Shared =
            of(messages.asReversed().flatMap { ConversationRowBuilder.build(it, agentId, parentAgentId, streaming = false).asReversed() })

        /** `[text](url)`, not `![alt](url)`; a URL may hold balanced parentheses. */
        private val markdownLink = Regex("""(?<!!)\[([^\]\n]{1,300})\]\((https?://(?:[^\s()]|\([^\s()]*\))+)\)""")
        private val markdownImage = Regex("""!\[[^\]\n]{0,300}\]\([^\s)]*\)""")
        private val bareLink = Regex("""https?://(?:[^\s<>"'`()\[\]{}]|\([^\s<>"'`()\[\]{}]*\))+""", RegexOption.IGNORE_CASE)

        /** What ends a sentence rather than a link. */
        private const val TRAILING = ".,;:!?*_~'\""

        /** The links in [text], in its order: a Markdown link with its text, a bare one as written, punctuation after it left out. */
        fun links(text: String): List<SharedLink> {
            if (!text.contains("http", ignoreCase = true)) return emptyList()
            val found = ArrayList<Pair<Int, SharedLink>>()
            val covered = markdownImage.findAll(text).map { it.range }.toMutableList()
            for (match in markdownLink.findAll(text)) {
                link(match.groupValues[2], match.groupValues[1])?.let { found += match.range.first to it }
                covered += match.range
            }
            for (match in bareLink.findAll(text)) {
                if (covered.any { it.first <= match.range.last && match.range.first <= it.last }) continue
                link(match.value, null)?.let { found += match.range.first to it }
            }
            return found.sortedBy { it.first }.map { it.second }
        }

        private fun link(raw: String, title: String?): SharedLink? {
            val url = raw.trimEnd { it in TRAILING }
            val host = try {
                URI(url).host
            } catch (_: Exception) {
                null
            }?.takeIf { it.isNotEmpty() } ?: return null
            val name = title?.trim()?.takeIf { it.isNotEmpty() && it != url && it != raw }
            return SharedLink(url, name, host.removePrefix("www."))
        }

        /** A link as it reads under its title: no scheme, no `www.`, no slash at its end. */
        fun address(url: String): String = url.removePrefix("https://").removePrefix("http://").removePrefix("www.").removeSuffix("/")
    }
}

/**
 * A conversation's shared media and links, read a page of history at a
 * time from the newest back (iOS's `SharedFeed`): as many pages as it takes
 * to have what the page asks for, never more than [PAGES_PER_ASK] for one
 * ask. One ask at a time; another while one reads gets what it had.
 */
class SharedFeed(private val api: ConversationApi, private val agentId: String, private val parentAgentId: () -> String?) {
    @Immutable
    data class State(val shared: Shared = Shared(), val hasMore: Boolean = true, val failed: Boolean = false, val read: Boolean = false)

    private val lock = Mutex()
    private var before: String? = null

    @Volatile var state = State()
        private set

    /** Reads on until [media] media or [links] links are in (null: not asked), history ends, or [PAGES_PER_ASK] pages are read. */
    suspend fun load(media: Int?, links: Int?): State {
        if (!lock.tryLock()) return state
        try {
            var pages = 0
            fun short() = state.shared.media.size < (media ?: 0) || state.shared.links.size < (links ?: 0)
            while (state.hasMore && pages < PAGES_PER_ASK && short()) {
                val page = try {
                    api.messages(agentId, before, PAGE_SIZE)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    state = state.copy(failed = true, read = true)
                    break
                }
                pages++
                // Runs come oldest first; the page's oldest is the next cursor.
                val messages = page.runs.flatMap { it.messages }
                before = page.runs.firstOrNull()?.id
                state = State(
                    shared = state.shared.merged(Shared.of(messages, agentId, parentAgentId())),
                    hasMore = page.hasMore && before != null,
                    failed = false,
                    read = true,
                )
            }
            if (!state.read) state = state.copy(read = true)
            return state
        } finally {
            lock.unlock()
        }
    }

    companion object {
        /** Small pages: a run comes whole, and a person's pictures with it as their bytes. */
        const val PAGE_SIZE = 10
        const val PAGES_PER_ASK = 6
    }
}

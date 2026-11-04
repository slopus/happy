package com.slopus.happy.feed

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.Intent
import com.slopus.happy.agent.IntentOutbox
import com.slopus.happy.agent.IntentRefusal
import com.slopus.happy.chat.num
import com.slopus.happy.chat.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * One paired computer's Feed for its person (API.md "Feed", iOS
 * `FeedLibrary`), kept on the phone: read from disk first, then the newest
 * page from the computer, then kept current by the `feed.*` events. Entries
 * merge by `id`, the greater `version` winning, newest `cursor` first, so a
 * replayed or late event never moves anything back.
 *
 * Seeing is an intent ([FEED_SEEN] per subject, [FEED_READ_ALL]) in the
 * connection's [outbox]: an entry reads as seen at once, kept through a
 * kill and sent once the computer is reachable; its answer then closes the
 * held copy. The unread count is the computer's, newest by event cursor,
 * less the open entries seen here and not yet sent.
 *
 * Only a computer whose health says `capabilities.feed` and whose
 * bootstrap carries `feedUnread` has one; older daemons show none.
 *
 * It holds references only (iOS 434228fa1): what an entry is about, who
 * did it and what the change was. Its rows are joined with what the
 * connection syncs ([FeedRows]).
 */
class FeedLibrary(
    private val scope: CoroutineScope,
    private val routes: FeedRoutes,
    private val outbox: IntentOutbox,
    /** What was kept, read off the main thread; null for nothing. */
    private val kept: suspend () -> JsonObject?,
    private val keep: suspend (JsonObject) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) {
    @Immutable
    data class State(
        /** Whether this computer keeps a feed for this person; null until it has said, on this phone ever. */
        val available: Boolean? = null,
        /** Newest cursor first. */
        val items: List<FeedItem> = emptyList(),
        /** Entries seen here that the computer still calls open. */
        val seenHere: Set<String> = emptySet(),
        /** How many entries are open, as this phone shows it. */
        val unread: Int = 0,
        val hasMore: Boolean = false,
        /** Something was read, from disk or the computer. */
        val loaded: Boolean = false,
        val refreshing: Boolean = false,
        val loadingMore: Boolean = false,
        /** The last read failed. */
        val failed: Boolean = false,
    ) {
        fun isUnread(item: FeedItem): Boolean = item.open && item.id !in seenHere
    }

    private val lock = Mutex()
    private val stateFlow = MutableStateFlow(State())
    val state: StateFlow<State> = stateFlow.asStateFlow()

    /** What the computer last said, before this phone's seeing is laid over it. */
    private var held: List<FeedItem> = emptyList()
    private var serverUnread = 0
    /** The event cursor [serverUnread] is as of; an older one is ignored. */
    private var unreadCursor: String? = null
    private var capable: Boolean? = null
    private var counted: Boolean? = null
    private var pending: List<Intent> = emptyList()
    private var live = false
    private var started = false
    private var connecting: Job? = null
    private var reading: Job? = null
    private var again = false
    private var lastKept: JsonObject? = null

    /** What was kept, and this phone's seeing still on its way. Once. */
    fun start() {
        if (started) return
        started = true
        outbox.handle(setOf(FEED_SEEN, FEED_READ_ALL), ::deliver)
        scope.launch {
            val kept = kept()
            lock.withLock {
                if (kept != null) {
                    lastKept = kept
                    held = FeedItem.list(kept["items"])
                    serverUnread = (kept["unread"].num?.toInt() ?: 0).coerceAtLeast(0)
                    unreadCursor = kept["unreadCursor"].str
                    stateFlow.value = stateFlow.value.copy(
                        available = (kept["available"] as? JsonPrimitive)?.booleanOrNull,
                        hasMore = (kept["hasMore"] as? JsonPrimitive)?.booleanOrNull ?: false,
                        loaded = true,
                    )
                }
                commit()
            }
            outbox.pending.collect { list ->
                val next = list.filter { it.kind in KINDS }
                lock.withLock {
                    if (next != pending) {
                        pending = next
                        commit()
                    }
                }
            }
        }
    }

    /** The bootstrap was read: its `feedUnread` (null from a daemon without a feed), as of its event [cursor]. */
    fun bootstrap(unread: Int?, cursor: String?) {
        scope.launch {
            lock.withLock {
                counted = unread != null
                if (unread != null) setUnread(unread, cursor)
                settle()
                commit()
            }
        }
    }

    /** The event stream opened: health says whether there is a feed, and the newest page is read. */
    fun connected() {
        live = true
        connecting?.cancel()
        connecting = scope.launch {
            val capable = try {
                routes.capable()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
            lock.withLock {
                if (capable != null) this@FeedLibrary.capable = capable
                settle()
                commit()
            }
            if (stateFlow.value.available == true) refresh()
        }
    }

    /** The stream went away: reads under way stop. */
    fun disconnected() {
        live = false
        connecting?.cancel()
        reading?.cancel()
        again = false
        stateFlow.value = stateFlow.value.copy(refreshing = false, loadingMore = false)
    }

    /**
     * A feed health vouches for and no bootstrap denies (a connection resumed
     * from its cursor reads none); either saying no takes it away, with what
     * was kept of it.
     */
    private fun settle() {
        val next = when {
            capable == false || counted == false -> false
            capable == true -> true
            else -> stateFlow.value.available
        }
        if (next == stateFlow.value.available) return
        stateFlow.value = stateFlow.value.copy(available = next)
        if (next == false) {
            held = emptyList()
            serverUnread = 0
            unreadCursor = null
            stateFlow.value = stateFlow.value.copy(hasMore = false, failed = false)
        }
    }

    /**
     * Reads the newest page and lays it over what is held: entries newer
     * than its last one are exactly the page, older ones already read stay,
     * so a person scrolled down keeps their place. One under way is followed by one more.
     */
    fun refresh() {
        if (stateFlow.value.available != true) return
        if (reading?.isActive == true) {
            again = true
            return
        }
        reading = scope.launch {
            do {
                again = false
                readFirst()
            } while (again)
        }
    }

    private suspend fun readFirst() {
        stateFlow.value = stateFlow.value.copy(refreshing = true)
        val page = try {
            routes.page(null, PAGE)
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentApiException) {
            lock.withLock {
                if (e.status == 404) {
                    // No feed for this person after all (a guest, an older daemon).
                    capable = false
                    settle()
                } else {
                    stateFlow.value = stateFlow.value.copy(failed = true)
                }
                stateFlow.value = stateFlow.value.copy(refreshing = false)
                commit()
            }
            return
        } catch (_: Exception) {
            stateFlow.value = stateFlow.value.copy(refreshing = false, failed = true)
            return
        }
        lock.withLock {
            val floor = page.items.lastOrNull()?.cursor
            val ids = page.items.mapTo(HashSet()) { it.id }
            val older = if (floor == null || !page.hasMore) emptyList() else held.filter { it.cursor < floor && it.id !in ids }
            val olderIds = older.mapTo(HashSet()) { it.id }
            held = upsert(held.filter { it.id in ids || it.id in olderIds }, page.items, hasMore = false)
            stateFlow.value = stateFlow.value.copy(
                hasMore = if (older.isEmpty()) page.hasMore else stateFlow.value.hasMore,
                failed = false,
                loaded = true,
                refreshing = false,
            )
            setUnread(page.unread, page.cursor)
            commit()
        }
    }

    /** Reads the page older than the last entry held. */
    fun loadMore() {
        val now = stateFlow.value
        val last = held.lastOrNull() ?: return
        if (!live || now.available != true || !now.hasMore || now.loadingMore) return
        stateFlow.value = now.copy(loadingMore = true)
        scope.launch {
            try {
                val page = routes.page(last.cursor, PAGE)
                lock.withLock {
                    val ids = held.mapTo(HashSet()) { it.id }
                    held = upsert((held + page.items.filter { it.id !in ids }).sortedWith(FeedItem.newestFirst), page.items, hasMore = false)
                    stateFlow.value = stateFlow.value.copy(hasMore = page.hasMore, failed = false)
                    commit()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                stateFlow.value = stateFlow.value.copy(failed = true)
            } finally {
                stateFlow.value = stateFlow.value.copy(loadingMore = false)
            }
        }
    }

    /** One `feed.*` event, in stream order. */
    suspend fun receive(event: AgentEvent) {
        lock.withLock {
            when (event.type) {
                "feed.item.created", "feed.item.updated" -> {
                    if (stateFlow.value.available == false) return
                    val item = FeedItem.parse(event.data["item"]) ?: return
                    held = upsert(held, listOf(item), stateFlow.value.hasMore)
                }
                "feed.item.removed" -> {
                    val id = event.data["itemId"].str ?: return
                    held = held.filter { it.id != id }
                }
                "feed.unread.updated" -> {
                    val unread = event.data["unread"].num ?: return
                    setUnread(unread.toInt().coerceAtLeast(0), event.cursor)
                }
                else -> return
            }
            commit()
        }
    }

    /** The person opened [item] from the feed: its subject is seen through the change it showed, so a newer one keeps it open. */
    suspend fun open(item: FeedItem) {
        val now = stateFlow.value
        if (now.available != true || !now.isUnread(item) || item.version.isEmpty()) return
        enqueueSeen(item.subject, item.cursor)
    }

    /**
     * The person opened [subject] elsewhere (an artifact, a Surface): its
     * open entry closes, whatever it holds. Nothing is sent to a computer
     * without a feed, nor while nothing is unread or its entry is already seen.
     */
    suspend fun seen(subject: FeedSubject) {
        val now = stateFlow.value
        if (now.available != true || now.unread <= 0) return
        val entry = now.items.firstOrNull { it.subject == subject }
        if (entry != null && !now.isUnread(entry)) return
        enqueueSeen(subject, null)
    }

    private suspend fun enqueueSeen(subject: FeedSubject, through: String?) {
        outbox.enqueue(FEED_SEEN, subject.key, buildJsonObject {
            put("type", subject.type)
            put("id", subject.id)
            through?.let { put("through", it) }
        })
    }

    /** Every entry read, up to the newest one shown: entries that arrive meanwhile stay open. */
    suspend fun readAll() {
        val now = stateFlow.value
        val newest = held.firstOrNull() ?: return
        if (now.available != true || (now.unread <= 0 && held.none(now::isUnread))) return
        outbox.enqueue(FEED_READ_ALL, "all", buildJsonObject { put("through", newest.cursor) })
    }

    /**
     * Sends one of the Feed's intents: the computer's answer closes the held
     * copies at once. Gone (an older daemon's 404) counts as done; any other
     * 4xx but 408 and 429 is a refusal.
     */
    suspend fun deliver(intent: Intent) {
        fun value(key: String) = (intent.value[key] as? JsonPrimitive)?.contentOrNull
        try {
            when (intent.kind) {
                FEED_SEEN -> {
                    val type = value("type") ?: return
                    val id = value("id") ?: return
                    val (items, unread) = routes.seen(FeedSubject(type, id), value("through"), intent.id)
                    lock.withLock {
                        held = upsert(held, items, hasMore = false)
                        setUnread(unread, null)
                        commit()
                    }
                }
                FEED_READ_ALL -> {
                    val through = value("through")
                    val unread = routes.readAll(through, intent.id)
                    lock.withLock {
                        // Every entry open at or before `through` is now closed, whether or not its own event has come.
                        val at = now()
                        held = held.map { if (it.open && (through == null || it.cursor <= through)) it.copy(seenAt = at) else it }
                        setUnread(unread, null)
                        commit()
                    }
                }
            }
        } catch (e: AgentApiException) {
            if (e.status == 404) return
            if (e.status in 400..499 && e.status != 408 && e.status != 429) throw IntentRefusal(e.message.orEmpty())
            throw e
        }
    }

    /** The places the feed gathers from, read whole each time. */
    suspend fun clusters(): List<FeedCluster> = routes.clusters()

    /** [cluster]'s newest entries, read whole each time. */
    suspend fun peek(cluster: String): List<FeedItem> = routes.peek(cluster, PEEK)

    /** Follows [cluster], or mutes it; what the computer says it is now. */
    suspend fun follow(cluster: String, following: Boolean): FeedCluster = routes.follow(cluster, following, AgentClient.newId())

    private fun setUnread(value: Int, cursor: String?) {
        if (cursor != null) {
            val heldCursor = unreadCursor
            if (heldCursor != null && cursor < heldCursor) return
            unreadCursor = cursor
        }
        serverUnread = value.coerceAtLeast(0)
    }

    /** Whether this phone's seeing, still on its way, covers [item]. */
    private fun covered(item: FeedItem): Boolean {
        if (!item.open) return false
        return pending.any { intent ->
            val through = (intent.value["through"] as? JsonPrimitive)?.contentOrNull
            val applies = intent.kind == FEED_READ_ALL || (intent.kind == FEED_SEEN && intent.target == item.subject.key)
            applies && (through == null || item.cursor <= through)
        }
    }

    /** Lays this phone's seeing over what is held, shows it, and writes it down when what is kept changed. Under [lock]. */
    private suspend fun commit() {
        val available = stateFlow.value.available == true
        val items = if (available) held else emptyList()
        val seen = items.filter(::covered).mapTo(HashSet()) { it.id }
        stateFlow.value = stateFlow.value.copy(
            items = items,
            seenHere = seen,
            unread = if (available) (serverUnread - seen.size).coerceAtLeast(0) else 0,
        )
        val value = buildJsonObject {
            put("items", JsonArray(held.take(KEPT).map { it.json() }))
            put("unread", serverUnread)
            put("hasMore", stateFlow.value.hasMore || held.size > KEPT)
            stateFlow.value.available?.let { put("available", it) }
            unreadCursor?.let { put("unreadCursor", it) }
        }
        // A change that changed nothing kept writes nothing.
        if (value == lastKept) return
        lastKept = value
        keep(value)
    }

    companion object {
        const val FEED_SEEN = "feed.seen"
        const val FEED_READ_ALL = "feed.readAll"
        val KINDS = setOf(FEED_SEEN, FEED_READ_ALL)

        /** The checkpoint it is kept under, beside the connection's catalog. */
        const val RESOURCE = "feed"
        const val PAGE = 50
        const val PEEK = 200
        /** The most entries kept on disk. */
        const val KEPT = 200

        /**
         * [incoming] taken into [current]: the greater `version` of each entry
         * wins, and with [hasMore] an entry older than the last one held is
         * left for paging to bring, so the list never has a gap. Unchanged
         * entries stay as they are.
         */
        fun upsert(current: List<FeedItem>, incoming: List<FeedItem>, hasMore: Boolean): List<FeedItem> {
            if (incoming.isEmpty()) return current
            val byId = LinkedHashMap<String, FeedItem>()
            current.forEach { byId.putIfAbsent(it.id, it) }
            val tail = current.lastOrNull()?.cursor
            var changed = false
            for (item in incoming) {
                val held = byId[item.id]
                if (held != null && held.version >= item.version) continue
                if (held == null && hasMore && tail != null && item.cursor < tail) continue
                byId[item.id] = item
                changed = true
            }
            return if (changed) byId.values.sortedWith(FeedItem.newestFirst) else current
        }
    }
}

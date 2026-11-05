package com.slopus.happy.vaults

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.text.Collator

/** A folder's order: [field], and whether it runs high to low. Folders always come first. */
data class VaultSort(val field: VaultSortField = VaultSortField.Name, val descending: Boolean = false) {
    /** Picking the field already in use turns its order round; another starts at its natural order. */
    fun picking(next: VaultSortField): VaultSort =
        if (next == field) copy(descending = !descending) else VaultSort(next, descending = next != VaultSortField.Name)

    fun comparator(collator: Collator = defaultCollator()): Comparator<VaultItem> {
        val byName = Comparator<VaultItem> { a, b -> collator.compare(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id) }
        val within: Comparator<VaultItem> = when (field) {
            VaultSortField.Name -> if (descending) byName.reversed() else byName
            VaultSortField.Updated -> compareBy<VaultItem> { it.updatedAt }.let { if (descending) it.reversed() else it }.then(byName)
            VaultSortField.Size -> compareBy<VaultItem> { it.size ?: 0L }.let { if (descending) it.reversed() else it }.then(byName)
        }
        return compareBy<VaultItem> { if (it.isFolder) 0 else 1 }.then(within)
    }

    companion object {
        /** Names as people sort them: accents and case second (Finder's order, not the wire's byte order). */
        fun defaultCollator(): Collator = Collator.getInstance().apply { strength = Collator.SECONDARY }
    }
}

/**
 * One folder's live children as this phone holds them (the root when
 * [parentId] is null), kept by the vault's version chain: a change that
 * follows the held version is applied, a newer one that doesn't is read
 * again, an older one is dropped. An entry that left (moved out, deleted)
 * is remembered with the version it left at, so a page read before it
 * left can't bring it back.
 */
class VaultListing(val surfaceId: String, val parentId: String?) {
    /** What an event asks of the holder. */
    sealed interface Outcome {
        data object Ignored : Outcome
        data object Changed : Outcome
        /** The chain broke, or an item may have arrived here: read [itemId], a folder when [folder]. */
        data class Read(val itemId: String, val folder: Boolean = false) : Outcome
        /** Read the whole folder again (a reconnect). */
        data object Reload : Outcome
        /** The folder itself is gone for good. */
        data object Gone : Outcome
    }

    private val held = LinkedHashMap<String, VaultItem>()
    /** Entries that left, with the version they left at; null: gone for good. */
    private val left = HashMap<String, String?>()
    /** Set while a whole read runs: what pages listed, and what events settled meanwhile. */
    private var listed: MutableSet<String>? = null
    private var settled: MutableSet<String>? = null

    val entries: Collection<VaultItem> get() = held.values

    operator fun get(id: String): VaultItem? = held[id]

    fun belongs(entry: VaultItem): Boolean = entry.surfaceId == surfaceId && entry.parentId == parentId && entry.deletedAt == null

    /** A whole read starts: entries no page lists and no event settles are dropped at [finish]. */
    fun begin() {
        listed = HashSet()
        settled = HashSet()
    }

    /** One page of the read; true when something shown changed. */
    fun page(entries: List<VaultItem>): Boolean {
        var changed = false
        for (entry in entries) {
            listed?.add(entry.id)
            if (belongs(entry) && accept(entry)) changed = true
        }
        return changed
    }

    /** The read reached its last page; true when something was dropped. */
    fun finish(): Boolean {
        val seen = listed ?: return false
        val kept = settled.orEmpty()
        val stale = held.keys.filter { it !in seen && it !in kept }
        stale.forEach { held.remove(it) }
        listed = null
        settled = null
        return stale.isNotEmpty()
    }

    /** The read stopped short (a failure): nothing is dropped. */
    fun abandon() {
        listed = null
        settled = null
    }

    fun receive(event: VaultEvent): Outcome {
        if (event is VaultEvent.Resync) return Outcome.Reload
        if (event.surfaceId != surfaceId) return Outcome.Ignored
        return when (event) {
            is VaultEvent.Created -> place(event.item)
            is VaultEvent.Known -> place(event.item)
            is VaultEvent.Updated -> updated(event)
            is VaultEvent.Removed -> {
                if (event.itemId == parentId) return Outcome.Gone
                left[event.itemId] = null
                settled?.add(event.itemId)
                if (held.remove(event.itemId) != null) Outcome.Changed else Outcome.Ignored
            }
            else -> Outcome.Ignored
        }
    }

    /** What reading [itemId] found: its entry, or null when it is gone (`404`). True when something shown changed. */
    fun read(itemId: String, entry: VaultItem?): Boolean {
        settled?.add(itemId)
        if (entry == null) {
            left[itemId] = null
            return held.remove(itemId) != null
        }
        return place(entry) == Outcome.Changed
    }

    private fun place(entry: VaultItem): Outcome {
        settled?.add(entry.id)
        if (belongs(entry)) return if (accept(entry)) Outcome.Changed else Outcome.Ignored
        val had = held[entry.id]
        if (had != null && !VaultVersions.newer(entry.version, had.version)) return Outcome.Ignored
        leave(entry.id, entry.version)
        return if (had != null) Outcome.Changed else Outcome.Ignored
    }

    private fun updated(event: VaultEvent.Updated): Outcome {
        settled?.add(event.itemId)
        val had = held[event.itemId]
        if (had == null) {
            if (event.itemId in left && left[event.itemId] == null) return Outcome.Ignored
            left[event.itemId]?.let { if (!VaultVersions.newer(event.version, it)) return Outcome.Ignored }
            val parent = event.changes["parentId"]
            val movedHere = event.changes.containsKey("parentId") &&
                (if (parentId == null) parent is JsonNull else (parent as? JsonPrimitive)?.content == parentId)
            val restored = event.changes.containsKey("deletedAt") && event.changes["deletedAt"] is JsonNull
            return if (movedHere || restored) Outcome.Read(event.itemId, event.folder) else Outcome.Ignored
        }
        if (!VaultVersions.newer(event.version, had.version)) return Outcome.Ignored
        if (event.previousVersion != had.version) return Outcome.Read(event.itemId, event.folder)
        val next = had.changed(event.changes, event.version) ?: return Outcome.Read(event.itemId, event.folder)
        if (belongs(next)) held[next.id] = next else leave(next.id, next.version)
        return Outcome.Changed
    }

    private fun accept(entry: VaultItem): Boolean {
        val had = held[entry.id]
        if (had != null && !VaultVersions.newer(entry.version, had.version)) return false
        if (entry.id in left) {
            val at = left[entry.id] ?: return false
            if (!VaultVersions.newer(entry.version, at)) return false
            left.remove(entry.id)
        }
        held[entry.id] = entry
        return true
    }

    private fun leave(id: String, version: String) {
        held.remove(id)
        left[id] = version
    }
}

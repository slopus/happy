package com.slopus.happy.documents.yjs

/** Structs an update brought before what they depend on, and the lowest clock each client is missing. */
internal class YPending(val refs: MutableMap<Long, MutableList<YItem>>, val missing: MutableMap<Long, Int>)

/** Every client's structs in clock order, with no gaps (`StructStore`). */
internal class YStructStore {
    val clients = HashMap<Long, ArrayList<YItem>>()
    var pending: YPending? = null
    /** Deletes of structs not here yet. */
    var pendingDeletes: YDeleteSet? = null

    fun state(client: Long): Int {
        val last = clients[client]?.lastOrNull() ?: return 0
        return last.id.clock + last.length
    }

    fun stateVector(): Map<Long, Int> {
        val vector = HashMap<Long, Int>()
        for ((client, structs) in clients) {
            val last = structs.lastOrNull() ?: continue
            vector[client] = last.id.clock + last.length
        }
        return vector
    }

    fun add(item: YItem) {
        val client = item.id.client
        check(state(client) == item.id.clock) { "Yjs: struct ${item.id} out of order" }
        clients.getOrPut(client) { ArrayList() }.add(item)
    }

    fun item(id: YID): YItem {
        val structs = clients[id.client] ?: throw YError.Unexpected("no structs for ${id.client}")
        return structs[findIndex(structs, id.clock)]
    }

    /** The struct starting exactly at [id], splitting the one that holds it. */
    fun itemCleanStart(transaction: YTransaction, id: YID): YItem =
        clients[id.client]!![findIndexCleanStart(transaction, id.client, id.clock)]

    fun findIndexCleanStart(transaction: YTransaction, client: Long, clock: Int): Int {
        val structs = clients[client]!!
        val index = findIndex(structs, clock)
        val item = structs[index]
        if (item.id.clock < clock && item.kind == YItem.Kind.Item) {
            structs.add(index + 1, split(transaction, item, clock - item.id.clock))
            return index + 1
        }
        return index
    }

    /** The struct ending exactly at [id], splitting the one that holds it. */
    fun itemCleanEnd(transaction: YTransaction, id: YID): YItem {
        val structs = clients[id.client]!!
        val index = findIndex(structs, id.clock)
        val item = structs[index]
        if (id.clock != item.id.clock + item.length - 1 && item.kind != YItem.Kind.Gc) {
            structs.add(index + 1, split(transaction, item, id.clock - item.id.clock + 1))
        }
        return item
    }

    /** Splits [left] after [diff] units; the caller places the right part in the store. */
    fun split(transaction: YTransaction, left: YItem, diff: Int): YItem {
        val id = left.id
        val (kept, rest) = left.content.splice(diff)
        left.content = kept
        val right = YItem(
            id = YID(id.client, id.clock + diff), left = left,
            origin = YID(id.client, id.clock + diff - 1),
            right = left.right, rightOrigin = left.rightOrigin,
            parent = left.parent, parentSub = left.parentSub, content = rest,
        )
        if (left.deleted) right.markDeleted()
        if (left.keep) right.keep = true
        left.right = right
        right.right?.left = right
        transaction.mergeStructs += right
        val parentSub = right.parentSub
        val parent = right.parentType
        if (parentSub != null && right.right == null && parent != null) parent.map[parentSub] = right
        left.length = diff
        return right
    }

    fun replace(old: YItem, new: YItem) {
        val structs = clients[old.id.client] ?: return
        val index = findIndex(structs, old.id.clock)
        if (structs[index] === old) structs[index] = new
    }

    /** Joins the struct at [pos] with those before it while Yjs would; returns how many went. */
    fun mergeWithLefts(client: Long, pos: Int): Int {
        val structs = clients[client] ?: return 0
        if (pos <= 0 || pos >= structs.size) return 0
        var i = pos
        var right = structs[i]
        while (i > 0) {
            val left = structs[i - 1]
            if (left.deleted != right.deleted || left.kind != right.kind || !left.mergeWith(right)) break
            val parentSub = right.parentSub
            val parent = right.parentType
            if (right.kind == YItem.Kind.Item && parentSub != null && parent != null && parent.map[parentSub] === right) parent.map[parentSub] = left
            right = left
            i--
        }
        val merged = pos - i
        if (merged > 0) structs.subList(pos + 1 - merged, pos + 1).clear()
        return merged
    }

    companion object {
        /** The index of the struct holding [clock] (`findIndexSS`). */
        fun findIndex(structs: List<YItem>, clock: Int): Int {
            var left = 0
            var right = structs.size - 1
            if (right < 0) return 0
            val last = structs[right]
            val lastClock = last.id.clock
            if (lastClock == clock) return right
            // Guess by assuming clocks spread evenly, then bisect.
            var mid = ((clock.toDouble() / (lastClock + last.length - 1).toDouble()) * right).toInt()
            mid = mid.coerceIn(0, right)
            while (left <= right) {
                val item = structs[mid]
                val midClock = item.id.clock
                if (midClock <= clock) {
                    if (clock < midClock + item.length) return mid
                    left = mid + 1
                } else {
                    right = mid - 1
                }
                mid = (left + right) / 2
            }
            return left.coerceIn(0, structs.size - 1)
        }
    }
}

/** Deleted ranges per client (`DeleteSet`). */
class YDeleteSet {
    data class Range(val clock: Int, val length: Int)

    val clients = HashMap<Long, MutableList<Range>>()

    val isEmpty: Boolean get() = clients.isEmpty()

    fun copy(): YDeleteSet = YDeleteSet().also { c -> clients.forEach { (k, v) -> c.clients[k] = v.toMutableList() } }

    override fun equals(other: Any?) = other is YDeleteSet && other.clients == clients
    override fun hashCode() = clients.hashCode()

    fun add(client: Long, clock: Int, length: Int) {
        clients.getOrPut(client) { ArrayList() }.add(Range(clock, length))
    }

    fun sortAndMerge() {
        for ((client, ranges) in clients) {
            val sorted = ranges.sortedBy { it.clock }
            val merged = ArrayList<Range>(sorted.size)
            for (range in sorted) {
                val last = merged.lastOrNull()
                if (last != null && last.clock + last.length >= range.clock) {
                    merged[merged.size - 1] = Range(last.clock, maxOf(last.length, range.clock + range.length - last.clock))
                } else {
                    merged += range
                }
            }
            clients[client] = merged
        }
    }

    fun contains(id: YID): Boolean {
        val ranges = clients[id.client] ?: return false
        var low = 0
        var high = ranges.size - 1
        while (low <= high) {
            val mid = (low + high) / 2
            val range = ranges[mid]
            if (range.clock <= id.clock) {
                if (id.clock < range.clock + range.length) return true
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return false
    }

    fun merge(other: YDeleteSet) {
        for ((client, ranges) in other.clients) clients.getOrPut(client) { ArrayList() }.addAll(ranges)
        sortAndMerge()
    }

    fun write(encoder: YEncoder) {
        encoder.writeVarUint(clients.size)
        for ((client, ranges) in clients.entries.sortedByDescending { it.key }) {
            encoder.writeVarUint(client)
            encoder.writeVarUint(ranges.size)
            for (range in ranges) {
                encoder.writeVarUint(range.clock)
                encoder.writeVarUint(range.length)
            }
        }
    }

    companion object {
        fun read(decoder: YDecoder): YDeleteSet {
            val set = YDeleteSet()
            repeat(decoder.readVarUint()) {
                val client = decoder.readVarUintLong()
                repeat(decoder.readVarUint()) {
                    val clock = decoder.readVarUint()
                    set.add(client, clock, decoder.readVarUint())
                }
            }
            return set
        }

        /** Every deleted range in a store (`createDeleteSetFromStructStore`). */
        internal fun from(store: YStructStore): YDeleteSet {
            val set = YDeleteSet()
            for ((client, structs) in store.clients) {
                val ranges = ArrayList<Range>()
                var i = 0
                while (i < structs.size) {
                    val item = structs[i]
                    if (item.deleted) {
                        val clock = item.id.clock
                        var length = item.length
                        while (i + 1 < structs.size && structs[i + 1].deleted) {
                            length += structs[i + 1].length
                            i++
                        }
                        ranges += Range(clock, length)
                    }
                    i++
                }
                if (ranges.isNotEmpty()) set.clients[client] = ranges
            }
            return set
        }
    }
}

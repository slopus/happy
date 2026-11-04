package com.slopus.happy.documents.yjs

import java.security.SecureRandom

/**
 * A Yjs document: a port of yjs 13.6's `Doc`, struct store, transactions
 * and version 1 update format, enough to hold and edit what BlockNote
 * writes and to merge with every other replica the way yjs merges. iOS's
 * `YDoc` (HappyCore/Documents/Yjs), name for name.
 *
 * Not thread-safe: one document belongs to one thread at a time.
 */
class YDoc(clientID: Long = randomClientID()) {
    var clientID: Long = clientID
        internal set
    internal val store = YStructStore()
    private val share = HashMap<String, YType>()
    /** Deleted content is dropped, as yjs does by default. */
    var gc = true
    private var transaction: YTransaction? = null

    /** Called after every transaction that changed something, with the update it made and the types it changed. */
    var onTransaction: ((YTransactionResult) -> Unit)? = null

    internal fun root(name: String): YType = share.getOrPut(name) {
        YType(YType.Kind.Unknown).also { it.rootName = name; it.doc = this }
    }

    fun getXmlFragment(name: String): YType = root(name).also { if (it.kind == YType.Kind.Unknown) it.kind = YType.Kind.XmlFragment }

    fun getMap(name: String): YType = root(name).also { if (it.kind == YType.Kind.Unknown) it.kind = YType.Kind.Map }

    fun stateVector(): Map<Long, Int> = store.stateVector()

    /** Runs [body] as one transaction. Nested calls join the outer one. */
    fun <T> transact(origin: String? = null, local: Boolean = true, body: (YTransaction) -> T): T {
        transaction?.let { return body(it) }
        val transaction = YTransaction(this, origin, local)
        this.transaction = transaction
        try {
            return body(transaction)
        } finally {
            this.transaction = null
            cleanup(transaction)
        }
    }

    private fun cleanup(transaction: YTransaction) {
        transaction.deleteSet.sortAndMerge()
        transaction.afterState = store.stateVector()
        val ds = transaction.deleteSet
        if (gc) {
            for ((client, ranges) in ds.clients) {
                val structs = store.clients[client] ?: continue
                for (range in ranges.asReversed()) {
                    val end = range.clock + range.length
                    var si = YStructStore.findIndex(structs, range.clock)
                    while (si < structs.size) {
                        val item = structs[si]
                        if (item.id.clock >= end) break
                        if (item.kind == YItem.Kind.Item && item.deleted && !item.keep) item.gc(store, false)
                        si++
                    }
                }
            }
        }
        // Join what the deletes and new structs left adjacent.
        for ((client, ranges) in ds.clients) {
            val structs = store.clients[client] ?: continue
            if (structs.isEmpty()) continue
            val count = structs.size
            for (range in ranges.asReversed()) {
                var si = minOf(count - 1, 1 + YStructStore.findIndex(structs, range.clock + range.length - 1))
                si = minOf(si, structs.size - 1)
                while (si > 0 && structs[si].id.clock >= range.clock) {
                    si -= 1 + store.mergeWithLefts(client, si)
                }
            }
        }
        for ((client, clock) in transaction.afterState) {
            val before = transaction.beforeState[client] ?: 0
            if (before == clock) continue
            val structs = store.clients[client] ?: continue
            val low = maxOf(YStructStore.findIndex(structs, before), 1)
            var i = structs.size - 1
            while (i >= low) {
                i -= 1 + store.mergeWithLefts(client, i)
            }
        }
        for (item in transaction.mergeStructs.asReversed()) {
            val client = item.id.client
            val structs = store.clients[client] ?: continue
            val pos = YStructStore.findIndex(structs, item.id.clock)
            if (pos + 1 < structs.size && store.mergeWithLefts(client, pos + 1) > 1) continue
            if (pos > 0) store.mergeWithLefts(client, pos)
        }
        if (!transaction.local && transaction.afterState[clientID] != transaction.beforeState[clientID]) {
            // Another replica wrote under this client ID: take a new one.
            clientID = randomClientID()
        }
        val onTransaction = onTransaction ?: return
        val changedState = transaction.afterState.any { transaction.beforeState[it.key] != it.value }
        if (!changedState && ds.isEmpty) return
        val encoder = YEncoder()
        writeStructs(encoder, transaction.beforeState)
        ds.write(encoder)
        onTransaction(
            YTransactionResult(
                update = encoder.bytes, local = transaction.local, origin = transaction.origin,
                changed = transaction.changed.keys.toList(), deleteSet = ds,
            ),
        )
    }

    /**
     * Applies a version 1 update (`Y.applyUpdate`). What it needs and does
     * not find waits here until a later update brings it.
     */
    fun applyUpdate(update: ByteArray, origin: String? = null) {
        val decoder = YDecoder(update)
        val refs = readStructRefs(decoder)
        val deletes = YDeleteSet.read(decoder)
        transact(origin, local = false) { transaction ->
            val all = refs
            val pending = store.pending
            if (pending != null && pending.missing.any { (client, clock) -> clock < store.state(client) }) {
                for ((client, items) in pending.refs) all[client] = ((all[client] ?: emptyList<YItem>()) + items).sortedBy { it.id.clock }.toMutableList()
                store.pending = null
            }
            val rest = integrate(transaction, all)
            if (rest != null) {
                val existing = store.pending
                if (existing != null) {
                    for ((client, items) in rest.refs) existing.refs[client] = ((existing.refs[client] ?: emptyList<YItem>()) + items).sortedBy { it.id.clock }.toMutableList()
                    for ((client, clock) in rest.missing) existing.missing[client] = minOf(existing.missing[client] ?: clock, clock)
                } else {
                    store.pending = rest
                }
            }
            val unapplied = applyDeletes(transaction, deletes)
            store.pendingDeletes?.let { waiting ->
                store.pendingDeletes = null
                unapplied.merge(applyDeletes(transaction, waiting))
            }
            store.pendingDeletes = if (unapplied.isEmpty) null else unapplied
        }
        // Something waiting may have become applicable.
        val pending = store.pending
        if (pending != null && pending.missing.any { it.value < store.state(it.key) }) applyUpdate(byteArrayOf(0, 0))
    }

    /** Whether some update waits for changes this document has not had. */
    val hasPending: Boolean get() = store.pending != null || store.pendingDeletes != null

    private fun readStructRefs(decoder: YDecoder): MutableMap<Long, MutableList<YItem>> {
        val refs = HashMap<Long, MutableList<YItem>>()
        repeat(decoder.readVarUint()) {
            val count = decoder.readVarUint()
            val client = decoder.readVarUintLong()
            var clock = decoder.readVarUint()
            val items = ArrayList<YItem>(minOf(count, 4096))
            repeat(count) {
                val info = decoder.readUint8()
                when (info and 0x1F) {
                    0 -> {
                        val length = decoder.readVarUint()
                        items += YItem.gc(YID(client, clock), length)
                        clock += length
                    }
                    10 -> {
                        val length = decoder.readVarUint()
                        items += YItem.skip(YID(client, clock), length)
                        clock += length
                    }
                    else -> {
                        val hasOrigin = info and 0x80 != 0
                        val hasRightOrigin = info and 0x40 != 0
                        val origin = if (hasOrigin) YID(decoder.readVarUintLong(), decoder.readVarUint()) else null
                        val rightOrigin = if (hasRightOrigin) YID(decoder.readVarUintLong(), decoder.readVarUint()) else null
                        var parent: YParent = YParent.None
                        var parentSub: String? = null
                        if (!hasOrigin && !hasRightOrigin) {
                            parent = if (decoder.readVarUint() == 1) YParent.Root(decoder.readVarString())
                            else YParent.Id(YID(decoder.readVarUintLong(), decoder.readVarUint()))
                            if (info and 0x20 != 0) parentSub = decoder.readVarString()
                        }
                        val content = YContent.read(decoder, info)
                        val item = YItem(YID(client, clock), null, origin, null, rightOrigin, parent, parentSub, content)
                        items += item
                        clock += item.length
                    }
                }
            }
            refs.getOrPut(client) { ArrayList() }.addAll(items)
        }
        return refs
    }

    private class Target(val refs: List<YItem>, var i: Int)

    /**
     * Integrates structs client by client, following dependencies across
     * clients (`integrateStructs`). Returns what could not be applied yet.
     */
    private fun integrate(transaction: YTransaction, refsIn: Map<Long, List<YItem>>): YPending? {
        val targets = HashMap<Long, Target>()
        refsIn.forEach { (k, v) -> targets[k] = Target(v, 0) }
        val ids = targets.keys.sorted().toMutableList()
        if (ids.isEmpty()) return null
        val stack = ArrayList<YItem>()
        val rest = HashMap<Long, MutableList<YItem>>()
        val missing = HashMap<Long, Int>()
        val state = HashMap<Long, Int>()
        fun updateMissing(client: Long, clock: Int) {
            val existing = missing[client]
            if (existing != null && existing <= clock) return
            missing[client] = clock
        }
        fun nextTarget(): Long? {
            while (ids.isNotEmpty()) {
                val last = ids.last()
                val target = targets[last]
                if (target != null && target.i < target.refs.size) return last
                ids.removeAt(ids.size - 1)
            }
            return null
        }
        fun take(client: Long): YItem? {
            val target = targets[client] ?: return null
            if (target.i >= target.refs.size) return null
            return target.refs[target.i++]
        }
        fun stackToRest() {
            for (item in stack) {
                val client = item.id.client
                val target = targets[client]
                if (target != null) {
                    target.i -= 1
                    rest[client] = target.refs.subList(target.i, target.refs.size).toMutableList()
                    targets.remove(client)
                } else {
                    rest[client] = mutableListOf(item)
                }
                ids.removeAll { it == client }
            }
            stack.clear()
        }
        var current = nextTarget()
        var head = current?.let(::take) ?: return null
        while (true) {
            if (head.kind != YItem.Kind.Skip) {
                val client = head.id.client
                val localClock = state[client] ?: store.state(client)
                state[client] = localClock
                val offset = localClock - head.id.clock
                if (offset < 0) {
                    stack += head
                    updateMissing(client, head.id.clock - 1)
                    stackToRest()
                } else {
                    val need = head.getMissing(transaction, store)
                    if (need != null) {
                        stack += head
                        val target = targets[need]
                        if (target != null && target.i < target.refs.size) {
                            head = take(need)!!
                            continue
                        }
                        updateMissing(need, store.state(need))
                        stackToRest()
                    } else if (offset == 0 || offset < head.length) {
                        head.integrate(transaction, offset)
                        state[client] = head.id.clock + head.length
                    }
                }
            }
            if (stack.isNotEmpty()) {
                head = stack.removeAt(stack.size - 1)
            } else {
                val next = current?.let(::take)
                if (next != null) {
                    head = next
                } else {
                    current = nextTarget()
                    head = current?.let(::take) ?: break
                }
            }
        }
        return if (rest.isEmpty()) null else YPending(rest, missing)
    }

    /** Deletes ranges; returns those whose structs are not here yet (`readAndApplyDeleteSet`). */
    private fun applyDeletes(transaction: YTransaction, deletes: YDeleteSet): YDeleteSet {
        val unapplied = YDeleteSet()
        for ((client, ranges) in deletes.clients) {
            val state = store.state(client)
            for (range in ranges) {
                val clock = range.clock
                val end = clock + range.length
                if (clock >= state) {
                    unapplied.add(client, clock, end - clock)
                    continue
                }
                if (state < end) unapplied.add(client, state, end - state)
                val structs = store.clients[client]!!
                var index = YStructStore.findIndex(structs, clock)
                val first = structs[index]
                if (!first.deleted && first.id.clock < clock && first.kind == YItem.Kind.Item) {
                    structs.add(index + 1, store.split(transaction, first, clock - first.id.clock))
                    index++
                }
                while (index < structs.size) {
                    val item = structs[index]
                    index++
                    if (item.id.clock >= end) break
                    if (!item.deleted) {
                        if (end < item.id.clock + item.length && item.kind == YItem.Kind.Item) {
                            structs.add(index, store.split(transaction, item, end - item.id.clock))
                        }
                        item.delete(transaction)
                    }
                }
            }
        }
        unapplied.sortAndMerge()
        return unapplied
    }

    /** The structs of every client past [vector] (`writeClientsStructs`). */
    internal fun writeStructs(encoder: YEncoder, vector: Map<Long, Int>) {
        val wanted = ArrayList<Pair<Long, Int>>()
        for ((client, structs) in store.clients) {
            val last = structs.lastOrNull() ?: continue
            val clock = vector[client] ?: 0
            if (last.id.clock + last.length > clock) wanted += client to clock
        }
        encoder.writeVarUint(wanted.size)
        for ((client, clock) in wanted.sortedByDescending { it.first }) {
            val structs = store.clients[client]!!
            val start = maxOf(clock, structs[0].id.clock)
            val index = YStructStore.findIndex(structs, start)
            encoder.writeVarUint(structs.size - index)
            encoder.writeVarUint(client)
            encoder.writeVarUint(start)
            structs[index].write(encoder, start - structs[index].id.clock)
            for (i in index + 1 until structs.size) structs[i].write(encoder, 0)
        }
    }

    /** The whole document, or only what [since] lacks (`Y.encodeStateAsUpdate`). */
    fun encodeStateAsUpdate(since: Map<Long, Int> = emptyMap()): ByteArray {
        val encoder = YEncoder()
        writeStructs(encoder, since)
        YDeleteSet.from(store).write(encoder)
        return encoder.bytes
    }

    companion object {
        private val random = SecureRandom()

        /** A random 32-bit client ID, as yjs picks one. */
        fun randomClientID(): Long = random.nextInt().toLong() and 0xFFFFFFFFL

        fun encodeStateVector(vector: Map<Long, Int>): ByteArray {
            val encoder = YEncoder()
            encoder.writeVarUint(vector.size)
            for ((client, clock) in vector.entries.sortedByDescending { it.key }) {
                encoder.writeVarUint(client)
                encoder.writeVarUint(clock)
            }
            return encoder.bytes
        }

        fun decodeStateVector(bytes: ByteArray): Map<Long, Int> {
            val decoder = YDecoder(bytes)
            val vector = HashMap<Long, Int>()
            repeat(decoder.readVarUint()) {
                val client = decoder.readVarUintLong()
                vector[client] = decoder.readVarUint()
            }
            return vector
        }

        /** The state vector an update leaves a document at, read without applying it. */
        fun updateStateVector(update: ByteArray): Map<Long, Int> = YDoc().also { it.applyUpdate(update) }.stateVector()

        /** A new, not yet inserted element, to insert with [YType.insert]. */
        fun element(name: String) = YType(YType.Kind.XmlElement(name))
        fun text() = YType(YType.Kind.XmlText)
    }
}

/** What a transaction did, for whoever follows the document. */
class YTransactionResult(
    val update: ByteArray,
    val local: Boolean,
    val origin: String?,
    val changed: List<YType>,
    val deleteSet: YDeleteSet,
)

class YTransaction internal constructor(internal val doc: YDoc, val origin: String?, val local: Boolean) {
    internal val deleteSet = YDeleteSet()
    internal val beforeState: Map<Long, Int> = doc.store.stateVector()
    internal var afterState: Map<Long, Int> = emptyMap()
    internal val changed = LinkedHashMap<YType, MutableSet<String?>>()
    internal val mergeStructs = ArrayList<YItem>()

    /** Records a change to a type that existed before this transaction. */
    internal fun addChanged(type: YType, key: String?) {
        val item = type.item
        if (item != null && (item.id.clock >= (beforeState[item.id.client] ?: 0) || item.deleted)) return
        changed.getOrPut(type) { HashSet() }.add(key)
    }
}

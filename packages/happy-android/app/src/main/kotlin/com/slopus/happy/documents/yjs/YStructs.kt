package com.slopus.happy.documents.yjs

/** One position in a Yjs document: a client (a uint32) and its own counter. */
data class YID(val client: Long, val clock: Int) {
    override fun toString() = "$client:$clock"
}

/**
 * What an item holds, numbered as Yjs numbers its content kinds. Strings
 * are UTF-16 code units, as Yjs counts them (a Kotlin String already is).
 */
internal sealed class YContent {
    class Deleted(val count: Int) : YContent()
    class Json(val values: List<YAny>) : YContent()
    class Binary(val data: ByteArray) : YContent()
    class Str(val units: String) : YContent()
    class Embed(val value: YAny) : YContent()
    class Format(val key: String, val value: YAny) : YContent()
    class Type(val type: YType) : YContent()
    class AnyList(val values: List<YAny>) : YContent()
    class Doc(val guid: String, val opts: YAny) : YContent()

    val ref: Int
        get() = when (this) {
            is Deleted -> 1
            is Json -> 2
            is Binary -> 3
            is Str -> 4
            is Embed -> 5
            is Format -> 6
            is Type -> 7
            is AnyList -> 8
            is Doc -> 9
        }

    val length: Int
        get() = when (this) {
            is Deleted -> count
            is Json -> values.size
            is Str -> units.length
            is AnyList -> values.size
            else -> 1
        }

    val countable: Boolean get() = this !is Deleted && this !is Format

    /** Splits at [offset] into the left and right parts. */
    fun splice(offset: Int): Pair<YContent, YContent> = when (this) {
        is Deleted -> Deleted(offset) to Deleted(count - offset)
        is Json -> Json(values.subList(0, offset).toList()) to Json(values.subList(offset, values.size).toList())
        is AnyList -> AnyList(values.subList(0, offset).toList()) to AnyList(values.subList(offset, values.size).toList())
        is Str -> {
            var left = units.substring(0, offset)
            var right = units.substring(offset)
            // A surrogate pair is never split: both halves become U+FFFD, as in Yjs.
            if (left.isNotEmpty() && Character.isHighSurrogate(left.last())) {
                left = left.substring(0, left.length - 1) + '\uFFFD'
                if (right.isNotEmpty()) right = '\uFFFD' + right.substring(1)
            }
            Str(left) to Str(right)
        }
        else -> this to this
    }

    /** The part after [offset], for an item integrated from part way through. */
    fun split(offset: Int): YContent = splice(offset).second

    /** This and [right] as one, when the two can be one item. */
    fun merged(right: YContent): YContent? = when {
        this is Deleted && right is Deleted -> Deleted(count + right.count)
        this is Str && right is Str -> Str(units + right.units)
        this is AnyList && right is AnyList -> AnyList(values + right.values)
        this is Json && right is Json -> Json(values + right.values)
        else -> null
    }

    fun write(encoder: YEncoder, offset: Int) {
        when (this) {
            is Deleted -> encoder.writeVarUint(count - offset)
            is Json -> {
                encoder.writeVarUint(values.size - offset)
                for (i in offset until values.size) encoder.writeVarString(if (values[i] == YAny.Undefined) "undefined" else values[i].jsonString)
            }
            is Binary -> encoder.writeVarUint8Array(data)
            is Str -> encoder.writeVarString(if (offset == 0) units else units.substring(offset))
            is Embed -> encoder.writeVarString(value.jsonString)
            is Format -> {
                encoder.writeVarString(key)
                encoder.writeVarString(value.jsonString)
            }
            is Type -> {
                encoder.writeVarUint(type.kind.ref)
                when (val kind = type.kind) {
                    is YType.Kind.XmlElement -> encoder.writeVarString(kind.name)
                    is YType.Kind.XmlHook -> encoder.writeVarString(kind.name)
                    else -> Unit
                }
            }
            is AnyList -> {
                encoder.writeVarUint(values.size - offset)
                for (i in offset until values.size) encoder.writeAny(values[i])
            }
            is Doc -> {
                encoder.writeVarString(guid)
                encoder.writeAny(opts)
            }
        }
    }

    companion object {
        fun read(decoder: YDecoder, info: Int): YContent = when (info and 0x1F) {
            1 -> Deleted(decoder.readVarUint())
            2 -> {
                val count = decoder.readVarUint()
                Json(List(count) {
                    val text = decoder.readVarString()
                    if (text == "undefined") YAny.Undefined else YAny.parseJSON(text)
                })
            }
            3 -> Binary(decoder.readVarUint8Array())
            4 -> Str(decoder.readVarString())
            5 -> Embed(YAny.parseJSON(decoder.readVarString()))
            6 -> {
                val key = decoder.readVarString()
                Format(key, YAny.parseJSON(decoder.readVarString()))
            }
            7 -> {
                val kind = when (val ref = decoder.readVarUint()) {
                    0 -> YType.Kind.Array
                    1 -> YType.Kind.Map
                    2 -> YType.Kind.Text
                    3 -> YType.Kind.XmlElement(decoder.readVarString())
                    4 -> YType.Kind.XmlFragment
                    5 -> YType.Kind.XmlHook(decoder.readVarString())
                    6 -> YType.Kind.XmlText
                    else -> throw YError.Malformed("type ref $ref")
                }
                Type(YType(kind))
            }
            8 -> {
                val count = decoder.readVarUint()
                val values = ArrayList<YAny>(minOf(count, 1024))
                repeat(count) { values += decoder.readAny() }
                AnyList(values)
            }
            9 -> {
                val guid = decoder.readVarString()
                Doc(guid, decoder.readAny())
            }
            else -> throw YError.Malformed("content ref ${info and 0x1F}")
        }
    }
}

/** Where an item belongs: a type, or before integration an item's ID or a root name. */
internal sealed class YParent {
    data object None : YParent()
    class Type(val value: YType) : YParent()
    class Id(val id: YID) : YParent()
    class Root(val name: String) : YParent()

    val type: YType? get() = (this as? Type)?.value
}

/**
 * An item, or a garbage-collected range (`gc`), or a range an update skips
 * (`skip`). One class for all three keeps the struct store a plain list.
 */
class YItem private constructor(
    internal val kind: Kind,
    var id: YID,
    internal var length: Int,
    internal var origin: YID?,
    internal var left: YItem?,
    internal var right: YItem?,
    internal var rightOrigin: YID?,
    internal var parent: YParent,
    internal var parentSub: String?,
    internal var content: YContent,
    var deleted: Boolean,
) {
    internal enum class Kind { Item, Gc, Skip }

    internal var keep = false

    internal constructor(id: YID, left: YItem?, origin: YID?, right: YItem?, rightOrigin: YID?, parent: YParent, parentSub: String?, content: YContent) :
        this(Kind.Item, id, content.length, origin, left, right, rightOrigin, parent, parentSub, content, false)

    internal companion object {
        fun gc(id: YID, length: Int) = YItem(Kind.Gc, id, length, null, null, null, null, YParent.None, null, YContent.Deleted(length), true)
        fun skip(id: YID, length: Int) = YItem(Kind.Skip, id, length, null, null, null, null, YParent.None, null, YContent.Deleted(length), false)
    }

    val lastId: YID get() = if (length == 1) id else YID(id.client, id.clock + length - 1)
    internal val countable: Boolean get() = kind == Kind.Item && content.countable
    internal val parentType: YType? get() = parent.type

    /** Visible text length this item adds to its parent. */
    internal val visibleLength: Int get() = if (!deleted && countable) length else 0

    internal fun markDeleted() { deleted = true }

    /**
     * The client whose earlier change this item needs, or null once its
     * neighbours and parent are found (`Item.getMissing`).
     */
    internal fun getMissing(transaction: YTransaction, store: YStructStore): Long? {
        val origin = origin
        val rightOrigin = rightOrigin
        if (origin != null && origin.client != id.client && origin.clock >= store.state(origin.client)) return origin.client
        if (rightOrigin != null && rightOrigin.client != id.client && rightOrigin.clock >= store.state(rightOrigin.client)) return rightOrigin.client
        val p = parent
        if (p is YParent.Id && id.client != p.id.client && p.id.clock >= store.state(p.id.client)) return p.id.client
        if (origin != null) {
            left = store.itemCleanEnd(transaction, origin)
            this.origin = left?.lastId
        }
        if (rightOrigin != null) {
            right = store.itemCleanStart(transaction, rightOrigin)
            this.rightOrigin = right?.id
        }
        val l = left
        val r = right
        if (l?.kind == Kind.Gc || r?.kind == Kind.Gc) {
            parent = YParent.None
        } else when (val current = parent) {
            YParent.None -> {
                if (l != null && l.kind == Kind.Item) {
                    parent = l.parent
                    parentSub = l.parentSub
                } else if (r != null && r.kind == Kind.Item) {
                    parent = r.parent
                    parentSub = r.parentSub
                }
            }
            is YParent.Id -> {
                val parentItem = store.item(current.id)
                val content = parentItem.content
                parent = if (parentItem.kind != Kind.Gc && content is YContent.Type) YParent.Type(content.type) else YParent.None
            }
            is YParent.Root -> parent = YParent.Type(transaction.doc.root(current.name))
            is YParent.Type -> Unit
        }
        return null
    }

    /**
     * YATA: places the item among concurrent inserts at the same spot, so
     * every replica orders them the same way (`Item.integrate`).
     */
    internal fun integrate(transaction: YTransaction, offset: Int) {
        val store = transaction.doc.store
        if (kind != Kind.Item) {
            if (offset > 0) {
                id = YID(id.client, id.clock + offset)
                length -= offset
            }
            store.add(this)
            return
        }
        if (offset > 0) {
            id = YID(id.client, id.clock + offset)
            left = store.itemCleanEnd(transaction, YID(id.client, id.clock - 1))
            origin = left?.lastId
            content = content.split(offset)
            length -= offset
        }
        (parent as? YParent.Root)?.let { parent = YParent.Type(transaction.doc.root(it.name)) }
        val parentType = parent.type
        if (parentType == null) {
            // No parent: the item's place was collected; keep its range as GC.
            store.add(gc(id, length))
            return
        }
        val l0 = left
        if ((l0 == null && (right == null || right?.left != null)) || (l0 != null && l0.right !== right)) {
            var newLeft = l0
            var o: YItem? = when {
                l0 != null -> l0.right
                parentSub != null -> {
                    var first = parentType.map[parentSub]
                    while (first?.left != null) first = first.left
                    first
                }
                else -> parentType.start
            }
            val conflicting = HashSet<YItem>()
            val beforeOrigin = HashSet<YItem>()
            while (o != null && o !== right) {
                val current: YItem = o
                beforeOrigin += current
                conflicting += current
                val currentOrigin = current.origin
                if (origin == currentOrigin) {
                    if (current.id.client < id.client) {
                        newLeft = current
                        conflicting.clear()
                    } else if (rightOrigin == current.rightOrigin) {
                        break
                    }
                } else if (currentOrigin != null && store.item(currentOrigin) in beforeOrigin) {
                    if (store.item(currentOrigin) !in conflicting) {
                        newLeft = current
                        conflicting.clear()
                    }
                } else {
                    break
                }
                o = current.right
            }
            left = newLeft
        }
        val l = left
        if (l != null) {
            right = l.right
            l.right = this
        } else {
            val r: YItem?
            if (parentSub != null) {
                var first = parentType.map[parentSub]
                while (first?.left != null) first = first.left
                r = first
            } else {
                r = parentType.start
                parentType.start = this
            }
            right = r
        }
        val r = right
        if (r != null) {
            r.left = this
        } else if (parentSub != null) {
            parentType.map[parentSub!!] = this
            left?.delete(transaction)
        }
        if (parentSub == null && countable && !deleted) parentType.length += length
        store.add(this)
        (content as? YContent.Type)?.type?.integrate(transaction.doc, this)
        if (content is YContent.Format) parentType.needsFormattingCleanup = true
        transaction.addChanged(parentType, parentSub)
        if (parentType.item?.deleted == true || (parentSub != null && right != null)) delete(transaction)
    }

    internal fun delete(transaction: YTransaction) {
        if (deleted || kind != Kind.Item) return
        val parentType = parent.type
        if (countable && parentSub == null) parentType?.let { it.length -= length }
        deleted = true
        transaction.deleteSet.add(id.client, id.clock, length)
        if (parentType != null) transaction.addChanged(parentType, parentSub)
        val type = (content as? YContent.Type)?.type ?: return
        var child = type.start
        while (child != null) {
            if (!child.deleted) child.delete(transaction)
            else if (child.id.clock < (transaction.beforeState[child.id.client] ?: 0)) transaction.mergeStructs += child
            child = child.right
        }
        for (item in type.map.values) {
            if (!item.deleted) item.delete(transaction)
            else if (item.id.clock < (transaction.beforeState[item.id.client] ?: 0)) transaction.mergeStructs += item
        }
        transaction.changed.remove(type)
    }

    /** Drops a deleted item's content; a deleted type's children go entirely. */
    internal fun gc(store: YStructStore, parentGCd: Boolean) {
        if (!deleted || kind != Kind.Item) return
        val type = (content as? YContent.Type)?.type
        if (type != null) {
            var child = type.start
            while (child != null) {
                child.gc(store, true)
                child = child.right
            }
            type.start = null
            for (value in type.map.values) {
                var item: YItem? = value
                while (item != null) { item.gc(store, true); item = item.left }
            }
            type.map.clear()
        }
        if (parentGCd) store.replace(this, gc(id, length))
        else content = YContent.Deleted(length)
    }

    /** Joins [right] into this item when Yjs would (`Item.mergeWith`). */
    internal fun mergeWith(right: YItem): Boolean {
        if (kind == Kind.Gc && right.kind == Kind.Gc) {
            length += right.length
            return true
        }
        if (kind != Kind.Item || right.kind != Kind.Item ||
            right.origin != lastId || this.right !== right || rightOrigin != right.rightOrigin ||
            id.client != right.id.client || id.clock + length != right.id.clock ||
            deleted != right.deleted || content.ref != right.content.ref
        ) return false
        val joined = content.merged(right.content) ?: return false
        content = joined
        if (right.keep) keep = true
        this.right = right.right
        this.right?.left = this
        length += right.length
        return true
    }

    internal fun write(encoder: YEncoder, offset: Int) {
        when (kind) {
            Kind.Gc -> { encoder.write(0); encoder.writeVarUint(length - offset); return }
            Kind.Skip -> { encoder.write(10); encoder.writeVarUint(length - offset); return }
            Kind.Item -> Unit
        }
        val writtenOrigin = if (offset > 0) YID(id.client, id.clock + offset - 1) else origin
        val rightOrigin = rightOrigin
        var info = content.ref and 0x1F
        if (writtenOrigin != null) info = info or 0x80
        if (rightOrigin != null) info = info or 0x40
        if (parentSub != null) info = info or 0x20
        encoder.write(info)
        if (writtenOrigin != null) { encoder.writeVarUint(writtenOrigin.client); encoder.writeVarUint(writtenOrigin.clock) }
        if (rightOrigin != null) { encoder.writeVarUint(rightOrigin.client); encoder.writeVarUint(rightOrigin.clock) }
        if (writtenOrigin == null && rightOrigin == null) {
            when (val p = parent) {
                is YParent.Type -> {
                    val item = p.value.item
                    if (item != null) {
                        encoder.writeVarUint(0)
                        encoder.writeVarUint(item.id.client); encoder.writeVarUint(item.id.clock)
                    } else {
                        encoder.writeVarUint(1)
                        encoder.writeVarString(p.value.rootName ?: "")
                    }
                }
                is YParent.Root -> { encoder.writeVarUint(1); encoder.writeVarString(p.name) }
                is YParent.Id -> { encoder.writeVarUint(0); encoder.writeVarUint(p.id.client); encoder.writeVarUint(p.id.clock) }
                YParent.None -> { encoder.writeVarUint(1); encoder.writeVarString("") }
            }
            parentSub?.let { encoder.writeVarString(it) }
        }
        content.write(encoder, offset)
    }
}

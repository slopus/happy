package com.slopus.happy.documents.yjs

/**
 * A shared type: a root of the document, or the content of an item. One
 * class serves every kind (yjs subclasses `AbstractType`), so a root first
 * met as a name in an update becomes a fragment or map when asked.
 */
class YType internal constructor(kind: Kind) {
    sealed class Kind {
        data object Array : Kind()
        data object Map : Kind()
        data object Text : Kind()
        data class XmlElement(val name: String) : Kind()
        data object XmlFragment : Kind()
        data class XmlHook(val name: String) : Kind()
        data object XmlText : Kind()
        data object Unknown : Kind()

        internal val ref: Int
            get() = when (this) {
                Array -> 0
                Map -> 1
                Text -> 2
                is XmlElement -> 3
                XmlFragment, Unknown -> 4
                is XmlHook -> 5
                XmlText -> 6
            }
    }

    var kind: Kind = kind
        internal set
    internal var start: YItem? = null
    internal val map = HashMap<String, YItem>()
    /** Visible countable length: children, or UTF-16 units of text. */
    var length = 0
        internal set
    /** The item holding this type; null for a root. */
    internal var item: YItem? = null
    internal var doc: YDoc? = null
    internal var rootName: String? = null
    internal var needsFormattingCleanup = false

    internal fun integrate(doc: YDoc, item: YItem) {
        this.doc = doc
        this.item = item
    }

    /** An element's name, as `XmlElement.nodeName`. */
    val nodeName: String? get() = (kind as? Kind.XmlElement)?.name
    val isText: Boolean get() = kind == Kind.XmlText || kind == Kind.Text
    /** The ID of the item holding this type, the way an update names it. */
    val itemID: YID? get() = item?.id
    val parent: YType? get() = item?.parentType

    /** Visible children of a fragment or element. */
    val children: List<YType>
        get() {
            val out = ArrayList<YType>()
            var n = start
            while (n != null) {
                if (!n.deleted) (n.content as? YContent.Type)?.let { out += it.type }
                n = n.right
            }
            return out
        }

    fun child(index: Int): YType? {
        var remaining = index
        var n = start
        while (n != null) {
            if (!n.deleted && n.countable) {
                if (remaining < n.length) return (n.content as? YContent.Type)?.type
                remaining -= n.length
            }
            n = n.right
        }
        return null
    }

    /** The visible index of a child type, or null. */
    fun indexOf(childType: YType): Int? {
        var index = 0
        var n = start
        while (n != null) {
            if (!n.deleted && n.countable) {
                if ((n.content as? YContent.Type)?.type === childType) return index
                index += n.length
            }
            n = n.right
        }
        return null
    }

    /** Inserts new types at [index] (`typeListInsertGenerics`). */
    fun insert(transaction: YTransaction, index: Int, types: List<YType>) {
        check(index <= length) { "Yjs: insert past the end" }
        var reference: YItem? = null
        if (index > 0) {
            var remaining = index
            var n = start
            while (n != null) {
                if (!n.deleted && n.countable) {
                    if (remaining <= n.length) {
                        if (remaining < n.length) transaction.doc.store.itemCleanStart(transaction, YID(n.id.client, n.id.clock + remaining))
                        break
                    }
                    remaining -= n.length
                }
                n = n.right
            }
            reference = n
        }
        insert(transaction, reference, types)
    }

    internal fun insert(transaction: YTransaction, after: YItem?, types: List<YType>) {
        var left = after
        val right = if (after == null) start else after.right
        val doc = transaction.doc
        for (type in types) {
            val item = YItem(
                YID(doc.clientID, doc.store.state(doc.clientID)),
                left, left?.lastId, right, right?.id,
                YParent.Type(this), null, YContent.Type(type),
            )
            item.integrate(transaction, 0)
            left = item
        }
    }

    /** Deletes [count] visible children or units from [index] (`typeListDelete`). */
    fun delete(transaction: YTransaction, index: Int, count: Int) {
        if (count <= 0) return
        var remaining = index
        var left = count
        var n = start
        val store = transaction.doc.store
        while (n != null && remaining > 0) {
            if (!n.deleted && n.countable) {
                if (remaining < n.length) store.itemCleanStart(transaction, YID(n.id.client, n.id.clock + remaining))
                remaining -= minOf(remaining, n.length)
            }
            n = n.right
        }
        while (n != null && left > 0) {
            if (!n.deleted) {
                if (left < n.length) store.itemCleanStart(transaction, YID(n.id.client, n.id.clock + left))
                n.delete(transaction)
                left -= n.length
            }
            n = n.right
        }
    }

    fun attribute(key: String): YAny? {
        val item = map[key]?.takeIf { !it.deleted } ?: return null
        return when (val content = item.content) {
            is YContent.AnyList -> content.values.lastOrNull()
            is YContent.Json -> content.values.lastOrNull()
            is YContent.Embed -> content.value
            is YContent.Binary -> YAny.Bytes(content.data)
            else -> null
        }
    }

    /** The map's typed child under [key], such as a nested map. */
    fun mapType(key: String): YType? {
        val item = map[key]?.takeIf { !it.deleted } ?: return null
        return (item.content as? YContent.Type)?.type
    }

    val attributes: Map<String, YAny>
        get() = buildMap { for (key in map.keys) attribute(key)?.let { put(key, it) } }

    val mapKeys: List<String> get() = map.filter { !it.value.deleted }.keys.toList()

    /** Sets a value under [key], replacing the last one (`typeMapSet`). */
    fun setAttribute(transaction: YTransaction, key: String, value: YAny) {
        val left = map[key]
        val doc = transaction.doc
        val content = if (value is YAny.Bytes) YContent.Binary(value.value) else YContent.AnyList(listOf(value))
        YItem(YID(doc.clientID, doc.store.state(doc.clientID)), left, left?.lastId, null, null, YParent.Type(this), key, content)
            .integrate(transaction, 0)
    }

    fun removeAttribute(transaction: YTransaction, key: String) {
        map[key]?.delete(transaction)
    }

    /** One run of text, an embed or a type, with the formats over it (`toDelta`). */
    data class DeltaOp(val insert: Insert, val attributes: Map<String, YAny>) {
        sealed class Insert {
            data class Text(val text: String) : Insert()
            data class Embed(val value: YAny) : Insert()
            /** A type, compared by identity. */
            class Type(val type: YType) : Insert() {
                override fun equals(other: Any?) = other is Type && other.type === type
                override fun hashCode() = System.identityHashCode(type)
            }
        }
    }

    fun toDelta(): List<DeltaOp> {
        val ops = ArrayList<DeltaOp>()
        val current = Attributes()
        val units = StringBuilder()
        fun pack() {
            if (units.isEmpty()) return
            ops += DeltaOp(DeltaOp.Insert.Text(units.toString()), current.dictionary)
            units.setLength(0)
        }
        var n = start
        while (n != null) {
            if (!n.deleted) {
                when (val content = n.content) {
                    is YContent.Str -> units.append(content.units)
                    is YContent.Embed -> { pack(); ops += DeltaOp(DeltaOp.Insert.Embed(content.value), current.dictionary) }
                    is YContent.Type -> { pack(); ops += DeltaOp(DeltaOp.Insert.Type(content.type), current.dictionary) }
                    is YContent.Format -> { pack(); current.update(content.key, content.value) }
                    else -> Unit
                }
            }
            n = n.right
        }
        pack()
        return ops
    }

    /** The text alone. */
    val string: String
        get() {
            val units = StringBuilder()
            var n = start
            while (n != null) {
                if (!n.deleted) (n.content as? YContent.Str)?.let { units.append(it.units) }
                n = n.right
            }
            return units.toString()
        }

    /** Ordered attributes, as a JavaScript `Map` keeps them. */
    internal class Attributes(val pairs: MutableList<Pair<String, YAny>> = ArrayList()) {
        fun copy() = Attributes(pairs.toMutableList())
        fun get(key: String): YAny? = pairs.firstOrNull { it.first == key }?.second
        fun set(key: String, value: YAny) {
            val i = pairs.indexOfFirst { it.first == key }
            if (i >= 0) pairs[i] = key to value else pairs += key to value
        }
        fun remove(key: String) { pairs.removeAll { it.first == key } }
        /** A format item: null ends it. */
        fun update(key: String, value: YAny) = if (value == YAny.Null) remove(key) else set(key, value)
        val dictionary: Map<String, YAny> get() = pairs.toMap()
    }

    internal class TextPosition(var left: YItem?, var right: YItem?, var index: Int, var attributes: Attributes) {
        fun forward() {
            val item = right ?: return
            val content = item.content
            if (content is YContent.Format) {
                if (!item.deleted) attributes.update(content.key, content.value)
            } else if (!item.deleted && item.countable) {
                index += item.length
            }
            left = item
            right = item.right
        }
    }

    internal fun findPosition(transaction: YTransaction, index: Int): TextPosition {
        val pos = TextPosition(null, start, 0, Attributes())
        var count = index
        val store = transaction.doc.store
        while (count > 0) {
            val item = pos.right ?: break
            val content = item.content
            if (content is YContent.Format) {
                if (!item.deleted) pos.attributes.update(content.key, content.value)
            } else if (!item.deleted && item.countable) {
                if (count < item.length) store.itemCleanStart(transaction, YID(item.id.client, item.id.clock + count))
                pos.index += item.length
                count -= item.length
            }
            pos.left = item
            pos.right = item.right
        }
        return pos
    }

    private fun newItem(transaction: YTransaction, pos: TextPosition, content: YContent): YItem {
        val doc = transaction.doc
        val item = YItem(
            YID(doc.clientID, doc.store.state(doc.clientID)),
            pos.left, pos.left?.lastId, pos.right, pos.right?.id,
            YParent.Type(this), null, content,
        )
        item.integrate(transaction, 0)
        return item
    }

    private fun minimizeAttributeChanges(pos: TextPosition, attributes: List<Pair<String, YAny>>) {
        while (true) {
            val item = pos.right ?: break
            if (item.deleted) { pos.forward(); continue }
            val content = item.content
            if (content is YContent.Format && equalAttrs(attributes.firstOrNull { it.first == content.key }?.second, content.value)) {
                pos.forward()
                continue
            }
            break
        }
    }

    private fun insertAttributes(transaction: YTransaction, pos: TextPosition, attributes: List<Pair<String, YAny>>): Attributes {
        val negated = Attributes()
        for ((key, value) in attributes) {
            val current = pos.attributes.get(key) ?: YAny.Null
            if (!equalAttrs(current, value)) {
                negated.set(key, current)
                pos.right = newItem(transaction, pos, YContent.Format(key, value))
                pos.forward()
            }
        }
        return negated
    }

    private fun insertNegatedAttributes(transaction: YTransaction, pos: TextPosition, negatedIn: Attributes) {
        val negated = negatedIn.copy()
        while (true) {
            val item = pos.right ?: break
            if (item.deleted) { pos.forward(); continue }
            val content = item.content
            if (content is YContent.Format) {
                val wanted = negated.get(content.key)
                if (wanted != null && equalAttrs(wanted, content.value)) {
                    negated.remove(content.key)
                    pos.forward()
                    continue
                }
            }
            break
        }
        for ((key, value) in negated.pairs) {
            pos.right = newItem(transaction, pos, YContent.Format(key, value))
            pos.forward()
        }
    }

    /**
     * Inserts text formatted exactly with [attributes]; formats around it
     * that it does not name end before it (`insertText`).
     */
    fun insertText(transaction: YTransaction, index: Int, text: String, attributes: List<Pair<String, YAny>> = emptyList()) {
        if (text.isEmpty()) return
        insertContent(transaction, findPosition(transaction, index), YContent.Str(text), attributes)
    }

    fun insertEmbed(transaction: YTransaction, index: Int, value: YAny, attributes: List<Pair<String, YAny>> = emptyList()) {
        insertContent(transaction, findPosition(transaction, index), YContent.Embed(value), attributes)
    }

    private fun insertContent(transaction: YTransaction, pos: TextPosition, content: YContent, attributesIn: List<Pair<String, YAny>>) {
        val attributes = attributesIn.toMutableList()
        for ((key, _) in pos.attributes.pairs) if (attributes.none { it.first == key }) attributes += key to YAny.Null
        minimizeAttributeChanges(pos, attributes)
        val negated = insertAttributes(transaction, pos, attributes)
        pos.right = newItem(transaction, pos, content)
        pos.forward()
        insertNegatedAttributes(transaction, pos, negated)
    }

    /** Deletes [length] units of text from [index] (`deleteText`). */
    fun deleteText(transaction: YTransaction, index: Int, length: Int) {
        if (length <= 0) return
        val pos = findPosition(transaction, index)
        var remaining = length
        val startAttributes = pos.attributes.copy()
        val first = pos.right
        val store = transaction.doc.store
        while (remaining > 0) {
            val item = pos.right ?: break
            if (!item.deleted) {
                when (item.content) {
                    is YContent.Str, is YContent.Embed, is YContent.Type -> {
                        if (remaining < item.length) store.itemCleanStart(transaction, YID(item.id.client, item.id.clock + remaining))
                        remaining -= item.length
                        item.delete(transaction)
                    }
                    else -> Unit
                }
            }
            pos.forward()
        }
        if (first != null) cleanupFormattingGap(transaction, first, pos.right, startAttributes, pos.attributes)
    }

    /** Sets formats over a range; null removes one (`formatText`). */
    fun format(transaction: YTransaction, index: Int, length: Int, attributes: List<Pair<String, YAny>>) {
        if (length <= 0) return
        val pos = findPosition(transaction, index)
        var remaining = length
        minimizeAttributeChanges(pos, attributes)
        val negated = insertAttributes(transaction, pos, attributes)
        val store = transaction.doc.store
        while (true) {
            val item = pos.right ?: break
            if (!(remaining > 0 || (negated.pairs.isNotEmpty() && (item.deleted || item.content is YContent.Format)))) break
            if (!item.deleted) {
                val content = item.content
                if (content is YContent.Format) {
                    val wanted = attributes.firstOrNull { it.first == content.key }?.second
                    if (wanted != null) {
                        if (equalAttrs(wanted, content.value)) {
                            negated.remove(content.key)
                        } else {
                            if (remaining == 0) break
                            negated.set(content.key, content.value)
                        }
                        item.delete(transaction)
                    } else {
                        pos.attributes.set(content.key, content.value)
                    }
                } else if (item.countable) {
                    if (remaining < item.length) store.itemCleanStart(transaction, YID(item.id.client, item.id.clock + remaining))
                    remaining -= item.length
                }
            }
            pos.forward()
        }
        insertNegatedAttributes(transaction, pos, negated)
    }

    /** Removes formats a deletion left with nothing to format (`cleanupFormattingGap`). */
    private fun cleanupFormattingGap(transaction: YTransaction, startItem: YItem, curr: YItem?, startAttributes: Attributes, currAttributes: Attributes) {
        var end: YItem? = startItem
        val endFormats = HashMap<String, YItem>()
        while (end != null && (!end.countable || end.deleted)) {
            val content = end.content
            if (!end.deleted && content is YContent.Format) endFormats[content.key] = end
            end = end.right
        }
        var reachedCurr = false
        var cursor: YItem? = startItem
        while (cursor != null && cursor !== end) {
            val item: YItem = cursor
            if (curr === item) reachedCurr = true
            val content = item.content
            if (!item.deleted && content is YContent.Format) {
                val key = content.key
                val value = content.value
                val startValue = startAttributes.get(key) ?: YAny.Null
                if (endFormats[key] !== item || startValue == value) {
                    item.delete(transaction)
                    if (!reachedCurr && (currAttributes.get(key) ?: YAny.Null) == value && startValue != value) {
                        if (startValue == YAny.Null) currAttributes.remove(key) else currAttributes.set(key, startValue)
                    }
                }
                if (!reachedCurr && !item.deleted) currAttributes.update(key, value)
            }
            cursor = item.right
        }
    }

    private companion object {
        fun equalAttrs(a: YAny?, b: YAny?): Boolean = (a ?: YAny.Null) == (b ?: YAny.Null)
    }
}

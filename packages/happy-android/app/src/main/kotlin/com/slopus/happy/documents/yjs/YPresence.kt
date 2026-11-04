package com.slopus.happy.documents.yjs

/**
 * A position that stays put while others edit around it
 * (`RelativePosition`): the item to its right, or the end of a type.
 * Cursors travel as these.
 */
data class YRelativePosition(val type: YID?, val tname: String?, val item: YID?, val assoc: Int = 0) {
    /** The type and index it stands at now (`createAbsolutePositionFromRelativePosition`). */
    fun resolve(doc: YDoc): Pair<YType, Int>? {
        val store = doc.store
        val rightID = item
        if (rightID != null) {
            if (store.state(rightID.client) <= rightID.clock) return null
            val right = store.item(rightID)
            val parent = right.parentType
            if (right.kind != YItem.Kind.Item || parent == null) return null
            var index = 0
            if (parent.item?.deleted != true) {
                val diff = rightID.clock - right.id.clock
                index = if (right.deleted || !right.countable) 0 else diff + (if (assoc >= 0) 0 else 1)
                var n = right.left
                while (n != null) {
                    if (!n.deleted && n.countable) index += n.length
                    n = n.left
                }
            }
            return parent to index
        }
        val found: YType = when {
            tname != null -> doc.root(tname)
            type != null -> {
                if (store.state(type.client) <= type.clock) return null
                val holder = store.item(type)
                if (holder.kind != YItem.Kind.Item) return null
                (holder.content as? YContent.Type)?.type ?: return null
            }
            else -> return null
        }
        return found to (if (assoc >= 0) found.length else 0)
    }

    /** As `JSON.stringify` writes a `RelativePosition`, the way awareness carries it. */
    val json: YAny
        get() {
            fun id(id: YID?): YAny = id?.let { YAny.Object(listOf("client" to YAny.Number(it.client.toDouble()), "clock" to YAny.Number(it.clock.toDouble()))) } ?: YAny.Null
            return YAny.Object(listOf("type" to id(type), "tname" to (tname?.let { YAny.Str(it) } ?: YAny.Null), "item" to id(item), "assoc" to YAny.Number(assoc.toDouble())))
        }

    companion object {
        /** `createRelativePositionFromTypeIndex`. */
        fun from(parent: YType, index: Int, assoc: Int = 0): YRelativePosition {
            val typeID = parent.item?.id
            val tname = if (parent.item == null) parent.rootName else null
            var i = index
            if (assoc < 0) {
                if (i == 0) return YRelativePosition(typeID, tname, null, assoc)
                i -= 1
            }
            var t = parent.start
            while (t != null) {
                if (!t.deleted && t.countable) {
                    if (t.length > i) return YRelativePosition(typeID, tname, YID(t.id.client, t.id.clock + i), assoc)
                    i -= t.length
                }
                if (t.right == null && assoc < 0) return YRelativePosition(typeID, tname, t.lastId, assoc)
                t = t.right
            }
            return YRelativePosition(typeID, tname, null, assoc)
        }

        fun fromJson(json: YAny): YRelativePosition? {
            if (json !is YAny.Object) return null
            fun id(value: YAny?): YID? {
                val client = value?.get("client")?.numberValue ?: return null
                val clock = value["clock"]?.numberValue ?: return null
                return YID(client.toLong(), clock.toInt())
            }
            val position = YRelativePosition(id(json["type"]), json["tname"]?.stringValue, id(json["item"]), (json["assoc"]?.numberValue ?: 0.0).toInt())
            return if (position.type == null && position.tname == null && position.item == null) null else position
        }
    }
}

/** One replica's presence: y-protocols' awareness state with its clock. */
data class YAwarenessState(val clientID: Long, val clock: Int, /** The JSON state, or null once it left. */ val state: YAny?) {
    companion object {
        /** `encodeAwarenessUpdate` for these states. */
        fun encode(states: List<YAwarenessState>): ByteArray {
            val encoder = YEncoder()
            encoder.writeVarUint(states.size)
            for (state in states) {
                encoder.writeVarUint(state.clientID)
                encoder.writeVarUint(state.clock)
                encoder.writeVarString(state.state?.jsonString ?: "null")
            }
            return encoder.bytes
        }

        fun decode(bytes: ByteArray): List<YAwarenessState> {
            val decoder = YDecoder(bytes)
            return List(decoder.readVarUint()) {
                val client = decoder.readVarUintLong()
                val clock = decoder.readVarUint()
                val state = YAny.parseJSON(decoder.readVarString())
                YAwarenessState(client, clock, if (state == YAny.Null) null else state)
            }
        }
    }
}

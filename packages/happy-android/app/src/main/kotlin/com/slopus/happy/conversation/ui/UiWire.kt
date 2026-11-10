package com.slopus.happy.conversation.ui

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Chat UI as the daemon sends it (@slopus/happy-agent-client
// `sources/protocol/ui.ts` and `sources/ui/`, whose schemas are vendored as
// `ui.schema.json`): a flat list of typed components in a `ui` block of an
// agent message or the `ui` presentation of a `show_ui` call, and the
// `action` block each click leaves in a service message. Quick replies,
// which are not chat UI, are in QuickReplies.kt.

/** One document: its components, drawn top to bottom. */
@Immutable
data class UiDocument(val id: String, val components: List<UiComponent>) {
    companion object {
        /** Null where there is no document to draw: no id, or no component that reads. */
        fun parse(value: JsonElement?): UiDocument? {
            val o = value.obj ?: return null
            val id = o["id"].str ?: return null
            val components = o["components"].arr.orEmpty().mapNotNull(UiComponent::parse)
            return if (components.isEmpty()) null else UiDocument(id, components)
        }
    }
}

/**
 * One component. The types this build draws are read strictly, as their
 * schemas say (closed objects, bounds, plain text); any other type, and a
 * known one whose props don't fit, is [Other], drawn as its [fallback]
 * line.
 */
@Immutable
sealed interface UiComponent {
    val id: String
    /** One line of plain text the daemon wrote for a client that can't draw the component. */
    val fallback: String

    /** Slash-separated paths drawn as a tree; a path ending in "/" is a folder. */
    data class FileTree(override val id: String, override val fallback: String, val paths: List<String>) : UiComponent {
        companion object {
            const val TYPE = "file_tree"
            const val MAX_PATHS = 200
            const val MAX_PATH_LENGTH = 1024
        }
    }

    /**
     * Pictures, recordings and files of the presentation that carries the
     * document, each named by its index among the presentation's items, with
     * an optional one-line label.
     */
    data class Media(override val id: String, override val fallback: String, val items: List<Item>) : UiComponent {
        data class Item(val mediaIndex: Int, val label: String?)

        companion object {
            const val TYPE = "media"
            const val MAX_ITEMS = 24
            const val MAX_LABEL_LENGTH = 80
        }
    }

    /** The default model for new conversations, drawn live from the computer's configuration, with a control that changes it. */
    data class DefaultModel(override val id: String, override val fallback: String) : UiComponent {
        companion object {
            const val TYPE = "default_model"
        }
    }

    /** A type this build doesn't draw, or one it does whose props don't fit. */
    data class Other(override val id: String, override val fallback: String) : UiComponent

    companion object {
        /** No C0 or C1 control character, nor DEL: a path. */
        private val PATH = Regex("^[^\\u0000-\\u001f\\u007f-\\u009f]*$")

        /** As [PATH], and no bidirectional formatting character: a label. */
        private val PLAIN = Regex("^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]*$")

        /** Null for what is no component at all: not an object, or without an id or a type. */
        fun parse(value: JsonElement?): UiComponent? {
            val o = value.obj ?: return null
            val id = o["id"].str ?: return null
            val type = o["type"].str ?: return null
            val fallback = o["fallback"].str.orEmpty()
            return o["props"].obj?.let { known(id, fallback, type, it) } ?: Other(id, fallback)
        }

        private fun known(id: String, fallback: String, type: String, props: JsonObject): UiComponent? = when (type) {
            FileTree.TYPE -> paths(props)?.let { FileTree(id, fallback, it) }
            Media.TYPE -> items(props)?.let { Media(id, fallback, it) }
            DefaultModel.TYPE -> if (props.isEmpty()) DefaultModel(id, fallback) else null
            else -> null
        }

        private fun JsonObject.only(vararg names: String): Boolean = keys.all { it in names }

        private fun paths(props: JsonObject): List<String>? {
            if (!props.only("paths")) return null
            val paths = props["paths"].arr?.map { it.str ?: return null } ?: return null
            if (paths.size !in 1..FileTree.MAX_PATHS) return null
            return paths.takeIf { all -> all.all { it.length in 1..FileTree.MAX_PATH_LENGTH && PATH.matches(it) } }
        }

        private fun items(props: JsonObject): List<Media.Item>? {
            if (!props.only("items")) return null
            val items = props["items"].arr?.map { value ->
                val item = value.obj?.takeIf { it.only("mediaIndex", "label") } ?: return null
                val index = item["mediaIndex"].num?.takeIf { it % 1.0 == 0.0 && it >= 0 && it < Media.MAX_ITEMS } ?: return null
                val label = item["label"]?.let { it.str?.takeIf { text -> text.length in 1..Media.MAX_LABEL_LENGTH && PLAIN.matches(text) } ?: return null }
                Media.Item(index.toInt(), label)
            } ?: return null
            return items.takeIf { it.size in 1..Media.MAX_ITEMS }
        }
    }
}

/** An action as the wire carries it: `{ type: "<component>.<action>", payload }`. */
@Immutable
data class UiAction(val type: String, val payload: JsonObject) {
    /** The component type the action is one of. */
    val component: String get() = type.substringBefore('.')

    fun json(): JsonObject = buildJsonObject {
        put("type", type)
        put("payload", payload)
    }

    companion object {
        fun parse(value: JsonElement?): UiAction? {
            val o = value.obj ?: return null
            return UiAction(o["type"].str ?: return null, o["payload"].obj ?: return null)
        }
    }
}

/** How an attempt stands: `pending` while its hook runs, then `accepted`, `rejected` or `failed`, with one sentence safe to show. */
@Immutable
data class UiOutcome(val status: String, val reason: String? = null) {
    val pending: Boolean get() = status == "pending"
    val refused: Boolean get() = status == "rejected" || status == "failed"

    companion object {
        fun parse(value: JsonElement?): UiOutcome? {
            val o = value.obj ?: return null
            return UiOutcome(o["status"].str ?: return null, o["reason"].str)
        }
    }
}

/** Which component of which offer: the agent message, its document and the component. */
@Immutable
data class UiOffer(val messageId: String, val uiId: String, val componentId: String)

/** An `action` block: one attempt at an [action] on an [offer], its secrets left out by the daemon, and how it stands. */
@Immutable
data class UiActionRecord(val offer: UiOffer, val action: UiAction, val outcome: UiOutcome) {
    companion object {
        fun parse(o: JsonObject): UiActionRecord? = UiActionRecord(
            UiOffer(o["messageId"].str ?: return null, o["uiId"].str ?: return null, o["componentId"].str ?: return null),
            UiAction.parse(o["action"]) ?: return null,
            UiOutcome.parse(o["outcome"]) ?: return null,
        )
    }
}

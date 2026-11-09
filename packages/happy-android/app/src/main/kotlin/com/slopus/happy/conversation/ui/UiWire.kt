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

// Chat UI as the daemon sends it (happy-agent API.md "Chat UI";
// @slopus/happy-agent-client `sources/protocol/ui.ts`, `fixtures/ui/`): a
// flat list of typed components in a `ui` block of an agent message or the
// `ui` presentation of a `show_ui` call, and the `action` blocks an action
// leaves. Every chat UI wire type is in this file; quick replies, which are
// not chat UI, are in QuickReplies.kt.

/** One document: its components, drawn top to bottom. */
@Immutable
data class UiDocument(val id: String, val components: List<UiComponent>) {
    companion object {
        fun parse(value: JsonElement?): UiDocument? {
            val o = value.obj ?: return null
            val components = o["components"].arr.orEmpty().mapNotNull(UiComponent::parse)
            if (components.isEmpty()) return null
            return UiDocument(o["id"].str ?: return null, components)
        }
    }
}

/**
 * One component. A type this build doesn't draw is [Other], shown as its
 * [fallback], the line the daemon wrote for it; so is one whose props don't
 * read.
 */
@Immutable
sealed interface UiComponent {
    val id: String
    val fallback: String
    val type: String
    /** The props as sent: what the client package's rules read ([UiCatalog.permission]). */
    val props: JsonObject

    /** Pictures the call presented, by their index among its items. */
    data class Images(override val id: String, override val fallback: String, val images: List<Image>, val columns: Int, override val props: JsonObject = NONE) : UiComponent {
        override val type: String get() = TYPE
        data class Image(val mediaIndex: Int, val alt: String?, val caption: String?)

        companion object {
            const val TYPE = "images"
        }
    }

    /** Paths drawn as their folders. */
    data class FileTree(override val id: String, override val fallback: String, val paths: List<String>, override val props: JsonObject = NONE) : UiComponent {
        override val type: String get() = TYPE

        companion object {
            const val TYPE = "file_tree"
        }
    }

    /**
     * Any other type: a live one drawn from the server's state (UiLiveViews),
     * else its fallback line, or nothing where the phone is no place for it
     * ([hidden]).
     */
    data class Other(override val id: String, override val fallback: String, override val type: String, override val props: JsonObject = NONE) : UiComponent {
        /** `phone_app` asks for the app this is; `phone_pair` pairs a phone with the computer it runs on. */
        val hidden: Boolean get() = type == PHONE_APP || type == PHONE_PAIR
    }

    companion object {
        const val PHONE_APP = "phone_app"
        const val PHONE_PAIR = "phone_pair"
        private val NONE = JsonObject(emptyMap())

        fun parse(value: JsonElement?): UiComponent? {
            val o = value.obj ?: return null
            val id = o["id"].str ?: return null
            val type = o["type"].str ?: return null
            val fallback = o["fallback"].str.orEmpty()
            val props = o["props"].obj ?: NONE
            return read(id, fallback, type, props) ?: Other(id, fallback, type, props)
        }

        private fun read(id: String, fallback: String, type: String, props: JsonObject): UiComponent? = when (type) {
            Images.TYPE -> Images(
                id, fallback,
                props["images"].arr.orEmpty().mapNotNull { value ->
                    val image = value.obj ?: return@mapNotNull null
                    Images.Image(image["mediaIndex"].num?.toInt() ?: return@mapNotNull null, image["alt"].str, image["caption"].str)
                }.takeIf { it.isNotEmpty() } ?: return null,
                props["columns"].num?.toInt()?.takeIf { it in 1..3 } ?: 0,
                props,
            )
            FileTree.TYPE -> FileTree(id, fallback, props["paths"].arr.orEmpty().mapNotNull { it.str }, props)
            else -> null
        }
    }
}

/** An action as the wire carries it: `{ type: "invite.create", payload }`. */
@Immutable
data class UiAction(val type: String, val payload: JsonObject) {
    fun json(): JsonObject = buildJsonObject {
        put("type", type)
        put("payload", payload)
    }

    companion object {
        fun parse(value: JsonElement?): UiAction? {
            val o = value.obj ?: return null
            return UiAction(o["type"].str ?: return null, o["payload"].obj ?: JsonObject(emptyMap()))
        }
    }
}

/** How an attempt ended: `pending`, `accepted`, `rejected` or `failed`, and why. */
@Immutable
data class UiOutcome(val status: String, val reason: String? = null, val code: String? = null) {
    val accepted: Boolean get() = status == "accepted"
    val refused: Boolean get() = status == "rejected" || status == "failed"

    companion object {
        fun parse(value: JsonElement?): UiOutcome? {
            val o = value.obj ?: return null
            return UiOutcome(o["status"].str ?: return null, o["reason"].str, o["code"].str)
        }
    }
}

/** Which component of which offer: the agent message, its document and the component. */
@Immutable
data class UiOffer(val messageId: String, val uiId: String, val componentId: String)

/** An `action` block: an action on [offer], secrets removed, and how it ended. */
@Immutable
data class UiActionRecord(val offer: UiOffer, val action: UiAction, val outcome: UiOutcome) {
    companion object {
        fun parse(o: JsonObject): UiActionRecord? = UiActionRecord(
            UiOffer(o["messageId"].str ?: return null, o["uiId"].str ?: return null, o["componentId"].str ?: return null),
            UiAction.parse(o["action"]) ?: return null,
            UiOutcome.parse(o["outcome"]) ?: UiOutcome("pending"),
        )
    }
}

package com.slopus.happy.conversation.ui

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The client package's chat UI rules, ported (@slopus/happy-agent-client
// `sources/ui/`: actionText.ts, offer.ts, permission.ts) and checked
// against its `fixtures/ui/` (UiActionsTest).

/** A press on its way from this phone: which offer, and what it sends. */
@Immutable
data class UiPress(val offer: UiOffer, val action: UiAction)

/** What an action needs the clicking person to hold, as its bundle declares it. */
sealed interface UiPermission {
    data class Id(val id: String) : UiPermission
    /** Chosen by one prop of the offer, else [default]. */
    data class ByProp(val prop: String, val map: Map<String, String>, val default: String) : UiPermission
    /** Only that the person can read the conversation. */
    data object ConversationRead : UiPermission
}

/** One action of the catalog: whether it becomes the person's words, whether it answers its offer, and what it needs. */
data class UiActionDefinition(val message: Boolean, val once: Boolean, val permission: UiPermission)

/**
 * Catalog version 1's actions (`ui.schema.json`), by `<component>.<action>`.
 * An action not here is one this build doesn't know.
 */
object UiCatalog {
    const val VERSION = 1

    private val write = UiPermission.Id("content.write")
    private val byTarget = UiPermission.ByProp("target", mapOf("team" to "providers.manage", "private" to "providers.own"), "providers.own")
    private val config = UiPermission.Id("config.manage")

    val actions: Map<String, UiActionDefinition> = mapOf(
        "choice.choose" to UiActionDefinition(message = true, once = true, write),
        "checklist.submit" to UiActionDefinition(message = true, once = true, write),
        "text_field.submit" to UiActionDefinition(message = true, once = true, write),
        "provider_sign_in.install" to UiActionDefinition(message = false, once = false, UiPermission.Id("providers.manage")),
        "provider_sign_in.sign_in" to UiActionDefinition(message = false, once = false, byTarget),
        "provider_sign_in.submit_code" to UiActionDefinition(message = false, once = false, byTarget),
        "provider_sign_in.submit_token" to UiActionDefinition(message = false, once = false, byTarget),
        "provider_sign_in.cancel" to UiActionDefinition(message = false, once = false, byTarget),
        "default_model.set" to UiActionDefinition(message = false, once = false, config),
        "phone_pair.start" to UiActionDefinition(message = false, once = false, config),
        "phone_pair.confirm" to UiActionDefinition(message = false, once = false, config),
        "phone_pair.cancel" to UiActionDefinition(message = false, once = false, config),
        "invite.create" to UiActionDefinition(message = false, once = false, UiPermission.Id("members.manage")),
        "invite.revoke" to UiActionDefinition(message = false, once = false, UiPermission.Id("members.manage")),
        "github_connect.install" to UiActionDefinition(message = false, once = false, UiPermission.Id("repositories.manage")),
        "github_connect.device_start" to UiActionDefinition(message = false, once = false, UiPermission.ConversationRead),
        "github_connect.connect" to UiActionDefinition(message = false, once = false, UiPermission.Id("repositories.manage")),
        "compute_join.create" to UiActionDefinition(message = false, once = false, UiPermission.Id("pools.manage")),
    )

    /**
     * `uiActionPermission`: the permission [actionType] needs against an
     * offer's [props], or null where reading the conversation is enough.
     * An action that declares nothing needs `content.write`.
     */
    fun permission(actionType: String, props: JsonObject): String? = when (val declared = actions[actionType]?.permission ?: write) {
        is UiPermission.Id -> declared.id
        is UiPermission.ByProp -> props[declared.prop].str?.let { declared.map[it] } ?: declared.default
        UiPermission.ConversationRead -> null
    }

    /** `uiActionAllowed`: whether a person [holds] what [actionType] needs; for showing only, the server decides. */
    fun allowed(actionType: String, props: JsonObject, holds: (String) -> Boolean): Boolean =
        permission(actionType, props)?.let(holds) ?: true
}

/** `uiOfferState`: whether an offer still takes an action. */
enum class UiOfferState {
    Open,
    /** The same answer again: it counts as accepted and changes nothing. */
    Repeat,
    Closed;

    companion object {
        /**
         * Not [once], always open. Once: the same accepted answer is a
         * repeat, another one closes it, and with none a person's message
         * recorded after the offer's ([personSpokeAfter]) closes it.
         */
        fun of(once: Boolean, accepted: UiAction?, personSpokeAfter: Boolean, action: UiAction): UiOfferState = when {
            !once -> Open
            accepted != null -> if (accepted.type == action.type && canonical(accepted.payload) == canonical(action.payload)) Repeat else Closed
            personSpokeAfter -> Closed
            else -> Open
        }

        /** JSON with object keys sorted, so two equal payloads compare equal. */
        fun canonical(value: JsonElement): String = when (value) {
            is JsonObject -> value.keys.sorted().joinToString(",", "{", "}") { "${JsonPrimitive(it)}:${canonical(value.getValue(it))}" }
            is JsonArray -> value.joinToString(",", "[", "]") { canonical(it) }
            else -> value.toString()
        }
    }
}

/**
 * `uiActionText`: the words a `"message"` action becomes as the person's
 * message against its offer's props, which the bubble drawn at once shows.
 * Null for a silent action, or a payload that doesn't fit the props.
 */
object UiActionText {
    fun of(type: String, props: JsonObject, action: UiAction): String? {
        val payload = action.payload
        return when (action.type) {
            "choice.choose" -> if (type != UiComponent.Choice.TYPE) null else options(props).firstOrNull { it.first == payload["optionId"].str }?.second
            "checklist.submit" -> {
                val submit = props["submitLabel"].str
                val selected = payload["selected"].arr
                if (type != UiComponent.Checklist.TYPE || submit == null || selected == null) return null
                val options = options(props)
                val ids = selected.map { it.str }
                if (ids.any { id -> options.none { it.first == id } }) return null
                val labels = options.filter { it.first in ids }.map { it.second }
                if (labels.isEmpty()) props["emptyLabel"].str ?: submit else "$submit: ${labels.joinToString(", ")}"
            }
            "text_field.submit" -> if (type != UiComponent.TextField.TYPE) null else payload["text"].str
            else -> null
        }
    }

    fun of(component: UiComponent, action: UiAction): String? = of(component.type, component.props, action)

    private fun options(props: JsonObject): List<Pair<String, String>> = props["options"].arr.orEmpty().mapNotNull { value ->
        val option = value.obj ?: return@mapNotNull null
        (option["id"].str ?: return@mapNotNull null) to (option["label"].str ?: return@mapNotNull null)
    }
}

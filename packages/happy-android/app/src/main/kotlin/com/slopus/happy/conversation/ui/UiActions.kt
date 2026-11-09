package com.slopus.happy.conversation.ui

import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonObject

// The client package's chat UI permission rules, ported
// (@slopus/happy-agent-client `sources/ui/permission.ts`) and checked
// against its `fixtures/ui/` (UiActionsTest). Every action is silent: no
// action becomes the person's words.

/** What an action needs the clicking person to hold, as its bundle declares it. */
sealed interface UiPermission {
    data class Id(val id: String) : UiPermission
    /** Chosen by one prop of the offer, else [default]. */
    data class ByProp(val prop: String, val map: Map<String, String>, val default: String) : UiPermission
    /** Only that the person can read the conversation. */
    data object ConversationRead : UiPermission
}

/**
 * Catalog version 1's actions (`ui.schema.json`), by `<component>.<action>`,
 * with what each needs. An action not here is one this build doesn't know.
 */
object UiCatalog {
    const val VERSION = 1

    private val write = UiPermission.Id("content.write")
    private val byTarget = UiPermission.ByProp("target", mapOf("team" to "providers.manage", "private" to "providers.own"), "providers.own")
    private val config = UiPermission.Id("config.manage")
    private val members = UiPermission.Id("members.manage")
    private val repositories = UiPermission.Id("repositories.manage")

    val actions: Map<String, UiPermission> = mapOf(
        "provider_sign_in.install" to UiPermission.Id("providers.manage"),
        "provider_sign_in.sign_in" to byTarget,
        "provider_sign_in.submit_code" to byTarget,
        "provider_sign_in.submit_token" to byTarget,
        "provider_sign_in.cancel" to byTarget,
        "default_model.set" to config,
        "phone_pair.start" to config,
        "phone_pair.confirm" to config,
        "phone_pair.cancel" to config,
        "invite.create" to members,
        "invite.revoke" to members,
        "github_connect.install" to repositories,
        "github_connect.device_start" to UiPermission.ConversationRead,
        "github_connect.connect" to repositories,
        "compute_join.create" to UiPermission.Id("pools.manage"),
    )

    /**
     * `uiActionPermission`: the permission [actionType] needs against an
     * offer's [props], or null where reading the conversation is enough.
     * An action that declares nothing needs `content.write`.
     */
    fun permission(actionType: String, props: JsonObject): String? = when (val declared = actions[actionType] ?: write) {
        is UiPermission.Id -> declared.id
        is UiPermission.ByProp -> props[declared.prop].str?.let { declared.map[it] } ?: declared.default
        UiPermission.ConversationRead -> null
    }

    /** `uiActionAllowed`: whether a person [holds] what [actionType] needs; for showing only, the server decides. */
    fun allowed(actionType: String, props: JsonObject, holds: (String) -> Boolean): Boolean =
        permission(actionType, props)?.let(holds) ?: true
}

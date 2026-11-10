package com.slopus.happy.conversation.ui

import com.slopus.happy.agent.Permission
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The actions this build sends, as the catalog declares them (the vendored
 * `ui.schema.json`, which `UiActionsTest` holds every entry here to): the
 * component an action is one of, the fields its payload takes, all of them
 * required, non-empty text and none marked `x-happy-secret`, and the
 * permission it needs. A secret field is never listed, so what [redacted]
 * keeps holds none.
 */
object UiActions {
    private class Entry(val component: (UiComponent) -> Boolean, val fields: Set<String>, val permission: String)

    const val SET_DEFAULT_MODEL = "default_model.set"

    private val catalog = mapOf(
        SET_DEFAULT_MODEL to Entry({ it is UiComponent.DefaultModel }, setOf("providerId", "modelId", "effort"), Permission.CONFIG_MANAGE),
    )

    /** `default_model.set`: new conversations start on this model at this effort. */
    fun setDefaultModel(providerId: String, modelId: String, effort: String) = UiAction(
        SET_DEFAULT_MODEL,
        buildJsonObject {
            put("providerId", providerId)
            put("modelId", modelId)
            put("effort", effort)
        },
    )

    /** The permission an action of [type] needs; null for one this build doesn't send. */
    fun permission(type: String): String? = catalog[type]?.permission

    /** Whether [component] takes [action]: one of its own, its payload exactly the fields it declares. */
    fun takes(component: UiComponent, action: UiAction): Boolean {
        val entry = catalog[action.type] ?: return false
        return entry.component(component) && action.payload.keys == entry.fields && action.payload.values.all { !it.str.isNullOrEmpty() }
    }

    /**
     * [action] as it may be kept while it is on its way, shown, logged or
     * stored: only the fields its entry lists. An action this build doesn't
     * know keeps no payload, because nothing here says which of its fields
     * are secret.
     */
    fun redacted(action: UiAction): UiAction {
        val fields = catalog[action.type]?.fields.orEmpty()
        return UiAction(action.type, JsonObject(action.payload.filterKeys { it in fields }))
    }
}

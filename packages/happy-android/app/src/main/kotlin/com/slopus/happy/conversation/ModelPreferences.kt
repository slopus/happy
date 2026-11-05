package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** What a new chat opens on: the last one started, or the default model chosen in Settings. */
enum class NewSessionStart { LastSession, DefaultModel }

/** A model's effort and speed as last used on one account (`happy-desktop.model.memory`). */
@Immutable
data class ModelMemory(val providerId: String, val modelId: String, val effort: String?, val serviceTier: String?)

/**
 * Desktop's model preferences (happyAgentModelPreferences.ts), the
 * person's own user settings on the agent, one key each so a change on one
 * device never overwrites another's: the default model (its id alone), the
 * default effort (`medium` when unset), the permission mode (`auto` when unset), the account
 * picked or started on last, each model's effort and speed per account, and
 * whether a new chat follows the last one started.
 */
@Immutable
data class ModelPreferences(
    val defaultModelId: String? = null,
    val defaultEffort: String = DEFAULT_EFFORT,
    val access: String? = null,
    val providerId: String? = null,
    /** Oldest first. */
    val memory: List<ModelMemory> = emptyList(),
    val start: NewSessionStart = NewSessionStart.LastSession,
) {
    /**
     * defaultSelectionResolve: the default model (else the catalog's) on the
     * account picked last when it serves it, else the catalog's default
     * account, else the first that does; the default effort where the model
     * runs it, else the model's own; the speed last used with it there. Each
     * falls back on its own. Null for a catalog with no default.
     */
    fun startMode(catalog: ModeCatalog): Mode? {
        val defaults = catalog.defaults
        val permission = permissionMode
        for (modelId in listOfNotNull(defaultModelId, defaults?.modelId).distinct()) {
            val serving = catalog.providers.filter { provider -> !provider.isDisabled && !provider.hidden && provider.models.any { it.modelId == modelId } }
            val provider = serving.firstOrNull { it.id == providerId } ?: serving.firstOrNull { it.id == defaults?.providerId } ?: serving.firstOrNull() ?: continue
            val model = provider.models.first { it.modelId == modelId }
            val tier = memory.lastOrNull { it.providerId == provider.id && it.modelId == modelId }?.serviceTier?.takeIf { it in model.serviceTiers }
            return Mode(provider.id, modelId, effortFor(model) ?: defaults?.effort ?: defaultEffort, tier, permission)
        }
        defaults ?: return null
        val model = catalog.model(defaults.providerId, defaults.modelId)
        return defaults.copy(effort = defaultEffort.takeIf { model != null && it in model.efforts } ?: defaults.effort, permissionMode = permission)
    }

    /** The default access mode: `auto` unless one was chosen, whatever the catalog's default, as desktop has it. */
    val permissionMode: String get() = access ?: "auto"

    private fun effortFor(model: ModelChoice): String? =
        defaultEffort.takeIf { it in model.efforts } ?: model.defaultEffort ?: model.efforts.firstOrNull()

    /**
     * selectionStarted: a chat was started on [mode]. Following the last
     * session, it becomes the default model and effort; either way its
     * account is the one picked last and its effort and speed are
     * remembered for the model.
     */
    fun started(mode: Mode): ModelPreferences {
        val follows = start == NewSessionStart.LastSession
        return copy(
            defaultModelId = if (follows) mode.modelId else defaultModelId,
            defaultEffort = if (follows) mode.effort else defaultEffort,
            providerId = mode.providerId,
            memory = memory.filterNot { it.providerId == mode.providerId && it.modelId == mode.modelId } +
                ModelMemory(mode.providerId, mode.modelId, mode.effort, mode.serviceTier),
        )
    }

    /** Each key as desktop writes it; a default is the setting cleared. */
    fun encode(): Map<String, JsonElement> = mapOf(
        DEFAULT_MODEL to (defaultModelId?.let { id -> buildJsonObject { put("modelId", id) } } ?: JsonNull),
        DEFAULT_EFFORT_KEY to (defaultEffort.takeIf { it != DEFAULT_EFFORT }?.let(::JsonPrimitive) ?: JsonNull),
        ACCESS to (access?.takeIf { it != "auto" }?.let(::JsonPrimitive) ?: JsonNull),
        PROVIDER to (providerId?.let(::JsonPrimitive) ?: JsonNull),
        MEMORY to memoryValue(),
        START to if (start == NewSessionStart.DefaultModel) JsonPrimitive("default") else JsonNull,
    )

    /** The keys [next] changes from these, each with its new value: what goes to the agent. */
    fun changes(next: ModelPreferences): Map<String, JsonElement> {
        val before = encode()
        return next.encode().filter { (key, value) -> before[key] != value }
    }

    /** memoryValue: the most recent 256 entries within 48 KiB, oldest first; none is the setting cleared. */
    private fun memoryValue(): JsonElement {
        val kept = ArrayList<JsonObject>()
        var bytes = 2
        for (entry in memory.asReversed()) {
            val value = buildJsonObject {
                put("providerId", entry.providerId)
                put("modelId", entry.modelId)
                put("effort", entry.effort?.let(::JsonPrimitive) ?: JsonNull)
                put("serviceTier", entry.serviceTier?.let(::JsonPrimitive) ?: JsonNull)
            }
            val size = value.toString().toByteArray().size + 1
            if (kept.size >= MEMORY_ENTRIES || bytes + size > MEMORY_BYTES) continue
            kept += value
            bytes += size
        }
        return if (kept.isEmpty()) JsonNull else JsonArray(kept.asReversed())
    }

    companion object {
        const val DEFAULT_MODEL = "happy-desktop.model.default"
        const val DEFAULT_EFFORT_KEY = "happy-desktop.model.effort"
        const val ACCESS = "happy-desktop.model.access"
        const val PROVIDER = "happy-desktop.model.provider"
        const val MEMORY = "happy-desktop.model.memory"
        const val START = "happy-desktop.model.start"

        const val DEFAULT_EFFORT = "medium"
        private const val MEMORY_ENTRIES = 256
        private const val MEMORY_BYTES = 48 * 1024
        private val EFFORTS = setOf("off", "on", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")
        private val ACCESS_MODES = setOf("auto", "workspace_write", "read_only", "full_access")

        private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }

        /** decode: each key read on its own; anything unset or not understood takes its default. */
        fun parse(values: Map<String, JsonElement>): ModelPreferences = ModelPreferences(
            // Older clients wrote `{providerId, modelId}`: the model alone counts.
            defaultModelId = (values[DEFAULT_MODEL] as? JsonObject)?.get("modelId").text(),
            defaultEffort = values[DEFAULT_EFFORT_KEY].text()?.takeIf { it in EFFORTS } ?: DEFAULT_EFFORT,
            access = values[ACCESS].text()?.takeIf { it in ACCESS_MODES },
            providerId = values[PROVIDER].text(),
            memory = (values[MEMORY] as? JsonArray).orEmpty().mapNotNull { raw ->
                val entry = raw as? JsonObject ?: return@mapNotNull null
                ModelMemory(
                    providerId = entry["providerId"].text() ?: return@mapNotNull null,
                    modelId = entry["modelId"].text() ?: return@mapNotNull null,
                    effort = entry["effort"].text()?.takeIf { it in EFFORTS },
                    serviceTier = entry["serviceTier"].text(),
                )
            },
            start = if (values[START].text() == "default") NewSessionStart.DefaultModel else NewSessionStart.LastSession,
        )
    }
}

package com.slopus.happy.model

import androidx.compose.runtime.Immutable

// sync/rigSessionCreation.ts: a Happy Agent (Rig) machine's published
// catalog as the new-session pickers offer it, and the spawn it validates.
// utils/permissionModeLabels.ts and utils/rigModelPickerOrder.ts give the
// display order.

/** rigSessionCreation.ts `RigMachineModelOption` */
@Immutable
data class RigModelOption(
    val key: String,
    val id: String,
    val providerId: String,
    val name: String,
    val providerName: String,
    val thinkingLevels: List<String>,
    val defaultThinkingLevel: String?,
)

/** rigSessionCreation.ts `RigMachineModeOption` */
@Immutable
data class RigModeOption(val key: String, val name: String, val description: String?, val semanticKind: String?)

/** rigSessionCreation.ts `RigMachineSessionCreation` */
@Immutable
data class RigSessionCreation(
    /** In picker order ([sortRigModelsForPicker]). */
    val models: List<RigModelOption>,
    /** In picker order ([sortPermissionModes]). */
    val permissionModes: List<RigModeOption>,
    val defaultModelKey: String?,
    val defaultPermissionMode: String?,
    val supportsWorktrees: Boolean,
    val supportsBots: Boolean,
    val pendingRetryAfterMs: Long?,
) {
    private fun modelFor(modelKey: String?): RigModelOption? =
        models.find { it.key == modelKey } ?: models.find { it.key == defaultModelKey }

    fun effortsForModel(modelKey: String?): List<String> = modelFor(modelKey)?.thinkingLevels.orEmpty()

    fun defaultEffortForModel(modelKey: String?): String? = modelFor(modelKey)?.defaultThinkingLevel
}

private fun nonEmpty(value: String?): String? = value?.takeIf { it.isNotBlank() }

/**
 * getRigMachineSessionCreation: null for a Happy CLI machine or a Happy
 * Agent that cannot start sessions. Defaults fall back to the order the
 * machine published, never the display order, so a sorted list can't hand
 * out more access than the harness listed first.
 */
fun MachineMetadata?.rigSessionCreation(): RigSessionCreation? {
    if (this == null || !isRigMachine() || capabilities?.newSession != true) return null
    val models = models.orEmpty().mapNotNull { model ->
        val providerId = nonEmpty(model.providerId) ?: nonEmpty(model.provider?.id) ?: return@mapNotNull null
        val id = nonEmpty(model.id) ?: nonEmpty(model.code) ?: return@mapNotNull null
        val levels = model.thinkingLevels.orEmpty().filter { it.isNotEmpty() }
        val declared = nonEmpty(model.defaultThinkingLevel)
        RigModelOption(
            key = qualifyRigModelKey(providerId, id),
            id = id,
            providerId = providerId,
            name = nonEmpty(model.name) ?: nonEmpty(model.value) ?: id,
            providerName = nonEmpty(model.providerName) ?: nonEmpty(model.provider?.name) ?: providerId,
            thinkingLevels = levels,
            defaultThinkingLevel = declared?.takeIf { it in levels } ?: levels.firstOrNull(),
        )
    }
    val published = operatingModes.orEmpty().mapNotNull { mode ->
        val key = nonEmpty(mode.code) ?: return@mapNotNull null
        RigModeOption(key, nonEmpty(mode.value) ?: key, nonEmpty(mode.description), nonEmpty(mode.kind))
    }
    val publishedModel = defaults?.let { d ->
        val provider = nonEmpty(d.providerId)
        val model = nonEmpty(d.modelId)
        if (provider != null && model != null) qualifyRigModelKey(provider, model) else null
    }
    val publishedPermission = nonEmpty(defaults?.permissionMode)
    return RigSessionCreation(
        models = sortRigModelsForPicker(models),
        permissionModes = sortPermissionModes(published),
        defaultModelKey = publishedModel?.takeIf { key -> models.any { it.key == key } } ?: models.firstOrNull()?.key,
        defaultPermissionMode = publishedPermission?.takeIf { key -> published.any { it.key == key } } ?: published.firstOrNull()?.key,
        supportsWorktrees = capabilities.worktrees == true,
        supportsBots = capabilities.bots == true,
        pendingRetryAfterMs = sessionCreation?.pendingRetryAfterMs?.takeIf { it.isFinite() }?.toLong(),
    )
}

private const val PENDING_RETRY_MIN_MS = 250L
private const val PENDING_RETRY_MAX_MS = 10_000L
private const val PENDING_RETRY_DEFAULT_MS = 1_000L

/** resolveRigPendingRetryDelayMs: the answer's delay, else the machine's, clamped to 250..10 000. */
fun resolveRigPendingRetryDelayMs(retryAfterMs: Long?, publishedRetryAfterMs: Long?): Long =
    (retryAfterMs ?: publishedRetryAfterMs ?: PENDING_RETRY_DEFAULT_MS).coerceIn(PENDING_RETRY_MIN_MS, PENDING_RETRY_MAX_MS)

/** rigSessionCreation.ts `RigSpawnConfiguration`, less what [com.slopus.happy.sync.SpawnSessionOptions] already says. */
data class RigSpawnConfiguration(val providerId: String, val modelId: String, val permissionMode: String, val effort: String)

/** Why the catalog refused a pick (buildRigSpawnConfiguration's throws). */
class RigSpawnException(message: String) : IllegalArgumentException(message)

/** buildRigSpawnConfiguration: the picks, or the machine's defaults, checked against what it published. */
fun RigSessionCreation.spawnConfiguration(modelKey: String?, permissionMode: String?, effort: String?): RigSpawnConfiguration {
    val key = modelKey ?: defaultModelKey
    val model = models.find { it.key == key } ?: throw RigSpawnException("The selected Rig model is unavailable.")
    val permission = permissionMode ?: defaultPermissionMode
    if (permission == null || permissionModes.none { it.key == permission }) {
        throw RigSpawnException("The selected Rig permission mode is unavailable.")
    }
    val level = effort ?: defaultEffortForModel(model.key)
    if (level == null || level !in model.thinkingLevels) {
        throw RigSpawnException("The selected Rig reasoning level is unavailable for this model.")
    }
    return RigSpawnConfiguration(model.providerId, model.id, permission, level)
}

private val PERMISSION_RANKS = mapOf(
    "auto" to 10, "edits" to 15, "plan" to 20, "workspace" to 30, "read" to 40, "yolo" to 50, "full" to 50, "default" to 100,
)
private const val UNRANKED = 90

private fun firstWord(name: String): String = name.trim().split(Regex("\\s+")).firstOrNull().orEmpty()

/** permissionModeLabels.ts `getPermissionModeShortLabel`: the chip's one word. */
fun permissionModeShortLabel(name: String?): String? = name?.let(::firstWord)?.ifEmpty { null }

/** permissionModeLabels.ts `sortPermissionModes`: by rank, unknown words keeping the harness's order. */
fun sortPermissionModes(modes: List<RigModeOption>): List<RigModeOption> =
    modes.withIndex()
        .sortedWith(compareBy({ PERMISSION_RANKS[firstWord(it.value.name).lowercase()] ?: UNRANKED }, { it.index }))
        .map { it.value }

/** rigModelPickerOrder.ts: Astra first within its provider, providers and the rest in published order. */
fun sortRigModelsForPicker(models: List<RigModelOption>): List<RigModelOption> {
    fun isAstra(model: RigModelOption) = model.id == "openai/gpt-6-astra" || model.id == "gpt-6-astra"
    return models.groupBy { it.providerId }.values.flatMap { group -> group.filter(::isAstra) + group.filterNot(::isAstra) }
}

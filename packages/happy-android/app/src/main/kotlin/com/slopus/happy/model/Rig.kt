package com.slopus.happy.model

import androidx.compose.runtime.Immutable

// The parts of happy-app's sync/rig.ts that read session metadata: who a
// Happy Agent (Rig) session is, what it is doing, and its git counts.

enum class ProviderIconKind { Codex, Claude, Grok, Kimi, Generic }

/** rig.ts `getProviderIconKind` */
fun providerIconKind(kind: String?): ProviderIconKind = when (kind?.trim()?.lowercase()) {
    "codex" -> ProviderIconKind.Codex
    "claude" -> ProviderIconKind.Claude
    "grok" -> ProviderIconKind.Grok
    "kimi" -> ProviderIconKind.Kimi
    else -> ProviderIconKind.Generic
}

fun SessionMetadata?.isRig(): Boolean = this?.client?.id == "rig"

fun SessionMetadata?.isRigV1(): Boolean = isRig() && (this?.rigMetadataVersion ?: 0) >= 1

private fun nonEmpty(value: String?): String? = value?.takeIf { it.isNotBlank() }

fun qualifyRigModelKey(providerId: String, modelId: String): String = "$providerId:$modelId"

@Immutable
data class RigModelDescriptor(
    val key: String,
    val id: String,
    val providerId: String,
    val name: String,
    val providerName: String,
    val providerKind: String,
    val contextWindow: Double? = null,
    val serviceTiers: List<String> = emptyList(),
    val thinkingLevels: List<String> = emptyList(),
    val defaultThinkingLevel: String? = null,
    val unavailable: Boolean = false,
)

/** rig.ts `getRigModels` */
fun SessionMetadata?.rigModels(): List<RigModelDescriptor> {
    if (!isRig()) return emptyList()
    return this?.models.orEmpty().mapNotNull { model ->
        val providerId = nonEmpty(model.provider?.id) ?: nonEmpty(model.providerId) ?: return@mapNotNull null
        val id = nonEmpty(model.id) ?: nonEmpty(model.code) ?: return@mapNotNull null
        RigModelDescriptor(
            key = qualifyRigModelKey(providerId, id),
            id = id,
            providerId = providerId,
            name = nonEmpty(model.name) ?: nonEmpty(model.value) ?: id,
            providerName = nonEmpty(model.provider?.name) ?: nonEmpty(model.providerName) ?: providerId,
            providerKind = nonEmpty(model.provider?.kind) ?: nonEmpty(model.providerKind) ?: "custom",
            contextWindow = model.contextWindow,
            serviceTiers = model.serviceTiers.orEmpty(),
            thinkingLevels = model.thinkingLevels.orEmpty(),
            defaultThinkingLevel = nonEmpty(model.defaultThinkingLevel),
        )
    }
}

/** rig.ts `getRigComposerMode`: the open draft first, else what the daemon last ran with. */
fun SessionMetadata?.rigComposerMode(): RigComposerMode? {
    if (!isRigV1()) return null
    return this?.draft ?: this?.lastMode
}

/** rig.ts `getRigSelectedModelPair` */
fun SessionMetadata?.rigSelectedModel(): Pair<String, String>? {
    if (!isRig()) return null
    val mode = rigComposerMode()
    val providerId = nonEmpty(mode?.providerId) ?: nonEmpty(this?.currentModelProviderId) ?: nonEmpty(this?.model?.first)
    val id = nonEmpty(mode?.modelId) ?: nonEmpty(this?.currentModelCode) ?: nonEmpty(this?.model?.second)
    return if (providerId != null && id != null) providerId to id else null
}

/** rig.ts `getRigCurrentModel` */
fun SessionMetadata?.rigCurrentModel(): RigModelDescriptor? {
    val (providerId, id) = rigSelectedModel() ?: return null
    val key = qualifyRigModelKey(providerId, id)
    return rigModels().find { it.key == key } ?: RigModelDescriptor(
        key = key,
        id = id,
        providerId = providerId,
        name = id,
        providerName = if (this?.provider?.id == providerId) this.provider.name
        else this?.providers?.find { it.id == providerId }?.name ?: providerId,
        providerKind = if (this?.provider?.id == providerId) this.provider.kind
        else this?.providers?.find { it.id == providerId }?.kind ?: "custom",
        unavailable = true,
    )
}

@Immutable
data class RigIdentity(
    val clientName: String,
    val clientVersion: String?,
    val providerName: String,
    val providerKind: ProviderIconKind,
    val modelName: String?,
)

/** rig.ts `getRigIdentity` */
fun SessionMetadata?.rigIdentity(): RigIdentity? {
    if (!isRig()) return null
    val currentModel = rigCurrentModel()
    return RigIdentity(
        clientName = nonEmpty(this?.client?.name) ?: "Rig",
        clientVersion = nonEmpty(this?.client?.version),
        providerName = nonEmpty(this?.provider?.name) ?: currentModel?.providerName ?: nonEmpty(this?.flavor) ?: "Provider",
        providerKind = providerIconKind(this?.provider?.kind ?: currentModel?.providerKind),
        modelName = currentModel?.name ?: nonEmpty(this?.currentModelCode),
    )
}

@Immutable
data class RigActivityIndicator(val key: String, val count: Long, val queued: Long? = null)

/** rig.ts `getRigActivityIndicators` */
fun SessionMetadata?.rigActivityIndicators(): List<RigActivityIndicator> {
    if (!isRig()) return emptyList()
    val activity = this?.activity ?: return emptyList()
    return buildList {
        if (activity.subagentsRunning > 0 || activity.subagentsQueued > 0) {
            add(RigActivityIndicator("subagents", activity.subagentsRunning.toLong(), activity.subagentsQueued.toLong()))
        }
        if (activity.workflowsRunning > 0) add(RigActivityIndicator("workflows", activity.workflowsRunning.toLong()))
        if (activity.processesRunning > 0) add(RigActivityIndicator("processes", activity.processesRunning.toLong()))
        if (activity.tasksPending + activity.tasksInProgress > 0) {
            add(RigActivityIndicator("tasks", activity.tasksInProgress.toLong(), activity.tasksPending.toLong()))
        }
    }
}

/** rig.ts `getRigGitSummary`: counts Happy Agent publishes; legacy Happy metadata never has them. */
fun SessionMetadata?.rigGitSummary(): GitCounts? = if (isRig()) this?.git else null

/** rig.ts `rigHasRpcMethod` */
fun SessionMetadata?.rigHasRpcMethod(method: String): Boolean =
    !isRigV1() || this?.capabilities?.rpcMethods?.contains(method) == true

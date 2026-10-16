package com.slopus.happy.model.settings

import androidx.compose.runtime.Immutable
import com.slopus.happy.R
import com.slopus.happy.model.CodeOption
import com.slopus.happy.model.ModelEntry
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRigV1
import com.slopus.happy.model.rigCurrentModel
import com.slopus.happy.model.rigModels

/**
 * modelModeOptions.ts `ModeOption`: a permission mode, model or effort level
 * as a picker lists it. [sinceCliVersion] is the happy-cli version that
 * first parses the mode; untagged modes go to every CLI. A [disabled] row
 * is listed but cannot be picked. [semanticKind] is a Happy Agent
 * operating mode's `kind`; the provider fields and [defaultThinkingLevel]
 * are a `ModelMode`'s, set for models a Happy Agent session publishes.
 */
@Immutable
data class ModeOption(
    val key: String,
    val name: String,
    val description: String? = null,
    val sinceCliVersion: String? = null,
    val semanticKind: String? = null,
    val disabled: Boolean = false,
    val providerId: String? = null,
    val providerName: String? = null,
    val providerKind: String? = null,
    val defaultThinkingLevel: String? = null,
)

/** modelModeOptions.ts `ModelModeProviderGroup`: [title] null for models with no provider. */
@Immutable
data class ModelProviderGroup(val key: String, val title: String?, val models: List<ModeOption>)

/**
 * modelModeOptions.ts: the hardcoded permission, model and effort catalogs
 * for harnesses that publish none of their own. Mode names are Happy's own
 * untranslated single words; descriptions are agentInput.* strings, read
 * through [translate].
 */
object ModeOptions {
    private fun claudePermissionModes(translate: (Int) -> String) = listOf(
        ModeOption("auto", "Auto", translate(R.string.agent_input_permission_mode_auto), AgentDefaults.CLI_VERSION_WITH_AUTO),
        ModeOption("acceptEdits", "Edits", translate(R.string.agent_input_permission_mode_accept_edits)),
        ModeOption("plan", "Plan", translate(R.string.agent_input_permission_mode_plan)),
        ModeOption("bypassPermissions", "Yolo", translate(R.string.agent_input_permission_mode_bypass_permissions)),
        ModeOption("default", "Default", translate(R.string.agent_input_permission_mode_default)),
    )

    private fun codexPermissionModes(translate: (Int) -> String) = listOf(
        ModeOption("auto", "Auto", translate(R.string.agent_input_codex_permission_mode_auto_description), AgentDefaults.CLI_VERSION_WITH_AUTO),
        ModeOption("safe-yolo", "Workspace", translate(R.string.agent_input_codex_permission_mode_safe_yolo_description)),
        ModeOption("read-only", "Read", translate(R.string.agent_input_codex_permission_mode_read_only_description)),
        ModeOption("yolo", "Yolo", translate(R.string.agent_input_codex_permission_mode_yolo_description)),
        ModeOption("default", "Default", translate(R.string.agent_input_codex_permission_mode_default_description)),
    )

    // Only the keys runGemini honours.
    private fun geminiPermissionModes(translate: (Int) -> String) = listOf(
        ModeOption("yolo", "Yolo", translate(R.string.agent_input_gemini_permission_mode_yolo)),
        ModeOption("default", "Default", translate(R.string.agent_input_gemini_permission_mode_default)),
    )

    // runOpenClaw never reads permissionMode; both rows say so.
    private fun openClawPermissionModes(translate: (Int) -> String) = listOf(
        ModeOption("bypassPermissions", "Yolo", translate(R.string.agent_input_permission_mode_openclaw_inert)),
        ModeOption("default", "Default", translate(R.string.agent_input_permission_mode_openclaw_inert)),
    )

    // agy's own sandboxed launch default leads, against the shared ranking.
    private fun agyPermissionModes(translate: (Int) -> String) = listOf(
        ModeOption("default", "Default", translate(R.string.agent_input_permission_mode_agy_default)),
        ModeOption("bypassPermissions", "Yolo", translate(R.string.agent_input_permission_mode_bypass_permissions)),
    )

    /** getHardcodedPermissionModes: Claude's for an unknown flavor. */
    fun permissionModes(flavor: String?, translate: (Int) -> String): List<ModeOption> = when (flavor) {
        "codex" -> codexPermissionModes(translate)
        "gemini" -> geminiPermissionModes(translate)
        "openclaw" -> openClawPermissionModes(translate)
        "agy" -> agyPermissionModes(translate)
        else -> claudePermissionModes(translate)
    }

    // The current generation by full model ID, one row each: every one is 1M-native.
    private val claudeModelModes = listOf(
        ModeOption("claude-fable-5-1", "Fable 5.1", "1M context"),
        ModeOption("claude-fable-5", "Fable 5"),
        ModeOption("claude-opus-5-5", "Opus 5.5"),
        ModeOption("claude-opus-5", "Opus 5"),
        ModeOption("claude-sonnet-5-5", "Sonnet 5.5"),
        ModeOption("claude-haiku-5-5", "Haiku 5.5"),
    )

    /** Claude models that left the list but can still be saved. */
    private val unlistedClaudeModelNames = mapOf("claude-sonnet-5" to "Sonnet 5")

    private val codexModelModes = listOf(
        ModeOption("gpt-6-astra", "GPT-6 Astra", "most capable"),
        ModeOption("gpt-6.1-sol", "GPT-6.1 Sol"),
        ModeOption("gpt-6-sol", "GPT-6 Sol"),
        ModeOption("gpt-6-luna", "GPT-6 Luna"),
        ModeOption("gpt-5.6-sol", "GPT-5.6 Sol"),
        ModeOption("gpt-5.6-terra", "GPT-5.6 Terra"),
        ModeOption("gpt-5.6-luna", "GPT-5.6 Luna"),
    )

    private val geminiModelModes = listOf(
        ModeOption("gemini-3.1-pro-preview", "Gemini 3.1 Pro", "latest & most capable"),
        ModeOption("gemini-3-flash-preview", "Gemini 3 Flash", "latest & fast"),
        ModeOption("gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite", "latest & fastest"),
        ModeOption("gemini-2.5-pro", "Gemini 2.5 Pro", "most capable"),
        ModeOption("gemini-2.5-flash", "Gemini 2.5 Flash", "fast & efficient"),
        ModeOption("gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite", "fastest"),
    )

    private val openClawModelModes = listOf(ModeOption("default", "Default model"))

    private val agyModelModes = listOf(
        ModeOption("Gemini 3.8 Flash", "Gemini 3.8 Flash"),
        ModeOption("Claude Sonnet 4.6 (Thinking)", "Claude Sonnet 4.6 (Thinking)"),
        ModeOption("Claude Opus 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)"),
        ModeOption("GPT-OSS 120B (Medium)", "GPT-OSS 120B (Medium)"),
    )

    /** getHardcodedModelModes: Claude's for an unknown flavor. */
    fun modelModes(flavor: String?): List<ModeOption> = when (flavor) {
        "codex" -> codexModelModes
        "gemini" -> geminiModelModes
        "openclaw" -> openClawModelModes
        "agy" -> agyModelModes
        else -> claudeModelModes
    }

    /**
     * includeConfiguredModel: appends the saved model when the list lacks
     * it, so a pick that left the catalog still shows as itself. Codex, agy
     * and Claude only; a saved Claude `[1m]` key maps onto its row first.
     */
    fun includeConfiguredModel(flavor: String?, models: List<ModeOption>, configuredModelKey: String?): List<ModeOption> {
        val isClaude = flavor != "rig" && AgentKey.normalize(flavor) == AgentKey.Claude
        val key = AgentDefaults.retireModelMode(flavor, configuredModelKey)
        if ((flavor != "codex" && flavor != "agy" && !isClaude) || key.isNullOrEmpty() || key == "default" || models.any { it.key == key }) {
            return models
        }
        val name = (if (isClaude) unlistedClaudeModelNames[key] else null) ?: key
        return models + ModeOption(key, name, if (flavor == "codex") "custom model" else "saved model")
    }

    /** effortDisplayName: capitalised, but `xhigh` keeps its brand spelling. */
    fun effortDisplayName(key: String): String = if (key == "xhigh") "xHigh" else key.replaceFirstChar { it.uppercaseChar() }

    private fun effortLevels(keys: List<String>) = keys.map { ModeOption(it, effortDisplayName(it)) }

    // The Agent SDK's EffortLevel union: one scale for every Claude model.
    private val claudeEfforts = listOf("low", "medium", "high", "xhigh", "max")

    private val agyEffortsByModel = mapOf("Gemini 3.8 Flash" to listOf("low", "medium", "high"))

    // What each model publishes in Codex's registry, in its order.
    private val codexEffortsByModel = mapOf(
        "gpt-6-astra" to listOf("low", "medium", "high", "xhigh", "max", "ultra"),
        "gpt-6.1-sol" to listOf("low", "medium", "high", "xhigh", "max", "ultra"),
        "gpt-6-sol" to listOf("low", "medium", "high", "xhigh", "max", "ultra"),
        "gpt-6-luna" to listOf("low", "medium", "high", "xhigh", "max"),
        "gpt-5.6-sol" to listOf("low", "medium", "high", "xhigh", "max", "ultra"),
        "gpt-5.6-terra" to listOf("low", "medium", "high", "xhigh", "max", "ultra"),
        "gpt-5.6-luna" to listOf("low", "medium", "high", "xhigh", "max"),
    )

    // An unknown Codex model gets the set every gpt-5 accepts.
    private val codexEffortsFallback = listOf("low", "medium", "high", "xhigh")

    /** getEffortLevelsForModel without rig metadata: empty when the model has no effort. */
    fun effortLevelsForModel(flavor: String?, modelKey: String?): List<ModeOption> = when (flavor) {
        "claude" -> effortLevels(claudeEfforts)
        "codex" -> effortLevels(codexEffortsByModel[modelKey] ?: codexEffortsFallback)
        "agy" -> effortLevels(agyEffortsByModel[modelKey] ?: emptyList())
        else -> emptyList()
    }

    /**
     * getEffortLevelsForModel: a Happy Agent session's levels for the
     * model (its own, else the session's), otherwise [effortLevelsForModel].
     */
    fun effortLevelsForModel(flavor: String?, modelKey: String?, metadata: SessionMetadata?): List<ModeOption> {
        if (metadata.isRigV1()) return rigReasoningLevels(metadata, modelKey).map { ModeOption(it, effortDisplayName(it)) }
        return effortLevelsForModel(flavor, modelKey)
    }

    // rig.ts getRigReasoningLevels; Sync's copy is in sync/RigCapabilities.kt.
    private fun rigReasoningLevels(metadata: SessionMetadata?, modelKey: String?): List<String> {
        val model = metadata.rigModels().find { it.key == modelKey }
        if (model != null && model.thinkingLevels.isNotEmpty()) return model.thinkingLevels
        metadata?.reasoning?.levels?.takeIf { it.isNotEmpty() }?.let { return it }
        return metadata?.thoughtLevels.orEmpty().map { it.code }
    }

    /** mapMetadataOptions */
    fun metadataOptions(options: List<CodeOption>?): List<ModeOption> =
        options.orEmpty().map { ModeOption(it.code, it.value, it.description) }

    private fun metadataModels(models: List<ModelEntry>?): List<ModeOption> =
        models.orEmpty().map { ModeOption(it.code, it.value, it.description) }

    /** filterPermissionModesForCli: the hardcoded lists only; a published catalog matches its own CLI. */
    fun filterPermissionModesForCli(modes: List<ModeOption>, cliVersion: String?): List<ModeOption> =
        modes.filter { com.slopus.happy.model.modeSupportedByCli(it, cliVersion) }

    /** modeHacks.ts `hackMode`: OpenCode's doubled "build, build" and "plan/plan" names. */
    fun hackMode(mode: ModeOption): ModeOption {
        val name = mode.name.trim().lowercase()
        val key = mode.key.trim().lowercase()
        return when {
            name == "build, build" || (key == "build" && name == "build") -> mode.copy(name = "Build")
            name == "plan/plan" || (key == "plan" && name == "plan") -> mode.copy(name = "Plan")
            else -> mode
        }
    }

    fun hackModes(modes: List<ModeOption>): List<ModeOption> = modes.map(::hackMode)

    // permissionModeLabels.ts: pick order by a name's first word, lowest first.
    // Home's sortPermissionModes ranks the machine catalog's RigModeOption the same way.
    private val permissionRanks = mapOf(
        "auto" to 10, "edits" to 15, "plan" to 20, "workspace" to 30,
        "read" to 40, "yolo" to 50, "full" to 50, "default" to 100,
    )
    private const val UNRANKED = 90

    private fun firstWord(name: String): String = name.trim().split(Regex("\\s+")).firstOrNull().orEmpty()

    /** getPermissionModeShortLabel: the one word on the composer chip (Home's, by name). */
    fun permissionModeShortLabel(mode: ModeOption?): String? = com.slopus.happy.model.permissionModeShortLabel(mode?.name)

    /** getPermissionModeRank */
    fun permissionModeRank(mode: ModeOption): Int = permissionRanks[firstWord(mode.name).lowercase()] ?: UNRANKED

    /** sortPermissionModes: by rank; unknown words keep the harness's order (the sort is stable). */
    fun sortPermissionModes(modes: List<ModeOption>): List<ModeOption> = modes.sortedBy(::permissionModeRank)

    /**
     * getAvailablePermissionModes. A Happy Agent session lists its own
     * operating modes, ranked, with the current mode first and disabled when
     * the catalog lacks it. Claude, Codex, OpenClaw and agy get their
     * hardcoded lists, less what the session's CLI cannot parse; anything
     * else its metadata's modes, else Claude's.
     */
    fun availablePermissionModes(
        flavor: String?,
        metadata: SessionMetadata?,
        translate: (Int) -> String,
        selectedKey: String? = null,
    ): List<ModeOption> {
        if (metadata.isRigV1()) {
            val modes = sortPermissionModes(
                metadata?.operatingModes.orEmpty().map { ModeOption(it.code, it.value, it.description, semanticKind = it.kind) },
            )
            val current = selectedKey ?: metadata?.currentOperatingModeCode ?: metadata?.permissionMode ?: metadata?.session?.permissionMode
            if (!current.isNullOrEmpty() && modes.none { it.key == current }) {
                // Literal in happy-app.
                return listOf(ModeOption(current, current, "Unavailable in the current Happy mode catalog", disabled = true)) + modes
            }
            return modes
        }
        if (flavor == "claude" || flavor == "codex" || flavor == "openclaw" || flavor == "agy") {
            return hackModes(filterPermissionModesForCli(permissionModes(flavor, translate), metadata?.version))
        }
        val published = metadataOptions(metadata?.operatingModes)
        if (published.isNotEmpty()) return sortPermissionModes(hackModes(published))
        return hackModes(permissionModes(flavor, translate))
    }

    /** rigModelPickerOrder.ts `sortRigModelsForPicker`: Astra first within its provider, groups in wire order. */
    private fun <T> sortRigModelsForPicker(models: List<T>, id: (T) -> String, providerId: (T) -> String): List<T> {
        val isAstra = { model: T -> id(model) == "openai/gpt-6-astra" || id(model) == "gpt-6-astra" }
        return models.groupBy(providerId).values.flatMap { group -> group.filter(isAstra) + group.filterNot(isAstra) }
    }

    /**
     * getAvailableModels. A Happy Agent session lists its published models
     * (Astra first per provider), then its current model and a locally
     * picked `provider:model` key as disabled rows when the catalog lacks
     * them. Otherwise the session metadata's models (Codex gets a `default`
     * row first), else the hardcoded list with [selectedKey] kept.
     */
    fun availableModels(
        flavor: String?,
        metadata: SessionMetadata?,
        translate: (Int) -> String,
        selectedKey: String? = null,
    ): List<ModeOption> {
        if (metadata.isRigV1()) {
            val models = sortRigModelsForPicker(metadata.rigModels(), { it.id }, { it.providerId }).map { model ->
                ModeOption(
                    key = model.key,
                    name = model.name,
                    description = model.providerName,
                    providerId = model.providerId,
                    providerName = model.providerName,
                    providerKind = model.providerKind,
                    defaultThinkingLevel = model.defaultThinkingLevel,
                )
            }.toMutableList()
            val current = metadata.rigCurrentModel()
            if (current != null && current.unavailable && models.none { it.key == current.key }) {
                models += ModeOption(
                    key = current.key,
                    name = current.name,
                    description = "${current.providerName} · unavailable",
                    disabled = true,
                    providerId = current.providerId,
                    providerName = current.providerName,
                    providerKind = current.providerKind,
                )
            }
            val local = selectedKey ?: metadata?.modelMode
            if (local != null && ':' in local && models.none { it.key == local }) {
                val providerId = local.substringBefore(':')
                models += ModeOption(
                    key = local,
                    name = local.substringAfter(':'),
                    description = "$providerId · unavailable",
                    disabled = true,
                    providerId = providerId,
                    providerName = providerId,
                    providerKind = "custom",
                )
            }
            return models
        }
        val published = metadataModels(metadata?.models)
        if (published.isNotEmpty()) {
            if (flavor == "codex" && published.none { it.key == "default" }) return listOf(ModeOption("default", "default model")) + published
            return published
        }
        return includeConfiguredModel(flavor, modelModes(flavor), selectedKey)
    }

    /** resolveCurrentOption: the first of [preferredKeys] the list has. */
    fun resolveCurrentOption(options: List<ModeOption>, preferredKeys: List<String?>): ModeOption? {
        for (key in preferredKeys) {
            if (key.isNullOrEmpty()) continue
            options.find { it.key == key }?.let { return it }
        }
        return null
    }

    /** groupModelModesByProvider: provider groups in first-seen order, rows in wire order. */
    fun groupModelsByProvider(models: List<ModeOption>): List<ModelProviderGroup> {
        val groups = LinkedHashMap<String, Pair<String?, MutableList<ModeOption>>>()
        for (model in models) {
            val providerId = model.providerId?.trim()?.takeIf { it.isNotEmpty() }
            val group = groups.getOrPut(providerId ?: "__models__") {
                (model.providerName?.trim()?.takeIf { it.isNotEmpty() } ?: providerId) to mutableListOf()
            }
            group.second += model
        }
        return groups.map { (key, group) -> ModelProviderGroup(key, group.first, group.second) }
    }
}

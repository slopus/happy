package com.slopus.happy.model.settings

import androidx.compose.runtime.Immutable
import com.slopus.happy.R

/**
 * modelModeOptions.ts `ModeOption`: a permission mode, model or effort level
 * as a picker lists it. [sinceCliVersion] is the happy-cli version that
 * first parses the mode; untagged modes go to every CLI.
 */
@Immutable
data class ModeOption(
    val key: String,
    val name: String,
    val description: String? = null,
    val sinceCliVersion: String? = null,
)

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
}

package com.slopus.happy.model.settings

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** happy-app sync/agentDefaults.ts `agentKeys`. */
enum class AgentKey(val wire: String) {
    Claude("claude"),
    Codex("codex"),
    Gemini("gemini"),
    Openclaw("openclaw"),
    Agy("agy");

    companion object {
        /** normalizeAgentKey: an unknown or missing flavor is Claude. */
        fun normalize(flavor: String?): AgentKey = entries.firstOrNull { it.wire == flavor && it != Claude } ?: Claude
    }
}

/** The fields an agent default can override (`AgentDefaultField`). */
enum class AgentDefaultField(val wire: String) { PermissionMode("permissionMode"), ModelMode("modelMode"), EffortLevel("effortLevel") }

/**
 * AgentDefaultOverrideSchema: the user's choices for one agent. Unknown keys
 * pass through ([unknown]).
 */
data class AgentDefaultOverride(
    val permissionMode: String? = null,
    val modelMode: String? = null,
    val effortLevel: String? = null,
    val unknown: JsonObject = EmptyJson,
) {
    operator fun get(field: AgentDefaultField): String? = when (field) {
        AgentDefaultField.PermissionMode -> permissionMode
        AgentDefaultField.ModelMode -> modelMode
        AgentDefaultField.EffortLevel -> effortLevel
    }

    fun with(field: AgentDefaultField, value: String?): AgentDefaultOverride = when (field) {
        AgentDefaultField.PermissionMode -> copy(permissionMode = value)
        AgentDefaultField.ModelMode -> copy(modelMode = value)
        AgentDefaultField.EffortLevel -> copy(effortLevel = value)
    }

    fun toJson(): JsonObject = JsonObject(
        unknown + listOfNotNull(
            permissionMode?.let { "permissionMode" to JsonPrimitive(it) },
            modelMode?.let { "modelMode" to JsonPrimitive(it) },
            effortLevel?.let { "effortLevel" to JsonPrimitive(it) },
        ),
    )

    internal companion object {
        fun parse(element: JsonElement): AgentDefaultOverride {
            val json = element.asObject()
            return AgentDefaultOverride(
                permissionMode = json["permissionMode"]?.asString(),
                modelMode = json["modelMode"]?.asString(),
                effortLevel = json["effortLevel"]?.asString(),
                unknown = JsonObject(json - AgentDefaultField.entries.map { it.wire }.toSet()),
            )
        }
    }
}

/**
 * AgentDefaultOverridesSchema: per-agent overrides keyed by [AgentKey];
 * other keys pass through ([unknown]).
 */
data class AgentDefaultOverrides(
    val agents: Map<AgentKey, AgentDefaultOverride> = emptyMap(),
    val unknown: JsonObject = EmptyJson,
) {
    fun toJson(): JsonObject = JsonObject(unknown + agents.entries.associate { (key, value) -> key.wire to value.toJson() })

    internal companion object {
        fun parse(element: JsonElement): AgentDefaultOverrides {
            val json = element.asObject()
            val agents = AgentKey.entries.mapNotNull { key -> json[key.wire]?.let { key to AgentDefaultOverride.parse(it) } }.toMap()
            return AgentDefaultOverrides(agents, JsonObject(json - AgentKey.entries.map { it.wire }.toSet()))
        }
    }
}

/** AgentDefaultConfig: what a new session of an agent starts with. */
data class AgentDefaultConfig(val permissionMode: String, val modelMode: String, val effortLevel: String?)

/** happy-app sync/agentDefaults.ts: code defaults, their CLI-version gates, and user overrides over them. */
object AgentDefaults {
    // Auto is the reviewed everyday mode for both shipped code agents. The
    // old CLI fallback is applied only when a machine version is known.
    private val codeAgentDefaults = mapOf(
        AgentKey.Claude to AgentDefaultConfig("auto", "claude-opus-5-5", "medium"),
        AgentKey.Codex to AgentDefaultConfig("auto", "gpt-6.1-sol", "medium"),
        AgentKey.Gemini to AgentDefaultConfig("default", "gemini-2.5-pro", null),
        AgentKey.Openclaw to AgentDefaultConfig("default", "default", null),
        AgentKey.Agy to AgentDefaultConfig("default", "Gemini 3.8 Flash", "medium"),
    )

    /** `auto` first shipped in happy-cli 1.2.1-beta.2, for Claude and Codex alike. */
    const val CLI_VERSION_WITH_AUTO = "1.2.1-beta.2"

    /** Opus 5.5 needs the Agent SDK happy-cli 1.2.6-beta.0 first requires. */
    const val CLI_VERSION_WITH_OPUS_5_5 = "1.2.6-beta.0"
    private const val CLAUDE_MODEL_BEFORE_OPUS_5_5 = "claude-opus-5"

    /** Offered once, no longer accepted: what they meant. */
    private val retiredPermissionModes = mapOf("dontAsk" to "acceptEdits")

    /** Claude `[1m]` rows that duplicated a 1M-native model. */
    private val retiredClaudeModelModes = mapOf(
        "claude-opus-5-5[1m]" to "claude-opus-5-5",
        "claude-opus-5[1m]" to "claude-opus-5",
        "claude-sonnet-5-5[1m]" to "claude-sonnet-5-5",
    )

    private fun codeDefaultPermissionMode(permissionMode: String, cliVersion: String?): String {
        if (permissionMode != "auto" || cliVersion.isNullOrEmpty()) return permissionMode
        if (!Versions.isWellFormed(cliVersion)) return "default"
        return if (Versions.compareWithPrerelease(cliVersion, CLI_VERSION_WITH_AUTO) >= 0) permissionMode else "default"
    }

    // The opposite of the auto gate on an unknown version: a missing or
    // mangled version keeps the old model, since a wrong guess fails every turn.
    private fun codeDefaultModelMode(agent: AgentKey, modelMode: String, cliVersion: String?): String {
        if (agent != AgentKey.Claude || modelMode != "claude-opus-5-5") return modelMode
        if (cliVersion.isNullOrEmpty() || !Versions.isWellFormed(cliVersion)) return CLAUDE_MODEL_BEFORE_OPUS_5_5
        return if (Versions.compareWithPrerelease(cliVersion, CLI_VERSION_WITH_OPUS_5_5) >= 0) modelMode else CLAUDE_MODEL_BEFORE_OPUS_5_5
    }

    /** getCodeAgentDefaults. */
    fun codeDefaults(flavor: String?, cliVersion: String? = null): AgentDefaultConfig {
        val agent = AgentKey.normalize(flavor)
        val defaults = codeAgentDefaults.getValue(agent)
        return defaults.copy(
            permissionMode = codeDefaultPermissionMode(defaults.permissionMode, cliVersion),
            modelMode = codeDefaultModelMode(agent, defaults.modelMode, cliVersion),
        )
    }

    /** retirePermissionMode. */
    fun retirePermissionMode(mode: String?): String? = if (mode.isNullOrEmpty()) mode else retiredPermissionModes[mode] ?: mode

    /** retireModelMode: Claude only; other harnesses own their model keys. */
    fun retireModelMode(flavor: String?, mode: String?): String? {
        if (mode.isNullOrEmpty() || flavor == "rig" || AgentKey.normalize(flavor) != AgentKey.Claude) return mode
        return retiredClaudeModelModes[mode] ?: mode
    }

    /** getAgentDefaultOverride: the agent's override with retired keys mapped. */
    fun override(overrides: AgentDefaultOverrides?, flavor: String?): AgentDefaultOverride {
        val override = overrides?.agents?.get(AgentKey.normalize(flavor)) ?: AgentDefaultOverride()
        return override.copy(
            permissionMode = retirePermissionMode(override.permissionMode),
            modelMode = retireModelMode(flavor, override.modelMode),
        )
    }

    /** resolveAgentDefaultConfig: the user's override over the code default, field by field. */
    fun resolve(overrides: AgentDefaultOverrides?, flavor: String?, cliVersion: String? = null): AgentDefaultConfig {
        val code = codeDefaults(flavor, cliVersion)
        val user = override(overrides, flavor)
        return AgentDefaultConfig(
            permissionMode = user.permissionMode ?: code.permissionMode,
            modelMode = user.modelMode ?: code.modelMode,
            effortLevel = user.effortLevel ?: code.effortLevel,
        )
    }

    /** hasAgentDefaultOverride. */
    fun hasOverride(overrides: AgentDefaultOverrides?, flavor: String?, field: AgentDefaultField): Boolean =
        override(overrides, flavor)[field] != null

    /** getAgentDefaultOverrideValue. */
    fun overrideValue(overrides: AgentDefaultOverrides?, flavor: String?, field: AgentDefaultField): String? =
        override(overrides, flavor)[field]

    /**
     * setAgentDefaultOverride: sets or (with null) clears one field. An
     * agent left with none of the three fields is dropped, unknown keys and all.
     */
    fun set(overrides: AgentDefaultOverrides?, flavor: String?, field: AgentDefaultField, value: String?): AgentDefaultOverrides {
        val key = AgentKey.normalize(flavor)
        val current = (overrides?.agents?.get(key) ?: AgentDefaultOverride()).with(field, value)
        val agents = (overrides?.agents ?: emptyMap()).toMutableMap()
        if (current.permissionMode == null && current.modelMode == null && current.effortLevel == null) {
            agents.remove(key)
        } else {
            agents[key] = current
        }
        return AgentDefaultOverrides(agents, overrides?.unknown ?: EmptyJson)
    }
}

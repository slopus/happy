package com.slopus.happy.model

import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.model.settings.EmptyJson
import com.slopus.happy.model.settings.SchemaMismatch
import com.slopus.happy.model.settings.asArray
import com.slopus.happy.model.settings.asBoolean
import com.slopus.happy.model.settings.asEnum
import com.slopus.happy.model.settings.asNumber
import com.slopus.happy.model.settings.asObject
import com.slopus.happy.model.settings.asString
import com.slopus.happy.model.settings.orNull
import com.slopus.happy.model.settings.toJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Diff view style (`split` is web-only). */
enum class DiffStyle(val wire: String) { Unified("unified"), Split("split") }

/** Home session list layout: one activity-sorted list, or grouped by project. */
enum class SessionListGrouping(val wire: String) { Flat("flat"), Project("project") }

/** One of the last machine-path combinations, most recent first. */
data class RecentMachinePath(val machineId: String, val path: String)

/** Which CLI installation warnings were dismissed, per agent. */
data class CliWarningFlags(
    val claude: Boolean? = null,
    val codex: Boolean? = null,
    val gemini: Boolean? = null,
    val openclaw: Boolean? = null,
)

/** Dismissed CLI warning banners, per machine and globally. */
data class DismissedCliWarnings(
    val perMachine: Map<String, CliWarningFlags> = emptyMap(),
    val global: CliWarningFlags = CliWarningFlags(),
)

/**
 * The account's synced settings: happy-app sync/settings.ts `SettingsSchema`,
 * every field with its default. Fields this version doesn't know are kept in
 * [unknown] and written back untouched, so a newer client's settings survive
 * a round trip through this one.
 *
 * The settings document syncs field by field (see `HappyStore`), so a change
 * is a delta of top-level keys: [com.slopus.happy.model.settings.SettingsRepository.change].
 */
data class Settings(
    val schemaVersion: Int = SUPPORTED_SCHEMA_VERSION,
    /** Legacy inline tool-call preference (no longer used). */
    val viewInline: Boolean = false,
    val inferenceOpenAIKey: String? = null,
    /** Legacy (no longer used). */
    val expandTodos: Boolean = true,
    /** Legacy (no longer used). */
    val showLineNumbers: Boolean = true,
    val showLineNumbersInToolViews: Boolean = false,
    /** Legacy (no longer used). */
    val wrapLinesInDiffs: Boolean = true,
    val diffStyle: DiffStyle = DiffStyle.Unified,
    val analyticsOptOut: Boolean = false,
    /** Current experiments: the Rig session file browser and the Usage settings page. */
    val experiments: Boolean = false,
    val alwaysShowContextSize: Boolean = false,
    /** Enter sends in the agent input (web). */
    val agentInputEnterToSend: Boolean = true,
    /** brutalist, pixelated or gradient; a free string so other versions' values survive. */
    val avatarStyle: String = "brutalist",
    val avatarMonochrome: Boolean = false,
    val sessionListGrouping: SessionListGrouping = SessionListGrouping.Flat,
    /** Harness badges in the session list (legacy key). */
    val showFlavorIcons: Boolean = false,
    val showHarnessIconInSessionHeader: Boolean = true,
    /** User message bubble color preset (utils/userMessageBubbleColor.ts). */
    val userMessageBubbleColor: String = DEFAULT_USER_MESSAGE_BUBBLE_COLOR,
    val usageLimitShowRemaining: Boolean = false,
    /** Hides archived sessions in the main list (the key keeps its old name). */
    val hideInactiveSessions: Boolean = true,
    /** Legacy (no longer used). */
    val sortSessionsByActivity: Boolean = true,
    /** Session fork and duplicate actions. */
    val expResumeSession: Boolean = true,
    val fileDiffsSidebar: Boolean = false,
    val groupToolCalls: Boolean = false,
    val compactToolCalls: Boolean = false,
    val reviewPromptAnswered: Boolean = false,
    val reviewPromptLikedApp: Boolean? = null,
    val voiceAssistantLanguage: String? = null,
    val voiceCustomAgentId: String? = null,
    val voiceBypassToken: Boolean = false,
    /** UI language, a `SUPPORTED_LANGUAGES` code; null follows the device. */
    val preferredLanguage: String? = null,
    val recentMachinePaths: List<RecentMachinePath> = emptyList(),
    val lastUsedAgent: String? = null,
    val lastUsedPermissionMode: String? = null,
    val lastUsedModelMode: String? = null,
    /** Missing values use code defaults and are not sent as agent metadata. */
    val agentDefaultOverrides: AgentDefaultOverrides = AgentDefaultOverrides(),
    val dismissedCLIWarnings: DismissedCliWarnings = DismissedCliWarnings(),
    /** Keys this version doesn't know, as they came. */
    val unknown: JsonObject = EmptyJson,
) {
    /** Every known field with its value, then [unknown]. */
    fun toJson(): JsonObject = JsonObject(unknown + fields.associate { it.name to it.write(this) })

    companion object {
        const val SUPPORTED_SCHEMA_VERSION = 2
        const val DEFAULT_USER_MESSAGE_BUBBLE_COLOR = "gray"

        val Defaults = Settings()

        /** The schema's top-level keys. */
        val knownKeys: Set<String> by lazy { fields.mapTo(LinkedHashSet()) { it.name } }

        /**
         * settingsParse. Not an object: the defaults. Otherwise every known
         * key is checked; if any has the wrong type, all known fields take
         * their defaults (zod's `safeParse` fails as a whole). Unknown keys
         * are kept either way, and `preferredLanguage: "zh"` becomes `zh-Hans`.
         */
        fun parse(element: JsonElement?): Settings {
            val json = element as? JsonObject ?: return Defaults
            val unknown = JsonObject(json - knownKeys)
            val parsed = try {
                fields.fold(Defaults) { settings, field -> json[field.name]?.let { field.read(settings, it) } ?: settings }
            } catch (_: SchemaMismatch) {
                return Defaults.copy(unknown = unknown)
            }
            val language = if (parsed.preferredLanguage == "zh") "zh-Hans" else parsed.preferredLanguage
            return parsed.copy(preferredLanguage = language, unknown = unknown)
        }

        /**
         * applySettings over JSON documents: [delta]'s keys over [settings]'s,
         * then any known key still missing takes its default. Values are not
         * checked; [parse] does that on read.
         */
        fun apply(settings: JsonObject, delta: JsonObject): JsonObject {
            val result = settings + delta
            return JsonObject(result + Defaults.toJson().filterKeys { it !in result })
        }

        /**
         * settingsToSyncPayload: what is uploaded. Agent overrides that are
         * not non-empty objects are dropped, and the key goes when none are
         * left.
         */
        fun syncPayload(settings: JsonObject): JsonObject {
            val overrides = settings["agentDefaultOverrides"] as? JsonObject ?: return JsonObject(settings - "agentDefaultOverrides")
            val compact = overrides.filterValues { it is JsonObject && it.isNotEmpty() }
            return if (compact.isEmpty()) JsonObject(settings - "agentDefaultOverrides") else JsonObject(settings + ("agentDefaultOverrides" to JsonObject(compact)))
        }
    }
}

/** One top-level key: how it's read onto a [Settings] and written from one. */
private class Field(
    val name: String,
    val read: (Settings, JsonElement) -> Settings,
    val write: (Settings) -> JsonElement,
)

private fun boolean(name: String, get: (Settings) -> Boolean, set: Settings.(Boolean) -> Settings) =
    Field(name, { s, j -> s.set(j.asBoolean()) }, { JsonPrimitive(get(it)) })

private fun nullableBoolean(name: String, get: (Settings) -> Boolean?, set: Settings.(Boolean?) -> Settings) =
    Field(name, { s, j -> s.set(j.orNull { asBoolean() }) }, { get(it).toJson() })

private fun string(name: String, get: (Settings) -> String, set: Settings.(String) -> Settings) =
    Field(name, { s, j -> s.set(j.asString()) }, { JsonPrimitive(get(it)) })

private fun nullableString(name: String, get: (Settings) -> String?, set: Settings.(String?) -> Settings) =
    Field(name, { s, j -> s.set(j.orNull { asString() }) }, { get(it).toJson() })

private fun flagsOf(element: JsonElement): CliWarningFlags {
    val json = element.asObject()
    return CliWarningFlags(
        claude = json["claude"]?.asBoolean(),
        codex = json["codex"]?.asBoolean(),
        gemini = json["gemini"]?.asBoolean(),
        openclaw = json["openclaw"]?.asBoolean(),
    )
}

private fun CliWarningFlags.toJson() = JsonObject(
    listOfNotNull(
        claude?.let { "claude" to JsonPrimitive(it) },
        codex?.let { "codex" to JsonPrimitive(it) },
        gemini?.let { "gemini" to JsonPrimitive(it) },
        openclaw?.let { "openclaw" to JsonPrimitive(it) },
    ).toMap(),
)

private val fields: List<Field> = listOf(
    Field("schemaVersion", { s, j -> s.copy(schemaVersion = j.asNumber().toInt()) }, { JsonPrimitive(it.schemaVersion) }),
    boolean("viewInline", { it.viewInline }) { copy(viewInline = it) },
    nullableString("inferenceOpenAIKey", { it.inferenceOpenAIKey }) { copy(inferenceOpenAIKey = it) },
    boolean("expandTodos", { it.expandTodos }) { copy(expandTodos = it) },
    boolean("showLineNumbers", { it.showLineNumbers }) { copy(showLineNumbers = it) },
    boolean("showLineNumbersInToolViews", { it.showLineNumbersInToolViews }) { copy(showLineNumbersInToolViews = it) },
    boolean("wrapLinesInDiffs", { it.wrapLinesInDiffs }) { copy(wrapLinesInDiffs = it) },
    Field(
        "diffStyle",
        { s, j -> s.copy(diffStyle = j.asEnum(DiffStyle.entries.map { it.wire }).let { w -> DiffStyle.entries.first { it.wire == w } }) },
        { JsonPrimitive(it.diffStyle.wire) },
    ),
    boolean("analyticsOptOut", { it.analyticsOptOut }) { copy(analyticsOptOut = it) },
    boolean("experiments", { it.experiments }) { copy(experiments = it) },
    boolean("alwaysShowContextSize", { it.alwaysShowContextSize }) { copy(alwaysShowContextSize = it) },
    boolean("agentInputEnterToSend", { it.agentInputEnterToSend }) { copy(agentInputEnterToSend = it) },
    string("avatarStyle", { it.avatarStyle }) { copy(avatarStyle = it) },
    boolean("avatarMonochrome", { it.avatarMonochrome }) { copy(avatarMonochrome = it) },
    Field(
        "sessionListGrouping",
        { s, j ->
            val wire = j.asEnum(SessionListGrouping.entries.map { it.wire })
            s.copy(sessionListGrouping = SessionListGrouping.entries.first { it.wire == wire })
        },
        { JsonPrimitive(it.sessionListGrouping.wire) },
    ),
    boolean("showFlavorIcons", { it.showFlavorIcons }) { copy(showFlavorIcons = it) },
    boolean("showHarnessIconInSessionHeader", { it.showHarnessIconInSessionHeader }) { copy(showHarnessIconInSessionHeader = it) },
    string("userMessageBubbleColor", { it.userMessageBubbleColor }) { copy(userMessageBubbleColor = it) },
    boolean("usageLimitShowRemaining", { it.usageLimitShowRemaining }) { copy(usageLimitShowRemaining = it) },
    boolean("hideInactiveSessions", { it.hideInactiveSessions }) { copy(hideInactiveSessions = it) },
    boolean("sortSessionsByActivity", { it.sortSessionsByActivity }) { copy(sortSessionsByActivity = it) },
    boolean("expResumeSession", { it.expResumeSession }) { copy(expResumeSession = it) },
    boolean("fileDiffsSidebar", { it.fileDiffsSidebar }) { copy(fileDiffsSidebar = it) },
    boolean("groupToolCalls", { it.groupToolCalls }) { copy(groupToolCalls = it) },
    boolean("compactToolCalls", { it.compactToolCalls }) { copy(compactToolCalls = it) },
    boolean("reviewPromptAnswered", { it.reviewPromptAnswered }) { copy(reviewPromptAnswered = it) },
    nullableBoolean("reviewPromptLikedApp", { it.reviewPromptLikedApp }) { copy(reviewPromptLikedApp = it) },
    nullableString("voiceAssistantLanguage", { it.voiceAssistantLanguage }) { copy(voiceAssistantLanguage = it) },
    nullableString("voiceCustomAgentId", { it.voiceCustomAgentId }) { copy(voiceCustomAgentId = it) },
    boolean("voiceBypassToken", { it.voiceBypassToken }) { copy(voiceBypassToken = it) },
    nullableString("preferredLanguage", { it.preferredLanguage }) { copy(preferredLanguage = it) },
    Field(
        "recentMachinePaths",
        { s, j ->
            s.copy(
                recentMachinePaths = j.asArray().map { entry ->
                    val o = entry.asObject()
                    RecentMachinePath(
                        machineId = o["machineId"]?.asString() ?: throw SchemaMismatch("machineId missing"),
                        path = o["path"]?.asString() ?: throw SchemaMismatch("path missing"),
                    )
                },
            )
        },
        { s -> JsonArray(s.recentMachinePaths.map { JsonObject(mapOf("machineId" to JsonPrimitive(it.machineId), "path" to JsonPrimitive(it.path))) }) },
    ),
    nullableString("lastUsedAgent", { it.lastUsedAgent }) { copy(lastUsedAgent = it) },
    nullableString("lastUsedPermissionMode", { it.lastUsedPermissionMode }) { copy(lastUsedPermissionMode = it) },
    nullableString("lastUsedModelMode", { it.lastUsedModelMode }) { copy(lastUsedModelMode = it) },
    Field(
        "agentDefaultOverrides",
        { s, j -> s.copy(agentDefaultOverrides = AgentDefaultOverrides.parse(j)) },
        { it.agentDefaultOverrides.toJson() },
    ),
    Field(
        "dismissedCLIWarnings",
        { s, j ->
            val o = j.asObject()
            s.copy(
                dismissedCLIWarnings = DismissedCliWarnings(
                    perMachine = o["perMachine"]?.asObject()?.mapValues { (_, v) -> flagsOf(v) } ?: emptyMap(),
                    global = o["global"]?.let(::flagsOf) ?: CliWarningFlags(),
                ),
            )
        },
        { s ->
            JsonObject(
                mapOf(
                    "perMachine" to JsonObject(s.dismissedCLIWarnings.perMachine.mapValues { it.value.toJson() }),
                    "global" to s.dismissedCLIWarnings.global.toJson(),
                ),
            )
        },
    ),
)

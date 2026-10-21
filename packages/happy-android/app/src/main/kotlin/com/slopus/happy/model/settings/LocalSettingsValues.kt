package com.slopus.happy.model.settings

import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Device-only preferences: happy-app sync/localSettings.ts
 * `LocalSettingsSchema`, every field with its default. Unknown keys are kept
 * in [unknown]. Web- and developer-only fields (the command palette, the
 * sidebar panels, logging) are carried so the document matches happy-app's;
 * of the developer fields the app reads [devModeEnabled] (toggled by ten
 * taps on Settings › Version).
 */
data class LocalSettingsValues(
    val debugMode: Boolean = false,
    val devModeEnabled: Boolean = false,
    /** control, show-paywall-before-first-voice-chat or voice-onboarding-and-upsell. */
    val voiceUpsellOverride: String? = null,
    /** CMD+K command palette (web only). */
    val commandPaletteEnabled: Boolean = false,
    val themePreference: ThemePreference = ThemePreference.Adaptive,
    val markdownCopyV2: Boolean = false,
    val consoleLoggingEnabled: Boolean = false,
    val verboseLogging: Boolean = false,
    val zenMode: Boolean = false,
    /** Open right-sidebar panels (changes, allFiles, sideChat), in tab order. */
    val sidebarPanelsOpen: List<String> = emptyList(),
    val sidebarPanelActive: String? = null,
    /** Acknowledged CLI versions, by machine id. */
    val acknowledgedCliVersions: Map<String, String> = emptyMap(),
    /** Projects showing every workspace, by project id. */
    val expandedProjects: Map<String, Boolean> = emptyMap(),
    /** Ticked steps of the link-your-computer checklist, by step id. */
    val linkComputerChecklist: Map<String, Boolean> = emptyMap(),
    val unknown: JsonObject = EmptyJson,
) {
    fun toJson(): JsonObject = JsonObject(
        unknown + mapOf(
            "debugMode" to JsonPrimitive(debugMode),
            "devModeEnabled" to JsonPrimitive(devModeEnabled),
            "voiceUpsellOverride" to voiceUpsellOverride.toJson(),
            "commandPaletteEnabled" to JsonPrimitive(commandPaletteEnabled),
            "themePreference" to JsonPrimitive(themePreference.wire),
            "markdownCopyV2" to JsonPrimitive(markdownCopyV2),
            "consoleLoggingEnabled" to JsonPrimitive(consoleLoggingEnabled),
            "verboseLogging" to JsonPrimitive(verboseLogging),
            "zenMode" to JsonPrimitive(zenMode),
            "sidebarPanelsOpen" to JsonArray(sidebarPanelsOpen.map(::JsonPrimitive)),
            "sidebarPanelActive" to sidebarPanelActive.toJson(),
            "acknowledgedCliVersions" to JsonObject(acknowledgedCliVersions.mapValues { JsonPrimitive(it.value) }),
            "expandedProjects" to JsonObject(expandedProjects.mapValues { JsonPrimitive(it.value) }),
            "linkComputerChecklist" to JsonObject(linkComputerChecklist.mapValues { JsonPrimitive(it.value) }),
        ),
    )

    companion object {
        val Defaults = LocalSettingsValues()

        private val voiceUpsellValues = listOf("control", "show-paywall-before-first-voice-chat", "voice-onboarding-and-upsell")
        private val sidebarPanels = listOf("changes", "allFiles", "sideChat")
        private val knownKeys = Defaults.toJson().keys

        /** The value happy-app stores for a theme. */
        val ThemePreference.wire: String
            get() = when (this) {
                ThemePreference.Adaptive -> "adaptive"
                ThemePreference.Light -> "light"
                ThemePreference.Dark -> "dark"
            }

        /**
         * localSettingsParse: the defaults with the document's fields over
         * them, unknown keys kept. If any known field has the wrong type the
         * whole document is dropped for the defaults, as happy-app does.
         */
        fun parse(element: JsonElement?): LocalSettingsValues {
            val json = element as? JsonObject ?: return Defaults
            return try {
                fun bool(key: String, default: Boolean) = json[key]?.asBoolean() ?: default
                fun <V> record(key: String, value: JsonElement.() -> V) = json[key]?.asObject()?.mapValues { it.value.value() } ?: emptyMap()
                LocalSettingsValues(
                    debugMode = bool("debugMode", false),
                    devModeEnabled = bool("devModeEnabled", false),
                    voiceUpsellOverride = json["voiceUpsellOverride"]?.orNull { asEnum(voiceUpsellValues) },
                    commandPaletteEnabled = bool("commandPaletteEnabled", false),
                    themePreference = json["themePreference"]?.asEnum(ThemePreference.entries.map { it.wire })
                        ?.let { w -> ThemePreference.entries.first { it.wire == w } } ?: ThemePreference.Adaptive,
                    markdownCopyV2 = bool("markdownCopyV2", false),
                    consoleLoggingEnabled = bool("consoleLoggingEnabled", false),
                    verboseLogging = bool("verboseLogging", false),
                    zenMode = bool("zenMode", false),
                    sidebarPanelsOpen = json["sidebarPanelsOpen"]?.asArray()?.map { it.asEnum(sidebarPanels) } ?: emptyList(),
                    sidebarPanelActive = json["sidebarPanelActive"]?.orNull { asEnum(sidebarPanels) },
                    acknowledgedCliVersions = record("acknowledgedCliVersions") { asString() },
                    expandedProjects = record("expandedProjects") { asBoolean() },
                    linkComputerChecklist = record("linkComputerChecklist") { asBoolean() },
                    unknown = JsonObject(json - knownKeys),
                )
            } catch (_: SchemaMismatch) {
                Defaults
            }
        }
    }
}

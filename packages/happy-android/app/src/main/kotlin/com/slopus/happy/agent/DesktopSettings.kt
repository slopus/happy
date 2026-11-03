package com.slopus.happy.agent

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * Happy Desktop's user settings that the phone follows (iOS's
 * `DesktopSettingKeys`). They live on the agent, one per person, so a
 * change on the desktop shows here and one made here shows there.
 */
object DesktopSettings {
    /** Whether the sidebar, and so home, lists the projects: `{"projectsHidden": true}` hides them. */
    const val PROJECTS_VISIBILITY = "happy-desktop.projectsVisibility"

    /** Projects are hidden only by an explicit `true`; unset, cleared or anything else shows them. */
    fun projectsHidden(values: Map<String, JsonElement>): Boolean =
        (values[PROJECTS_VISIBILITY] as? JsonObject)?.get("projectsHidden") == JsonPrimitive(true)

    /** The value that hides ([hidden]) or shows the projects, as the desktop writes it. */
    fun projectsVisibility(hidden: Boolean): JsonObject = buildJsonObject { put("projectsHidden", hidden) }

    /** When this connection chimes for a finished conversation (desktop's happyAgentAttentionStore): `"focused"`, `"never"`, else always. */
    const val COMPLETION_SOUND = "happy-desktop.completionSound"

    /** A bot's attention, `{"muted": …, "hidden": …}`, under this prefix and the bot's id. */
    const val BOT_PREFIX = "happy-desktop.bot."

    fun completionSound(values: Map<String, JsonElement>): CompletionSound = when ((values[COMPLETION_SOUND] as? JsonPrimitive)?.contentOrNull) {
        "focused" -> CompletionSound.Focused
        "never" -> CompletionSound.Never
        else -> CompletionSound.Always
    }

    /** [sound] as the desktop writes it: always is the setting cleared. */
    fun completionSoundValue(sound: CompletionSound): JsonElement = when (sound) {
        CompletionSound.Always -> JsonNull
        CompletionSound.Focused -> JsonPrimitive("focused")
        CompletionSound.Never -> JsonPrimitive("never")
    }

    /** Whether the person hid bot [botId] on the desktop: home leaves it out (iOS SidebarRows, desktop 1dc8b566). */
    fun botHidden(values: Map<String, JsonElement>, botId: String): Boolean =
        (values[BOT_PREFIX + botId] as? JsonObject)?.get("hidden") == JsonPrimitive(true)

    /** Whether the person muted bot [botId]: home lists it, its subtasks too, with no activity or unread (desktop 731c8bbc). */
    fun botMuted(values: Map<String, JsonElement>, botId: String): Boolean =
        (values[BOT_PREFIX + botId] as? JsonObject)?.get("muted") == JsonPrimitive(true)

    /** Whether the person muted or hid bot [botId]: it never chimes, whatever its connection says. */
    fun botQuiet(values: Map<String, JsonElement>, botId: String): Boolean {
        val attention = values[BOT_PREFIX + botId] as? JsonObject ?: return false
        return attention["muted"] == JsonPrimitive(true) || attention["hidden"] == JsonPrimitive(true)
    }
}

/**
 * Desktop's completion sound choices. A phone's link runs only while its
 * connection is open and the app in the foreground, which is desktop's
 * "focused", so on the phone [Always] and [Focused] chime alike.
 */
enum class CompletionSound { Always, Focused, Never }

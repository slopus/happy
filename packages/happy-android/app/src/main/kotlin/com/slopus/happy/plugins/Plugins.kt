package com.slopus.happy.plugins

import androidx.compose.runtime.Immutable

/**
 * A plugin's picture as the server serves it: its path on the connection
 * (drawn through [com.slopus.happy.agent.AgentPictures]) with the ThumbHash
 * painted until it loads.
 */
@Immutable
data class PluginImage(val path: String, val thumbhash: String?)

@Immutable
data class PluginTool(val name: String, val summary: String)

/** One value a fields setup asks for, such as an API key. A [secret] is typed into a password field and never shown again. */
@Immutable
data class PluginField(
    val key: String,
    val label: String,
    val help: String,
    val required: Boolean,
    val secret: Boolean,
    val multiline: Boolean,
)

/** One way an installation signs in to the service its plugin wraps. */
@Immutable
sealed interface PluginAuthMethod {
    val id: String
    val label: String

    /** A sign-in in the browser; the server finishes it. */
    data class OAuth(override val id: String, override val label: String, val scopes: List<String>) : PluginAuthMethod

    /** Values typed here and sent once, such as a token. */
    data class Fields(override val id: String, override val label: String, val fields: List<PluginField>) : PluginAuthMethod
}

/** Whether this connection can install a catalog entry; a Happy Agent host refuses some with its own reason. */
@Immutable
sealed interface Installability {
    data object Installable : Installability
    data class Refused(val reason: String?) : Installability
}

/**
 * One plugin the connection offers, installed or not. [key] is unique in
 * the catalog: a Happy Agent host lists the same plugin once per source.
 */
@Immutable
data class Plugin(
    val key: String,
    val id: String,
    val name: String,
    val description: String,
    val version: String,
    val image: PluginImage?,
    val tools: List<PluginTool>,
    /** An installation does nothing until it signs in. */
    val authRequired: Boolean,
    /** Only the methods that work on this server. */
    val authMethods: List<PluginAuthMethod>,
    val installability: Installability,
    /** It may be installed more than once (a cluster's plugins always may). */
    val multiInstance: Boolean,
)

/** Where one installation stands. */
@Immutable
sealed interface InstallationStatus {
    data object Active : InstallationStatus
    /** Installed, waiting for a sign-in. */
    data object NeedsSetup : InstallationStatus
    /** Signed in with a method this server no longer offers: set up again or removed. */
    data object MethodUnavailable : InstallationStatus
    /** A Happy Agent host downloading and unpacking it. */
    data object Installing : InstallationStatus
    /** A Happy Agent host stopped installing it, in its own words. */
    data class Failed(val error: String?) : InstallationStatus
}

/** One installation of a plugin. A plugin may be installed more than once. */
@Immutable
data class PluginInstallation(
    val id: String,
    /** The [Plugin.key] it was installed from. */
    val pluginKey: String,
    /** The plugin's name, or its ID once the server stops offering it. */
    val name: String,
    /** Counts installations of one plugin from 1; never reused. */
    val ordinal: Int,
    val label: String?,
    val status: InstallationStatus,
    /** The method it signed in with, if any. */
    val authMethod: String?,
    val image: PluginImage?,
    /** False for a plugin this server no longer offers: it can't be changed or removed then. */
    val available: Boolean,
)

/** An account an installation signed in to, which disconnect may remove alone. */
@Immutable
data class PluginConnection(val id: String, val name: String, val description: String)

/** What the connection offers and has installed, and whether the person may change it. */
@Immutable
data class PluginsSnapshot(
    /** By name. */
    val plugins: List<Plugin>,
    val installations: List<PluginInstallation>,
    val canManage: Boolean,
) {
    fun plugin(key: String): Plugin? = plugins.firstOrNull { it.key == key }

    fun installationsOf(key: String): List<PluginInstallation> = installations.filter { it.pluginKey == key }

    /** Plugins with no installation, by name: the catalog's rest. */
    val available: List<Plugin> get() = installations.map { it.pluginKey }.toSet().let { installed -> plugins.filter { it.key !in installed } }
}

/** Why a plugin action didn't happen. */
@Immutable
sealed interface PluginRefusal {
    /** The server refused some setup fields, each with what is wrong (its words, never the value). */
    data class Fields(val fields: Map<String, String>) : PluginRefusal
    /** The person's role may not manage plugins. */
    data object Forbidden : PluginRefusal
    /** The plugin or installation is gone. */
    data object NotFound : PluginRefusal
    /** This server can't run the sign-in (no connect host). */
    data object Unsupported : PluginRefusal
    /** The server's own reason. */
    data class Said(val message: String) : PluginRefusal
    /** The server couldn't be reached or answered nonsense. */
    data object Failed : PluginRefusal
}

class PluginsException(val refusal: PluginRefusal) : Exception(refusal.toString())

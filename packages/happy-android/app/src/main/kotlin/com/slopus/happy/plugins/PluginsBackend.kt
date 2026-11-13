package com.slopus.happy.plugins

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.decode
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * One connection's plugin API. A Happy Cloud server and a Happy Agent host
 * speak different wires under the same `/v0/plugins`; each has its own
 * backend and the screens see only this. Every write throws a
 * [PluginsException]; the source reads the list again after it settles.
 */
interface PluginsBackend {
    /** The catalog and installations; null where the connection has no plugins at all (`404`/`501`). */
    suspend fun read(): PluginsSnapshot?

    /** Installs [plugin] and answers the new installation's ID. */
    suspend fun install(plugin: Plugin): String

    /** Removes an installation with its secrets; one already gone counts as removed. */
    suspend fun remove(installationId: String)

    /** Signs an installation in with a fields method. */
    suspend fun configure(installationId: String, methodId: String, values: Map<String, String>)

    /** Starts an OAuth sign-in and answers the `https` page to send the person to. */
    suspend fun connect(installationId: String, methodId: String): String

    /** Forgets [connectionId]'s secret, or every one of the installation's when null. */
    suspend fun disconnect(installationId: String, connectionId: String? = null)

    /** The accounts an installation signed in to; empty where the server doesn't say. */
    suspend fun connections(installationId: String): List<PluginConnection>

    /** Whether [event] may have changed what [read] answers. */
    fun changes(event: AgentEvent): Boolean
}

/**
 * A Happy Cloud server's plugins (happy-cluster API.md, "Plugins"):
 * compiled into the server, installed for the team. Members read the
 * catalog; installations and their writes take `mcp.manage`, which
 * [canManage] answers where the installations list doesn't say itself.
 */
class ClusterPlugins(
    private val client: AgentClient,
    private val canManage: () -> Boolean,
) : PluginsBackend {
    override suspend fun read(): PluginsSnapshot? {
        val catalog = try {
            client.decode<JsonObject>("GET", "/v0/plugins")
        } catch (e: AgentApiException) {
            if (e.status == 404 || e.status == 501) return null
            throw e
        }
        val listed = try {
            client.decode<JsonObject>("GET", "/v0/plugins/installations")
        } catch (e: AgentApiException) {
            // A member without mcp.manage on a server that keeps installations to managers.
            if (e.status == 403) null else throw e
        }
        val plugins = catalog["plugins"].arr.orEmpty().mapNotNull { it.obj?.let(::plugin) }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
        return PluginsSnapshot(
            plugins = plugins,
            installations = listed?.get("installations").arr.orEmpty().mapNotNull { it.obj?.let(::installation) },
            canManage = listed?.get("canManage").bool ?: canManage(),
        )
    }

    override suspend fun install(plugin: Plugin): String = refusals {
        val answer = client.decode<JsonObject>("POST", INSTALLATIONS, buildJsonObject { put("plugin", plugin.id) })
        answer["installation"].obj?.get("id").str ?: throw PluginsException(PluginRefusal.Failed)
    }

    override suspend fun remove(installationId: String) {
        try {
            refusals { client.send("DELETE", installation(installationId)) }
        } catch (e: PluginsException) {
            if (e.refusal != PluginRefusal.NotFound) throw e
        }
    }

    override suspend fun configure(installationId: String, methodId: String, values: Map<String, String>) {
        refusals {
            client.send(
                "POST",
                "${installation(installationId)}/configure",
                buildJsonObject {
                    put("method", methodId)
                    putJsonObject("values") { values.forEach { (key, value) -> put(key, value) } }
                },
            )
        }
    }

    override suspend fun connect(installationId: String, methodId: String): String = refusals {
        val answer = client.decode<JsonObject>("POST", "${installation(installationId)}/connect", buildJsonObject { put("method", methodId) })
        answer["authorizeUrl"].str?.takeIf { it.startsWith("https://") } ?: throw PluginsException(PluginRefusal.Failed)
    }

    override suspend fun disconnect(installationId: String, connectionId: String?) {
        refusals {
            client.send("POST", "${installation(installationId)}/disconnect", buildJsonObject { connectionId?.let { put("secretId", it) } })
        }
    }

    override suspend fun connections(installationId: String): List<PluginConnection> = try {
        client.decode<JsonObject>("GET", installation(installationId))["connections"].arr.orEmpty().mapNotNull { element ->
            val entry = element.obj ?: return@mapNotNull null
            val id = entry["id"].str ?: return@mapNotNull null
            PluginConnection(id, entry["name"].str ?: id, entry["description"].str.orEmpty())
        }
    } catch (e: AgentApiException) {
        if (e.status == 404 || e.status == 405 || e.status == 501) emptyList() else throw e
    }

    override fun changes(event: AgentEvent): Boolean = event.type == AgentEvent.HELLO || event.type == "plugins.changed" ||
        event.type.startsWith("role.") || event.type == "member.updated"

    private fun installation(id: String) = "$INSTALLATIONS/${AgentClient.escape(id)}"

    internal companion object {
        const val INSTALLATIONS = "/v0/plugins/installations"

        fun image(json: JsonElement?): PluginImage? {
            val image = json.obj ?: return null
            val digest = image["digest"].str?.takeIf { it.isNotEmpty() } ?: return null
            return PluginImage("/v0/plugins/images/${AgentClient.escape(digest)}", image["thumbhash"].str?.takeIf { it.isNotEmpty() })
        }

        fun plugin(json: JsonObject): Plugin? {
            val id = json["id"].str?.takeIf { it.isNotEmpty() } ?: return null
            val auth = json["auth"].obj
            return Plugin(
                key = id,
                id = id,
                name = json["name"].str?.takeIf { it.isNotEmpty() } ?: id,
                description = json["description"].str.orEmpty(),
                version = json["version"].str.orEmpty(),
                image = image(json["image"]),
                tools = json["tools"].arr.orEmpty().mapNotNull { tool ->
                    val name = tool.obj?.get("name").str ?: return@mapNotNull null
                    PluginTool(name, tool.obj?.get("summary").str.orEmpty())
                },
                authRequired = auth?.get("required").bool == true,
                authMethods = auth?.get("methods").arr.orEmpty().mapNotNull { it.obj?.let(::method) },
                installability = Installability.Installable,
                multiInstance = true,
            )
        }

        fun method(json: JsonObject): PluginAuthMethod? {
            val id = json["id"].str?.takeIf { it.isNotEmpty() } ?: return null
            val label = json["label"].str?.takeIf { it.isNotEmpty() } ?: id
            return when (json["type"].str) {
                "oauth" -> PluginAuthMethod.OAuth(id, label, json["scopes"].arr.orEmpty().mapNotNull { it.str })
                "fields" -> PluginAuthMethod.Fields(
                    id,
                    label,
                    json["fields"].arr.orEmpty().mapNotNull { element ->
                        val field = element.obj ?: return@mapNotNull null
                        val key = field["key"].str?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                        PluginField(
                            key = key,
                            label = field["label"].str?.takeIf { it.isNotEmpty() } ?: key,
                            help = field["help"].str.orEmpty(),
                            required = field["required"].bool == true,
                            secret = field["secret"].bool == true,
                            multiline = field["multiline"].bool == true,
                        )
                    },
                )
                else -> null
            }
        }

        fun installation(json: JsonObject): PluginInstallation? {
            val id = json["id"].str?.takeIf { it.isNotEmpty() } ?: return null
            val plugin = json["plugin"].str?.takeIf { it.isNotEmpty() } ?: return null
            return PluginInstallation(
                id = id,
                pluginKey = plugin,
                name = json["pluginName"].str?.takeIf { it.isNotEmpty() } ?: plugin,
                ordinal = json["ordinal"].num?.toInt() ?: 1,
                label = json["label"].str?.takeIf { it.isNotEmpty() },
                status = when {
                    json["status"].str == "active" -> InstallationStatus.Active
                    json["reason"].str == "method_unavailable" -> InstallationStatus.MethodUnavailable
                    else -> InstallationStatus.NeedsSetup
                },
                authMethod = json["authMethod"].str?.takeIf { it.isNotEmpty() },
                image = image(json["image"]),
                available = json["available"].bool != false,
            )
        }

        /** A refusal as a [PluginsException]; an unreachable server or a garbled answer is [PluginRefusal.Failed]. */
        suspend fun <T> refusals(block: suspend () -> T): T = try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: PluginsException) {
            throw e
        } catch (e: AgentApiException) {
            val fields = e.body.obj?.get("fields").obj?.mapNotNull { (key, value) -> value.str?.let { key to it } }?.toMap()
            throw PluginsException(
                when {
                    e.code == "invalid_fields" && fields != null -> PluginRefusal.Fields(fields)
                    e.status == 403 -> PluginRefusal.Forbidden
                    e.status == 404 -> PluginRefusal.NotFound
                    e.status == 501 -> PluginRefusal.Unsupported
                    e.status in 400..499 && !e.message.isNullOrBlank() -> PluginRefusal.Said(e.message!!)
                    else -> PluginRefusal.Failed
                },
            )
        } catch (_: Exception) {
            throw PluginsException(PluginRefusal.Failed)
        }
    }
}

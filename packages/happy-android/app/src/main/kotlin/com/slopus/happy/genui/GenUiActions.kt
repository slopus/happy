package com.slopus.happy.genui

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One variable a secret action asks for: its name and a hint, never a value. */
@Immutable
data class SecretVariable(val name: String, val description: String?)

/** What the Happy Agent secret form starts with (SPEC.md "Secret actions"). The person may change all of it. */
@Immutable
data class SecretPrefill(val id: String?, val description: String?, val variables: List<SecretVariable>)

/** The four kinds of a Happy Cloud secret, by their wire `type`. */
enum class ClusterSecretKind(val wire: String) { Endpoint("endpoint"), SshKey("ssh_key"), GitCredential("git_credential"), Environment("environment") }

/** Who shows a version: a Happy Agent client, or a Happy Cloud one. Each serves its own secret action. */
enum class GenUiHostKind { HappyAgent, Cluster }

/**
 * What the computer says it runs, in its health's `capabilities`
 * (`artifactSecretActions`, `plugins`); a flag it doesn't report is false.
 */
@Immutable
data class GenUiCapabilities(val secretActions: Boolean = false, val plugins: Boolean = false)

/**
 * The secret and plugin actions' shapes (render catalog `action`), and which
 * actions a host may enable. A prefill is checked strictly: its objects are
 * closed, so one that tries to carry a value is no action at all.
 */
object GenUiActions {
    /** Secret names: 2–32 characters, a lowercase letter then lowercase letters, digits, `_` or `-`. */
    val SECRET_ID = Regex("[a-z][a-z0-9_-]{1,31}")

    /** Environment variable names. */
    val VARIABLE = Regex("[A-Za-z_][A-Za-z0-9_]*")

    const val MAX_DESCRIPTION = 2000
    const val MAX_VARIABLES = 64

    private val CLUSTER_ID = Regex("[a-z][a-z0-9]{23}")
    private val CLUSTER_KEYS = setOf("type", "id", "name", "description", "owner", "uses", "public")
    private val CLUSTER_USES = mapOf(
        ClusterSecretKind.Endpoint to setOf("egress", "mcp"),
        ClusterSecretKind.SshKey to setOf("ssh"),
        ClusterSecretKind.GitCredential to setOf("git"),
        ClusterSecretKind.Environment to setOf("environment", "mcp"),
    )

    /**
     * Whether [host] enables [action] for a version with or without a live
     * [origin] agent, given what the computer reports in [capabilities]
     * (SPEC.md rule 7, conformance `actions.json`). This is the rule alone; a
     * client also needs the means to run it, such as a conversation to send to.
     */
    fun enabled(action: Action, host: GenUiHostKind, origin: Boolean, capabilities: GenUiCapabilities): Boolean = when (action) {
        is Action.Message -> origin
        is Action.Open, is Action.Copy -> true
        is Action.Plugin -> capabilities.plugins
        is Action.Secret -> origin && host == GenUiHostKind.HappyAgent && capabilities.secretActions
        is Action.ClusterSecret -> origin && host == GenUiHostKind.Cluster && capabilities.secretActions
        is Action.Tool, is Action.Unsupported -> false
    }

    /** `secret`'s prefill, or null when it breaks the catalog. */
    internal fun secret(o: JsonObject?): Action.Secret? {
        if (o == null || !o.closed("id", "description", "variables")) return null
        val id = o.optionalString("id") ?: return null
        if (id.value != null && !SECRET_ID.matches(id.value)) return null
        val description = o.optionalString("description")?.takeIf { (it.value?.length ?: 0) <= MAX_DESCRIPTION } ?: return null
        val list = o["variables"] as? JsonArray ?: return null
        if (list.size !in 1..MAX_VARIABLES) return null
        val variables = list.map { item ->
            val v = item as? JsonObject ?: return null
            if (!v.closed("name", "description")) return null
            val name = (v["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { VARIABLE.matches(it) } ?: return null
            val hint = v.optionalString("description")?.takeIf { (it.value?.length ?: 0) <= MAX_DESCRIPTION } ?: return null
            SecretVariable(name, hint.value)
        }
        if (variables.distinctBy { it.name.lowercase() }.size != variables.size) return null
        return Action.Secret(SecretPrefill(id.value, description.value, variables))
    }

    /**
     * `cluster_secret`'s prefill, checked as far as its own keys: a closed
     * object of a known kind with a name, so `material` or any other place
     * for a value makes it no action. Its `public` metadata is the
     * cluster's to check when the form is saved (SPEC.md).
     */
    internal fun clusterSecret(o: JsonObject?): Action.ClusterSecret? {
        if (o == null || !o.keys.all { it in CLUSTER_KEYS }) return null
        val kind = ClusterSecretKind.entries.firstOrNull { it.wire == (o["type"] as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: return null
        val name = (o["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        if (name.length !in 1..100 || name != name.trim() || name.any { it.isISOControl() }) return null
        val id = o.optionalString("id") ?: return null
        if (id.value != null && !CLUSTER_ID.matches(id.value)) return null
        if ((o.optionalString("description") ?: return null).value.orEmpty().length > MAX_DESCRIPTION) return null
        val owner = o.optionalString("owner") ?: return null
        if (owner.value != null && owner.value !in setOf("me", "team")) return null
        o["uses"]?.let { uses ->
            val names = (uses as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return null } ?: return null
            val allowed = CLUSTER_USES.getValue(kind)
            if (names.isEmpty() || names.size > allowed.size || names.toSet().size != names.size || !allowed.containsAll(names)) return null
        }
        if (o["public"] != null && o["public"] !is JsonObject) return null
        return Action.ClusterSecret(kind, o)
    }

    /** `plugin`'s target, or null without an id. */
    internal fun plugin(o: JsonObject?): Action.Plugin? {
        val id = (o?.get("id") as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() } ?: return null
        return Action.Plugin(id)
    }

    private fun JsonObject.closed(vararg allowed: String): Boolean = keys.all { it in allowed }

    /** An absent key, or a string; anything else at [key] is null (not a valid object). */
    private class Optional(val value: String?)

    private fun JsonObject.optionalString(key: String): Optional? = when (val v: JsonElement? = this[key]) {
        null -> Optional(null)
        is JsonPrimitive -> if (v.isString) Optional(v.content) else null
        else -> null
    }
}

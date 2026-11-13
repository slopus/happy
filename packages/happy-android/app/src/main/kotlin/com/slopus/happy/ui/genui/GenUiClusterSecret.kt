package com.slopus.happy.ui.genui

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.slopus.happy.genui.ClusterSecretKind
import com.slopus.happy.genui.GenUiActions
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Whose a cluster secret is: the person's own, or the team's. */
enum class ClusterOwner(val wire: String) { Me("me"), Team("team") }

enum class GitMethod(val wire: String) { SshKey("ssh_key"), Password("password"), Token("token") }

enum class GitOperation(val wire: String) { Read("read"), Write("write"), Sign("sign") }

/** A Happy Cloud secret as the server shows it (cluster API.md "Secrets"): its public metadata, never a value. */
@Immutable
data class ClusterStored(
    val id: String,
    val kind: ClusterSecretKind,
    val name: String,
    val description: String,
    val public: JsonObject,
    val version: String,
    /** Whether the person may change it (`access.manage`). */
    val manage: Boolean,
) {
    /** An endpoint's header names, in order. */
    val headers: List<Pair<String, String>>
        get() = (public.obj("algorithm")?.get("headers") as? JsonArray).orEmpty().mapNotNull { h ->
            val o = h as? JsonObject ?: return@mapNotNull null
            (o.str("name") ?: return@mapNotNull null) to o.str("prefix").orEmpty()
        }

    /** An environment secret's variable names. */
    val variables: List<String> get() = (public["variables"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }

    /** A git credential's way in. */
    val method: GitMethod? get() = public.obj("method")?.str("kind")?.let { k -> GitMethod.entries.firstOrNull { it.wire == k } }

    companion object {
        fun parse(e: JsonElement?): ClusterStored? {
            val o = e as? JsonObject ?: return null
            val kind = ClusterSecretKind.entries.firstOrNull { it.wire == o.str("type") } ?: return null
            return ClusterStored(
                o.str("id") ?: return null,
                kind,
                o.str("name").orEmpty(),
                o.str("description").orEmpty(),
                o.obj("public") ?: JsonObject(emptyMap()),
                o.str("version") ?: return null,
                (o.obj("access")?.get("manage") as? JsonPrimitive)?.takeIf { !it.isString }?.content == "true",
            )
        }
    }
}

/** What a save did: the secret as it now stands (null on a retry the person can no longer see), and its ID. */
@Immutable
data class ClusterSaved(val secret: ClusterStored?, val secretId: String)

/** What stops a cluster form from being saved, said under the part it is about. */
enum class ClusterProblem { Owner, Unchangeable, Name, Description, Targets, Headers, Value, Hosts, Key, Server, Username, Operations, NoVariables, VariableName, VariableTwice }

@Stable
class ClusterRow internal constructor(val key: Int, name: String, prefix: String = "") {
    var name by mutableStateOf(name)
    /** A header's prefix, such as `Bearer `; unused for a variable. */
    var prefix by mutableStateOf(prefix)
    /** Typed by the person; never kept anywhere but the one request. */
    var value by mutableStateOf("")
}

/**
 * Where an endpoint's values may go: [host] and its [path] prefixes as the
 * person types them, comma-separated, and whatever else the agent's target
 * said ([rest]: its ports and methods), kept as it was.
 */
@Stable
class ClusterTarget internal constructor(val key: Int, host: String, path: String, val rest: JsonObject = JsonObject(emptyMap())) {
    var host by mutableStateOf(host)
    var path by mutableStateOf(path)

    /** The methods it is limited to, shown with it; none means any. */
    val methods: List<String> get() = rest.strings("methods")
}

/**
 * The Happy Cloud secret form as the person edits it, started from a
 * `cluster_secret` action's prefill ([kind] fixed by the action). Every
 * shown field may change. With [existing] (the action named a stored
 * secret) the form changes that one: its name, description and values,
 * an empty value keeping what is stored; its public metadata (where values
 * go, and their names) stays, so a kept value never goes anywhere new and
 * the cluster's rule that a new `public` asks for every value again never
 * comes up.
 */
@Stable
class ClusterSecretDraft(val kind: ClusterSecretKind, prefill: JsonObject) {
    private var nextKey = 0

    var name by mutableStateOf(prefill.str("name").orEmpty())
    var description by mutableStateOf(prefill.str("description").orEmpty())
    var owner by mutableStateOf(if (prefill.str("owner") == "team") ClusterOwner.Team else ClusterOwner.Me)
    /** The owners the person may choose; empty until read, or when their role may add none. */
    var owners by mutableStateOf<List<ClusterOwner>>(emptyList())
    /** Endpoint and environment: whether MCP servers may open it too. */
    var mcp by mutableStateOf((prefill["uses"] as? JsonArray)?.any { (it as? JsonPrimitive)?.content == "mcp" } == true)

    val targets = mutableStateListOf<ClusterTarget>()
    val headers = mutableStateListOf<ClusterRow>()
    val variables = mutableStateListOf<ClusterRow>()

    var hosts by mutableStateOf("")
    var server by mutableStateOf("")
    var method by mutableStateOf(GitMethod.Token)
    var username by mutableStateOf("")
    var repos by mutableStateOf("")
    val operations = mutableStateListOf<GitOperation>()

    var privateKey by mutableStateOf("")
    var passphrase by mutableStateOf("")
    var password by mutableStateOf("")
    var token by mutableStateOf("")

    var existing by mutableStateOf<ClusterStored?>(null)
        private set

    /** The prefill's public metadata this form doesn't show (an SSH key's ports, a git server's port), sent as it came. */
    private val rest: JsonObject

    init {
        val public = prefill.obj("public") ?: JsonObject(emptyMap())
        rest = JsonObject(public - when (kind) {
            ClusterSecretKind.Endpoint -> setOf("targets", "algorithm")
            // The store derives an SSH key's public key and fingerprint; one the agent sent could only disagree.
            ClusterSecretKind.SshKey -> setOf("hosts", "publicKey", "fingerprint")
            ClusterSecretKind.GitCredential -> setOf("server", "method", "repos", "operations")
            ClusterSecretKind.Environment -> setOf("variables")
        })
        when (kind) {
            ClusterSecretKind.Endpoint -> {
                (public["targets"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>().forEach { t ->
                    targets += ClusterTarget(nextKey++, t.str("host").orEmpty(), t.strings("pathPrefixes").joinToString(", "), JsonObject(t - setOf("host", "pathPrefixes")))
                }
                if (targets.isEmpty()) addTarget()
                (public.obj("algorithm")?.get("headers") as? JsonArray).orEmpty().filterIsInstance<JsonObject>().forEach { h ->
                    headers += ClusterRow(nextKey++, h.str("name").orEmpty(), h.str("prefix").orEmpty())
                }
                if (headers.isEmpty()) headers += ClusterRow(nextKey++, "Authorization", "Bearer ")
            }
            ClusterSecretKind.SshKey -> hosts = public.strings("hosts").joinToString(", ")
            ClusterSecretKind.GitCredential -> {
                server = public.str("server").orEmpty()
                val m = public.obj("method")
                method = GitMethod.entries.firstOrNull { it.wire == m?.str("kind") } ?: GitMethod.Token
                username = m?.str("username").orEmpty()
                repos = public.strings("repos").joinToString(", ")
                operations += public.strings("operations").mapNotNull { o -> GitOperation.entries.firstOrNull { it.wire == o } }.ifEmpty { listOf(GitOperation.Read) }
            }
            ClusterSecretKind.Environment -> {
                public.strings("variables").forEach { variables += ClusterRow(nextKey++, it) }
                if (variables.isEmpty()) addVariable()
            }
        }
    }

    fun addTarget() {
        targets += ClusterTarget(nextKey++, "", "")
    }

    fun addHeader() {
        headers += ClusterRow(nextKey++, "", "")
    }

    fun addVariable() {
        variables += ClusterRow(nextKey++, "")
    }

    /** The owners the person may choose, once read: the prefilled one if allowed, otherwise the first. */
    fun allow(allowed: List<ClusterOwner>) {
        owners = allowed
        if (owner !in allowed) allowed.firstOrNull()?.let { owner = it }
    }

    fun toggle(operation: GitOperation) {
        if (operation in operations) operations.remove(operation) else operations += operation
    }

    /** Opens the form on [secret], the stored one the action named: its words, and its value fields empty to keep. */
    fun adopt(secret: ClusterStored) {
        existing = secret
        name = secret.name
        description = secret.description
        when (kind) {
            ClusterSecretKind.Endpoint -> {
                headers.clear()
                secret.headers.forEach { (n, p) -> headers += ClusterRow(nextKey++, n, p) }
            }
            ClusterSecretKind.Environment -> {
                variables.clear()
                secret.variables.forEach { variables += ClusterRow(nextKey++, it) }
            }
            ClusterSecretKind.GitCredential -> secret.method?.let { method = it }
            ClusterSecretKind.SshKey -> Unit
        }
    }

    val changing: Boolean get() = existing != null

    private val keyed: Boolean get() = kind == ClusterSecretKind.SshKey || (kind == ClusterSecretKind.GitCredential && method == GitMethod.SshKey)

    /** Everything that stops a save, or nothing. */
    val problems: Set<ClusterProblem>
        get() = buildSet {
            val changing = existing != null
            if (!changing && owner !in owners) add(ClusterProblem.Owner)
            if (existing?.manage == false) add(ClusterProblem.Unchangeable)
            if (name.trim().length !in 1..100) add(ClusterProblem.Name)
            if (description.trim().length > GenUiActions.MAX_DESCRIPTION) add(ClusterProblem.Description)
            when (kind) {
                ClusterSecretKind.Endpoint -> {
                    if (!changing && (targets.size !in 1..MAX_TARGETS || targets.any { t -> t.host.isBlank() || list(t.path).any { !it.startsWith("/") } })) add(ClusterProblem.Targets)
                    if (headers.size !in 1..MAX_HEADERS || headers.any { !HEADER.matches(it.name) || it.prefix.length > 32 } || headers.distinctBy { it.name.lowercase() }.size != headers.size) add(ClusterProblem.Headers)
                    if (headers.any { !(changing && it.value.isEmpty()) && !injectable(it.value) }) add(ClusterProblem.Value)
                }
                ClusterSecretKind.SshKey -> {
                    if (!changing && list(hosts).isEmpty()) add(ClusterProblem.Hosts)
                    if (!changing && privateKey.isBlank()) add(ClusterProblem.Key)
                }
                ClusterSecretKind.GitCredential -> {
                    if (!changing) {
                        if (server.isBlank()) add(ClusterProblem.Server)
                        if (method == GitMethod.Password && username.isBlank()) add(ClusterProblem.Username)
                        if (operations.none { it != GitOperation.Sign || method == GitMethod.SshKey }) add(ClusterProblem.Operations)
                    }
                    when (method) {
                        GitMethod.SshKey -> if (!changing && privateKey.isBlank()) add(ClusterProblem.Key)
                        GitMethod.Password -> if (!(changing && password.isEmpty()) && !injectable(password)) add(ClusterProblem.Value)
                        GitMethod.Token -> if (!(changing && token.isEmpty()) && !injectable(token)) add(ClusterProblem.Value)
                    }
                }
                ClusterSecretKind.Environment -> {
                    if (variables.isEmpty()) add(ClusterProblem.NoVariables)
                    if (variables.any { !GenUiActions.VARIABLE.matches(it.name) }) add(ClusterProblem.VariableName)
                    if (variables.distinctBy { it.name.lowercase() }.size != variables.size) add(ClusterProblem.VariableTwice)
                    if (variables.any { '\u0000' in it.value || it.value.length > 65_536 }) add(ClusterProblem.Value)
                }
            }
        }

    /**
     * The form as the actions route takes it. Creating, a create body of the
     * action's type with its whole value. Changing, a patch: the words, and
     * the value where one was typed (an endpoint's or environment's empty
     * field is `null`, kept), plus the `version` it changes.
     */
    fun form(): JsonObject {
        val stored = existing
        return buildJsonObject {
            if (stored == null) {
                put("type", kind.wire)
                put("owner", owner.wire)
            }
            put("name", name.trim())
            put("description", description.trim())
            if (stored == null) {
                put("public", public())
                put("uses", buildJsonArray { uses().forEach { add(JsonPrimitive(it)) } })
            }
            material(changing = stored != null)?.let { put("material", it) }
            stored?.let { put("version", it.version) }
        }
    }

    private fun uses(): List<String> = when (kind) {
        ClusterSecretKind.Endpoint -> if (mcp) listOf("egress", "mcp") else listOf("egress")
        ClusterSecretKind.SshKey -> listOf("ssh")
        ClusterSecretKind.GitCredential -> listOf("git")
        ClusterSecretKind.Environment -> if (mcp) listOf("environment", "mcp") else listOf("environment")
    }

    private fun public(): JsonObject = buildJsonObject {
        rest.forEach { (k, v) -> put(k, v) }
        when (kind) {
            ClusterSecretKind.Endpoint -> {
                put("targets", buildJsonArray {
                    targets.forEach { t ->
                        add(buildJsonObject {
                            put("host", t.host.trim())
                            list(t.path).takeIf { it.isNotEmpty() }?.let { p -> put("pathPrefixes", buildJsonArray { p.forEach { add(JsonPrimitive(it)) } }) }
                            t.rest.forEach { (k, v) -> put(k, v) }
                        })
                    }
                })
                put("algorithm", buildJsonObject {
                    put("kind", "headers")
                    put("headers", buildJsonArray {
                        headers.forEach { h -> add(buildJsonObject { put("name", h.name); if (h.prefix.isNotEmpty()) put("prefix", h.prefix) }) }
                    })
                })
            }
            ClusterSecretKind.SshKey -> put("hosts", buildJsonArray { list(hosts).forEach { add(JsonPrimitive(it)) } })
            ClusterSecretKind.GitCredential -> {
                put("server", server.trim())
                put("method", buildJsonObject {
                    put("kind", method.wire)
                    if (method != GitMethod.SshKey && username.isNotBlank()) put("username", username.trim())
                })
                list(repos).takeIf { it.isNotEmpty() }?.let { r -> put("repos", buildJsonArray { r.forEach { add(JsonPrimitive(it)) } }) }
                // Only an SSH key may sign.
                put("operations", buildJsonArray { operations.filter { it != GitOperation.Sign || method == GitMethod.SshKey }.forEach { add(JsonPrimitive(it.wire)) } })
            }
            ClusterSecretKind.Environment -> Unit
        }
    }

    private fun material(changing: Boolean): JsonObject? = when {
        kind == ClusterSecretKind.Endpoint || kind == ClusterSecretKind.Environment -> {
            val rows = if (kind == ClusterSecretKind.Endpoint) headers else variables
            if (changing && rows.all { it.value.isEmpty() }) null
            else buildJsonObject { rows.forEach { r -> if (changing && r.value.isEmpty()) put(r.name, JsonNull) else put(r.name, r.value) } }
        }
        keyed -> if (changing && privateKey.isEmpty()) null else buildJsonObject {
            put("privateKey", privateKey)
            if (passphrase.isNotEmpty()) put("passphrase", passphrase)
        }
        method == GitMethod.Password -> if (changing && password.isEmpty()) null else buildJsonObject { put("password", password) }
        else -> if (changing && token.isEmpty()) null else buildJsonObject { put("token", token) }
    }

    /** Forgets every typed value, once saved or abandoned. */
    fun forget() {
        headers.forEach { it.value = "" }
        variables.forEach { it.value = "" }
        privateKey = ""
        passphrase = ""
        password = ""
        token = ""
    }

    companion object {
        /** docs/secrets.md 2.3: an endpoint has 1 to 16 targets and 1 to 8 headers. */
        const val MAX_TARGETS = 16
        const val MAX_HEADERS = 8

        private val HEADER = Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]+")

        /** Endpoint headers and git passwords and tokens: 16 to 4,096 printable ASCII characters other than `[` and `]`. */
        private val INJECTABLE = Regex("[\\x20-\\x5a\\x5c\\x5e-\\x7e]{16,4096}")

        fun injectable(value: String): Boolean = INJECTABLE.matches(value)

        fun list(text: String): List<String> = text.split(',', '\n').map { it.trim() }.filter { it.isNotEmpty() }
    }
}

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
private fun JsonObject.strings(key: String): List<String> = (this[key] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }

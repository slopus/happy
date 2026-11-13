package com.slopus.happy.ui.genui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.genui.Action
import com.slopus.happy.genui.GenUiActions
import com.slopus.happy.genui.GenUiHostKind
import com.slopus.happy.genui.SecretPrefill
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.CancellationException
import java.util.Collections
import java.util.WeakHashMap

/** A Happy Agent secret as the daemon shows it (API.md "The secret object"): names, never values. */
@Immutable
data class StoredSecret(
    val id: String,
    val description: String,
    val variables: List<String>,
    val managed: Boolean,
    val availableToAgents: Boolean,
    val version: String,
) {
    /** A secret this form may change: one the daemon lets a person rotate and agents read. */
    val changeable: Boolean get() = !managed && availableToAgents

    companion object {
        fun parse(e: JsonElement?): StoredSecret? {
            val o = e as? JsonObject ?: return null
            fun str(key: String) = (o[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            fun bool(key: String) = (o[key] as? JsonPrimitive)?.takeIf { !it.isString }?.content == "true"
            return StoredSecret(
                str("id") ?: return null,
                str("description").orEmpty(),
                (o["environmentVariables"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty(),
                bool("managed"),
                bool("availableToAgents"),
                str("version") ?: return null,
            )
        }
    }
}

/** What a save did: the secret as it now stands, and whether it was made or changed. */
@Immutable
data class SecretSaved(val secret: StoredSecret, val created: Boolean)

/**
 * The secret action's calls (API.md): whether the computer runs it at all,
 * reading the secret a form may change, and saving the form through the
 * artifact's actions route, which stores it, gives the origin agent access
 * and tells it, in one change. The form never calls the plain secret
 * routes to save.
 */
class GenUiSecretApi(private val client: AgentClient) {
    private var capable by mutableStateOf(capability[client])
    private var answered404 by mutableStateOf(client in unserved)

    /**
     * Whether this computer runs secret actions: its health says
     * `capabilities.artifactSecretActions` (a released daemon without the
     * flag does not, so nobody types values into a form that can't save).
     * Observable, so a button reading it enables once [check] has heard.
     */
    val served: Boolean get() = capable == true && !answered404

    /** Which host this computer is: a Happy Cloud server serves `cluster_secret`, a Happy Agent `secret`. */
    val host: GenUiHostKind get() = if (client.cloud) GenUiHostKind.Cluster else GenUiHostKind.HappyAgent

    /** Asks the computer's health once per connection; unanswered, it stays off and is asked again next time. */
    suspend fun check() {
        if (capable != null) return
        val flag = try {
            val capabilities = AgentClient.json.parseToJsonElement(client.send("GET", "/v0/health").text).asObject()?.get("capabilities") as? JsonObject
            (capabilities?.get("artifactSecretActions") as? JsonPrimitive)?.takeIf { !it.isString }?.content == "true"
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return
        }
        capability[client] = flag
        capable = flag
    }

    /** [id] as stored, or null when there is no such secret. */
    suspend fun read(id: String): StoredSecret? = try {
        StoredSecret.parse(AgentClient.json.parseToJsonElement(client.send("GET", "/v0/secrets/${AgentClient.escape(id)}").text).asObject()?.get("secret"))
            ?: throw IllegalStateException("no secret in the answer")
    } catch (e: AgentApiException) {
        if (e.status == 404) null else throw e
    }

    /**
     * Saves [form] for [element] of [artifactId]'s [version], under the
     * retry key [id]. A `404` marks this computer as not running the action.
     */
    suspend fun save(artifactId: String, version: Int, element: String, id: String, form: SecretForm): SecretSaved {
        val body = buildJsonObject {
            put("id", id)
            put("element", element)
            put("secret", form.secret)
            form.ifMatch?.let { put("ifMatch", it) }
            put("mutationId", AgentClient.newId())
        }
        val path = "/v0/artifacts/${AgentClient.escape(artifactId)}/versions/$version/actions"
        val answer = try {
            AgentClient.json.parseToJsonElement(client.send("POST", path, body).text).asObject()
        } catch (e: AgentApiException) {
            // Fallback: a computer that said it runs the route but answers 404 (rolled back) is taken at its word.
            if (e.status == 404) {
                unserved += client
                answered404 = true
            }
            throw e
        }
        val secret = StoredSecret.parse(answer?.get("secret")) ?: throw IllegalStateException("no secret in the answer")
        return SecretSaved(secret, (answer?.get("outcome") as? JsonPrimitive)?.content == "created")
    }

    private fun JsonElement.asObject(): JsonObject? = this as? JsonObject

    companion object {
        /** Computers that answered the actions route with `404`, for as long as their client lives. */
        private val unserved: MutableSet<AgentClient> = Collections.synchronizedSet(Collections.newSetFromMap(WeakHashMap()))

        /** What each computer's health said of `artifactSecretActions`, for as long as its client lives. */
        private val capability: MutableMap<AgentClient, Boolean> = Collections.synchronizedMap(WeakHashMap())
    }
}

/**
 * The secret form of one shown version: a tapped `secret` element opens it
 * on its prefill, or on the secret it saved before, and a save marks the
 * element in [state] (SPEC.md: what the view shows after saving stays local).
 */
@Stable
class GenUiSecretForm internal constructor(
    private val api: GenUiSecretApi,
    private val artifactId: String,
    private val version: Int,
    private val state: GenUiState,
) {
    private var asking by mutableStateOf<SecretAsk?>(null)

    val served: Boolean get() = api.served

    val host: GenUiHostKind get() = api.host

    fun open(key: String, action: Action.Secret) {
        asking = SecretAsk(artifactId, version, key, action.secret, state.saved(key))
    }

    @Composable
    fun Sheet() {
        val ask = asking ?: return
        GenUiSecretSheet(ask, api, onSaved = { state.save(ask.element, it.secret.id) }, onDismiss = { asking = null })
    }
}

/** [artifactId]'s [version]'s secret form, or null where there is no computer to save to. */
@Composable
fun rememberGenUiSecretForm(api: GenUiSecretApi?, artifactId: String, version: Int, state: GenUiState): GenUiSecretForm? {
    LaunchedEffect(api) { api?.check() }
    return remember(api, artifactId, version, state) { api?.let { GenUiSecretForm(it, artifactId, version, state) } }
}

/** A saved form as the actions route takes it: the `secret` object, and `ifMatch` when it changes a stored one. */
class SecretForm(val secret: JsonObject, val ifMatch: String?)

/** What stops a form from being saved, each said once under the field it is about. */
enum class SecretProblem { Name, Description, NoVariables, VariableName, VariableTwice, Value, Managed }

/** One variable row: its name, the hint the agent wrote, and the stored variable it stands for when changing. */
@Stable
class SecretRow internal constructor(val key: Int, name: String, val hint: String?, stored: String?, val fromStore: Boolean) {
    var name by mutableStateOf(name)
    /** Typed by the person; never saved anywhere but the one request. */
    var value by mutableStateOf("")
    var stored by mutableStateOf(stored)
        internal set

    /** Changing, a row left empty keeps what is stored under its name. */
    val keeps: Boolean get() = stored != null && stored == name
}

/**
 * The secret form as the person edits it, started from an action's
 * [prefill]: every field may change, variables may be added, removed and
 * renamed. [existing] is the stored secret the name points at, once read;
 * with one the form changes it, otherwise it makes a new one.
 */
@Stable
class SecretDraft(private val prefill: SecretPrefill, name: String? = prefill.id) {
    var name by mutableStateOf(name.orEmpty())
    var description by mutableStateOf(prefill.description.orEmpty())
    private var describedByHand = false
    val rows = mutableStateListOf<SecretRow>()
    private var nextKey = 0

    /** The stored secret [name] points at; null when there is none or it isn't known yet. */
    var existing by mutableStateOf<StoredSecret?>(null)
        private set

    init {
        prefill.variables.forEach { rows += SecretRow(nextKey++, it.name, it.description, null, fromStore = false) }
    }

    fun describe(text: String) {
        description = text
        describedByHand = true
    }

    fun add() {
        rows += SecretRow(nextKey++, "", null, null, fromStore = false)
    }

    fun remove(row: SecretRow) {
        rows.remove(row)
    }

    /**
     * Opens the form on [secret], the one [name] now points at, or back on
     * a new one when null: its stored variables join the rows, kept unless
     * the person types over them, and its description shows unless the
     * person wrote their own.
     */
    fun adopt(secret: StoredSecret?) {
        existing = secret
        if (secret == null) {
            rows.removeAll { it.fromStore && it.value.isEmpty() && it.keeps }
            rows.forEach { it.stored = null }
            if (!describedByHand) description = prefill.description.orEmpty()
            return
        }
        val left = secret.variables.toMutableList()
        rows.forEach { row ->
            val match = left.firstOrNull { it.equals(row.name, ignoreCase = true) }
            row.stored = match
            if (match != null) {
                left.remove(match)
                row.name = match
            }
        }
        left.forEach { rows += SecretRow(nextKey++, it, null, it, fromStore = true) }
        if (!describedByHand && secret.description.isNotEmpty()) description = secret.description
    }

    val changing: Boolean get() = existing != null

    /** Everything that stops a save, or nothing. */
    val problems: Set<SecretProblem>
        get() = buildSet {
            if (!GenUiActions.SECRET_ID.matches(name)) add(SecretProblem.Name)
            if (description.trim().length !in 1..GenUiActions.MAX_DESCRIPTION) add(SecretProblem.Description)
            if (rows.isEmpty() || rows.size > MAX_BUNDLE) add(SecretProblem.NoVariables)
            if (rows.any { !GenUiActions.VARIABLE.matches(it.name) }) add(SecretProblem.VariableName)
            if (rows.distinctBy { it.name.lowercase() }.size != rows.size) add(SecretProblem.VariableTwice)
            if (rows.any { missing(it) || it.value.length > MAX_VALUE || '\u0000' in it.value }) add(SecretProblem.Value)
            if (existing?.changeable == false) add(SecretProblem.Managed)
        }

    /** Whether [row] still needs a value: always when creating, and for a new or renamed one when changing. */
    fun missing(row: SecretRow): Boolean = row.value.isEmpty() && !(existing != null && row.keeps)

    /**
     * The form as the route takes it. Creating, the whole bundle. Changing,
     * a patch: a typed value sets, a row left empty keeps, a removed or
     * renamed stored variable is `null`; and the stored version as `ifMatch`.
     */
    fun form(): SecretForm {
        val stored = existing
        val environment = buildJsonObject {
            if (stored == null) {
                rows.forEach { put(it.name, it.value) }
            } else {
                val kept = rows.mapNotNull { row -> row.stored?.takeIf { row.keeps } }.toSet()
                stored.variables.filter { it !in kept }.forEach { put(it, JsonNull) }
                rows.filter { it.value.isNotEmpty() }.forEach { put(it.name, it.value) }
            }
        }
        val secret = buildJsonObject {
            put("id", name)
            put("description", description.trim())
            put("environment", environment)
        }
        return SecretForm(secret, stored?.version)
    }

    /** Forgets every typed value, once saved or abandoned. */
    fun forget() {
        rows.forEach { it.value = "" }
    }

    companion object {
        /** API.md: a secret holds at most 256 variables, each value at most 65,536 characters. */
        const val MAX_BUNDLE = 256
        const val MAX_VALUE = 65_536
    }
}

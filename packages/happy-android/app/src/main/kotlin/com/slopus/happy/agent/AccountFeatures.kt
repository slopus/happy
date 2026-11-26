package com.slopus.happy.agent

import androidx.compose.runtime.Immutable
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * One of Happy's features as a person has it for their whole account
 * (happy-cluster API.md, "Account features"): the account's switch, not a
 * team's, the same on every server they are a member of. Off hides it from
 * them and deletes nothing.
 */
@Immutable
data class AccountFeature(val id: String, val name: String, val enabled: Boolean) {
    fun toJson(): JsonObject = buildJsonObject { put("id", id); put("name", name); put("enabled", enabled) }

    companion object {
        const val PIPELINES = "pipelines"

        /** Journalled to the person alone on every change; its payload is the whole list, as `GET` answers it. */
        const val UPDATED = "account.features.updated"

        /** A feature's routes while it is off for the person: `403` with this code, before anything else is checked. */
        const val TURNED_OFF = "feature_not_installed"

        /** `{ id, name, enabled }`; null for anything else. A name left out is the ID. */
        fun parse(json: JsonElement?): AccountFeature? {
            val feature = json as? JsonObject ?: return null
            val id = (feature["id"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() } ?: return null
            val enabled = (feature["enabled"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
            val name = (feature["name"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() } ?: id
            return AccountFeature(id, name, enabled)
        }

        /** `{ features: [Feature] }`, a feature it can't read left out; null when it isn't a list at all. */
        fun parseList(json: JsonElement?): List<AccountFeature>? =
            ((json as? JsonObject)?.get("features") as? JsonArray)?.mapNotNull(::parse)

        fun toJson(features: List<AccountFeature>): JsonObject = buildJsonObject { put("features", JsonArray(features.map { it.toJson() })) }

        /**
         * Whether [e] is a route of [feature] refused because the person
         * turned it off (`403 feature_not_installed`). The body names the
         * feature; one that names none is taken as the route's own.
         */
        fun refusedAsOff(e: Throwable, feature: String): Boolean {
            if (e !is AgentApiException || e.status != 403 || e.code != TURNED_OFF) return false
            val named = ((e.body as? JsonObject)?.get("feature") as? JsonPrimitive)?.contentOrNull
            return named == null || named == feature
        }
    }
}

/** The account features routes; a fake stands in for them in tests. */
interface AccountFeaturesApi {
    /** `GET /v0/account/features`; null on a server deployed before them (`404`/`501`), where every feature is on. */
    suspend fun features(): List<AccountFeature>?
}

class ClusterAccountFeatures(private val client: AgentClient) : AccountFeaturesApi {
    override suspend fun features(): List<AccountFeature>? {
        val answer = try {
            client.decode<JsonObject>("GET", PATH)
        } catch (e: AgentApiException) {
            // As PluginsAvailability probes `/v0/plugins`: an older server has no switch, so nothing is off.
            if (e.status == 404 || e.status == 501) return null else throw e
        }
        return AccountFeature.parseList(answer) ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }

    private companion object {
        const val PATH = "/v0/account/features"
    }
}

/**
 * The person's account features on one connection, as the apps show or hide
 * each by: what `GET` last answered or the last [AccountFeature.UPDATED]
 * said, kept beside the catalog so nothing comes and goes on each start.
 * Read on every connect (its `hello`; coming back to the foreground starts
 * the link again, so that is a connect too) where [served] (the server
 * has a feature the switch governs) or it has answered the list before,
 * and once [served] turns true after one.
 * An event replaces the list with its own, and a read that was on its way
 * meanwhile is dropped, so an older answer never undoes a newer change.
 * [features] is null where nothing is known, or the server has none: every
 * feature is on until the person turns it off.
 */
class AccountFeaturesSource(
    private val api: AccountFeaturesApi,
    events: SharedFlow<AgentEvent>,
    private val served: StateFlow<Boolean>,
    kept: suspend () -> JsonObject?,
    private val keep: suspend (JsonObject) -> Unit,
    private val scope: CoroutineScope,
) {
    private val state = MutableStateFlow<List<AccountFeature>?>(null)
    val features: StateFlow<List<AccountFeature>?> = state.asStateFlow()

    private val lock = Mutex()
    /** Bumped by every change that isn't a read's: a read that began before one is stale. */
    @Volatile private var generation = 0L
    @Volatile private var heard = false
    /** A `hello` came: the link has been up. */
    @Volatile private var connected = false
    private val asks = Channel<Unit>(Channel.CONFLATED)

    init {
        // Subscribed before the link's first hello can come.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { event ->
                when (event.type) {
                    AgentEvent.HELLO -> {
                        connected = true
                        // A server that answered the list once is asked on every connect, whatever health says now.
                        if (served.value || state.value != null) refresh()
                    }
                    AccountFeature.UPDATED -> AccountFeature.parseList(event.data)?.let { change { _ -> it } }
                }
            }
        }
        // Health said so after the hello (a first connect): read now, not at the next one. Never before a link was up.
        scope.launch { served.filter { it }.collect { if (connected) refresh() } }
        scope.launch {
            val last = kept()
            lock.withLock { if (!heard && last != null) state.value = AccountFeature.parseList(last) }
        }
        scope.launch {
            for (ask in asks) read()
        }
    }

    /** Whether the person turned [id] off: known and `enabled: false`. Unknown, or not on the list, is on. */
    fun off(id: String): StateFlow<Boolean> = state
        .map { list -> list?.firstOrNull { it.id == id }?.enabled == false }
        .distinctUntilChanged()
        .stateIn(scope, SharingStarted.Eagerly, state.value?.firstOrNull { it.id == id }?.enabled == false)

    fun refresh() {
        asks.trySend(Unit)
    }

    /**
     * A route of [id] answered that it is off for the person
     * ([AccountFeature.refusedAsOff]): it is, here too, at once; the event
     * that said so may not have come yet.
     */
    fun turnedOff(id: String) {
        scope.launch { change { list -> list.with(id, enabled = false) } }
    }

    private suspend fun read() {
        val started = generation
        val answer = try {
            api.features()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Offline or refused: what was known stays.
            return
        }
        lock.withLock {
            if (generation != started) return
            heard = true
            state.value = answer
        }
        keep(answer?.let(AccountFeature::toJson) ?: JsonObject(emptyMap()))
    }

    /** A change not of a read's: applied, kept, and a read under way dropped. */
    private suspend fun change(change: (List<AccountFeature>) -> List<AccountFeature>) {
        val list = lock.withLock {
            heard = true
            generation++
            change(state.value.orEmpty()).also { state.value = it }
        }
        keep(AccountFeature.toJson(list))
    }

    private fun List<AccountFeature>.with(id: String, enabled: Boolean): List<AccountFeature> =
        if (any { it.id == id }) map { if (it.id == id) it.copy(enabled = enabled) else it }
        else this + AccountFeature(id, id, enabled)

    companion object {
        /** Kept in the connection's resources under this key. */
        const val RESOURCE = "account-features"
    }
}

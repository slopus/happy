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
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
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
 * One of Happy's own features and whether it is available to the person
 * (happy-cluster API.md, "Feature plugins"): whether their account has its
 * feature plugin installed. Theirs, not a team's, the same on every server
 * they are a member of. Uninstalled hides it from them and deletes nothing.
 */
@Immutable
data class Feature(val id: String, val available: Boolean) {
    fun toJson(): JsonObject = buildJsonObject { put("id", id); put("available", available) }

    companion object {
        const val PIPELINES = "pipelines"

        /** The system event about availability, private to the person; its payload is the whole list, as `GET /v0/features` answers it. */
        const val UPDATED = "features.updated"

        /** A feature's routes while it is unavailable to the person: `403` with this code, before anything else is checked. */
        const val NOT_INSTALLED = "feature_not_installed"

        /** `{ id, available }`; null for anything else. */
        fun parse(json: JsonElement?): Feature? {
            val feature = json as? JsonObject ?: return null
            val id = (feature["id"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() } ?: return null
            val available = (feature["available"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
            return Feature(id, available)
        }

        /** `{ features: [Feature] }`, a feature it can't read left out; null when it isn't a list at all. */
        fun parseList(json: JsonElement?): List<Feature>? =
            ((json as? JsonObject)?.get("features") as? JsonArray)?.mapNotNull(::parse)

        fun toJson(features: List<Feature>): JsonObject = buildJsonObject { put("features", JsonArray(features.map { it.toJson() })) }

        /**
         * Whether [e] is a route of [feature] refused because the person
         * doesn't have its plugin installed (`403 feature_not_installed`).
         * The body names the feature; one that names none is taken as the
         * route's own.
         */
        fun notInstalled(e: Throwable, feature: String): Boolean {
            if (e !is AgentApiException || e.status != 403 || e.code != NOT_INSTALLED) return false
            val named = ((e.body as? JsonObject)?.get("feature") as? JsonPrimitive)?.contentOrNull
            return named == null || named == feature
        }
    }
}

/** The availability route; a fake stands in for it in tests. */
fun interface FeaturesApi {
    /** `GET /v0/features`; null where the server has none (`404`/`501`), where every feature is available. */
    suspend fun features(): List<Feature>?
}

class ClusterFeatures(private val client: AgentClient) : FeaturesApi {
    override suspend fun features(): List<Feature>? {
        val answer = try {
            client.decode<JsonObject>("GET", "/v0/features")
        } catch (e: AgentApiException) {
            // As PluginsAvailability probes `/v0/plugins`: a server without it has every feature available.
            if (e.status == 404 || e.status == 501) return null else throw e
        }
        return Feature.parseList(answer) ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }
}

/**
 * Which of Happy's features are available to the person on one connection,
 * as the apps show or hide each: what `GET /v0/features` last answered or
 * the last [Feature.UPDATED] said, kept beside the catalog so nothing comes
 * and goes on each start. Only where [served] (health's
 * `capabilities.features`); elsewhere every feature is available. Read on
 * every connect (its `hello`; coming back to the foreground starts the link
 * again, so that is a connect too), and once [served] turns true after one.
 * An event replaces the list with its own, and a read that was on its way
 * meanwhile is dropped, so an older answer never undoes a newer change.
 */
class FeaturesSource(
    private val api: FeaturesApi,
    events: SharedFlow<AgentEvent>,
    private val served: StateFlow<Boolean>,
    kept: suspend () -> JsonObject?,
    private val keep: suspend (JsonObject) -> Unit,
    private val scope: CoroutineScope,
) {
    private val state = MutableStateFlow<List<Feature>?>(null)
    /** Null where nothing is known, or the server has none. */
    val features: StateFlow<List<Feature>?> = state.asStateFlow()

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
                        if (served.value) refresh()
                    }
                    Feature.UPDATED -> Feature.parseList(event.data)?.let { change { _ -> it } }
                }
            }
        }
        // Health said so after the hello (a first connect): read now, not at the next one. Never before a link was up.
        scope.launch { served.filter { it }.collect { if (connected) refresh() } }
        scope.launch {
            val last = kept()
            lock.withLock { if (!heard && last != null) state.value = Feature.parseList(last) }
        }
        scope.launch {
            for (ask in asks) read()
        }
    }

    /** Whether [id] is unavailable to the person: the server has feature plugins and says so. Unknown, or not on the list, is available. */
    fun unavailable(id: String): StateFlow<Boolean> = combine(served, state) { served, list -> served && list?.firstOrNull { it.id == id }?.available == false }
        .distinctUntilChanged()
        .stateIn(scope, SharingStarted.Eagerly, served.value && state.value?.firstOrNull { it.id == id }?.available == false)

    fun refresh() {
        asks.trySend(Unit)
    }

    /**
     * What a route or a plugin write here said of [id] before the event
     * does: its routes refused as not installed ([Feature.notInstalled]), or
     * its feature plugin installed or uninstalled. Shown at once.
     */
    fun note(id: String, available: Boolean) {
        scope.launch {
            change { list -> if (list.any { it.id == id }) list.map { if (it.id == id) it.copy(available = available) else it } else list + Feature(id, available) }
        }
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
        keep(answer?.let(Feature::toJson) ?: JsonObject(emptyMap()))
    }

    /** A change not of a read's: applied, kept, and a read under way dropped. */
    private suspend fun change(change: (List<Feature>) -> List<Feature>) {
        val list = lock.withLock {
            heard = true
            generation++
            change(state.value.orEmpty()).also { state.value = it }
        }
        keep(Feature.toJson(list))
    }

    companion object {
        /** Kept in the connection's resources under this key. */
        const val RESOURCE = "features"
    }
}

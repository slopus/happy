package com.slopus.happy.model.settings

import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.Settings
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * The account's settings as the app acts on them: the stored server copy
 * with pending local changes on top (`HappyStore.effectiveSettings`), parsed.
 * happy-app's `storage.settings` and `sync.applySettings`.
 *
 * [settings] starts at the defaults and follows the store from the first
 * read on. A [change] shows at once, is recorded as pending in the store, and
 * asks for a sync ([onChanged]), which uploads it.
 */
class SettingsRepository(
    private val store: HappyStore,
    private val scope: CoroutineScope,
    private val onChanged: () -> Unit,
    private val io: CoroutineDispatcher = Dispatchers.IO.limitedParallelism(1),
) {
    private val state = MutableStateFlow(Settings.Defaults)
    val settings: StateFlow<Settings> = state.asStateFlow()
    private val raw = MutableStateFlow(EmptyJson)
    /** What [settings] is parsed from, for a reader that checks one key on its own ([Settings.analyticsOptOut]). */
    val document: StateFlow<JsonObject> = raw.asStateFlow()

    private val lock = Any()
    private var stored = EmptyJson
    /** Changes not yet in the store, so a read that races a write doesn't undo it on screen. */
    private var unwritten = EmptyJson

    init {
        scope.launch(io) {
            store.changes.collect {
                val read = store.effectiveSettings()
                synchronized(lock) {
                    stored = read
                    publish()
                }
            }
        }
    }

    /**
     * Sets the top-level keys in [delta] (applySettings). Completes with
     * whether it was written down: one that wasn't still shows, until the
     * app starts again.
     */
    fun change(delta: JsonObject): Deferred<Boolean> {
        if (delta.isEmpty()) return CompletableDeferred(true)
        synchronized(lock) {
            unwritten = JsonObject(unwritten + delta)
            publish()
        }
        return scope.async(io) {
            try {
                store.changeSettings(delta)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w("Settings", "Settings not written: ${e.javaClass.simpleName}")
                return@async false
            }
            synchronized(lock) {
                unwritten = JsonObject(unwritten.filter { (key, value) -> delta[key] != value })
            }
            onChanged()
            true
        }
    }

    /** Changes the fields [transform] changes: `change { it.copy(analyticsOptOut = true) }`. */
    fun change(transform: (Settings) -> Settings): Deferred<Boolean> {
        val before = state.value
        val beforeJson = before.toJson()
        val after = transform(before).toJson()
        return change(JsonObject(after.filter { (key, value) -> beforeJson[key] != value }))
    }

    private fun publish() {
        raw.value = JsonObject(stored + unwritten)
        state.value = Settings.parse(raw.value)
    }
}

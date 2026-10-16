package com.slopus.happy.model.settings

import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.Settings
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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

    /** Sets the top-level keys in [delta] (applySettings). */
    fun change(delta: JsonObject) {
        if (delta.isEmpty()) return
        synchronized(lock) {
            unwritten = JsonObject(unwritten + delta)
            publish()
        }
        scope.launch(io) {
            store.changeSettings(delta)
            synchronized(lock) {
                unwritten = JsonObject(unwritten.filter { (key, value) -> delta[key] != value })
            }
            onChanged()
        }
    }

    /** Changes the fields [transform] changes: `change { it.copy(analyticsOptOut = true) }`. */
    fun change(transform: (Settings) -> Settings) {
        val before = state.value
        val beforeJson = before.toJson()
        val after = transform(before).toJson()
        change(JsonObject(after.filter { (key, value) -> beforeJson[key] != value }))
    }

    private fun publish() {
        state.value = Settings.parse(JsonObject(stored + unwritten))
    }
}

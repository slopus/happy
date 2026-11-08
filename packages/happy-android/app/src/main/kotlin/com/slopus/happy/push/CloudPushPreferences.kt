package com.slopus.happy.push

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class CloudPushPreferences(private val api: CloudPushApi) {
    sealed interface State {
        data object Loading : State
        data object Failed : State
        data class Loaded(val value: CloudPushSettings, val saving: Boolean = false) : State
    }
    private val mutable = MutableStateFlow<State>(State.Loading)
    val state = mutable.asStateFlow()
    private val lock = Mutex()

    suspend fun refresh() = lock.withLock {
        try { mutable.value = State.Loaded(api.settings()) }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { mutable.value = State.Failed }
    }

    suspend fun set(enabled: Boolean) = lock.withLock {
        val before = mutable.value as? State.Loaded ?: return@withLock
        mutable.value = before.copy(saving = true)
        try { mutable.value = State.Loaded(api.settings(CloudPushSettings(enabled))) }
        catch (e: CancellationException) { mutable.value = before; throw e }
        catch (_: Exception) { mutable.value = State.Failed }
    }
}
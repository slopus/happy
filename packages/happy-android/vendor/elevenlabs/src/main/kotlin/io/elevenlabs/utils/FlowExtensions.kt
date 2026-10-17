package io.elevenlabs.utils

import androidx.lifecycle.LiveData
import androidx.lifecycle.asLiveData
import kotlinx.coroutines.flow.StateFlow

/**
 * Extension function to convert a StateFlow to LiveData for backward compatibility.
 *
 * This is useful for developers who want to continue using LiveData-based
 * observers in their UI layer while benefiting from the StateFlow-based SDK API.
 *
 * Example usage:
 * ```kotlin
 * val session: ConversationSession = ConversationClient.startSession(config, context)
 * val statusLiveData: LiveData<ConversationStatus> = session.status.asLiveData()
 *
 * statusLiveData.observe(viewLifecycleOwner) { status ->
 *     // Handle status changes
 * }
 * ```
 *
 * @receiver StateFlow to convert
 * @return LiveData that mirrors the StateFlow's values
 */
fun <T> StateFlow<T>.asLiveData(): LiveData<T> = (this as kotlinx.coroutines.flow.Flow<T>).asLiveData()


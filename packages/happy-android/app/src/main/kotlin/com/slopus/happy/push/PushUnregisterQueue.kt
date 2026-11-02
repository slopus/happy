package com.slopus.happy.push

import android.util.Log
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.net.HttpStatusException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID
import kotlin.math.min

/** A signed-out account's push token, still to be dropped on its server with the account's token. */
@Serializable
data class PendingPushRemoval(val serverUrl: String, val authToken: String, val pushToken: String) {
    override fun toString() = "PendingPushRemoval(serverUrl=$serverUrl)"
}

/**
 * iOS's PushUnregisterQueue (c7d74a4e8). A sign-out no longer waits for
 * the server to drop the phone's push token: the removal is kept here,
 * encrypted since the account's token is in it, and sent behind the
 * screens, retried 1, 2, 4, 8, 16 then every 30 s, and again at every
 * start, until the server answers. A 4xx is an answer too (the token or
 * the account is already gone), so it is not retried.
 */
class PushUnregisterQueue(
    private val items: ExpoSecureStore,
    private val scope: CoroutineScope,
    private val unregister: suspend (PendingPushRemoval) -> Unit,
    private val wait: suspend (attempt: Int) -> Unit = { delay(retryDelayMs(it)) },
) {
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var started = false

    /** Keeps [removal] and sends it as soon as it can. Blocks on storage. */
    fun add(removal: PendingPushRemoval) {
        val key = UUID.nameUUIDFromBytes("${removal.serverUrl}\n${removal.authToken}\n${removal.pushToken}".toByteArray()).toString()
        items.setItem(key, json.encodeToString(PendingPushRemoval.serializer(), removal))
        drain()
    }

    /** Sends whatever is waiting, now (the start, a removal added). */
    @Synchronized
    fun drain() {
        if (!started) {
            started = true
            scope.launch(Dispatchers.IO) { for (signal in wake) sendAll() }
        }
        wake.trySend(Unit)
    }

    private suspend fun sendAll() {
        var attempt = 0
        while (true) {
            val waiting = items.keys().mapNotNull { key ->
                val removal = read(key)
                if (removal == null) items.deleteItem(key)
                removal?.let { key to it }
            }
            if (waiting.isEmpty()) return
            var failed = false
            for ((key, removal) in waiting) {
                if (send(removal)) items.deleteItem(key) else failed = true
            }
            if (failed) wait(++attempt)
        }
    }

    /** Whether the server answered; a refusal of the token or the account is an answer. */
    private suspend fun send(removal: PendingPushRemoval): Boolean = try {
        unregister(removal)
        true
    } catch (e: CancellationException) {
        throw e
    } catch (e: HttpStatusException) {
        e.status in 400..499
    } catch (e: Exception) {
        Log.w(TAG, "Unregistering a signed-out account's push token failed; retrying", e)
        false
    }

    private fun read(key: String): PendingPushRemoval? = try {
        items.getItem(key)?.let { json.decodeFromString(PendingPushRemoval.serializer(), it) }
    } catch (_: Exception) {
        null
    }

    companion object {
        const val PREFS_NAME = "push-unregister"
        const val KEYCHAIN_SERVICE = "push-unregister"
        private const val TAG = "PushUnregisterQueue"
        private val json = Json { ignoreUnknownKeys = true }

        /** 1, 2, 4, 8, 16, then 30 s. */
        fun retryDelayMs(attempt: Int): Long = min(30_000L, 1_000L shl min(attempt - 1, 5).coerceAtLeast(0))
    }
}

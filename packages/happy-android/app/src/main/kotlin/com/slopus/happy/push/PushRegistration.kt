package com.slopus.happy.push

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Where this device's FCM token comes from. Null when push can't work here. */
fun interface DevicePushTokenSource {
    suspend fun token(): String?
}

/**
 * Firebase Cloud Messaging. Firebase is configured at build time from a
 * google-services.json (AGENTS.md "Push"); a build without one has no
 * Firebase app, and push is unsupported. So is a device without Play
 * services, where FCM can't hand out a token.
 */
class FcmTokenSource(private val context: Context) : DevicePushTokenSource {
    val supported: Boolean get() = hasPlayServices(context) && isFirebaseConfigured(context)

    override suspend fun token(): String? {
        if (!supported) return null
        return suspendCancellableCoroutine { continuation ->
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { continuation.resume(it) }
                .addOnFailureListener { continuation.resumeWithException(it) }
                .addOnCanceledListener { continuation.cancel() }
        }
    }

    companion object {
        /** Installed and enabled; an outdated version may still deliver. */
        fun hasPlayServices(context: Context): Boolean =
            GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context) !in setOf(
                ConnectionResult.SERVICE_MISSING,
                ConnectionResult.SERVICE_DISABLED,
                ConnectionResult.SERVICE_INVALID,
            )

        fun isFirebaseConfigured(context: Context): Boolean = try {
            FirebaseApp.getApps(context).isNotEmpty() || FirebaseApp.initializeApp(context) != null
        } catch (_: IllegalStateException) {
            false
        }
    }
}

/** persistence.ts `registered-push-token`: the Expo token last registered with happy-server. */
class RegisteredPushTokenStore(private val prefs: SharedPreferences) {
    fun load(): String? = prefs.getString(KEY, null)
    fun save(token: String) = prefs.edit().putString(KEY, token).apply()
    fun clear() = prefs.edit().remove(KEY).apply()

    companion object {
        const val PREFS_NAME = "push"
        private const val KEY = "registered-push-token"
    }
}

sealed interface PushSyncResult {
    data class Registered(val token: String) : PushSyncResult

    /** No Firebase in this build, or no FCM token on this device (no Play services). */
    data object Unsupported : PushSyncResult
}

/**
 * pushRegistration.ts syncCurrentPushToken, once notifications are allowed
 * (the permission is the UI's: [PushRegistrationEffect]). Gets the Expo
 * token for this device's FCM token, registers it with happy-server,
 * remembers it, and drops the previously registered token if it changed.
 * Throws when the FCM token or the Expo exchange fails.
 */
class PushRegistrar(
    private val deviceTokens: DevicePushTokenSource,
    private val expo: ExpoPushTokenClient,
    private val api: PushApi,
    private val store: RegisteredPushTokenStore,
    private val installationId: () -> String,
    private val applicationId: String,
) {
    /** getCurrentExpoPushToken, without the permission check. */
    suspend fun currentExpoToken(): String? {
        val fcm = deviceTokens.token() ?: return store.load()
        return expo.exchange(fcm, installationId(), applicationId)
    }

    suspend fun sync(authToken: String): PushSyncResult {
        val fcm = deviceTokens.token() ?: return PushSyncResult.Unsupported
        val current = expo.exchange(fcm, installationId(), applicationId)
        val previous = store.load()
        api.register(authToken, current)
        store.save(current)
        if (previous != null && previous != current) {
            try {
                api.unregister(authToken, previous)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Failed to unregister previous push token", e)
            }
        }
        return PushSyncResult.Registered(current)
    }

    /** removePushToken: Settings › Account's per-device remove. */
    suspend fun remove(authToken: String, token: String) {
        api.unregister(authToken, token)
        if (store.load() == token) store.clear()
    }

    /** Signing out forgets the registration, as logout's `mmkv.clearAll()` does. */
    fun forget() = store.clear()

    /**
     * AuthContext.tsx logout: this device's token is dropped on the server
     * while the account's token still works, so the account stops pushing
     * here. [PushApi] retries forever and a logout must not hang, so it gets
     * [timeoutMs]; a token that couldn't be dropped is forgotten all the same.
     */
    suspend fun unregisterOnLogout(authToken: String, timeoutMs: Long = LOGOUT_TIMEOUT_MS) {
        val token = store.load() ?: return
        try {
            withTimeout(timeoutMs) { api.unregister(authToken, token) }
        } catch (e: TimeoutCancellationException) {
            Log.w(TAG, "Unregistering the push token timed out during logout", e)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Failed to unregister push token during logout", e)
        }
        store.clear()
    }

    companion object {
        private const val TAG = "PushRegistrar"
        const val LOGOUT_TIMEOUT_MS = 5_000L
    }
}

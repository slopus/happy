package com.slopus.happy.config

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.RestrictionsManager
import android.os.Bundle
import android.util.Log
import androidx.core.content.ContextCompat
import com.slopus.happy.connection.ServerAuthClient
import com.slopus.happy.connection.ServerAuthException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * What an organization's device management set for this app (Android
 * Enterprise managed configurations, `res/xml/app_restrictions.xml`). The
 * keys are the edge SSO contract's §6, the same on iOS and desktop. A key
 * that is set is enforced in code and its control shows locked; one that
 * isn't (null here) leaves the person's own choice. A value of the wrong
 * type, or a server that isn't an `https://` origin, is ignored.
 */
data class ManagedPolicy(
    /** The team server's origin: offered on the first screen, kept and not removable once signed in. */
    val serverUrl: String? = null,
    /** False: no team server but [serverUrl] can be added. */
    val allowAdditionalServers: Boolean? = null,
    /** False: analytics off, locked. Management can only turn analytics off: true is read as unset. */
    val analyticsEnabled: Boolean? = null,
    /** False: no Happy account on Happy's hosted relay server can be created, restored or used. */
    val hostedRelayEnabled: Boolean? = null,
    /** False: nothing connects over Tailcat. */
    val tailcatEnabled: Boolean? = null,
    /** False: no agent can be paired by QR code (`happy://direct?`). */
    val phonePairingEnabled: Boolean? = null,
) {
    /** Whether the person may add the team server at [origin]. */
    fun allowsServer(origin: String): Boolean = allowAdditionalServers != false || origin == serverUrl

    val managed: Boolean get() = this != ManagedPolicy()

    companion object {
        const val SERVER_URL = "serverUrl"
        const val ALLOW_ADDITIONAL_SERVERS = "allowAdditionalServers"
        const val ANALYTICS_ENABLED = "analyticsEnabled"
        const val HOSTED_RELAY_ENABLED = "hostedRelayEnabled"
        const val TAILCAT_ENABLED = "tailcatEnabled"
        const val PHONE_PAIRING_ENABLED = "phonePairingEnabled"

        private const val TAG = "ManagedSettings"

        /** From the restrictions as typed values; unknown keys are ignored. */
        fun from(values: Map<String, Any?>): ManagedPolicy {
            fun bool(key: String): Boolean? = when (val value = values[key]) {
                null -> null
                is Boolean -> value
                else -> null.also { Log.w(TAG, "Ignoring managed $key: not a bool") }
            }
            val server = when (val value = values[SERVER_URL]) {
                null -> null
                is String -> value.takeIf { it.isNotBlank() }?.let { text ->
                    try {
                        // Only an https:// origin; a bare host isn't accepted from management.
                        if (!text.trim().startsWith("https://")) throw ServerAuthException(ServerAuthException.Reason.InvalidAddress)
                        ServerAuthClient.parseAddress(text).value
                    } catch (_: ServerAuthException) {
                        null.also { Log.w(TAG, "Ignoring managed $SERVER_URL: not an https:// origin") }
                    }
                }
                else -> null.also { Log.w(TAG, "Ignoring managed $SERVER_URL: not a string") }
            }
            return ManagedPolicy(
                serverUrl = server,
                allowAdditionalServers = bool(ALLOW_ADDITIONAL_SERVERS),
                analyticsEnabled = bool(ANALYTICS_ENABLED)?.takeIf { !it },
                hostedRelayEnabled = bool(HOSTED_RELAY_ENABLED),
                tailcatEnabled = bool(TAILCAT_ENABLED),
                phonePairingEnabled = bool(PHONE_PAIRING_ENABLED),
            )
        }

        @Suppress("DEPRECATION")
        fun from(bundle: Bundle): ManagedPolicy = from(bundle.keySet().associateWith { bundle.get(it) })
    }
}

/**
 * The [ManagedPolicy] in effect, read from [RestrictionsManager] when the
 * graph is built and again whenever the device's management changes it
 * while the app runs (`ACTION_APPLICATION_RESTRICTIONS_CHANGED`).
 */
class ManagedSettings(context: Context) {
    private val appContext = context.applicationContext ?: context
    private val state = MutableStateFlow(read())
    val policy: StateFlow<ManagedPolicy> = state.asStateFlow()

    init {
        ContextCompat.registerReceiver(
            appContext,
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    state.value = read()
                }
            },
            IntentFilter(Intent.ACTION_APPLICATION_RESTRICTIONS_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    private fun read(): ManagedPolicy = try {
        val manager = appContext.getSystemService(Context.RESTRICTIONS_SERVICE) as? RestrictionsManager
        manager?.applicationRestrictions?.let(ManagedPolicy::from) ?: ManagedPolicy()
    } catch (e: Exception) {
        Log.w("ManagedSettings", "Couldn't read managed configuration", e)
        ManagedPolicy()
    }
}

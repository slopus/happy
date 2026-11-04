package com.slopus.happy.connection

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * Whether the phone has a way out at all (iOS's `NetworkPath`): a default
 * network, now and on every change. Without one a header says "Waiting for
 * network…" ([LinkState.WaitingForNetwork]) rather than "Connecting…".
 */
fun Context.networkPath(): Flow<Boolean> {
    val manager = getSystemService(ConnectivityManager::class.java) ?: return callbackFlow {
        trySend(true)
        awaitClose()
    }
    return networkPath(
        hasDefault = { manager.activeNetwork != null },
        register = manager::registerDefaultNetworkCallback,
        unregister = manager::unregisterNetworkCallback,
    )
}

/**
 * [networkPath] over its system calls. The callback is registered before
 * the network is read: a default network lost in between (airplane mode
 * turned on as an activity is recreated) sends no callback to one
 * registered after it, which then said "there is one" until the next change.
 */
internal fun networkPath(
    hasDefault: () -> Boolean,
    register: (ConnectivityManager.NetworkCallback) -> Unit,
    unregister: (ConnectivityManager.NetworkCallback) -> Unit,
): Flow<Boolean> = callbackFlow {
    val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            trySend(true)
        }

        // The default network went and none took its place yet: one that does comes as onAvailable.
        override fun onLost(network: Network) {
            trySend(false)
        }
    }
    register(callback)
    trySend(hasDefault())
    awaitClose { unregister(callback) }
}.distinctUntilChanged()

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
fun Context.networkPath(): Flow<Boolean> = callbackFlow {
    val manager = getSystemService(ConnectivityManager::class.java)
    if (manager == null) {
        trySend(true)
        awaitClose()
        return@callbackFlow
    }
    val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            trySend(true)
        }

        // The default network went and none took its place yet: one that does comes as onAvailable.
        override fun onLost(network: Network) {
            trySend(false)
        }
    }
    trySend(manager.activeNetwork != null)
    manager.registerDefaultNetworkCallback(callback)
    awaitClose { manager.unregisterNetworkCallback(callback) }
}.distinctUntilChanged()

package com.slopus.happy.connection

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map

/**
 * Whether the phone has a way out at all (iOS's `NetworkPath`): a default
 * network, now and on every change. Without one a header says "Waiting for
 * network…" ([LinkState.WaitingForNetwork]) rather than "Connecting…".
 */
fun Context.networkPath(): Flow<Boolean> = defaultNetwork().map { it != null }.distinctUntilChanged()

/**
 * The phone's default network, by its handle ([Network.getNetworkHandle]),
 * now and on every change; null while there is none. Wi-Fi handing over to
 * cellular is another handle with no null between, which [networkPath]
 * doesn't tell ([changes] does).
 */
fun Context.defaultNetwork(): Flow<Long?> {
    val manager = getSystemService(ConnectivityManager::class.java) ?: return callbackFlow {
        trySend(0L)
        awaitClose()
    }
    return defaultNetwork(
        current = { manager.activeNetwork?.networkHandle },
        register = manager::registerDefaultNetworkCallback,
        unregister = manager::unregisterNetworkCallback,
    )
}

/**
 * [defaultNetwork] over its system calls. The callback is registered before
 * the network is read: a default network lost in between (airplane mode
 * turned on as an activity is recreated) sends no callback to one
 * registered after it, which then said "there is one" until the next change.
 */
internal fun defaultNetwork(
    current: () -> Long?,
    register: (ConnectivityManager.NetworkCallback) -> Unit,
    unregister: (ConnectivityManager.NetworkCallback) -> Unit,
): Flow<Long?> = callbackFlow {
    val callback = object : ConnectivityManager.NetworkCallback() {
        // Also another network taking the default's place, with no onLost before it.
        override fun onAvailable(network: Network) {
            trySend(network.networkHandle)
        }

        // The default network went and none took its place yet: one that does comes as onAvailable.
        override fun onLost(network: Network) {
            trySend(null)
        }
    }
    register(callback)
    trySend(current())
    awaitClose { unregister(callback) }
}.distinctUntilChanged()

/** What a change of the default network asks of the links over it ([changes]). */
enum class NetworkChange {
    /** A network after none (back from airplane mode): what waited for the backoff tries now. */
    Returned,

    /**
     * Another network than the last one (Wi-Fi to cellular, or back on
     * another after none; iOS's `NetworkPath.moves`): what was open went
     * out the old way, where it can hang with nothing said.
     */
    Moved,
}

/** Each [NetworkChange] in [this] ([defaultNetwork]). The first value is never one. */
fun Flow<Long?>.changes(): Flow<NetworkChange> = flow {
    var last: Long? = null
    var away = false
    collect { now ->
        when {
            now == null -> {}
            last != null && now != last -> emit(NetworkChange.Moved)
            away -> emit(NetworkChange.Returned)
        }
        if (now != null) last = now
        away = now == null
    }
}

/**
 * Each time [this] says there is a network after saying there was none
 * (back from airplane mode): what waited for the backoff tries now
 * instead (iOS's `networkReturned`). The first value is never a return.
 */
fun Flow<Boolean>.returns(): Flow<Unit> = flow {
    var away = false
    collect { up ->
        if (up && away) emit(Unit)
        away = !up
    }
}

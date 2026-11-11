package com.slopus.happy.connection

import android.net.ConnectivityManager
import android.net.Network
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.count
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.shadows.ShadowNetwork

/**
 * The default network, as headers and links read it: the callback is in
 * place before the network is read, so one lost in between (airplane mode
 * turned on as an activity is recreated) still says "Waiting for
 * network…"; and Wi-Fi handing over to cellular is told as a move.
 */
@RunWith(AndroidJUnit4::class)
class NetworkPathTest {
    @Test fun `a network lost between the first read and the registration is not missed`() = runTest {
        // The network is there until the callback is registered, and gone by the time it is read after:
        // the system sends nothing to a callback registered with no default network.
        var present: Long? = 1L
        val registered = mutableListOf<ConnectivityManager.NetworkCallback>()
        val path = defaultNetwork(
            current = { present },
            register = { registered += it; present = null },
            unregister = { registered -= it },
        )
        assertEquals(null, path.first())
        assertTrue("unregistered once collected", registered.isEmpty())
    }

    @Test fun `changes come through, each once`() = runTest {
        var callback: ConnectivityManager.NetworkCallback? = null
        val wifi: Network = ShadowNetwork.newInstance(1)
        val cellular: Network = ShadowNetwork.newInstance(2)
        val path = defaultNetwork(current = { wifi.networkHandle }, register = { callback = it }, unregister = {})
        val seen = mutableListOf<Long?>()
        val collecting = launch { path.take(4).toList(seen) }
        testScheduler.advanceUntilIdle()
        callback!!.onAvailable(wifi)
        callback!!.onLost(wifi)
        testScheduler.advanceUntilIdle()
        callback!!.onAvailable(wifi)
        testScheduler.advanceUntilIdle()
        // Off Wi-Fi onto cellular: the system names the new default, with no loss before it.
        callback!!.onAvailable(cellular)
        collecting.join()
        assertEquals(listOf(wifi.networkHandle, null, wifi.networkHandle, cellular.networkHandle), seen)
    }

    @Test fun `another network is a move, the same one after none a return`() = runTest {
        assertEquals(emptyList<NetworkChange>(), flowOf<Long?>(1, 1).changes().toList())
        assertEquals(emptyList<NetworkChange>(), flowOf<Long?>(null).changes().toList())
        assertEquals(listOf(NetworkChange.Moved, NetworkChange.Moved), flowOf<Long?>(1, 2, 1).changes().toList())
        assertEquals(listOf(NetworkChange.Returned), flowOf<Long?>(1, null, 1).changes().toList())
        assertEquals(listOf(NetworkChange.Moved), flowOf<Long?>(1, null, null, 2).changes().toList())
        assertEquals(listOf(NetworkChange.Returned, NetworkChange.Moved), flowOf<Long?>(null, 1, 2).changes().toList())
    }

    @Test fun `a return is a network after none, and the first reading is never one`() = runTest {
        assertEquals(0, flowOf(true, true).returns().count())
        assertEquals(2, flowOf(true, false, false, true, true, false, true).returns().count())
        assertEquals(1, flowOf(false, true).returns().count())
    }
}

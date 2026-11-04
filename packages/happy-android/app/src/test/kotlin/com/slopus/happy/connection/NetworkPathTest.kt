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
 * Whether there is a network, as headers read it: the callback is in place
 * before the network is read, so one lost in between (airplane mode turned
 * on as an activity is recreated) still says "Waiting for network…".
 */
@RunWith(AndroidJUnit4::class)
class NetworkPathTest {
    @Test fun `a network lost between the first read and the registration is not missed`() = runTest {
        // The network is there until the callback is registered, and gone by the time it is read after:
        // the system sends nothing to a callback registered with no default network.
        var present = true
        val registered = mutableListOf<ConnectivityManager.NetworkCallback>()
        val path = networkPath(
            hasDefault = { present },
            register = { registered += it; present = false },
            unregister = { registered -= it },
        )
        assertEquals(false, path.first())
        assertTrue("unregistered once collected", registered.isEmpty())
    }

    @Test fun `changes come through, each once`() = runTest {
        var callback: ConnectivityManager.NetworkCallback? = null
        val path = networkPath(hasDefault = { true }, register = { callback = it }, unregister = {})
        val seen = mutableListOf<Boolean>()
        val collecting = launch { path.take(3).toList(seen) }
        testScheduler.advanceUntilIdle()
        val network: Network = ShadowNetwork.newInstance(1)
        callback!!.onAvailable(network)
        callback!!.onLost(network)
        testScheduler.advanceUntilIdle()
        callback!!.onAvailable(network)
        collecting.join()
        assertEquals(listOf(true, false, true), seen)
    }

    @Test fun `a return is a network after none, and the first reading is never one`() = runTest {
        assertEquals(0, flowOf(true, true).returns().count())
        assertEquals(2, flowOf(true, false, false, true, true, false, true).returns().count())
        assertEquals(1, flowOf(false, true).returns().count())
    }
}

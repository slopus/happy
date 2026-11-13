package com.slopus.happy.camera

import androidx.concurrent.futures.CallbackToFutureAdapter
import com.google.common.util.concurrent.ListenableFuture
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotoZoomRequestsTest {
    private val sent = ArrayList<Float>()
    private val answers = ArrayList<CallbackToFutureAdapter.Completer<Void>>()
    private val camera: (Float) -> ListenableFuture<Void> = { ratio ->
        sent += ratio
        CallbackToFutureAdapter.getFuture { answers += it; "zoom $ratio" }
    }

    @Test fun onlyOneRatioIsInFlightAndThePinchsLatestGoesNext() {
        val zooms = PhotoZoomRequests { it.run() }
        zooms.bind(camera)
        zooms.request(1.2f)
        zooms.request(1.6f)
        zooms.request(2f)
        assertEquals(listOf(1.2f), sent)
        assertTrue(zooms.pending)
        answers.last().set(null)
        assertEquals(listOf(1.2f, 2f), sent)
        answers.last().set(null)
        assertEquals(listOf(1.2f, 2f), sent)
        assertFalse(zooms.pending)
    }

    @Test fun aFailedOrCancelledRatioFreesTheCamera() {
        val zooms = PhotoZoomRequests { it.run() }
        zooms.bind(camera)
        zooms.request(2f)
        zooms.request(3f)
        answers.last().setException(IllegalStateException("Camera is not active"))
        assertEquals(listOf(2f, 3f), sent)
        answers.last().setCancelled()
        assertFalse(zooms.pending)
    }

    @Test fun aCameraBoundAnewDropsWhatTheOldOneOwed() {
        val zooms = PhotoZoomRequests { it.run() }
        zooms.bind(camera)
        zooms.request(2f)
        zooms.request(5f)
        zooms.bind(camera)
        assertFalse(zooms.pending)
        answers.first().set(null)
        assertEquals(listOf(2f), sent)
        zooms.bind(null)
        zooms.request(1f)
        assertEquals(listOf(2f), sent)
    }
}

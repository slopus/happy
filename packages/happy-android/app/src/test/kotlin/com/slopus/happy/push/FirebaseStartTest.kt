package com.slopus.happy.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.firebase.FirebaseApp
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric

/**
 * Firebase starts where push needs it, not with the process ([FirebaseStart]):
 * a push that wakes a killed process reaches HappyMessagingService with no
 * FirebaseApp, and the service starts one before FirebaseMessagingService's
 * own handling reads it.
 */
@RunWith(AndroidJUnit4::class)
class FirebaseStartTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Before
    fun noFirebase() {
        FirebaseApp.clearInstancesForTest()
    }

    @After
    fun clear() {
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun aPushThatStartsTheProcessStartsFirebase() {
        Robolectric.buildService(HappyMessagingService::class.java).create()
        val app = FirebaseApp.getApps(context).single()
        // From the resources build.gradle.kts generates out of google-services.json.
        assertEquals(context.getString(context.resources.getIdentifier("google_app_id", "string", context.packageName)), app.options.applicationId)
    }

    @Test
    fun startingAgainKeepsTheSameApp() {
        assertTrue(FirebaseStart.ensure(context))
        val first = FirebaseApp.getInstance()
        assertTrue(FirebaseStart.ensure(context))
        Robolectric.buildService(HappyMessagingService::class.java).create()
        assertTrue(FcmTokenSource.isFirebaseConfigured(context))
        assertSame(first, FirebaseApp.getApps(context).single())
    }

    @Test
    fun startingFromManyThreadsAtOnceMakesOneApp() {
        val results = (1..8).map { java.util.concurrent.CompletableFuture.supplyAsync { FirebaseStart.ensure(context) } }.map { it.get() }
        assertEquals(List(8) { true }, results)
        assertEquals(1, FirebaseApp.getApps(context).size)
    }
}

package com.slopus.happy.push

import android.content.Context
import com.google.firebase.FirebaseApp

/**
 * Firebase, started where push first needs it instead of with the process.
 * The manifest removes FirebaseInitProvider, which ran before
 * `Application.onCreate` on every cold start (research/cold-start.md). So
 * every path into FirebaseMessaging starts it first:
 * - push registration, off the main thread after the first frame
 *   ([PushRegistrationEffect], Settings' push rows), through [FcmTokenSource];
 * - [HappyMessagingService.onCreate], before FirebaseMessagingService's own,
 *   for a push or a new token that starts a killed process.
 *
 * FirebaseInstanceIdReceiver, the GMS broadcast that wakes the process,
 * only starts that service; it never reads FirebaseApp.
 *
 * The options are the resources that build.gradle.kts generates from
 * google-services.json, the same ones FirebaseInitProvider read. Idempotent
 * and safe from any thread. False when the build has no Firebase client.
 */
object FirebaseStart {
    fun ensure(context: Context): Boolean = synchronized(this) {
        try {
            FirebaseApp.getApps(context).isNotEmpty() || FirebaseApp.initializeApp(context) != null
        } catch (_: IllegalStateException) {
            false
        }
    }
}

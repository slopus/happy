package com.slopus.happy

import android.app.Application
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.contentcapture.ContentCaptureManager
import com.slopus.happy.data.DiskThread
import com.slopus.happy.diagnostics.traced
import com.slopus.happy.push.PushServices
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlin.concurrent.thread

class HappyApplication : Application() {
    /** Built on first use. The main thread never asks for it: it waits for [graphReady]. */
    val graph: AppGraph by lazy {
        traced("AppGraph") {
            AppGraph(
                context = this,
                clientId = "android/${BuildConfig.VERSION_NAME}",
                defaultServerUrl = BuildConfig.DEFAULT_SERVER_URL,
            ).also { PushServices.unregisterOnLogout(this, it) }
        }
    }

    /**
     * The graph, built off the main thread the first time the window asks:
     * it reads the account registry, the credentials and the preferences
     * from disk.
     */
    val graphReady: Deferred<AppGraph> by lazy {
        val built = CompletableDeferred<AppGraph>()
        thread(name = "app-graph") {
            try {
                built.complete(graph)
                // Home's rows from disk while the window composes (research/cold-start.md).
                traced("warmHome") { graph.warmHome() }
                // What the first screens would otherwise read on the main thread: the push preferences, the glass switch.
                traced("PushServices") { PushServices.get(this) }
                com.slopus.happy.ui.components.glassBlurEnabled(this)
            } catch (e: Throwable) {
                built.completeExceptionally(e)
            }
        }
        built
    }

    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate() {
        super.onCreate()
        // Private conversations aren't input to Android's system-intelligence capture.
        // Its Compose semantics scans also cost 5–12 ms during navigation on the
        // Nothing Phone. This switch only stops content capture: accessibility and
        // autofill have their own managers and keep the complete semantics tree.
        ContentCaptureManager.isEnabled = false
        if (BuildConfig.DEBUG) DiskThread.watch()
    }
}

package com.slopus.happy

import android.app.Application
import com.slopus.happy.data.DiskThread
import com.slopus.happy.push.PushServices
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlin.concurrent.thread

class HappyApplication : Application() {
    /** Built on first use. The main thread never asks for it: it waits for [graphReady]. */
    val graph: AppGraph by lazy {
        AppGraph(
            context = this,
            clientId = "android/${BuildConfig.VERSION_NAME}",
            defaultServerUrl = BuildConfig.DEFAULT_SERVER_URL,
        ).also { PushServices.unregisterOnLogout(this, it) }
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
                // Home's push effect reads its preferences on the main thread; read them here first.
                PushServices.get(this)
            } catch (e: Throwable) {
                built.completeExceptionally(e)
            }
        }
        built
    }

    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.DEBUG) DiskThread.watch()
    }
}

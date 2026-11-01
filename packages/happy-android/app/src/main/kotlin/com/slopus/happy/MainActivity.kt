package com.slopus.happy

import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewTreeObserver
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.slopus.happy.push.BackgroundSendNotifications
import com.slopus.happy.ui.AfterStart
import com.slopus.happy.ui.FirstFrame
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.LocalAfterStart
import com.slopus.happy.ui.connect.DeepLinks
import androidx.profileinstaller.ProfileInstaller
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlin.coroutines.resume

class MainActivity : ComponentActivity() {
    /** Null until the graph is built off the main thread ([HappyApplication.graphReady]). */
    private val graph = MutableStateFlow<AppGraph?>(null)

    /** [AfterStart]: the opening screen fully drawn (or [START_GRACE_MS] without it), and one frame more. */
    private val started = CompletableDeferred<Unit>()
    private val afterStart = AfterStart { started.await() }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) DeepLinks.offer(intent)
        val ready = (application as HappyApplication).graphReady
        // The first frame waits for the graph (the system's splash stays up meanwhile); the main thread doesn't.
        if (!ready.isCompleted) holdFirstFrame()
        lifecycleScope.launch {
            val built = ready.await()
            graph.value = built
            BackgroundSendNotifications.start(this@MainActivity, built)
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                built.setForeground(true)
                built.requestSync()
                try {
                    awaitCancellation()
                } finally {
                    built.setForeground(false)
                }
            }
        }
        // Glass blurs from the second frame (FirstFrame); API 29's commit callback says when the first is drawn.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            FirstFrame.pending()
            // Posted, so it runs once the window is attached and lands on its own tree observer.
            window.decorView.post {
                window.decorView.viewTreeObserver.registerFrameCommitCallback {
                    FirstFrame.done()
                }
            }
        }
        lifecycleScope.launch {
            withTimeoutOrNull(START_GRACE_MS) { fullyDrawn() }
            awaitFrame()
            started.complete(Unit)
            // What ProfileInstallerInitializer did before the first frame, now after it, as late as it did its work.
            delay(PROFILE_DELAY_MS)
            withContext(Dispatchers.IO) { ProfileInstaller.writeProfile(applicationContext) }
        }
        setContent {
            val shown by graph.collectAsState()
            // System bar icons follow the app's theme, which can differ from the system's.
            shown?.let { CompositionLocalProvider(LocalAfterStart provides afterStart) {
                HappyApp(it, onDarkThemeChange = { dark ->
                    val style = if (dark) {
                        SystemBarStyle.dark(Color.TRANSPARENT)
                    } else {
                        SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                    }
                    enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
                })
            } }
        }
    }

    /** Both homes and the first screen report it once their rows (or loader) are drawn. */
    private suspend fun fullyDrawn() = suspendCancellableCoroutine { done ->
        val listener: () -> Unit = { if (done.isActive) done.resume(Unit) }
        fullyDrawnReporter.addOnReportDrawnListener(listener)
        done.invokeOnCancellation { fullyDrawnReporter.removeOnReportDrawnListener(listener) }
    }

    /**
     * Before the window's views attach, so before its first composition. The graph is
     * usually built by now, but the main thread is only told by a message that runs
     * after the first traversal; without this, that traversal composes an empty window,
     * [holdFirstFrame] cancels its draw, and home is drawn a traversal later.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        val ready = (application as HappyApplication).graphReady
        if (graph.value == null && ready.isCompleted && ready.getCompletionExceptionOrNull() == null) graph.value = ready.getCompleted()
    }

    private fun holdFirstFrame() {
        val content = findViewById<View>(android.R.id.content)
        content.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                if (graph.value == null) return false
                content.viewTreeObserver.removeOnPreDrawListener(this)
                return true
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        DeepLinks.offer(intent)
    }
}

/** A screen that never reports fully drawn (a chat restored after process death) ends the start this late. */
private const val START_GRACE_MS = 3_000L

/** ProfileInstallerInitializer's own wait before it writes the profile (5 s from the first frame). */
private const val PROFILE_DELAY_MS = 5_000L

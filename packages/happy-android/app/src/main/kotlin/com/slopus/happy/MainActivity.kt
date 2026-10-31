package com.slopus.happy

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewTreeObserver
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.slopus.happy.push.BackgroundSendNotifications
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.connect.DeepLinks
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    /** Null until the graph is built off the main thread ([HappyApplication.graphReady]). */
    private val graph = MutableStateFlow<AppGraph?>(null)

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
        setContent {
            val shown by graph.collectAsState()
            // System bar icons follow the app's theme, which can differ from the system's.
            shown?.let {
                HappyApp(it, onDarkThemeChange = { dark ->
                    val style = if (dark) {
                        SystemBarStyle.dark(Color.TRANSPARENT)
                    } else {
                        SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                    }
                    enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
                })
            }
        }
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

package com.slopus.happy

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.slopus.happy.push.BackgroundSendNotifications
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.connect.DeepLinks

class MainActivity : ComponentActivity() {
    private val graph: AppGraph get() = (application as HappyApplication).graph

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) DeepLinks.offer(intent)
        BackgroundSendNotifications.start(this, graph)
        setContent {
            // System bar icons follow the app's theme, which can differ from the system's.
            HappyApp(graph, onDarkThemeChange = { dark ->
                val style = if (dark) {
                    SystemBarStyle.dark(Color.TRANSPARENT)
                } else {
                    SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                }
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            })
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        DeepLinks.offer(intent)
    }

    override fun onStart() {
        super.onStart()
        graph.setForeground(true)
        graph.requestSync()
    }

    override fun onStop() {
        super.onStop()
        graph.setForeground(false)
    }
}

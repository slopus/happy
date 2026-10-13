package com.slopus.happy

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.slopus.happy.ui.HappyApp

class MainActivity : ComponentActivity() {
    private val graph: AppGraph get() = (application as HappyApplication).graph

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
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

    override fun onStart() {
        super.onStart()
        graph.requestSync()
    }
}

package com.slopus.happy.ui.genui

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.slopus.happy.genui.GenUi
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme

/**
 * Debug builds only: every bundled Gen UI render document (the spec's
 * compiled examples and its icons-and-colours page, under
 * `assets/genui/fixtures`) in a list; tapping one draws it with the real
 * renderer on the chat's ground. Light or dark follows the system.
 * Reached from its own launcher icon, "Gen UI fixtures". Actions and image
 * taps only show up in logcat (tag `GenUiFixtures`); nothing runs them.
 */
class GenUiFixturesActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val names = assets.list("genui/fixtures").orEmpty().filter { it.endsWith(".json") }.map { it.removeSuffix(".json") }.sorted()
        val host = GenUiHost(
            onAction = { key, action -> Log.i("GenUiFixtures", "action $key $action") },
            onView = { key, viewer -> Log.i("GenUiFixtures", "view $key ${viewer.group}[${viewer.index}]") },
            file = { file -> "file:///android_asset/genui/$file" },
        )
        setContent {
            HappyTheme {
                var open by rememberSaveable { mutableStateOf<String?>(intent.getStringExtra("genui.fixture")) }
                val name = open
                if (name == null) {
                    Screen(header = { StackHeader("Gen UI fixtures", onBack = ::finish) }) {
                        Column(Modifier.verticalScroll(rememberScrollState())) {
                            ItemGroup(footer = "Compiled render documents bundled with this debug build, drawn with the Gen UI renderer. Actions are logged, not run.") {
                                names.forEach { Item(it, onClick = { open = it }) }
                            }
                        }
                    }
                } else {
                    BackHandler { open = null }
                    val document = remember(name) {
                        GenUi.parse(runCatching { assets.open("genui/fixtures/$name.json").bufferedReader().use { it.readText() } }.getOrDefault(""))
                    }
                    Screen(header = { StackHeader(name, onBack = { open = null }) }, ground = HappyTheme.colors.surface) {
                        Box(Modifier.fillMaxSize().background(HappyTheme.colors.surface).verticalScroll(rememberScrollState())) {
                            GenUiView(document, Modifier.padding(vertical = 16.dp), host)
                        }
                    }
                }
            }
        }
    }
}

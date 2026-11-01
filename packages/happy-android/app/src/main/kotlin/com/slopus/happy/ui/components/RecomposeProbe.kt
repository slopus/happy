package com.slopus.happy.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.NonRestartableComposable
import androidx.compose.runtime.SideEffect

/**
 * Counts how often marked parts of a screen compose, for tests that pin
 * what an update recomposes (a streamed delta recomposes its row alone).
 * Off unless a test sets [counts]; then each [mark] adds one per
 * composition of the scope it sits in.
 */
object RecomposeProbe {
    @Volatile
    var counts: MutableMap<String, Int>? = null

    @Composable
    @NonRestartableComposable
    fun mark(tag: String) {
        val counts = counts ?: return
        SideEffect { counts[tag] = (counts[tag] ?: 0) + 1 }
    }
}

package com.slopus.happy.ui.components

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle

/**
 * A bar's title with a status line under it that comes and goes in place.
 * The line's room, one [statusStyle] line, is kept whether or not there is
 * a [status], so the title never moves when the connection or the work
 * changes; the line crossfades from one status to the next, at once with
 * animations off. [line] draws a status; null draws nothing.
 */
@Composable
fun <T : Any> TitleWithStatus(
    status: T?,
    statusStyle: TextStyle,
    title: @Composable () -> Unit,
    line: @Composable (T) -> Unit,
) {
    val reduceMotion = rememberReduceMotion()
    val height = with(LocalDensity.current) { statusStyle.lineHeight.toDp() }
    Column {
        title()
        Box(Modifier.height(height), contentAlignment = Alignment.CenterStart) {
            Crossfade(
                targetState = status,
                animationSpec = if (reduceMotion) snap() else tween(STATUS_FADE_MILLIS),
                label = "status",
            ) { shown ->
                if (shown != null) line(shown)
            }
        }
    }
}

private const val STATUS_FADE_MILLIS = 150

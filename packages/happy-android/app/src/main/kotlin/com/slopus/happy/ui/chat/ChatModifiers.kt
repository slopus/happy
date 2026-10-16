package com.slopus.happy.ui.chat

import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * RN's negative margins: the content is laid out [start] + [end] wider and
 * drawn [start] left and [top] up of where it sits, while taking that much
 * less room in its parent. Lets a section bleed to the edges of a padded card.
 */
fun Modifier.outset(start: Dp = 0.dp, top: Dp = 0.dp, end: Dp = 0.dp, bottom: Dp = 0.dp): Modifier = layout { measurable, constraints ->
    val s = start.roundToPx()
    val t = top.roundToPx()
    val e = end.roundToPx()
    val b = bottom.roundToPx()
    val placeable = measurable.measure(
        Constraints(
            minWidth = constraints.minWidth + s + e,
            maxWidth = if (constraints.hasBoundedWidth) constraints.maxWidth + s + e else Constraints.Infinity,
            minHeight = if (constraints.minHeight > 0) constraints.minHeight + t + b else 0,
            maxHeight = if (constraints.hasBoundedHeight) constraints.maxHeight + t + b else Constraints.Infinity,
        ),
    )
    val width = (placeable.width - s - e).coerceIn(constraints.minWidth, constraints.maxWidth)
    val height = (placeable.height - t - b).coerceIn(constraints.minHeight, constraints.maxHeight)
    layout(width, height) { placeable.place(-s, -t) }
}

/** [outset] by [all] on every side. */
fun Modifier.outset(all: Dp): Modifier = outset(all, all, all, all)

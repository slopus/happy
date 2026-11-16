package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.theme.HappyTheme
import kotlin.math.max

/**
 * Material 3's small top app bar, laid out here to the pixel: [navigationIcon]
 * 4 in from the start, [title] in title large after it (16 in at least),
 * [actions] 4 in from the end, each centred in a bar 64 tall under the
 * status bar, all in the text colour, with no ground of its own.
 *
 * Not Material's: its TopAppBar reads the title's baseline while measuring
 * (for a bottom-aligned title, never this one), and on Compose UI 1.12 that
 * read crashed showing a retained page whose title had changed while covered
 * (b/549552303, RetainedHeaderStatusTest).
 */
@Composable
fun TopBar(
    navigationIcon: @Composable () -> Unit,
    title: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val color = HappyTheme.colors.text
    val titleStyle = LocalTextStyle.current.merge(MaterialTheme.typography.titleLarge)
    Layout(
        content = {
            Box(Modifier.padding(start = TopBarSpec.edge)) {
                CompositionLocalProvider(LocalContentColor provides color, content = navigationIcon)
            }
            Box(Modifier.padding(horizontal = TopBarSpec.edge)) {
                CompositionLocalProvider(LocalContentColor provides color, LocalTextStyle provides titleStyle, content = title)
            }
            CompositionLocalProvider(LocalContentColor provides color) {
                Row(Modifier.padding(end = TopBarSpec.edge), verticalAlignment = Alignment.CenterVertically, content = actions)
            }
        },
        // Touches on the bar stop at it, as on Material's, rather than reaching what scrolls under it.
        modifier = modifier
            .semantics { isTraversalGroup = true }
            .pointerInput(Unit) {}
            .windowInsetsPadding(TopAppBarDefaults.windowInsets)
            .clipToBounds(),
    ) { (navigation, words, end), constraints ->
        val loose = constraints.copy(minWidth = 0)
        val navigationPlaceable = navigation.measure(loose)
        val endPlaceable = end.measure(loose)
        val titleWidth = if (constraints.maxWidth == Constraints.Infinity) Constraints.Infinity
            else (constraints.maxWidth - navigationPlaceable.width - endPlaceable.width).coerceAtLeast(0)
        val titlePlaceable = words.measure(loose.copy(maxWidth = titleWidth))
        val height = max(TopBarSpec.height.roundToPx(), titlePlaceable.height)
        layout(constraints.maxWidth, height) {
            navigationPlaceable.placeRelative(0, (height - navigationPlaceable.height) / 2)
            titlePlaceable.placeRelative(max(TopBarSpec.titleStart.roundToPx(), navigationPlaceable.width), (height - titlePlaceable.height) / 2)
            endPlaceable.placeRelative(constraints.maxWidth - endPlaceable.width, (height - endPlaceable.height) / 2)
        }
    }
}

private object TopBarSpec {
    val height = 64.dp
    val edge = 4.dp
    val titleStart = 16.dp - edge
}

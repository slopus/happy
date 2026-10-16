package com.slopus.happy.ui.home

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

/**
 * Swipeable with a right action: dragging left uncovers a 112 Archive
 * button (error red, white archive glyph over "Archive Session") and stops
 * there; it never overshoots. Releasing past half way leaves it open.
 */
@Composable
internal fun SwipeToArchive(
    enabled: Boolean,
    onArchive: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit,
) {
    val colors = HappyTheme.colors
    val actionWidth = with(LocalDensity.current) { FlatRowSpec.swipeAction.toPx() }
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    Box(modifier = modifier.fillMaxWidth().clipToBounds()) {
        Box(modifier = Modifier.matchParentSize(), contentAlignment = Alignment.CenterEnd) {
            Column(
                modifier = Modifier
                    .width(FlatRowSpec.swipeAction)
                    .fillMaxHeight()
                    .testTag(FlatRowTags.ARCHIVE_ACTION)
                    .background(colors.status.error)
                    .clickable(enabled = enabled) {
                        scope.launch { offset.animateTo(0f) }
                        onArchive()
                    },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Icon(Ionicon.ArchiveOutline, size = FlatRowSpec.swipeIcon, color = Color.White)
                Text(
                    text = stringResource(R.string.session_info_archive_session),
                    style = FlatRowSpec.swipeText,
                    color = Color.White,
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
        Box(
            modifier = Modifier
                .offset { IntOffset(offset.value.roundToInt(), 0) }
                .draggable(
                    enabled = enabled,
                    orientation = Orientation.Horizontal,
                    state = rememberDraggableState { delta ->
                        scope.launch { offset.snapTo((offset.value + delta).coerceIn(-actionWidth, 0f)) }
                    },
                    onDragStopped = { velocity ->
                        val open = offset.value < -actionWidth / 2 || velocity < -1000f
                        offset.animateTo(if (open) -actionWidth else 0f)
                    },
                ),
            content = content,
        )
    }
}

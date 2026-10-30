package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.slopus.happy.R
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.RemoteImage

object PictureViewerTags {
    const val VIEWER = "conversation.picture.viewer"
    const val IMAGE = "conversation.picture.viewer.image"
    const val CLOSE = "conversation.picture.viewer.close"
}

/**
 * One picture of the conversation, filling the window over black: the whole
 * picture at once, pinched to 1–5 times and dragged while it is larger than
 * the window. Pinching back to whole resets the position. Back or the close button leaves.
 */
@Composable
fun PictureViewer(bytes: ByteArray, cacheKey: String, name: String?, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        var scale by remember { mutableFloatStateOf(1f) }
        var offsetX by remember { mutableFloatStateOf(0f) }
        var offsetY by remember { mutableFloatStateOf(0f) }
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .testTag(PictureViewerTags.VIEWER),
        ) {
            RemoteImage(
                model = bytes,
                cacheKey = cacheKey,
                contentDescription = name,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .testTag(PictureViewerTags.IMAGE)
                    .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offsetX, translationY = offsetY)
                    .pointerInput(Unit) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            scale = (scale * zoom).coerceIn(1f, 5f)
                            if (scale > 1f) {
                                offsetX += pan.x
                                offsetY += pan.y
                            } else {
                                offsetX = 0f
                                offsetY = 0f
                            }
                        }
                    },
            )
            IconButton(
                onClick = onClose,
                colors = IconButtonDefaults.iconButtonColors(contentColor = Color.White),
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .windowInsetsPadding(WindowInsets.statusBars)
                    .padding(8.dp)
                    .testTag(PictureViewerTags.CLOSE),
            ) {
                Icon(MaterialSymbols.Close, stringResource(R.string.conversation_picture_close))
            }
        }
    }
}

/** The picture a row asked to show full screen, if any. */
@Composable
internal fun rememberPictureViewer(): PictureViewerState = remember { PictureViewerState() }

class PictureViewerState {
    internal var showing by mutableStateOf<Triple<ByteArray, String, String?>?>(null)

    fun show(bytes: ByteArray, cacheKey: String, name: String?) {
        showing = Triple(bytes, cacheKey, name)
    }

    fun close() {
        showing = null
    }
}

/** Draws the picture the conversation asked to show, over everything. */
@Composable
internal fun PictureViewerHost(state: PictureViewerState) {
    val showing = state.showing ?: return
    PictureViewer(showing.first, showing.second, showing.third, state::close)
}

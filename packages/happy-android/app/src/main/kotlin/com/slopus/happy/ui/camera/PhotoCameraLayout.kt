package com.slopus.happy.ui.camera

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.rememberImageLoader
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import com.slopus.happy.ui.theme.happyTextStyle
import kotlin.math.roundToInt

internal enum class PhotoProblem { Permission, NoCamera, Unavailable, InUse, CaptureFailed }

/** A rectangular layer clip whose offset also limits hit testing to the visible live tile. */
private class PreviewClip(private val rect: Rect) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline = Outline.Rectangle(rect)
}

/**
 * One measured preview at its full size, transformed and clipped into the two-cell tile.
 * iOS CameraScreenLayout: 4:3 photo, 96 shutter target, 68 ring/3 stroke/60 disc,
 * tablet controls in a 120 trailing column; review has a 96 bar and text 16 in.
 * Android's standard 64 Header replaces iOS's 44 camera bar (AGENTS rule5).
 * [preview] stays at the same composition location across opening and closing.
 */
@Composable
internal fun PhotoCameraLayout(
    full: Boolean,
    motion: PhotoMotion,
    tile: () -> Rect?,
    ready: Boolean,
    busy: Boolean,
    problem: PhotoProblem?,
    review: AttachmentPreview?,
    firstFrame: () -> Float,
    blink: () -> Float,
    onOpen: () -> Unit,
    onBack: () -> Unit,
    onTake: () -> Unit,
    onRetake: () -> Unit,
    onUse: () -> Unit,
    onSettings: () -> Unit,
    onRetry: () -> Unit,
    preview: @Composable () -> Unit,
    tileClip: () -> Rect? = tile,
) {
    val density = LocalDensity.current
    val tablet = LocalWindowLayout.current.isTablet
    val top = WindowInsets.statusBars.getTop(density) + with(density) { 64.dp.toPx() }
    val bottom = WindowInsets.navigationBars.getBottom(density).toFloat()
    val viewfinder = stringResource(R.string.camera_viewfinder)
    HappyTheme(preference = ThemePreference.Dark) {
        BoxWithConstraints(Modifier.fillMaxSize().graphicsLayer { alpha = motion.fade.value }) {
            val size = Size(constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat())
            val frames = PhotoFrames.of(size, top, bottom, tablet, density.density)
            fun slide(): Float = if (motion.morphs) 0f else size.height * (1 - motion.progress.value)
            fun transform(): PreviewTransform {
                val origin = tile()
                return if (motion.morphs && origin != null) previewTransform(frames.preview, origin, motion.progress.value).let {
                    it.copy(clip = androidx.compose.ui.geometry.lerp(tileClip() ?: origin, frames.preview, motion.progress.value))
                }
                else PreviewTransform(1f, Offset(0f, slide()), frames.preview.translate(Offset(0f, slide())))
            }

            if (full) {
                Box(Modifier.fillMaxSize().drawBehind { drawRect(Color.Black, alpha = motion.progress.value.coerceIn(0f, 1f)) }.clickable(onClick = {}).clearAndSetSemantics {})
            }
            if (review == null && (full || tile() != null)) {
                Box(
                    Modifier.fillMaxSize()
                        .graphicsLayer { clip = true; shape = PreviewClip(transform().clip) }
                        // The embedded viewfinder is above the sheet. Its clipped parent forwards a
                        // tap to the tile's same action; accessibility stays on the gallery's tile.
                        .then(if (!full) Modifier.pointerInput(onOpen) { detectTapGestures { onOpen() } }.clearAndSetSemantics {}
                            else Modifier.semantics { contentDescription = viewfinder }),
                ) {
                    Box(
                        Modifier.frame(frames.preview, density)
                            .graphicsLayer {
                                val at = transform()
                                scaleX = at.scale; scaleY = at.scale
                                translationX = at.shift.x; translationY = at.shift.y
                                alpha = firstFrame()
                            }
                            .testTag(PhotoTags.PREVIEW),
                    ) {
                        preview()
                        Box(Modifier.fillMaxSize().drawBehind { drawRect(Color.Black, alpha = blink().coerceIn(0f, 1f)) })
                    }
                }
                if (!full) {
                    Icon(
                        MaterialSymbols.PhotoCamera, null, tint = Color.White,
                        modifier = Modifier.size(30.dp).graphicsLayer {
                            val at = tile()
                            alpha = if (at == null) 0f else 1f
                            translationX = (at?.right ?: 0f) - 33.dp.toPx()
                            translationY = (at?.top ?: 0f) + 3.dp.toPx() - 1f
                        }.clearAndSetSemantics {},
                    )
                }
            }
            if (full) {
                if (review != null) {
                    val area = Rect(0f, top, size.width, frames.review.top.coerceAtLeast(top))
                    val photo = fitPhoto(Size(review.width.toFloat(), review.height.toFloat()), area)
                    AsyncImage(
                        review.uri, stringResource(R.string.attach_photo_label), imageLoader = rememberImageLoader(), contentScale = ContentScale.Fit,
                        modifier = Modifier.frame(photo, density).graphicsLayer { translationY = slide() }.testTag(PhotoTags.REVIEW),
                    )
                    Box(Modifier.frame(frames.review, density).graphicsLayer { translationY = slide() }.testTag(PhotoTags.REVIEW_BAR)) {
                        Row(Modifier.fillMaxWidth().height(96.dp), verticalAlignment = Alignment.CenterVertically) {
                            ReviewButton(stringResource(R.string.camera_retake), !motion.closing, onRetake, Modifier.testTag(PhotoTags.RETAKE))
                            Spacer(Modifier.weight(1f))
                            ReviewButton(stringResource(R.string.camera_use_photo), !motion.closing, onUse, Modifier.testTag(PhotoTags.USE))
                        }
                    }
                } else {
                    Shutter(
                        enabled = ready && !busy && !motion.closing,
                        onTake = onTake,
                        modifier = Modifier.frame(frames.shutter, density).graphicsLayer { alpha = motion.controls.value; translationY = slide() },
                    )
                    if (problem != null) {
                        Box(Modifier.frame(frames.preview, density).graphicsLayer { translationY = slide() }, contentAlignment = Alignment.Center) {
                            CameraMessage(problem, onSettings, onRetry)
                        }
                    }
                }
                Header(
                    title = stringResource(R.string.attach_photo_label),
                    background = Color.Black,
                    left = { IconButton(onClick = onBack) { Icon(MaterialSymbols.ArrowBack, stringResource(R.string.common_back), tint = Color.White) } },
                    modifier = Modifier.align(Alignment.TopCenter).graphicsLayer { alpha = motion.controls.value; translationY = slide() },
                )
            }
        }
    }
}

private fun Modifier.frame(rect: Rect, density: Density): Modifier =
    offset { IntOffset(rect.left.roundToInt(), rect.top.roundToInt()) }.size(with(density) { rect.width.toDp() }, with(density) { rect.height.toDp() })

@Composable
private fun Shutter(enabled: Boolean, onTake: () -> Unit, modifier: Modifier) {
    val presses = remember { MutableInteractionSource() }
    val pressed by presses.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.8f else 1f, tween(300), label = "shutter press")
    val label = stringResource(R.string.camera_take_photo)
    Box(
        modifier.testTag(PhotoTags.SHUTTER)
            .semantics { contentDescription = label }
            .clickable(enabled = enabled, role = Role.Button, interactionSource = presses, indication = null, onClickLabel = label, onClick = onTake),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(68.dp).graphicsLayer { alpha = if (enabled) 1f else 0.45f }.drawBehind {
            val stroke = 3.dp.toPx()
            drawCircle(Color.White, (size.minDimension - stroke) / 2, style = Stroke(stroke))
        }.testTag(PhotoTags.RING))
        Box(Modifier.size(60.dp).graphicsLayer { scaleX = scale; scaleY = scale; alpha = if (enabled) 1f else 0.45f }.background(Color.White, CircleShape).testTag(PhotoTags.DISC))
    }
}

@Composable
private fun ReviewButton(text: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier) {
    Box(modifier.heightIn(min = 48.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
        Text(text, color = Color.White, style = happyTextStyle(17))
    }
}

@Composable
private fun CameraMessage(problem: PhotoProblem, settings: () -> Unit, retry: () -> Unit) {
    val words = when (problem) {
        PhotoProblem.Permission -> R.string.camera_permission
        PhotoProblem.NoCamera -> R.string.camera_no_camera
        PhotoProblem.Unavailable -> R.string.camera_unavailable
        PhotoProblem.InUse -> R.string.camera_in_use
        PhotoProblem.CaptureFailed -> R.string.camera_capture_failed
    }
    Column(Modifier.padding(32.dp).widthIn(max = 320.dp).testTag(PhotoTags.MESSAGE), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(stringResource(words), style = happyTextStyle(17), color = Color.White, textAlign = TextAlign.Center)
        if (problem == PhotoProblem.Permission || problem == PhotoProblem.Unavailable || problem == PhotoProblem.CaptureFailed) {
            Spacer(Modifier.height(20.dp))
            TextButton(onClick = if (problem == PhotoProblem.Permission) settings else retry, contentPadding = PaddingValues(12.dp)) {
                Text(stringResource(if (problem == PhotoProblem.Permission) R.string.scan_open_settings else R.string.common_retry), color = Color.White, style = happyTextStyle(17))
            }
        }
    }
}

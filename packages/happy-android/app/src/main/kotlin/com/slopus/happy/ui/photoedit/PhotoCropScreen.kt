package com.slopus.happy.ui.photoedit

import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.Path
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.lerp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalView
import androidx.core.view.ViewCompat
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Telegram's crop (`PhotoCropView`: `CropView`, `CropAreaView`,
 * `CropRotationWheel`): the photo under a frame that its corners and sides
 * resize, dimmed round it, the thirds drawn while a finger is down. One
 * finger on the photo moves it under the frame, two pinch it to ten times;
 * the frame never leaves the photo. Let go, a resized frame grows back to
 * fill the area in 0.3 s after 0.8 s. Under it the wheel straightens ±45°
 * between mirror and the aspect list on the left and a quarter turn on the
 * right; under that ✕, Reset once anything has changed, and ✓.
 */
@Composable
internal fun PhotoCropScreen(
    photo: Bitmap,
    layer: Bitmap?,
    initial: PhotoCrop,
    onCancel: () -> Unit,
    onDone: (PhotoCrop) -> Unit,
) {
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val w = photo.width
    val h = photo.height
    var crop by remember { mutableStateOf(initial) }
    var scale by remember { mutableFloatStateOf(0f) }
    var center by remember { mutableStateOf(Offset.Zero) }
    var area by remember { mutableStateOf(Rect.Zero) }
    var touching by remember { mutableStateOf(false) }
    var choosing by remember { mutableStateOf(false) }
    val spin = remember { Animatable(0f) }
    var settling by remember { mutableStateOf<Job?>(null) }
    val paint = remember { Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG) }
    val dim = remember { Paint().apply { color = PhotoEditSpec.CROP_DIM } }

    fun fitScale(of: PhotoCrop) = PhotoPainting.fit(of.width, of.height, area.width, area.height)
    fun frame() = Rect(center - Offset(crop.width * scale / 2, crop.height * scale / 2), Size(crop.width * scale, crop.height * scale))

    /** Back to filling the area, the frame's middle on its middle. */
    fun settle(after: Long, turning: Boolean = false) {
        settling?.cancel()
        settling = scope.launch {
            delay(after)
            val fromScale = scale
            val fromCenter = center
            val toScale = fitScale(crop)
            if (turning) launch { spin.animateTo(0f, tween(PhotoEditSpec.SETTLE_MS, easing = PhotoEditSpec.easing)) }
            animate(0f, 1f, animationSpec = tween(PhotoEditSpec.SETTLE_MS, easing = PhotoEditSpec.easing)) { t, _ ->
                scale = fromScale + (toScale - fromScale) * t
                center = lerp(fromCenter, area.center, t)
            }
        }
    }

    // The frame's sides come within the system's back swipe of the screen's edges: its handles there are the crop's.
    val view = LocalView.current
    var areaAt by remember { mutableStateOf(Offset.Zero) }
    DisposableEffect(view) { onDispose { ViewCompat.setSystemGestureExclusionRects(view, emptyList()) } }
    LaunchedEffect(view) {
        val reach = with(density) { PhotoEditSpec.handleReach.toPx() }
        snapshotFlow { if (scale == 0f) null else frame().translate(areaAt) }.collect { at ->
            val rects = if (at == null) emptyList() else listOf(at.left, at.right).flatMap { x ->
                listOf(at.top, at.center.y, at.bottom).map { y -> android.graphics.Rect((x - reach).roundToInt(), (y - reach).roundToInt(), (x + reach).roundToInt(), (y + reach).roundToInt()) }
            }
            ViewCompat.setSystemGestureExclusionRects(view, rects)
        }
    }

    Column(Modifier.fillMaxSize().background(Color.Black).testTag(PhotoEditTags.CROP)) {
        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .onGloballyPositioned { areaAt = it.positionInWindow() }
                .onSizeChanged {
                    val inset = with(density) { PhotoEditSpec.cropInset.toPx() }
                    area = Rect(inset, inset, it.width - inset, it.height - inset)
                    if (scale == 0f) {
                        scale = fitScale(crop)
                        center = area.center
                    }
                }
                .pointerInput(Unit) {
                    val reach = PhotoEditSpec.handleReach.toPx()
                    val least = PhotoEditSpec.minFrame.toPx()
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        settling?.cancel()
                        val handle = PhotoCropping.handle(frame(), down.position, reach)
                        touching = true
                        var resized = false
                        while (true) {
                            val event = awaitPointerEvent()
                            val fingers = event.changes.count { it.pressed }
                            if (fingers == 0) break
                            if (handle != null && fingers == 1) {
                                val delta = event.changes.first { it.pressed }.positionChange()
                                if (delta != Offset.Zero) {
                                    val from = frame()
                                    val wanted = PhotoCropping.resize(from, handle, delta, crop.ratio, least, area)
                                    val to = PhotoCropping.furthest(crop, from, wanted, scale, w, h)
                                    crop = PhotoCropping.reframed(crop, from, to, scale)
                                    center = to.center
                                    resized = true
                                }
                            } else {
                                val zoom = event.calculateZoom()
                                if (zoom != 1f) {
                                    val next = PhotoCropping.zoomed(crop, zoom, w, h)
                                    scale *= crop.width / next.width
                                    crop = next
                                }
                                val pan = event.calculatePan()
                                if (pan != Offset.Zero) crop = PhotoCropping.panned(crop, pan, scale, w, h)
                            }
                            event.changes.forEach { if (it.positionChange() != Offset.Zero) it.consume() }
                        }
                        touching = false
                        settle(if (resized) PhotoEditSpec.SETTLE_DELAY_MS else 0)
                    }
                }
                .testTag(PhotoEditTags.CROP_AREA),
        ) {
            Canvas(Modifier.fillMaxSize()) {
                if (scale == 0f) return@Canvas
                val frame = frame()
                drawIntoCanvas { canvas ->
                    val native = canvas.nativeCanvas
                    native.save()
                    native.rotate(spin.value, center.x, center.y)
                    val matrix = crop.matrix().apply {
                        postScale(scale, scale)
                        postTranslate(frame.left, frame.top)
                    }
                    native.drawBitmap(photo, matrix, paint)
                    layer?.let { native.drawBitmap(it, matrix, paint) }
                    // Dim round the frame, out past the screen while it turns.
                    val reach = size.maxDimension * 2
                    val around = Path().apply {
                        fillType = Path.FillType.EVEN_ODD
                        addRect(-reach, -reach, size.width + reach, size.height + reach, Path.Direction.CW)
                        addRect(frame.left, frame.top, frame.right, frame.bottom, Path.Direction.CW)
                    }
                    native.drawPath(around, dim)
                    native.restore()
                }
                rotateFrame(spin.value, center) {
                    val line = 1.dp.toPx()
                    drawRect(Color(PhotoEditSpec.CROP_LINE), frame.topLeft, frame.size, style = Stroke(line))
                    if (touching) for (i in 1..2) {
                        val x = frame.left + frame.width * i / 3
                        val y = frame.top + frame.height * i / 3
                        drawLine(Color(PhotoEditSpec.CROP_GRID), Offset(x, frame.top), Offset(x, frame.bottom), line)
                        drawLine(Color(PhotoEditSpec.CROP_GRID), Offset(frame.left, y), Offset(frame.right, y), line)
                    }
                    val long = PhotoEditSpec.handleLength.toPx()
                    val thick = PhotoEditSpec.handleThickness.toPx()
                    val handles = Color.White
                    // The corners' Ls, just outside the frame's line.
                    for ((x, y, dx, dy) in listOf(
                        Corner(frame.left, frame.top, 1f, 1f), Corner(frame.right, frame.bottom, -1f, -1f),
                        Corner(frame.right, frame.top, -1f, 1f), Corner(frame.left, frame.bottom, 1f, -1f),
                    )) {
                        val ox = x - dx * thick / 2
                        val oy = y - dy * thick / 2
                        drawLine(handles, Offset(ox - dx * thick / 2, oy), Offset(ox + dx * long, oy), thick)
                        drawLine(handles, Offset(ox, oy - dy * thick / 2), Offset(ox, oy + dy * long), thick)
                    }
                    // The sides' middles.
                    val cx = frame.center.x
                    val cy = frame.center.y
                    drawLine(handles, Offset(cx - long / 2, frame.top - thick / 2), Offset(cx + long / 2, frame.top - thick / 2), thick)
                    drawLine(handles, Offset(cx - long / 2, frame.bottom + thick / 2), Offset(cx + long / 2, frame.bottom + thick / 2), thick)
                    drawLine(handles, Offset(frame.left - thick / 2, cy - long / 2), Offset(frame.left - thick / 2, cy + long / 2), thick)
                    drawLine(handles, Offset(frame.right + thick / 2, cy - long / 2), Offset(frame.right + thick / 2, cy + long / 2), thick)
                }
            }
        }
        var base by remember { mutableStateOf(crop) }
        var baseScale by remember { mutableFloatStateOf(1f) }
        Row(Modifier.fillMaxWidth().height(PhotoEditSpec.wheelHeight), verticalAlignment = Alignment.CenterVertically) {
            WheelButton(PhotoEditIcons.Mirror, stringResource(R.string.photo_edit_mirror), crop.mirrored, PhotoEditTags.CROP_MIRROR) {
                crop = crop.copy(mirrored = !crop.mirrored)
            }
            WheelButton(PhotoEditIcons.Aspect, stringResource(R.string.photo_edit_aspect), crop.ratio > 0f, PhotoEditTags.CROP_ASPECT) {
                // Locked, the button unlocks, as Telegram's does.
                if (crop.ratio > 0f) crop = crop.copy(ratio = 0f) else choosing = true
            }
            RotationWheel(
                angle = crop.straighten,
                onStart = {
                    settling?.cancel()
                    touching = true
                    base = crop
                    baseScale = scale
                },
                // Straightened, the photo grows under the frame until it covers it; back straight, it is as it was.
                onChange = { angle ->
                    val next = base.copy(straighten = angle).inside(w, h)
                    scale = baseScale * base.width / next.width
                    crop = next
                },
                onEnd = { touching = false; settle(0) },
                modifier = Modifier.weight(1f),
            )
            WheelButton(PhotoEditIcons.RotateLeft, stringResource(R.string.photo_edit_rotate), false, PhotoEditTags.CROP_ROTATE) {
                settling?.cancel()
                scope.launch { spin.snapTo(spin.value + 90f) }
                crop = crop.turned()
                settle(0, turning = true)
            }
        }
        EditorBar(
            onCancel = onCancel,
            onDone = { onDone(crop) },
            middle = if (!crop.isIdentity(w, h)) ({
                Text(
                    stringResource(R.string.photo_edit_reset).uppercase(Locale.getDefault()),
                    color = Color.White,
                    style = happyTextStyle(14, weight = FontWeight.SemiBold),
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(role = Role.Button) {
                            crop = PhotoCrop.whole(w, h)
                            settle(0)
                        }
                        .padding(horizontal = 12.dp, vertical = 10.dp)
                        .testTag(PhotoEditTags.CROP_RESET),
                )
            }) else null,
        )
    }
    if (choosing) {
        AspectList(
            photoRatio = if (crop.turns % 2 == 0) w / h.toFloat() else h / w.toFloat(),
            portrait = crop.height > crop.width,
            onPick = { ratio ->
                choosing = false
                crop = crop.locked(ratio)
                settle(0)
            },
            onDismiss = { choosing = false },
        )
    }
}

private data class Corner(val x: Float, val y: Float, val dx: Float, val dy: Float)

private inline fun DrawScope.rotateFrame(degrees: Float, pivot: Offset, block: DrawScope.() -> Unit) = rotate(degrees, pivot) { block() }

/** Mirror, aspect and the quarter turn by the wheel: 70 × 64, white, or the edited yellow while on. */
@Composable
private fun WheelButton(icon: ImageVector, label: String, on: Boolean, tag: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(PhotoEditSpec.wheelButtonWidth, PhotoEditSpec.wheelHeight)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics {
                contentDescription = label
                selected = on
            }
            .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = if (on) PhotoEditSpec.edited else Color.White, modifier = Modifier.size(24.dp))
    }
}

/**
 * `CropRotationWheel`: ticks a degree apart, every fifth longer, sliding
 * under a fixed middle line in the edited yellow, the angle above it. A
 * drag turns 1 / (1.65π) degree a dp, to ±45, and snaps to 0 within 0.05.
 */
@Composable
private fun RotationWheel(angle: Float, onStart: () -> Unit, onChange: (Float) -> Unit, onEnd: () -> Unit, modifier: Modifier) {
    val label = stringResource(R.string.photo_edit_straighten)
    Box(
        modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown()
                    onStart()
                    var at = angle
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.pressed } ?: break
                        val dx = change.positionChange().x
                        if (dx != 0f) {
                            at = (at - dx / density / PI.toFloat() / 1.65f).coerceIn(-PhotoCrop.MAX_STRAIGHTEN, PhotoCrop.MAX_STRAIGHTEN)
                            onChange(if (abs(at) < 0.05f) 0f else at)
                            change.consume()
                        }
                    }
                    onEnd()
                }
            }
            .semantics { contentDescription = label }
            .testTag(PhotoEditTags.CROP_WHEEL),
        contentAlignment = Alignment.TopCenter,
    ) {
        Text(
            String.format(Locale.getDefault(), "%.1f°", angle),
            color = Color.White,
            style = happyTextStyle(12, weight = FontWeight.SemiBold),
            modifier = Modifier.padding(top = 6.dp),
        )
        Canvas(Modifier.fillMaxSize()) {
            val step = 1.65f * PI.toFloat() * density
            val middle = size.width / 2
            val bottom = size.height - 12.dp.toPx()
            for (degree in -45..45) {
                val x = middle + (degree - angle) * step
                if (x < 0 || x > size.width) continue
                val fade = 1f - abs(x - middle) / middle
                val long = degree % 5 == 0
                val height = (if (long) 14 else 8).dp.toPx()
                drawLine(Color.White.copy(alpha = (if (long) 0.9f else 0.5f) * fade), Offset(x, bottom - height), Offset(x, bottom), 1.5.dp.toPx())
            }
            drawLine(PhotoEditSpec.edited, Offset(middle, bottom - 20.dp.toPx()), Offset(middle, bottom + 2.dp.toPx()), 2.dp.toPx())
        }
    }
}

/**
 * Telegram's aspect list (`CropView.showAspectRatioDialog`): Original,
 * Square, then 3:2 … 16:9, turned to the frame's way.
 */
@Composable
private fun AspectList(photoRatio: Float, portrait: Boolean, onPick: (Float) -> Unit, onDismiss: () -> Unit) {
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.4f))
            .clickable(interactionSource = null, indication = null, onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier
                .widthIn(min = 220.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(Color(PhotoEditSpec.SHEET))
                .padding(vertical = 8.dp)
                .testTag(PhotoEditTags.CROP_ASPECTS),
        ) {
            @Composable
            fun item(text: String, ratio: Float) {
                Text(
                    text,
                    color = Color.White,
                    style = happyTextStyle(16),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(role = Role.Button) { onPick(ratio) }
                        .padding(horizontal = 24.dp, vertical = 13.dp),
                )
            }
            item(stringResource(R.string.photo_edit_original), photoRatio)
            item(stringResource(R.string.photo_edit_square), 1f)
            for ((a, b) in PhotoCrop.RATIOS) {
                val (x, y) = if (portrait) b to a else a to b
                item("$x:$y", x / y.toFloat())
            }
        }
    }
}

/**
 * The editor's foot (`PhotoViewer`'s editing bar): ✕ on the left, ✓ on the
 * right in the composer send button's colours (white, a black check, on the
 * black), and [middle] between, above the navigation bar.
 */
@Composable
internal fun EditorBar(onCancel: () -> Unit, onDone: () -> Unit, middle: (@Composable () -> Unit)? = null) {
    Box(
        Modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.navigationBars)
            .height(PhotoEditSpec.barHeight)
            .padding(horizontal = 8.dp),
    ) {
        val cancel = stringResource(R.string.photo_edit_cancel)
        val done = stringResource(R.string.photo_edit_done)
        Box(
            Modifier
                .align(Alignment.CenterStart)
                .size(48.dp)
                .clip(RoundedCornerShape(24.dp))
                .clickable(role = Role.Button, onClick = onCancel)
                .semantics { contentDescription = cancel }
                .testTag(PhotoEditTags.CANCEL),
            contentAlignment = Alignment.Center,
        ) {
            Icon(com.slopus.happy.ui.components.MaterialSymbols.Close, null, tint = Color.White)
        }
        Box(Modifier.align(Alignment.Center)) { middle?.invoke() }
        Box(
            Modifier
                .align(Alignment.CenterEnd)
                .size(48.dp)
                .clickable(interactionSource = null, indication = null, role = Role.Button, onClick = onDone)
                .semantics { contentDescription = done }
                .testTag(PhotoEditTags.DONE),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(36.dp).clip(RoundedCornerShape(18.dp)).background(Color.White), contentAlignment = Alignment.Center) {
                Icon(com.slopus.happy.ui.components.MaterialSymbols.Check, null, tint = Color.Black, modifier = Modifier.size(22.dp))
            }
        }
    }
}

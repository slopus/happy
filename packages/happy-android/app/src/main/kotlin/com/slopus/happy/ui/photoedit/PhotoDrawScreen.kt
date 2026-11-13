package com.slopus.happy.ui.photoedit

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.produceState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.theme.happyTextStyle
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

/**
 * Telegram-Android's drawing (`LPhotoPaintView`), its brushes without the
 * shapes, stickers and text: the photo as cut, drawn on with one finger.
 * Undo top left (faded with nothing to undo), Clear All top right (asked
 * first); the size wedge on the left (`PaintWeightChooserView`), the
 * stroke's width shown in the middle while it moves; under the photo the
 * colours, then the colour button (the whole palette, [PhotoColorSheet])
 * and the six white brush outlines with a circular selector. Each brush keeps its own
 * colour and size, from Telegram's defaults; Arrow is the one it opens on.
 */
@Composable
internal fun PhotoDrawScreen(
    photo: Bitmap,
    edit: PhotoEdit,
    onCancel: () -> Unit,
    onDone: (List<PaintStroke>) -> Unit,
) {
    val crop = edit.crop
    val strokes = remember { mutableStateListOf<PaintStroke>().apply { addAll(edit.strokes) } }
    var drawn by remember { mutableIntStateOf(0) }
    var tool by remember { mutableStateOf(PaintTool.Arrow) }
    val colors = remember { mutableStateMapOf<PaintTool, Int>() }
    val sizes = remember { mutableStateMapOf<PaintTool, Float>() }
    val color = colors[tool] ?: tool.defaultColor
    val sizing = sizes[tool] ?: tool.defaultSize
    var live by remember { mutableStateOf<LivePaintStroke?>(null) }
    var area by remember { mutableStateOf(Size.Zero) }
    var resizing by remember { mutableStateOf(false) }
    var palette by remember { mutableStateOf(false) }
    var pipette by remember { mutableStateOf<Bitmap?>(null) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    val paint = remember { Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG) }
    val clearTitle = stringResource(R.string.photo_edit_clear_title)
    val clearConfirm = stringResource(R.string.photo_edit_clear_confirm)
    val cancelText = stringResource(R.string.photo_edit_cancel)

    // The photo as cut, fitted in the area: one matrix from its pixels to the screen's.
    val scale = if (area == Size.Zero) 0f else PhotoPainting.fit(crop.width, crop.height, area.width, area.height)
    val frame = Rect(Offset((area.width - crop.width * scale) / 2, (area.height - crop.height * scale) / 2), Size(crop.width * scale, crop.height * scale))
    val toScreen = remember(crop, scale, frame) { crop.matrix().apply { postScale(scale, scale); postTranslate(frame.left, frame.top) } }
    val toPhoto = remember(toScreen) { Matrix().also { toScreen.invert(it) } }
    val preview by produceState<PhotoDrawPreview?>(null, photo, toScreen, area) {
        value = if (area == Size.Zero) null else withContext(Dispatchers.Default) {
            PhotoDrawPreview(photo, area.width.roundToInt(), area.height.roundToInt(), frame, toScreen, edit.strokes)
        }
    }

    fun weight(): Float = PhotoPainting.weight(sizing, crop.width)
    // The finger's handler outlives a composition: it reads the brush as it is when the finger lands.
    val brush by rememberUpdatedState(Triple(tool, color, weight()))
    fun redraw() {
        preview?.redraw(strokes)
        drawn++
    }
    fun photoPoint(at: Offset): Offset {
        val values = floatArrayOf(at.x, at.y)
        toPhoto.mapPoints(values)
        return Offset(values[0], values[1])
    }
    /** What the area shows, for the eyedropper to read. */
    fun snapshot(): Bitmap = Bitmap.createBitmap(area.width.roundToInt().coerceAtLeast(1), area.height.roundToInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888).also {
        val canvas = Canvas(it)
        canvas.drawColor(android.graphics.Color.BLACK)
        preview?.let { cache ->
            canvas.drawBitmap(cache.background, 0f, 0f, paint)
            canvas.drawBitmap(cache.ink, 0f, 0f, paint)
        }
    }

    Column(Modifier.fillMaxSize().background(Color.Black).testTag(PhotoEditTags.DRAW)) {
        Row(
            Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .height(PhotoEditSpec.barHeight)
                .padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val undo = stringResource(R.string.photo_edit_undo)
            Box(
                Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .clickable(enabled = strokes.isNotEmpty(), role = Role.Button) {
                        strokes.removeAt(strokes.lastIndex)
                        redraw()
                    }
                    .semantics { contentDescription = undo }
                    .testTag(PhotoEditTags.UNDO),
                contentAlignment = Alignment.Center,
            ) {
                Icon(PhotoEditIcons.Undo, null, tint = Color.White.copy(alpha = if (strokes.isEmpty()) 0.4f else 1f))
            }
            Box(Modifier.weight(1f))
            Text(
                stringResource(R.string.photo_edit_clear).uppercase(Locale.getDefault()),
                color = Color.White.copy(alpha = if (strokes.isEmpty()) 0.4f else 1f),
                style = happyTextStyle(14, weight = FontWeight.SemiBold),
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(enabled = strokes.isNotEmpty(), role = Role.Button) {
                        alert = Alert(
                            clearTitle, null,
                            listOf(
                                AlertButton(cancelText),
                                AlertButton(clearConfirm, destructive = true) {
                                    strokes.clear()
                                    redraw()
                                },
                            ),
                        )
                    }
                    .padding(horizontal = 12.dp, vertical = 10.dp)
                    .testTag(PhotoEditTags.CLEAR),
            )
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            Canvas(
                Modifier
                    .fillMaxSize()
                    .onSizeChanged { area = Size(it.width.toFloat(), it.height.toFloat()) }
                    .pointerInput(toPhoto, preview) {
                        val cache = preview ?: return@pointerInput
                        awaitEachGesture {
                            val down = awaitFirstDown()
                            val (drawTool, drawColor, drawWeight) = brush.let { (each, tint, width) -> Triple(each, if (each.coloured) tint else 0, width) }
                            val current = LivePaintStroke(drawTool, drawColor, drawWeight, photoPoint(down.position))
                            live = current
                            down.consume()
                            while (true) {
                                val event = awaitPointerEvent()
                                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                if (!change.pressed) break
                                if (change.positionChange() != Offset.Zero) {
                                    if (current.append(photoPoint(change.position))) drawn++
                                    change.consume()
                                }
                            }
                            val stroke = current.finish()
                            live = null
                            strokes += stroke
                            cache.commit(stroke)
                            drawn++
                        }
                    }
                    .then(if (preview != null) Modifier.testTag(PhotoEditTags.DRAW_AREA) else Modifier),
            ) {
                // Read for the layer's changes, which aren't state of their own.
                if (scale == 0f || drawn < 0) return@Canvas
                val cache = preview ?: return@Canvas
                val stroke = live
                drawIntoCanvas { canvas ->
                    val native = canvas.nativeCanvas
                    native.save()
                    native.clipRect(frame.left, frame.top, frame.right, frame.bottom)
                    native.drawBitmap(cache.background, 0f, 0f, paint)
                    if (stroke?.stroke?.tool == PaintTool.Eraser) {
                        // The eraser takes from the drawing alone, not the photo under it.
                        val saved = native.saveLayer(frame.left, frame.top, frame.right, frame.bottom, null)
                        native.drawBitmap(cache.ink, 0f, 0f, paint)
                        native.concat(toScreen)
                        cache.draw(native, stroke.stroke, stroke.path())
                        native.restoreToCount(saved)
                    } else {
                        native.drawBitmap(cache.ink, 0f, 0f, paint)
                        if (stroke != null) {
                            native.concat(toScreen)
                            cache.draw(native, stroke.stroke, stroke.path())
                        }
                    }
                    native.restore()
                }
                if (resizing) {
                    val radius = weight() * tool.scale * scale / 2
                    drawCircle(if (tool.coloured) Color(color) else Color.White.copy(alpha = 0.3f), radius, center)
                    drawCircle(Color.White, radius, center, style = Stroke(1.5.dp.toPx()))
                }
            }
            SizeWedge(
                size = sizing,
                onChange = { sizes[tool] = it },
                onResizing = { resizing = it },
                modifier = Modifier.align(Alignment.CenterStart),
            )
            pipette?.let { snapshot ->
                PhotoPipette(
                    snapshot,
                    onPick = { picked ->
                        if (tool.coloured) colors[tool] = picked
                        pipette = null
                        snapshot.recycle()
                    },
                )
            }
        }
        Swatches(
            current = color,
            enabled = tool.coloured,
            onPick = { colors[tool] = PhotoColors.withAlpha(it, (color ushr 24) / 255f) },
        )
        Tools(
            tool = tool,
            color = color,
            onTool = { tool = it },
            onPalette = { palette = true },
        )
        EditorBar(onCancel = onCancel, onDone = { onDone(strokes.toList()) })
    }
    if (palette) {
        PhotoColorSheet(
            color = color,
            onColor = { if (tool.coloured) colors[tool] = it },
            onPipette = {
                palette = false
                pipette = snapshot()
            },
            onDismiss = { palette = false },
        )
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

/**
 * The size wedge: narrow at the foot, wide at the head, the knob where the
 * size is; dragged up and down from 0 to 1, the stroke shown meanwhile.
 */
@Composable
private fun SizeWedge(size: Float, onChange: (Float) -> Unit, onResizing: (Boolean) -> Unit, modifier: Modifier) {
    val label = stringResource(R.string.photo_edit_size)
    val change by rememberUpdatedState(onChange)
    var touching by remember { mutableStateOf(false) }
    val shown by animateFloatAsState(if (touching) 1f else 0f, tween(200), label = "brush width")
    Canvas(
        modifier
            .size(PhotoEditSpec.wedgeWidth, PhotoEditSpec.wedgeHeight)
            // By the screen's edge: the system's back swipe would take it.
            .systemGestureExclusion()
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    touching = true
                    onResizing(true)
                    change((1f - down.position.y / this.size.height).coerceIn(0f, 1f))
                    down.consume()
                    while (true) {
                        val event = awaitPointerEvent()
                        val moved = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!moved.pressed) break
                        change((1f - moved.position.y / this.size.height).coerceIn(0f, 1f))
                        moved.consume()
                    }
                    onResizing(false)
                    touching = false
                }
            }
            .semantics {
                contentDescription = label
                progressBarRangeInfo = ProgressBarRangeInfo(size, 0f..1f)
            }
            .testTag(PhotoEditTags.SIZE),
    ) {
        val wide = (6 + 26 * shown).dp.toPx()
        val narrow = 6.dp.toPx()
        val middle = 32.dp.toPx() * shown
        val top = wide / 2
        val bottom = this.size.height - narrow / 2
        val wedge = Path().apply {
            moveTo(middle - wide / 2, top)
            lineTo(middle + wide / 2, top)
            lineTo(middle + narrow / 2, bottom)
            lineTo(middle - narrow / 2, bottom)
            close()
        }
        drawPath(wedge, Color.White.copy(alpha = 0.3f))
        drawCircle(Color.White.copy(alpha = 0.3f), wide / 2, Offset(middle, top))
        drawCircle(Color.White.copy(alpha = 0.3f), narrow / 2, Offset(middle, bottom))
        val y = top + (bottom - top) * (1f - size)
        drawCircle(Color.White, (12 * (1 - shown) + (4.5f + 11.5f * size) * shown).dp.toPx(), Offset(middle, y))
    }
}

/** Telegram's nine colours (`PersistColorPalette`) in a row, the current one ringed. */
@Composable
private fun Swatches(current: Int, enabled: Boolean, onPick: (Int) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(44.dp)
            .padding(horizontal = 24.dp)
            .graphicsLayer { alpha = if (enabled) 1f else 0.4f },
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (swatch in PhotoColors.PRESETS) {
            val on = enabled && (swatch and 0xffffff) == (current and 0xffffff)
            Box(
                Modifier
                    .size(30.dp)
                    .clip(CircleShape)
                    .then(if (on) Modifier.border(2.dp, Color.White, CircleShape) else Modifier)
                    .clickable(enabled = enabled, role = Role.Button) { onPick(swatch) }
                    .semantics { selected = on }
                    .testTag(PhotoEditTags.SWATCH),
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.size(if (on) 20.dp else 24.dp).clip(CircleShape).background(Color(swatch)))
            }
        }
    }
}

/** Telegram's PaintToolsView: white 28dp brush glyphs, a translucent circular selector, and the colour button. */
@Composable
private fun Tools(tool: PaintTool, color: Int, onTool: (PaintTool) -> Unit, onPalette: () -> Unit) {
    val colorLabel = stringResource(R.string.photo_edit_color)
    Row(
        Modifier.fillMaxWidth().height(48.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(PhotoEditSpec.toolSpacing)
                .clip(CircleShape)
                .clickable(enabled = tool.coloured, role = Role.Button, onClick = onPalette)
                .semantics { contentDescription = colorLabel }
                .graphicsLayer { alpha = if (tool.coloured) 1f else 0.4f }
                .testTag(PhotoEditTags.COLOR),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.size(30.dp)) {
                val ring = 3.dp.toPx()
                drawCircle(
                    Brush.sweepGradient(listOf(Color.Red, Color.Yellow, Color.Green, Color.Cyan, Color.Blue, Color.Magenta, Color.Red)),
                    radius = this.size.minDimension / 2 - ring / 2,
                    style = Stroke(ring),
                )
                drawCircle(Color(color), this.size.minDimension / 2 - ring * 2)
            }
        }
        for (each in PaintTool.entries) {
            val chosen = each == tool
            val selectionAlpha by animateFloatAsState(if (chosen) 1f else 0f, tween(250), label = "brush selected")
            val label = stringResource(each.label)
            Box(
                Modifier
                    .size(PhotoEditSpec.toolSpacing)
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = selectionAlpha * 0.1875f))
                    .clickable(role = Role.Button) { onTool(each) }
                    .semantics {
                        contentDescription = label
                        selected = chosen
                    }
                    .testTag(PhotoEditTags.TOOL + each.name.lowercase(Locale.ROOT)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    PhotoEditIcons.of(each), null,
                    tint = Color.White,
                    modifier = Modifier.size(28.dp),
                )
            }
        }
    }
}

private val PaintTool.label: Int
    get() = when (this) {
        PaintTool.Pen -> R.string.photo_edit_pen
        PaintTool.Arrow -> R.string.photo_edit_arrow
        PaintTool.Marker -> R.string.photo_edit_marker
        PaintTool.Neon -> R.string.photo_edit_neon
        PaintTool.Blur -> R.string.photo_edit_blur
        PaintTool.Eraser -> R.string.photo_edit_eraser
    }

/**
 * The eyedropper (`PipettePickerView`): a loupe over the photo, starting in
 * its middle, the pixels under it six times over and its ring the colour
 * at its centre; dragged anywhere, let go, it takes that colour.
 */
@Composable
private fun PhotoPipette(snapshot: Bitmap, onPick: (Int) -> Unit) {
    var point by remember { mutableStateOf<Offset?>(null) }
    var picked by remember { mutableIntStateOf(0) }
    val paint = remember { Paint().apply { isFilterBitmap = false } }
    fun sample(at: Offset): Int = snapshot.getPixel(at.x.roundToInt().coerceIn(0, snapshot.width - 1), at.y.roundToInt().coerceIn(0, snapshot.height - 1))
    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    point = down.position
                    picked = sample(down.position)
                    down.consume()
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) break
                        point = change.position
                        picked = sample(change.position)
                        change.consume()
                    }
                    onPick(picked)
                }
            }
            .testTag(PhotoEditTags.PIPETTE),
    ) {
        val start = with(LocalDensity.current) { Offset(maxWidth.toPx() / 2, maxHeight.toPx() / 2) }
        Canvas(Modifier.fillMaxSize()) {
            val at = point ?: start
            val shown = if (point == null) sample(at) else picked
            val radius = PhotoEditSpec.loupe.toPx() / 2
            // Above the finger, so it isn't under it.
            val loupe = Offset(at.x, (at.y - radius - 24.dp.toPx()).coerceAtLeast(radius))
            drawIntoCanvas { canvas ->
                val native = canvas.nativeCanvas
                native.save()
                val circle = android.graphics.Path().apply { addCircle(loupe.x, loupe.y, radius, android.graphics.Path.Direction.CW) }
                native.clipPath(circle)
                native.drawColor(android.graphics.Color.BLACK)
                val zoom = PhotoEditSpec.LOUPE_ZOOM
                native.drawBitmap(snapshot, Matrix().apply { setScale(zoom, zoom); postTranslate(loupe.x - at.x * zoom, loupe.y - at.y * zoom) }, paint)
                native.restore()
            }
            val cell = PhotoEditSpec.LOUPE_ZOOM
            drawRect(Color.White, Offset(loupe.x - cell, loupe.y - cell), Size(cell * 2, cell * 2), style = Stroke(1.dp.toPx()))
            drawCircle(Color(shown).copy(alpha = 1f), radius - 4.dp.toPx(), loupe, style = Stroke(8.dp.toPx()))
            drawCircle(Color.White, radius, loupe, style = Stroke(1.5.dp.toPx()))
        }
    }
}

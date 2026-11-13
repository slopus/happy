package com.slopus.happy.ui.photoedit

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.roundToInt

private enum class PaletteTab(val label: Int) { Grid(R.string.photo_edit_grid), Spectrum(R.string.photo_edit_spectrum) }

/**
 * Telegram-Android's colour sheet (`ColorPickerBottomSheet`), without its
 * Sliders tab: on #252525 under a 36 × 4 handle, the 12 × 10 grid or the
 * spectrum (picked by a tap or a drag), the opacity slider over a
 * checkerboard, then the eyedropper, the two tabs and ✓. It rises over the
 * draw screen in 250 ms; a tap above it, ✓ or Back puts it away.
 */
@Composable
internal fun PhotoColorSheet(color: Int, onColor: (Int) -> Unit, onPipette: () -> Unit, onDismiss: () -> Unit) {
    var tab by remember { mutableStateOf(PaletteTab.Grid) }
    var current by remember { mutableIntStateOf(color) }
    var spectrumAt by remember { mutableStateOf<Offset?>(null) }
    val rise = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { rise.animateTo(1f, tween(250, easing = PhotoEditSpec.easing)) }
    fun set(next: Int) {
        current = next
        onColor(next)
    }
    fun dismiss() {
        scope.launch {
            rise.animateTo(0f, tween(200, easing = PhotoEditSpec.easing))
            onDismiss()
        }
    }
    androidx.activity.compose.BackHandler { dismiss() }
    Box(
        Modifier
            .fillMaxSize()
            .graphicsLayer { alpha = rise.value }
            .background(Color.Black.copy(alpha = 0.3f))
            .clickable(interactionSource = null, indication = null) { dismiss() },
    ) {
        var height by remember { mutableIntStateOf(0) }
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .onSizeChanged { height = it.height }
                .graphicsLayer { translationY = height * (1 - rise.value) }
                .clip(RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp))
                .background(Color(PhotoEditSpec.SHEET))
                .clickable(interactionSource = null, indication = null) {}
                .windowInsetsPadding(WindowInsets.navigationBars)
                .testTag(PhotoEditTags.COLOR_SHEET),
        ) {
            Box(Modifier.fillMaxWidth().height(20.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.size(36.dp, 4.dp).clip(RoundedCornerShape(2.dp)).background(Color(0xff5B5B5B)))
            }
            Text(
                stringResource(R.string.photo_edit_colors),
                color = Color.White,
                style = happyTextStyle(17, weight = FontWeight.SemiBold),
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
            )
            Box(
                Modifier
                    .padding(horizontal = 12.dp)
                    .fillMaxWidth()
                    .aspectRatio(PhotoColors.GRID_COLUMNS / PhotoColors.GRID_ROWS.toFloat())
                    // 12 from the screen's edges: a drag there is the picker's, not the system's back.
                    .systemGestureExclusion(),
            ) {
                when (tab) {
                    PaletteTab.Grid -> ColorGrid(current) { set(PhotoColors.withAlpha(it, alphaOf(current))) }
                    PaletteTab.Spectrum -> ColorSpectrum(spectrumAt) { at, picked ->
                        spectrumAt = at
                        set(PhotoColors.withAlpha(picked, alphaOf(current)))
                    }
                }
            }
            OpacitySlider(current, onAlpha = { set(PhotoColors.withAlpha(current, it)) })
            Row(
                Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val eyedropper = stringResource(R.string.photo_edit_eyedropper)
                Box(
                    Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .clickable(role = Role.Button, onClick = onPipette)
                        .semantics { contentDescription = eyedropper }
                        .testTag(PhotoEditTags.EYEDROPPER),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(PhotoEditIcons.Eyedropper, null, tint = Color.White, modifier = Modifier.size(24.dp))
                }
                Row(
                    Modifier
                        .weight(1f)
                        .padding(horizontal = 12.dp)
                        .height(36.dp)
                        .clip(RoundedCornerShape(18.dp))
                        .background(Color.White.copy(alpha = 0.08f)),
                ) {
                    for (each in PaletteTab.entries) {
                        val on = each == tab
                        Box(
                            Modifier
                                .weight(1f)
                                .fillMaxHeight()
                                .padding(3.dp)
                                .clip(RoundedCornerShape(15.dp))
                                .background(if (on) Color.White.copy(alpha = 0.16f) else Color.Transparent)
                                .clickable(role = Role.Tab) { tab = each }
                                .semantics { selected = on }
                                .testTag(PhotoEditTags.COLOR_TAB + each.name.lowercase(Locale.ROOT)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(stringResource(each.label).uppercase(Locale.getDefault()), color = Color.White, style = happyTextStyle(13, weight = FontWeight.SemiBold))
                        }
                    }
                }
                val done = stringResource(R.string.photo_edit_done)
                Box(
                    Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .clickable(role = Role.Button) { dismiss() }
                        .semantics { contentDescription = done }
                        .testTag(PhotoEditTags.COLOR_DONE),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(MaterialSymbols.Check, null, tint = Color.White, modifier = Modifier.size(24.dp))
                }
            }
        }
    }
}

private fun alphaOf(color: Int): Float = (color ushr 24) / 255f

/** Runs [at] for where a finger lands and every place it moves to, until it lifts. */
private suspend fun PointerInputScope.follow(at: (Offset) -> Unit) {
    awaitEachGesture {
        val down = awaitFirstDown()
        at(down.position)
        down.consume()
        while (true) {
            val event = awaitPointerEvent()
            val change = event.changes.firstOrNull { it.id == down.id } ?: break
            if (!change.pressed) break
            at(change.position)
            change.consume()
        }
    }
}

/** `GridPickerView`: 12 hues by 10 shades, rounded 10 as a whole; the cell of the colour in use outlined 3. */
@Composable
private fun ColorGrid(current: Int, onPick: (Int) -> Unit) {
    Canvas(
        Modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(10.dp))
            .pointerInput(Unit) {
                follow { at ->
                    val x = (at.x / size.width * PhotoColors.GRID_COLUMNS).toInt().coerceIn(0, PhotoColors.GRID_COLUMNS - 1)
                    val y = (at.y / size.height * PhotoColors.GRID_ROWS).toInt().coerceIn(0, PhotoColors.GRID_ROWS - 1)
                    onPick(PhotoColors.grid(x, y))
                }
            }
            .testTag(PhotoEditTags.COLOR_GRID),
    ) {
        val cell = Size(size.width / PhotoColors.GRID_COLUMNS, size.height / PhotoColors.GRID_ROWS)
        var chosen: Offset? = null
        for (y in 0 until PhotoColors.GRID_ROWS) for (x in 0 until PhotoColors.GRID_COLUMNS) {
            val each = PhotoColors.grid(x, y)
            val at = Offset(x * cell.width, y * cell.height)
            // A hair over, so no seam shows between cells.
            drawRect(Color(each), at, Size(cell.width + 1, cell.height + 1))
            if ((each and 0xffffff) == (current and 0xffffff)) chosen = at
        }
        chosen?.let { at ->
            val stroke = 3.dp.toPx()
            drawRoundRect(Color.White, at + Offset(stroke / 2, stroke / 2), Size(cell.width - stroke, cell.height - stroke), CornerRadius(4.dp.toPx()), style = Stroke(stroke))
        }
    }
}

/** `SpectrumPickerView`: the hues down, white to their left and black to their right; a ring where it was touched. */
@Composable
private fun ColorSpectrum(at: Offset?, onPick: (Offset, Int) -> Unit) {
    Canvas(
        Modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(10.dp))
            .pointerInput(Unit) {
                follow { point ->
                    val x = (point.x / size.width).coerceIn(0f, 1f)
                    val y = (point.y / size.height).coerceIn(0f, 1f)
                    onPick(Offset(x, y), PhotoColors.spectrum(x, y))
                }
            }
            .testTag(PhotoEditTags.COLOR_SPECTRUM),
    ) {
        drawRect(Brush.verticalGradient(PhotoColors.SPECTRUM.map { Color(it) }))
        drawRect(Brush.horizontalGradient(0.06f to Color.White, 0.22f to Color.Transparent, 0.78f to Color.Transparent, 0.94f to Color.Black))
        at?.let {
            val point = Offset(it.x * size.width, it.y * size.height)
            drawCircle(Color(PhotoColors.spectrum(it.x, it.y)), 10.dp.toPx(), point)
            drawCircle(Color.White, 11.5.dp.toPx(), point, style = Stroke(3.dp.toPx()))
        }
    }
}

/** `AlphaPickerView`: a 12-tall bar, clear to the colour over a checkerboard, under a 13 knob ringed white. */
@Composable
private fun OpacitySlider(color: Int, onAlpha: (Float) -> Unit) {
    val label = stringResource(R.string.photo_edit_opacity)
    BoxWithConstraints(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 12.dp).systemGestureExclusion()) {
        Canvas(
            Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    val inset = 6.dp.toPx()
                    follow { at -> onAlpha(((at.x - inset) / (size.width - inset * 2)).coerceIn(0f, 1f)) }
                }
                .semantics {
                    contentDescription = label
                    role = Role.Image
                }
                .testTag(PhotoEditTags.COLOR_OPACITY),
        ) {
            val inset = 6.dp.toPx()
            val y = size.height / 2
            val bar = Size(size.width - inset * 2, inset * 2)
            val corner = CornerRadius(bar.height / 2)
            val square = inset
            // The checkerboard, clipped to the bar's round ends by drawing it in cells inside.
            val columns = (bar.width / square).roundToInt()
            for (i in 0 until columns) for (j in 0 until 2) {
                val light = (i + j) % 2 == 0
                drawRect(if (light) Color.White else Color(0xffcccccc), Offset(inset + i * square, y - inset + j * square), Size(square + 0.5f, square))
            }
            drawRoundRect(Color(PhotoEditSpec.SHEET), Offset(inset, y - inset), bar, corner, style = Stroke(1.dp.toPx()))
            drawRoundRect(Brush.horizontalGradient(listOf(Color.Transparent, Color(color).copy(alpha = 1f)), startX = inset, endX = size.width - inset), Offset(inset, y - inset), bar, corner)
            val alpha = alphaOf(color)
            val knob = 13.dp.toPx()
            val x = (inset + bar.width * alpha).coerceIn(inset + knob / 2, size.width - inset - knob / 2)
            drawCircle(Color.White, knob, Offset(x, y))
            drawCircle(Color(color), knob - 3.dp.toPx(), Offset(x, y))
        }
    }
}

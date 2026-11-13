package com.slopus.happy.ui.camera

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.camera.PhotoControl
import com.slopus.happy.camera.PhotoFlash
import com.slopus.happy.camera.PhotoPreferences
import com.slopus.happy.camera.PhotoShape
import com.slopus.happy.camera.PhotoZoom
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay
import kotlin.math.cos
import kotlin.math.sin

private val Active = Color(0xFFFFD300)
private val Focus = Color(0xFFFFD60A)

/** iOS CameraControls:13sp semibold,48 Android targets, active yellow; tablet uses a column. */
@Composable
internal fun PhotoTools(control: PhotoControl, tablet: Boolean, enabled: Boolean, rotation: Float) {
    val off = stringResource(R.string.camera_off)
    val on = stringResource(R.string.camera_on)
    val tools: @Composable () -> Unit = {
        val timer: @Composable () -> Unit = {
            val seconds = stringResource(R.string.camera_timer_seconds, control.timer)
            PhotoTool(stringResource(R.string.camera_timer), if (control.timer == 0) off else seconds, enabled,
                control.timer != 0, rotation, icon = if (control.timer == 0) MaterialSymbols.CameraTimer else null,
                word = if (control.timer == 0) null else seconds, tag = "camera.timer") {
                control.timer = when (control.timer) { 0 -> 3; 3 -> 10; else -> 0 }
            }
        }
        val aspect: @Composable () -> Unit = {
            PhotoTool(stringResource(R.string.camera_shape), PhotoPreferences.shape.label, enabled, false, rotation,
                word = PhotoPreferences.shape.label, tag = "camera.shape") { PhotoPreferences.shape = PhotoPreferences.shape.next() }
        }
        val grid: @Composable () -> Unit = {
            PhotoTool(stringResource(R.string.camera_grid), if (PhotoPreferences.grid) on else off, enabled, PhotoPreferences.grid, rotation,
                icon = MaterialSymbols.CameraGrid, tag = "camera.grid") { PhotoPreferences.grid = !PhotoPreferences.grid }
        }
        val flash: @Composable () -> Unit = {
            if (control.hasFlash || control.actualFront) {
                val mode = PhotoPreferences.flash
                PhotoTool(stringResource(R.string.camera_flash), when (mode) {
                    PhotoFlash.Auto -> stringResource(R.string.camera_flash_auto)
                    PhotoFlash.On -> on
                    PhotoFlash.Off -> off
                }, enabled, mode == PhotoFlash.On || mode == PhotoFlash.Auto && control.dark == true, rotation,
                    icon = when (mode) { PhotoFlash.Auto -> MaterialSymbols.CameraFlashAuto; PhotoFlash.On -> MaterialSymbols.CameraFlash; PhotoFlash.Off -> MaterialSymbols.CameraFlashOff }, tag = "camera.flash") {
                    PhotoPreferences.flash = mode.next()
                }
            }
        }
        if (tablet) { flash(); timer(); aspect(); grid() } else { timer(); aspect(); grid(); flash() }
    }
    if (tablet) Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) { tools() }
    else Row { tools() }
}

@Composable
private fun PhotoTool(label: String, state: String, enabled: Boolean, active: Boolean, rotation: Float, icon: ImageVector? = null, word: String? = null, tag: String, click: () -> Unit) {
    Box(Modifier.size(48.dp).testTag(tag).semantics { contentDescription = label; stateDescription = state }
        .clickable(enabled = enabled, role = Role.Button, onClick = click), contentAlignment = Alignment.Center) {
        val tint = if (active) Active else Color.White
        if (icon != null) Icon(icon, null, tint = tint, modifier = Modifier.size(22.dp).graphicsLayer { rotationZ = rotation; alpha = if (enabled) 1f else 0.45f })
        else Text(word.orEmpty(), color = tint, style = happyTextStyle(13, weight = FontWeight.SemiBold),
            modifier = Modifier.graphicsLayer { rotationZ = rotation; alpha = if (enabled) 1f else 0.45f })
    }
}

@Composable
internal fun PhotoZoomBar(control: PhotoControl, rotation: Float, enabled: Boolean, modifier: Modifier) {
    val bounds = control.zoomBounds
    if (bounds.stops.size < 2) return
    val selected = bounds.selected(control.zoom)
    Row(modifier.heightIn(min = 48.dp).drawBehind {
        drawRoundRect(Color(0x4D222222), topLeft = Offset(0f, (size.height - 43.dp.toPx()) / 2), size = Size(size.width, 43.dp.toPx()), cornerRadius = androidx.compose.ui.geometry.CornerRadius(22.dp.toPx()))
    }.padding(horizontal = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        bounds.stops.forEachIndexed { index, value ->
            val chosen = index == selected
            val label = PhotoZoom.label(if (chosen) control.zoom else value, chosen)
            val description = stringResource(R.string.camera_zoom, PhotoZoom.label(value, true))
            Box(Modifier.size(48.dp).testTag("camera.zoom.$index")
                .semantics { contentDescription = description; stateDescription = label }
                .clickable(enabled = enabled, role = Role.Button) { control.zoomTo(value) }, contentAlignment = Alignment.Center) {
                Box(Modifier.size(37.dp).graphicsLayer { scaleX = if (chosen) 1f else 0.7f; scaleY = scaleX }
                    .background(Color.Black.copy(alpha = 0.3f), CircleShape), contentAlignment = Alignment.Center) {
                    Text(label, color = if (chosen) Active else Color.White, style = happyTextStyle(13, weight = FontWeight.SemiBold), modifier = Modifier.graphicsLayer { rotationZ = rotation })
                }
            }
        }
    }
}

@Composable
internal fun PhotoFlip(enabled: Boolean, rotation: Float, onFlip: () -> Unit, modifier: Modifier) {
    Box(modifier.size(48.dp).testTag("camera.flip").background(Color.Black.copy(alpha = 0.3f), CircleShape)
        .clickable(enabled = enabled, role = Role.Button, onClick = onFlip), contentAlignment = Alignment.Center) {
        Icon(MaterialSymbols.CameraFlip, stringResource(R.string.camera_flip), tint = Color.White, modifier = Modifier.size(28.dp).graphicsLayer { rotationZ = rotation })
    }
}

/** Preview-local crop bands, thirds,80focus/144track/26sun and120sp countdown, from CameraScreenLayout. */
@Composable
internal fun PhotoPictureControls(control: PhotoControl, size: Size, shape: PhotoShape, rotation: Float) {
    val unit = LocalDensity.current.density
    val area = Rect(Offset.Zero, size)
    val crop = fitPhoto(Size(shape.ratio.toFloat(), 1f), area, portrait = size.height >= size.width)
    val focus = control.focus
    val alpha = remember { Animatable(0f) }
    val scale = remember { Animatable(1f) }
    LaunchedEffect(focus?.generation, focus?.aeLocked, control.exposure) {
        if (focus == null) { alpha.snapTo(0f); return@LaunchedEffect }
        alpha.snapTo(1f)
        scale.snapTo(2f)
        scale.animateTo(1f, tween(150))
        if (!focus.afLocked && !focus.aeLocked) {
            repeat(3) { alpha.animateTo(0.6f, tween(165)); alpha.animateTo(1f, tween(165)) }
            delay(750)
            alpha.animateTo(0.5f, tween(200))
            delay(3000)
            alpha.animateTo(0f, tween(200))
            control.dismissFocus(focus.generation)
        }
    }
    val side = minOf(80 * unit, size.width, size.height)
    val square = focus?.point?.let {
        val left = (it.x - side / 2).coerceIn(0f, (size.width - side).coerceAtLeast(0f))
        val top = (it.y - side / 2).coerceIn(0f, (size.height - side).coerceAtLeast(0f))
        Rect(left, top, left + side, top + side)
    }
    val track = square?.let {
        val x = if (it.right + 38 * unit <= size.width) it.right + 25 * unit else it.left - 25 * unit
        val height = minOf(144 * unit, size.height)
        val top = (it.center.y - height / 2).coerceIn(0f, (size.height - height).coerceAtLeast(0f))
        Rect(x - 24 * unit, top, x + 24 * unit, top + height)
    }
    Canvas(Modifier.fillMaxSize()) {
        if (crop.top > 0) { drawRect(Color.Black.copy(alpha = 0.6f), size = Size(size.width, crop.top)); drawRect(Color.Black.copy(alpha = 0.6f), Offset(0f, crop.bottom), Size(size.width, size.height - crop.bottom)) }
        if (crop.left > 0) { drawRect(Color.Black.copy(alpha = 0.6f), size = Size(crop.left, size.height)); drawRect(Color.Black.copy(alpha = 0.6f), Offset(crop.right, 0f), Size(size.width - crop.right, size.height)) }
        if (PhotoPreferences.grid) for (index in 1..2) {
            val x = crop.left + crop.width * index / 3
            val y = crop.top + crop.height * index / 3
            drawLine(Color.White.copy(alpha = 0.35f), Offset(x, crop.top), Offset(x, crop.bottom), 0.5f * unit)
            drawLine(Color.White.copy(alpha = 0.35f), Offset(crop.left, y), Offset(crop.right, y), 0.5f * unit)
        }
        if (square != null) {
            val scaled = Size(square.width * scale.value, square.height * scale.value)
            drawRect(Focus.copy(alpha = alpha.value), square.center - Offset(scaled.width / 2, scaled.height / 2), scaled, style = Stroke(unit))
            if (track != null && control.exposureSupported) {
                val x = track.center.x
                drawLine(Focus.copy(alpha = alpha.value), Offset(x, track.top), Offset(x, track.bottom), unit)
                val sun = Offset(x, track.top + (1 - control.exposure) * track.height / 2)
                drawCircle(Color.Black.copy(alpha = alpha.value), 13 * unit, sun)
                drawCircle(Focus.copy(alpha = alpha.value), 4 * unit, sun, style = Stroke(unit))
                for (ray in 0..7) {
                    val angle = ray * Math.PI / 4
                    val vector = Offset(cos(angle).toFloat(), sin(angle).toFloat())
                    drawLine(Focus.copy(alpha = alpha.value), sun + vector * (7 * unit), sun + vector * (11 * unit), unit)
                }
            }
        }
    }
    if (track != null && control.exposureSupported) {
        val label = stringResource(R.string.camera_exposure)
        Box(Modifier.frame(track, LocalDensity.current).testTag("camera.exposure").semantics {
            contentDescription = label
            progressBarRangeInfo = ProgressBarRangeInfo(control.exposure, -1f..1f)
            setProgress { control.expose(it); true }
        })
    }
    if (focus != null && (focus.afLocked || focus.aeLocked)) {
        val label = when { focus.afLocked && focus.aeLocked -> R.string.camera_ae_af_lock; focus.afLocked -> R.string.camera_af_lock; else -> R.string.camera_ae_lock }
        Box(Modifier.frame(Rect(crop.left, crop.top + 12 * unit, crop.right, crop.top + 48 * unit), LocalDensity.current), contentAlignment = Alignment.TopCenter) {
            Text(stringResource(label), color = Color.Black, style = happyTextStyle(13, weight = FontWeight.SemiBold), modifier = Modifier.background(Focus).padding(horizontal = 8.dp, vertical = 3.dp))
        }
    }
    control.countdown?.let { count ->
        val tick = remember { Animatable(1f) }
        LaunchedEffect(count) { tick.snapTo(1.3f); tick.animateTo(1f, tween(300)) }
        Box(Modifier.frame(crop, LocalDensity.current), contentAlignment = Alignment.Center) {
            Text(count.toString(), color = Color.White, style = happyTextStyle(120), modifier = Modifier.testTag("camera.countdown").graphicsLayer { scaleX = tick.value; scaleY = tick.value; rotationZ = rotation })
        }
    }
}
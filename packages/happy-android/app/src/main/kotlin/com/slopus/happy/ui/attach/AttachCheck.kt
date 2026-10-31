package com.slopus.happy.ui.attach

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import com.slopus.happy.ui.components.rememberReduceMotion

/**
 * Telegram's `CheckBox2` as a gallery cell draws it (`CheckBoxBase`,
 * background type 6). Unpicked: a white ring over a faint shade. Picked
 * ([number] > 0), one 200 ms `EASE_OUT` progress: its first half fills the
 * circle with [AttachColors.accent] from the rim inward while a ring of the
 * sheet's colour ([sheet]) sweeps round it; its second half widens the
 * number in from nothing. Unpicked again, the same backwards.
 */
@Composable
fun AttachCheck(number: Int, sheet: Color, colors: AttachColors, modifier: Modifier = Modifier) {
    val reduceMotion = rememberReduceMotion()
    val progress = remember { Animatable(if (number > 0) 1f else 0f) }
    // The number stays drawn while the check empties.
    var shown by remember { mutableIntStateOf(number) }
    if (number > 0 && number != shown) shown = number
    LaunchedEffect(number > 0) {
        val target = if (number > 0) 1f else 0f
        progress.animateTo(target, if (reduceMotion) snap() else tween(AttachMotion.CHECK_MS, easing = AttachMotion.easeOut))
    }
    val measurer = rememberTextMeasurer()
    Canvas(modifier.size(AttachSpec.check).graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }) {
        val p = progress.value
        val round = if (p >= 0.5f) 1f else p / 0.5f
        val centre = Offset(size.width / 2, size.height / 2)
        // Unpicked: the shade and the white ring.
        drawCircle(CheckShade, AttachSpec.checkRingShade.toPx(), centre)
        drawCircle(Color.White, AttachSpec.checkRing.toPx(), centre, style = Stroke(AttachSpec.checkStroke.toPx()))
        if (p > 0) {
            val sweep = AttachSpec.checkSweep.toPx()
            drawArc(
                sheet.copy(alpha = sheet.alpha * p),
                startAngle = 0f,
                sweepAngle = -360f * p,
                useCenter = false,
                topLeft = Offset(centre.x - sweep, centre.y - sweep),
                size = Size(sweep * 2, sweep * 2),
                style = Stroke(AttachSpec.checkStroke.toPx()),
            )
        }
        if (round > 0) {
            val fill = AttachSpec.checkFill.toPx()
            drawCircle(colors.accent, fill, centre)
            val hole = fill * (1 - round)
            if (hole > 0) drawCircle(Color.Transparent, hole, centre, blendMode = BlendMode.Clear)
        }
        val numberProgress = if (p < 0.5f) 0f else (p - 0.5f) / 0.5f
        if (numberProgress > 0 && shown > 0) {
            val text = shown.toString()
            val layout = measurer.measure(
                text,
                TextStyle(color = colors.onAccent, fontSize = AttachSpec.checkText(shown), fontWeight = FontWeight.Bold),
            )
            val baseline = AttachSpec.checkBaseline(shown).toPx()
            scale(numberProgress, 1f, centre) {
                translate(centre.x - layout.size.width / 2f, baseline - layout.firstBaseline) {
                    drawText(layout)
                }
            }
        }
    }
}

/** `chat_attachPhotoBackground` under the ring: black at 0x0C. */
private val CheckShade = Color(0x0C000000)

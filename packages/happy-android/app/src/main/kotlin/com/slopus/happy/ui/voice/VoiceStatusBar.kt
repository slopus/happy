package com.slopus.happy.ui.voice

import android.os.SystemClock
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.voice.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

internal object NoVoice : VoiceController {
    override val state = MutableStateFlow(VoiceState())
    override suspend fun start(sessionId: String, microphone: MicrophonePermission) = VoiceStart.Unavailable
    override suspend fun stop() = Unit
}

val LocalVoiceController = staticCompositionLocalOf<VoiceController> { NoVoice }

internal fun formatCallDuration(seconds: Long): String {
    val s = seconds.coerceAtLeast(0)
    val mm = (s / 60 % 60).toString().padStart(if (s >= 3600) 2 else 1, '0')
    val ss = (s % 60).toString().padStart(2, '0')
    return if (s >= 3600) "${s / 3600}:$mm:$ss" else "$mm:$ss"
}

/** VoiceAssistantStatusBar.tsx: observes the single call, ticking elapsed duration once a second. */
@Composable
fun VoiceStatusBar(sidebar: Boolean = false) {
    val controller = LocalVoiceController.current
    val state by controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var elapsed by remember(state.connectedAtElapsed) { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(state.status, state.connectedAtElapsed) {
        if (state.status == VoiceStatus.Connected) while (true) {
            elapsed = SystemClock.elapsedRealtime()
            delay(1000)
        }
    }
    val duration = state.connectedAtElapsed?.let { formatCallDuration((elapsed - it) / 1000) }
    VoiceStatusBarContent(state, duration, sidebar, onEnd = { scope.launch { controller.stop() } })
}

/**
 * VoiceAssistantStatusBar.tsx on Android. Full: 16 side inset, 6 above a 44-high pill,
 * radius 22, surfaceHighest, 24 mic in a 44 slot, centred 16/20 semibold duration,
 * 12pt end hint inset 16. Sidebar: 32 high, 12 side padding, 8 dot, 6 gap, 16 mic,
 * 6 gap, 12pt status, 14 close. The entire bar ends the call in any visible state.
 */
@Composable
fun VoiceStatusBarContent(state: VoiceState, duration: String?, sidebar: Boolean, onEnd: () -> Unit) {
    if (state.status == VoiceStatus.Disconnected) return
    val colors = HappyTheme.colors
    val text = when (state.status) {
        VoiceStatus.Connecting -> stringResource(R.string.voice_status_bar_connecting)
        VoiceStatus.Error -> stringResource(R.string.voice_status_bar_error)
        else -> duration ?: if (sidebar) stringResource(R.string.voice_status_bar_active) else "0:00"
    }
    val end = stringResource(R.string.voice_status_bar_tap_to_end)
    if (sidebar) {
        Row(
            Modifier.testTag("voice.sidebar").fillMaxWidth().heightIn(min = 32.dp)
                .background(colors.surfaceHighest).clickable(role = Role.Button, onClickLabel = end, onClick = onEnd)
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val dot = when (state.status) {
                VoiceStatus.Connecting -> colors.status.connecting
                VoiceStatus.Error -> colors.status.error
                else -> colors.status.connected
            }
            StatusDot(dot, pulsing = state.status == VoiceStatus.Connecting, size = 8.dp)
            Spacer(Modifier.width(6.dp))
            Icon(Ionicon.Mic, 16.dp, colors.text)
            Spacer(Modifier.width(6.dp))
            Text(text, color = colors.text, style = happyTextStyle(12, weight = FontWeight.Medium), modifier = Modifier.weight(1f))
            val speaking = state.mode != VoiceMode.Idle
            if (speaking) VoiceBars()
            Spacer(Modifier.width(if (speaking) 4.dp else 8.dp))
            Icon(Ionicon.Close, 14.dp, colors.text)
        }
    } else {
        Box(Modifier.testTag("voice.full").fillMaxWidth().padding(horizontal = 16.dp).padding(top = 6.dp)) {
            Box(
                Modifier.testTag("voice.pill").fillMaxWidth().heightIn(min = 44.dp)
                    .clip(RoundedCornerShape(22.dp))
                    .background(colors.surfaceHighest, RoundedCornerShape(22.dp))
                    .clickable(role = Role.Button, onClickLabel = end, onClick = onEnd),
            ) {
                Box(Modifier.align(Alignment.CenterStart).size(44.dp), contentAlignment = Alignment.Center) { ShimmerMic() }
                Text(text, color = colors.header.tint,
                    style = happyTextStyle(fontSize = 16, lineHeight = 20, weight = FontWeight.SemiBold).copy(fontFeatureSettings = "tnum"),
                    modifier = Modifier.align(Alignment.Center).testTag("voice.duration"))
                Text(end, color = colors.textSecondary, style = happyTextStyle(12),
                    modifier = Modifier.align(Alignment.CenterEnd).padding(horizontal = 16.dp, vertical = 12.dp))
            }
        }
    }
}

/** ShimmerView.tsx: the white mic's highlight crosses in 1800ms; static with reduced motion. */
@Composable
private fun ShimmerMic() {
    val reduce = rememberReduceMotion()
    val progress = remember { Animatable(0f) }
    LaunchedEffect(reduce) {
        if (!reduce) progress.animateTo(1f, infiniteRepeatable(tween(1800, easing = LinearEasing)))
    }
    val modifier = if (reduce) Modifier else Modifier
        .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
        .drawWithContent {
            drawContent()
            val band = size.width * 0.8f
            val x = -band + (size.width + band) * progress.value
            drawRect(Brush.linearGradient(listOf(Color.White.copy(alpha = .45f), Color.White, Color.White.copy(alpha = .45f)),
                start = Offset(x, 0f), end = Offset(x + band, 0f)), blendMode = BlendMode.SrcIn)
        }
    Box(modifier) { Icon(Ionicon.Mic, 24.dp, Color.White) }
}

/** VoiceBars.tsx small: three 2×12 bars, 1.5 gap; independent 300/350/400ms pulses. */
@Composable
private fun VoiceBars() {
    val reduce = rememberReduceMotion()
    val color = HappyTheme.colors.text
    Row(Modifier.testTag("voice.bars").height(12.dp), horizontalArrangement = Arrangement.spacedBy(1.5.dp)) {
        repeat(3) { index ->
            val scale = remember { Animatable(listOf(.3f, .5f, .4f)[index]) }
            LaunchedEffect(reduce) {
                if (!reduce) {
                    delay(index * 100L)
                    scale.animateTo(1f, infiniteRepeatable(tween(300 + index * 50), RepeatMode.Reverse))
                }
            }
            Box(Modifier.width(2.dp).height(12.dp).graphicsLayer { scaleY = scale.value }
                .background(color, RoundedCornerShape(2.dp)))
        }
    }
}
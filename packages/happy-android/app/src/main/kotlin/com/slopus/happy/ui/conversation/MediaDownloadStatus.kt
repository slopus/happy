package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.KeptMedia
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.media.DownloadPhase
import com.slopus.happy.media.MediaSizeText
import com.slopus.happy.ui.theme.happyTextStyle

/**
 * Telegram's media status over a kept tile (iOS `MediaStatusLayout`,
 * `ChatMessageInteractiveMediaBadge`): the size badge in the top-left
 * corner, a recording's length over its size or how much of it is here,
 * white on dark glass; and the ring, whose tap reads the file, pauses it
 * or tries again. A recording's ring is its play button.
 */
object MediaStatusSpec {
    val badgeInset = 6.dp
    val badgePaddingH = 6.dp
    val badgePaddingV = 2.dp
    val badgeRadius = 9.dp
    val badgeFill = Color.Black.copy(alpha = 0.5f)
    val badge = happyTextStyle(fontSize = 12, lineHeight = 16, weight = FontWeight.Medium).copy(fontFeatureSettings = "tnum")
    const val BADGE = "conversation.media.badge"
}

/** The ring and badge over [ref]'s tile, from where its download is in [kept]; [onPlay] plays a recording. */
@Composable
internal fun BoxScope.DownloadStatus(ref: MediaRef, kept: KeptMedia, video: Boolean, duration: String? = null, onPlay: () -> Unit = {}) {
    LaunchedEffect(ref.key) { kept.shown(ref) }
    val phase = kept.phase(ref)
    val state = MediaRingState.of(phase, video)
    // Already here when first seen, a picture shows no ring; one seen arriving fills and shrinks away.
    var arriving by remember(ref.key) { mutableStateOf(false) }
    if (phase != null && state != MediaRingState.Done) arriving = true
    if (video || arriving) {
        val label = when {
            video -> stringResource(R.string.artifact_video)
            phase is DownloadPhase.Downloading -> stringResource(R.string.media_pause_download)
            else -> stringResource(R.string.media_download)
        }
        MediaRing(
            state = state,
            onClick = if (video) onPlay else ({ kept.toggle(ref) }),
            label = label,
            modifier = Modifier.matchParentSize(),
        )
    }
    val lines = buildList {
        if (video && duration != null) add(duration)
        if (phase != null && (!phase.isComplete || (video && isEmpty()))) MediaSizeText.text(phase)?.let(::add)
    }
    if (lines.isNotEmpty()) {
        Column(
            Modifier
                .align(Alignment.TopStart)
                .padding(MediaStatusSpec.badgeInset)
                .background(MediaStatusSpec.badgeFill, RoundedCornerShape(MediaStatusSpec.badgeRadius))
                .padding(horizontal = MediaStatusSpec.badgePaddingH, vertical = MediaStatusSpec.badgePaddingV)
                .testTag(MediaStatusSpec.BADGE),
        ) {
            lines.forEach { Text(it, style = MediaStatusSpec.badge, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}

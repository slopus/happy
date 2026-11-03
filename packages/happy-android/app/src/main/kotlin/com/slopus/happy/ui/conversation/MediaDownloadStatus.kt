package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
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
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
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
    /** A file card's chip, where its glyph or ring sits, and the glyph. */
    val fileChip = 32.dp
    val fileGlyph = 22.dp
}

/** The ring and badge over [ref]'s tile, from where its download is in [kept]; [onPlay] plays a recording. */
@Composable
internal fun BoxScope.DownloadStatus(ref: MediaRef, kept: KeptMedia, video: Boolean, duration: String? = null, onPlay: () -> Unit = {}) {
    LaunchedEffect(ref.key) { kept.shown(ref) }
    MediaStatus(ref.key, kept.phase(ref), video, duration, onTap = if (video) onPlay else ({ kept.toggle(ref) }))
}

/**
 * The ring and badge for a download at [phase] over the tile this fills,
 * [key] naming the file. Already here when first seen, a picture shows no
 * ring; one seen arriving fills and shrinks away. [onTap] is the ring's.
 */
@Composable
fun BoxScope.MediaStatus(key: String, phase: DownloadPhase?, video: Boolean, duration: String? = null, onTap: () -> Unit) {
    val state = MediaRingState.of(phase, video)
    var arriving by remember(key) { mutableStateOf(false) }
    if (phase != null && state != MediaRingState.Done) arriving = true
    if (video || arriving) {
        val label = when {
            video -> stringResource(R.string.artifact_video)
            phase is DownloadPhase.Downloading -> stringResource(R.string.media_pause_download)
            else -> stringResource(R.string.media_download)
        }
        MediaRing(state = state, onClick = onTap, label = label, modifier = Modifier.matchParentSize())
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

/**
 * A file card's chip (iOS `ChatFileStatusView`, Telegram's file bubble):
 * the file's [icon] once it is here, else the ring, blue on the card, with
 * the download arrow or how far it is; a tap on it reads, pauses or tries
 * again ([onTap]). One seen arriving fills and shrinks away over the icon.
 */
@Composable
fun FileStatusChip(key: String, phase: DownloadPhase?, icon: Ionicon, onTap: () -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val state = MediaRingState.of(phase, video = false)
    var arriving by remember(key) { mutableStateOf(false) }
    if (phase != null && state != MediaRingState.Done) arriving = true
    Box(modifier.size(MediaStatusSpec.fileChip), contentAlignment = Alignment.Center) {
        if (state == MediaRingState.Done) Icon(icon, MediaStatusSpec.fileGlyph, colors.textSecondary)
        if (arriving) {
            val label = stringResource(if (phase is DownloadPhase.Downloading) R.string.media_pause_download else R.string.media_download)
            MediaRing(
                state = state,
                onClick = onTap,
                label = label,
                // The ring's touch slop reaches past the chip.
                modifier = Modifier.requiredSize(MediaStatusSpec.fileChip + UploadRingSpec.touchSlop * 2),
                disc = if (colors.dark) UploadRingSpec.fileDiscDark else UploadRingSpec.fileDisc,
            )
        }
    }
}

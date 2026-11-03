package com.slopus.happy.ui.artifacts

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import com.slopus.happy.R
import com.slopus.happy.artifacts.ArtifactMedia
import com.slopus.happy.artifacts.ArtifactMediaItem
import com.slopus.happy.artifacts.ArtifactMediaLayout
import com.slopus.happy.artifacts.Extent
import com.slopus.happy.artifacts.Frame
import com.slopus.happy.artifacts.Insets
import com.slopus.happy.artifacts.MediaFlow
import com.slopus.happy.artifacts.formatDuration
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.conversation.MediaStatus
import com.slopus.happy.ui.conversation.PlayFill
import com.slopus.happy.ui.conversation.PlayGlyph
import com.slopus.happy.ui.theme.happyTextStyle

object ArtifactGalleryTags {
    const val GALLERY = "artifact.gallery"
    const val COUNT = "artifact.count"
    const val TILE = "artifact.tile"
    const val BADGE = "artifact.badge"
}

private val countStyle = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.Medium)
private val badgeStyle = happyTextStyle(fontSize = 12, lineHeight = 16, weight = FontWeight.SemiBold)

/** What a grid of pictures and recordings holds: "4 images", "3 images, 1 video". */
@Composable
internal fun mediaCount(images: Int, videos: Int): String = listOfNotNull(
    images.takeIf { it > 0 }?.let { pluralResource(R.plurals.artifact_count_images, it, it) },
    videos.takeIf { it > 0 }?.let { pluralResource(R.plurals.artifact_count_videos, it, it) },
).joinToString(", ")

/**
 * An image, image series or video artifact ([ArtifactMediaLayout]): one item
 * large in the middle of the screen, or several under their count in the
 * conversation's media flow, a recording's length in a pill at its bottom
 * left. Laid out again as sizes and lengths arrive. A tap opens the item.
 */
@Composable
fun ArtifactGallery(items: List<ArtifactMediaItem>, media: ArtifactMedia, onOpen: (Int) -> Unit) {
    val colors = HappyTheme.colors
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val videos = items.count { it.isVideo }
    val count = if (items.size > 1) mediaCount(items.size - videos, videos) else null
    val bottom = with(density) { WindowInsets.navigationBars.getBottom(this).toDp() }
    BoxWithConstraints(Modifier.fillMaxSize().testTag(ArtifactGalleryTags.GALLERY)) {
        val countSize = count?.let { text ->
            val measured = measurer.measure(text, countStyle)
            with(density) { Extent(measured.size.width.toDp().value.toDouble(), measured.size.height.toDp().value.toDouble()) }
        }
        val badges = items.map { item -> if (item.isVideo) media.durations[item.key]?.let(::formatDuration) else null }
        val badgeWidths = badges.map { text -> text?.let { with(density) { measurer.measure(it, badgeStyle).size.width.toDp().value.toDouble() } } }
        val layout = ArtifactMediaLayout.of(
            size = Extent(maxWidth.value.toDouble(), maxHeight.value.toDouble()),
            safeArea = Insets(bottom = bottom.value.toDouble()),
            items = items.map { item ->
                val size = media.sizes[item.key]
                MediaFlow.Item(item.isVideo, MediaFlow.Image(size?.width, size?.height))
            },
            count = countSize,
            badges = badgeWidths,
        )
        Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Box(Modifier.size(layout.contentSize.width.dp, layout.contentSize.height.dp)) {
                val countFrame = layout.count
                if (count != null && countFrame != null) {
                    Text(count, style = countStyle, color = colors.textSecondary, maxLines = 1, modifier = Modifier.place(countFrame).testTag(ArtifactGalleryTags.COUNT))
                }
                items.forEachIndexed { index, item ->
                    val frame = layout.tiles.getOrNull(index) ?: return@forEachIndexed
                    MediaTile(item, media, Modifier.place(frame).testTag(ArtifactGalleryTags.TILE)) { onOpen(index) }
                    val pill = layout.badges.getOrNull(index)
                    val text = badges.getOrNull(index)
                    if (pill != null && text != null) {
                        Box(
                            Modifier.place(pill).clip(RoundedCornerShape(ArtifactMediaLayout.BADGE_HEIGHT.dp / 2)).background(PlayFill).testTag(ArtifactGalleryTags.BADGE),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(text, style = badgeStyle, color = PlayGlyph, maxLines = 1, textAlign = TextAlign.Center)
                        }
                    }
                }
            }
        }
    }
}

private fun Modifier.place(frame: Frame): Modifier = offset(frame.x.dp, frame.y.dp).size(frame.width.dp, frame.height.dp)

/**
 * One picture or recording, drawn as soon as its bytes (or first frame) are
 * in: a picture fitted to its tile, a recording's first frame under a play
 * button, on the tile's grey until then. Where the version's files are
 * kept, Telegram's ring and size badge follow the download, as on the
 * chat's tiles, and a recording's ring is its play button.
 */
@Composable
internal fun MediaTile(item: ArtifactMediaItem, media: ArtifactMedia, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    LaunchedEffect(item.key) { media.publish(item.key) }
    val phase = media.phase(item.key)
    Box(
        modifier
            .clip(RoundedCornerShape(8.dp))
            .background(colors.surfaceHighest)
            .clickable(role = Role.Image, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = item.label },
        contentAlignment = Alignment.Center,
    ) {
        if (item.isVideo) {
            val poster by produceState<Bitmap?>(null, item.key) { value = media.poster(item.key, 1080) }
            poster?.let { frame ->
                val bitmap = remember(frame) { frame.asImageBitmap() }
                Image(bitmap, null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
            }
            if (phase != null) {
                MediaStatus(item.key, phase, video = true, onTap = onClick)
            } else {
                Box(Modifier.size(MediaFlow.PLAY_SIZE.dp).clip(CircleShape).background(PlayFill), contentAlignment = Alignment.Center) {
                    Icon(MaterialSymbols.PlayArrow, null, tint = PlayGlyph, modifier = Modifier.wrapContentSize())
                }
            }
        } else {
            val scope = rememberCoroutineScope()
            val bytes by produceState<ByteArray?>(null, item.key) { value = media.data(item.key) }
            bytes?.let {
                RemoteImage(
                    model = it,
                    cacheKey = "artifact/${media.artifactId}/${media.version}/${item.key}",
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            if (phase != null) MediaStatus(item.key, phase, video = false, onTap = { scope.launch { media.toggle(item.key) } })
        }
    }
}

package com.slopus.happy.ui.conversation

import android.util.Base64
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.theme.happyTextStyle
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.slopus.happy.conversation.MediaFlow
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.ThumbHash
import com.slopus.happy.ui.theme.HappyTheme
import kotlin.math.roundToInt

/** A picture tile's look: iOS's `ChatMediaView`. */
object ConversationMediaSpec {
    val radius = 8.dp
    val outline = 1.dp
    val failedIcon = 20.dp
    val playIcon = 22.dp
    val badgeInset = 6.dp
    val badgeHeight = 20.dp
    val badgePadding = 6.dp
    val badge = happyTextStyle(fontSize = 12, lineHeight = 16, weight = FontWeight.SemiBold)
    val more = happyTextStyle(fontSize = 22, lineHeight = 28, weight = FontWeight.SemiBold)
    val moreScrim = Color(0x73000000)
}

object ConversationMediaTags {
    /** Every picture and recording tile; the flow they sit in is [FLOW]. */
    const val TILE = "conversation.media.tile"
    const val FLOW = "conversation.media.flow"
    /** A recording's play circle and its length. */
    const val PLAY = "conversation.media.play"
    const val DURATION = "conversation.media.duration"
    /** The "+N" over the last of a message's photos shown. */
    const val MORE = "conversation.media.more"
}

/**
 * Pictures shown together, as iOS lays a conversation's out ([MediaFlow]),
 * recordings each at their own box under them ([MediaFlow.mediaLayout]):
 * planned from their shapes before any bytes arrive, then placed at the
 * width this is given. [measure] turns that width (dp) into the flow's own;
 * with [alignEnd] the flow is pushed against the right edge, the rest
 * left clear, as a person's photos hug the right as their bubble does.
 * Otherwise the flow takes the width its tiles use, from the left.
 *
 * Every tile is measured at exactly its frame, so a tile is its picture's
 * own shape before, while and after it loads, and nothing moves when it
 * lands.
 */
@Composable
fun MediaFlowLayout(
    items: List<MediaFlow.Item>,
    modifier: Modifier = Modifier,
    columns: Int = 0,
    limits: MediaFlow.Limits = MediaFlow.tool,
    alignEnd: Boolean = false,
    measure: (Float) -> Float = { it },
    tile: @Composable (index: Int) -> Unit,
) {
    Layout(
        content = { items.indices.forEach { index -> key(index) { tile(index) } } },
        modifier = modifier.testTag(ConversationMediaTags.FLOW),
    ) { measurables, constraints ->
        val available = if (constraints.hasBoundedWidth) constraints.maxWidth / density else FALLBACK_WIDTH
        val room = measure(available).coerceAtLeast(0f)
        val flow = MediaFlow.mediaLayout(items, room, columns, limits, alignEnd)
        val shift = if (alignEnd) available - room else 0f
        fun px(dp: Float) = (dp * density).roundToInt()
        val placeables = measurables.mapIndexed { index, measurable ->
            val frame = flow.frames.getOrNull(index) ?: MediaFlow.Frame(0f, 0f, 0f, 0f)
            // Each edge rounded on its own, so neighbours never overlap or open a gap.
            val width = (px(frame.right + shift) - px(frame.x + shift)).coerceAtLeast(0)
            val height = (px(frame.bottom) - px(frame.y)).coerceAtLeast(0)
            measurable.measure(Constraints.fixed(width, height))
        }
        val width = if (alignEnd) px(available) else px(flow.width)
        layout(width.coerceIn(constraints.minWidth, constraints.maxWidth), px(flow.height).coerceAtLeast(constraints.minHeight)) {
            placeables.forEachIndexed { index, placeable ->
                val frame = flow.frames.getOrNull(index) ?: return@forEachIndexed
                placeable.place(px(frame.x + shift), px(frame.y))
            }
        }
    }
}

/** Only where a flow is given no width to fill (never in the transcript). */
private const val FALLBACK_WIDTH = 360f

/**
 * One picture of a conversation's, as iOS's `ChatMediaView` draws it: the
 * picture whole in a tile of its own shape, on surfacePressed until it
 * lands, a 1 dp divider hairline over the whole tile and corners rounded
 * 8. [placeholder] (a thumbhash, or a recording's first frame) shows until
 * then. A picture that couldn't be had keeps its ground under a quiet image
 * glyph. A recording ([video]) shows its first frame under a 48 play
 * circle (a 22 glyph on the play fill), and its length ([duration]) in a
 * pill 6 in from its bottom left (20 high, 6 either side of 12/16
 * semibold), as the artifact gallery shows it. [more] photos not shown
 * read "+N" (22/28 semibold, white) over a darkened tile.
 */
@Composable
fun MediaTile(
    bytes: ByteArray?,
    cacheKey: String,
    contentDescription: String?,
    failed: Boolean,
    onClick: (() -> Unit)?,
    modifier: Modifier = Modifier,
    placeholder: ImageBitmap? = null,
    video: Boolean = false,
    duration: String? = null,
    more: Int = 0,
    /** A recording's play circle; off where a ring shows it instead. */
    playButton: Boolean = true,
) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(ConversationMediaSpec.radius)
    Box(
        modifier
            .testTag(ConversationMediaTags.TILE)
            .clip(shape)
            .background(colors.surfacePressed)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .border(ConversationMediaSpec.outline, colors.divider, shape)
            .then(if (video && contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        if (bytes != null && !failed) {
            RemoteImage(
                model = bytes,
                cacheKey = cacheKey,
                contentDescription = contentDescription,
                // The tile is the picture's shape: fitted, it fills it.
                contentScale = ContentScale.Fit,
                placeholder = placeholder,
                modifier = Modifier.matchParentSize(),
            )
        } else if (placeholder != null && !failed) {
            androidx.compose.foundation.Image(placeholder, null, Modifier.matchParentSize(), contentScale = if (video) ContentScale.Fit else ContentScale.FillBounds)
        }
        if (video && playButton) {
            Box(
                Modifier.size(MediaFlow.PLAY_SIZE.dp).clip(CircleShape).background(PlayFill).testTag(ConversationMediaTags.PLAY),
                contentAlignment = Alignment.Center,
            ) {
                androidx.compose.material3.Icon(MaterialSymbols.PlayArrow, null, tint = PlayGlyph, modifier = Modifier.size(ConversationMediaSpec.playIcon))
            }
        }
        if (video && duration != null) {
            Box(
                Modifier
                    .align(Alignment.BottomStart)
                    .padding(ConversationMediaSpec.badgeInset)
                    .testTag(ConversationMediaTags.DURATION)
                    .heightIn(min = ConversationMediaSpec.badgeHeight)
                    .clip(RoundedCornerShape(ConversationMediaSpec.badgeHeight / 2))
                    .background(PlayFill)
                    .padding(horizontal = ConversationMediaSpec.badgePadding),
                contentAlignment = Alignment.Center,
            ) {
                Text(duration, style = ConversationMediaSpec.badge, color = PlayGlyph, maxLines = 1)
            }
        }
        if (more > 0) {
            Box(Modifier.matchParentSize().background(ConversationMediaSpec.moreScrim).testTag(ConversationMediaTags.MORE), contentAlignment = Alignment.Center) {
                Text("+$more", style = ConversationMediaSpec.more, color = Color.White, maxLines = 1)
            }
        }
        if (failed) Icon(Ionicon.ImageOutline, ConversationMediaSpec.failedIcon, colors.textSecondary)
    }
}

/** What the flow knows of a presented picture before its bytes arrive: as stated, else its thumbhash's shape. */
internal fun MediaItem.flowImage(): MediaFlow.Image = MediaFlow.Image(
    width = width?.toFloat(),
    height = height?.toFloat(),
    scale = scale?.toFloat(),
    hashedRatio = hashedRatio(thumbhash),
)

/** The width over height a ThumbHash's header carries; null for no hash or one too short. */
internal fun hashedRatio(thumbhash: String?): Float? {
    if (thumbhash.isNullOrEmpty()) return null
    return try {
        val hash = Base64.decode(thumbhash.replace('-', '+').replace('_', '/'), Base64.DEFAULT)
        if (hash.size < 5) null else ThumbHash.approximateAspectRatio(hash).takeIf { it > 0f && it.isFinite() }
    } catch (_: IllegalArgumentException) {
        null
    }
}


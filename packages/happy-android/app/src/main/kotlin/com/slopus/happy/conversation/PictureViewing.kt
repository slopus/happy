package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * One page of the viewer, iOS's `Picture`: a picture or a recording by
 * [key] (also its image cache key), what it reads as, and what is known of
 * it before its bytes come.
 */
@Immutable
data class ViewerItem(
    val key: String,
    val label: String?,
    val isVideo: Boolean = false,
    /** Its pixels as stated, so the page has the picture's shape before it lands. */
    val width: Float? = null,
    val height: Float? = null,
    val thumbhash: String? = null,
)

/**
 * How the viewer holds what it pages through, as iOS's
 * `PicturePagerLayout`, `PictureViewerLayout` and `PictureViewController`
 * do, in dp.
 */
object PictureViewing {
    /** Pages sit this far apart while swiped between, as Photos keeps them. */
    const val PAGE_GAP = 20f
    const val CLOSE_SIZE = 44f
    const val CLOSE_INSET = 8f

    data class Insets(val left: Float = 0f, val top: Float = 0f, val right: Float = 0f, val bottom: Float = 0f)

    /**
     * Where a picture of [natural] size (dp, its pixels one to one, as iOS
     * holds an image's points; null before it is known) rests in a page of
     * [width] × [height]: fitted inside the safe area and centred in it,
     * never enlarged past its own size. Not known yet, it takes the whole
     * safe area.
     */
    fun fitted(width: Float, height: Float, safeArea: Insets, natural: Pair<Float, Float>?): MediaFlow.Frame {
        val areaX = safeArea.left
        val areaY = safeArea.top
        val areaWidth = max(0f, width - safeArea.left - safeArea.right)
        val areaHeight = max(0f, height - safeArea.top - safeArea.bottom)
        val (naturalWidth, naturalHeight) = natural ?: return MediaFlow.Frame(areaX, areaY, areaWidth, areaHeight)
        if (naturalWidth <= 0 || naturalHeight <= 0) return MediaFlow.Frame(areaX, areaY, areaWidth, areaHeight)
        val scale = minOf(1f, areaWidth / naturalWidth, areaHeight / naturalHeight)
        val fittedWidth = rounded(naturalWidth * scale)
        val fittedHeight = rounded(naturalHeight * scale)
        return MediaFlow.Frame(
            rounded(areaX + areaWidth / 2 - fittedWidth / 2),
            rounded(areaY + areaHeight / 2 - fittedHeight / 2),
            fittedWidth,
            fittedHeight,
        )
    }

    /**
     * The size a page lays its picture out at before the bytes come: as
     * stated, else in its thumbhash's shape, so large it fills the safe
     * area; null knows nothing, and it takes the whole area.
     */
    fun restingSize(item: ViewerItem, hashedRatio: Float?, side: Float): Pair<Float, Float>? {
        val width = item.width
        val height = item.height
        if (width != null && height != null && width > 0 && height > 0) return width to height
        val ratio = hashedRatio?.takeIf { it > 0 && it.isFinite() } ?: return null
        val tall = max(side, 1f) * 4
        return tall * ratio to tall
    }

    /** What a finger on a page turns out to be doing. */
    enum class Gesture {
        /** Up or down on a whole picture: it follows the finger, and may go. */
        Dismiss,
        /** Pinching, or moving a zoomed picture inside its page. */
        Transform,
        /** Across a whole picture: the pager turns the page. */
        Page,
    }

    /**
     * Decides a gesture once it is past the touch slop, or at once with a
     * second finger or a pinch; null while undecided. [movedX] and [movedY]
     * are how far the finger has gone. A zoomed picture only moves inside
     * its page (no paging, no dismissal); a whole one is dragged away up or
     * down and paged across. A page that doesn't zoom (a recording) leaves
     * pinches alone.
     */
    fun decide(fingers: Int, zoomChange: Float, movedX: Float, movedY: Float, slop: Float, zoomed: Boolean, zoomable: Boolean = true): Gesture? {
        if (fingers > 1 || zoomChange != 1f) return if (zoomable) Gesture.Transform else null
        if (hypot(movedX, movedY) < slop) return null
        if (zoomed) return Gesture.Transform
        return if (abs(movedY) > abs(movedX)) Gesture.Dismiss else Gesture.Page
    }

    /** The pager turns only on a whole picture that isn't being dragged away. */
    fun pages(zoomed: Boolean, dismissing: Boolean): Boolean = !zoomed && !dismissing

    /**
     * How far a picture of [pictureWidth] × [pictureHeight] at [scale] may be
     * moved from its resting place in a page of [pageWidth] × [pageHeight]
     * (half the overhang each way, (x, y)): only as far as it is larger than
     * the page, so it never leaves an edge of black it could cover.
     */
    fun panLimit(pictureWidth: Float, pictureHeight: Float, scale: Float, pageWidth: Float, pageHeight: Float): Pair<Float, Float> =
        max(0f, (pictureWidth * scale - pageWidth) / 2) to max(0f, (pictureHeight * scale - pageHeight) / 2)

    /** "N of M" as the page's position reads; null for a viewer of one. */
    fun position(index: Int, count: Int): Pair<Int, Int>? = if (count > 1 && index in 0 until count) index + 1 to count else null

    /** A rectangle in px, left and top first. */
    data class Box(val x: Float, val y: Float, val width: Float, val height: Float) {
        val centerX: Float get() = x + width / 2
        val centerY: Float get() = y + height / 2
        fun meets(other: Box): Boolean = width > 0 && height > 0 && x < other.x + other.width && other.x < x + width && y < other.y + other.height && other.y < y + height
    }

    /**
     * The picture on its way between its thumbnail and its place in the
     * viewer (Telegram's PhotoViewer opening from and closing into its
     * `PlaceProviderObject`), at [progress] (0 on the thumbnail, 1 at rest).
     * The picture keeps its resting layout ([frame]) and is scaled about
     * its middle by [scale] and moved by [dx], [dy]; what shows of it is
     * the window between the thumbnail and the frame, in the picture's own
     * px ([clip], rounded by [radius]), so it starts filling the thumbnail
     * as the thumbnail crops it, corners and all.
     */
    data class Flight(val scale: Float, val dx: Float, val dy: Float, val clip: Box, val radius: Float)

    fun flight(origin: Box, frame: Box, originRadius: Float, progress: Float): Flight {
        val t = progress.coerceIn(0f, 1f)
        fun lerp(from: Float, to: Float) = from + (to - from) * t
        // Filling the thumbnail, cropped as it crops: the larger of the two ratios.
        val cover = if (frame.width > 0 && frame.height > 0) max(origin.width / frame.width, origin.height / frame.height) else 1f
        val scale = lerp(cover, 1f)
        val windowWidth = lerp(origin.width, frame.width)
        val windowHeight = lerp(origin.height, frame.height)
        val clipWidth = windowWidth / scale
        val clipHeight = windowHeight / scale
        return Flight(
            scale = scale,
            dx = lerp(origin.centerX, frame.centerX) - frame.centerX,
            dy = lerp(origin.centerY, frame.centerY) - frame.centerY,
            clip = Box((frame.width - clipWidth) / 2, (frame.height - clipHeight) / 2, clipWidth, clipHeight),
            radius = lerp(originRadius, 0f) / scale,
        )
    }

    private fun rounded(value: Float): Float = if (value >= 0) floor(value + 0.5f) else -floor(-value + 0.5f)
}

/**
 * Everything a conversation shows that the viewer pages through, in the
 * conversation's order (iOS's `Picture.all(in:)`): a person's photos (all
 * of them, also the ones past the four their row shows), an agent's inline
 * pictures, and the pictures and recordings tools presented. Files are
 * not among them; they open elsewhere.
 */
object ConversationViewing {
    /** One page: its item and where its bytes come from. */
    data class Entry(val item: ViewerItem, val inline: Block.Image? = null, val presented: MediaRef? = null)

    /** A message's own picture: [index] among its row's. */
    fun pictureKey(rowKey: String, index: Int) = "conversation/$rowKey:$index"

    /** A picture or recording a tool presented. */
    fun presentedKey(ref: MediaRef) = "conversation/media/${ref.key}"

    /** [rows] newest first, as the transcript holds them; the pages oldest first. */
    fun entries(rows: List<ConversationRow>, pictureLabel: String, videoLabel: String): List<Entry> {
        val entries = ArrayList<Entry>()
        for (row in rows.asReversed()) {
            when (row) {
                is ConversationRow.User -> row.pictures.forEachIndexed { index, picture ->
                    entries += Entry(ViewerItem(pictureKey(row.key, index), pictureLabel), inline = picture)
                }
                is ConversationRow.Picture -> entries += Entry(ViewerItem(pictureKey(row.key, 0), pictureLabel), inline = row.image)
                is ConversationRow.Media -> entries += presented(row.items, pictureLabel, videoLabel)
                else -> Unit
            }
        }
        return entries
    }

    private fun presented(items: List<MediaRef>, pictureLabel: String, videoLabel: String): List<Entry> =
        items.filter { it.item.isVisual }.map { ref ->
            val video = ref.item.kind == "video"
            Entry(
                ViewerItem(
                    key = presentedKey(ref),
                    label = ref.item.name.ifEmpty { if (video) videoLabel else pictureLabel },
                    isVideo = video,
                    width = ref.item.width?.toFloat(),
                    height = ref.item.height?.toFloat(),
                    thumbhash = ref.item.thumbhash,
                ),
                presented = ref,
            )
        }
}

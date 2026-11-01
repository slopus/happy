package com.slopus.happy.ui.conversation

import com.slopus.happy.conversation.pictureSize
import android.content.ActivityNotFoundException
import android.content.Intent
import android.media.MediaDataSource
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.components.PageDialog as Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationViewing
import com.slopus.happy.conversation.PictureDismissal
import com.slopus.happy.conversation.PictureViewing
import com.slopus.happy.conversation.ViewerItem
import com.slopus.happy.conversation.MediaFiles
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.rememberThumbHash
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

object PictureViewerTags {
    const val VIEWER = "conversation.picture.viewer"
    const val PAGER = "conversation.picture.viewer.pager"
    /** The picture in view; the pages either side of it have no tag. */
    const val IMAGE = "conversation.picture.viewer.image"
    const val CLOSE = "conversation.picture.viewer.close"
    const val SHARE = "conversation.picture.viewer.share"
    /** The recording in view, and its play button. */
    const val VIDEO = "conversation.picture.viewer.video"
    const val PLAY = "conversation.picture.viewer.play"
}

/** The viewer's motion, iOS's PictureViewController. */
object PictureViewerSpec {
    /** The cross-dissolve it comes and goes with. */
    const val FADE_MS = 250
    /** Let go short of closing, it springs back (UIKit's 0.35 s, damping 0.85). */
    const val SPRING_DAMPING = 0.85f
    const val SPRING_STIFFNESS = 322f
    /** Flung away, it carries on off the screen in 0.15 to 0.3 s. */
    const val LEAVE_MIN_MS = 150
    const val LEAVE_MAX_MS = 300
    const val MAX_ZOOM = 5f
    /** A double tap zooms a whole picture to this. */
    const val DOUBLE_TAP_ZOOM = 2.5f
}

/**
 * Where the viewer's pictures and recordings come from, by
 * [ViewerItem.key] (iOS's `ChatMediaSource`, `ChatMediaPlaying` and
 * `ChatMediaSharing`).
 */
interface ViewerSource {
    /** The bytes already at hand, shown from the first frame. */
    fun cached(key: String): ByteArray? = null

    /** A picture's bytes; null when they can't be had. */
    suspend fun bytes(key: String): ByteArray?

    /** A recording read a range at a time; null when it can't be played here. */
    fun video(key: String): MediaDataSource? = null

    /** Whether the viewer offers Share. */
    val shares: Boolean get() = false

    /** The item as a file under [directory] (which the app's file provider shares), for the share sheet. */
    suspend fun shareable(key: String, directory: File): File? = null
}

/**
 * Pictures and recordings whole on black, swiped between in their order:
 * iOS's `PictureViewController`, which holds a conversation's and an
 * artifact's alike. Pages sit 20 apart while swiped. A picture rests
 * fitted inside the safe area, never enlarged past its own size; pinched
 * to 1–5 times and dragged while larger than its page, double-tapped in
 * and out; it turns no page while zoomed, and is whole again once turned
 * away from. A whole picture or a recording dragged up or down follows the
 * finger, shrinking to 0.8 as the black fades over half the screen
 * ([PictureDismissal]); let go past 100 dp or flung, it carries on off the
 * screen and the viewer goes, otherwise it springs back. A recording plays
 * in its page while it is the one in view ([VideoPage]). It comes and goes
 * with a 250 ms fade; Back, a tap on a picture or the close button (44, 8
 * in from the safe area's top right) leaves. A source that shares adds a
 * Share button at the top left. The position ("2 of 5") is the page's
 * state for TalkBack, as iOS gives it to VoiceOver.
 */
@Composable
fun PictureViewer(items: List<ViewerItem>, index: Int, source: ViewerSource, onClose: () -> Unit) {
    if (items.isEmpty()) return
    val scope = rememberCoroutineScope()
    val shown = remember { Animatable(0f) }
    val leave by rememberUpdatedState(onClose)
    val motion = remember { ViewerMotion(scope) { leave() } }
    // One lambda for the viewer's life: the pages' gestures are keyed on it.
    val close: () -> Unit = remember {
        {
            if (!motion.leaving) {
                motion.leaving = true
                scope.launch {
                    shown.animateTo(0f, tween(PictureViewerSpec.FADE_MS, easing = FastOutSlowInEasing))
                    leave()
                }
            }
        }
    }
    LaunchedEffect(Unit) { shown.animateTo(1f, tween(PictureViewerSpec.FADE_MS, easing = LinearOutSlowInEasing)) }

    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        // Its own black fades; the window's dim would stay behind it. Light status icons over the black.
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect {
            window?.setDimAmount(0f)
            window?.let { WindowCompat.getInsetsController(it, it.decorView).isAppearanceLightStatusBars = false }
        }
        val density = LocalDensity.current
        motion.density = density.density
        val pager = rememberPagerState(initialPage = index.coerceIn(0, items.lastIndex)) { items.size }
        val zooms = remember(items) { List(items.size) { PageZoom() } }
        val pages by remember(items) {
            derivedStateOf { PictureViewing.pages(zooms.getOrNull(pager.currentPage)?.zoomed == true, motion.drag != Offset.Zero || motion.leaving) }
        }

        Box(
            Modifier
                .fillMaxSize()
                .onSizeChanged { motion.height = it.height }
                .drawBehind { drawRect(Color.Black.copy(alpha = shown.value * motion.dismissal().groundAlpha)) }
                .testTag(PictureViewerTags.VIEWER),
        ) {
            HorizontalPager(
                state = pager,
                modifier = Modifier.fillMaxSize().testTag(PictureViewerTags.PAGER),
                pageSpacing = PictureViewing.PAGE_GAP.dp,
                beyondViewportPageCount = 1,
                userScrollEnabled = pages,
                key = { items[it].key },
            ) { page ->
                val item = items[page]
                val current = pager.currentPage == page
                val position = PictureViewing.position(page, items.size)?.let { (number, count) ->
                    stringResource(R.string.message_media_position, number, count)
                }
                Box(
                    Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            // Only the page in view is dragged away.
                            if (current) {
                                val dismissal = motion.dismissal()
                                translationX = motion.drag.x
                                translationY = motion.drag.y
                                scaleX = dismissal.scale
                                scaleY = dismissal.scale
                            }
                            alpha = shown.value
                        }
                        .semantics { if (position != null) stateDescription = position },
                ) {
                    if (item.isVideo) {
                        VideoPage(item, source, active = pager.settledPage == page && !pager.isScrollInProgress, current = current, motion = motion)
                    } else {
                        val zoom = zooms[page]
                        // Turned away from, a page is whole again when it comes back.
                        LaunchedEffect(pager.settledPage == page) { if (pager.settledPage != page) zoom.reset() }
                        PicturePage(item, source, zoom, current, motion, scope, onTap = close)
                    }
                }
            }
            val controls = Modifier.graphicsLayer { alpha = min(shown.value, motion.dismissal().groundAlpha) }
            if (source.shares) ShareButton(source, items[pager.currentPage], controls.align(Alignment.TopStart))
            IconButton(
                onClick = close,
                colors = IconButtonDefaults.iconButtonColors(contentColor = Color.White),
                modifier = controls
                    .align(Alignment.TopEnd)
                    .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                    .padding(PictureViewing.CLOSE_INSET.dp)
                    .size(PictureViewing.CLOSE_SIZE.dp)
                    .testTag(PictureViewerTags.CLOSE),
            ) {
                Icon(MaterialSymbols.Close, stringResource(R.string.conversation_picture_close))
            }
        }
    }
}

/** One picture held in memory, alone in the viewer. */
@Composable
fun PictureViewer(bytes: ByteArray, cacheKey: String, name: String?, onClose: () -> Unit) {
    val source = remember(bytes, cacheKey) {
        object : ViewerSource {
            override fun cached(key: String) = bytes
            override suspend fun bytes(key: String) = bytes
        }
    }
    PictureViewer(listOf(ViewerItem(cacheKey, name)), 0, source, onClose)
}

/**
 * The page in view dragged up or down to put the viewer away, and how far
 * it is: one for the viewer, read while drawing so a drag only redraws.
 */
@Stable
internal class ViewerMotion(private val scope: CoroutineScope, private val onClose: () -> Unit) {
    /** The dismissal drag, in px; animated back or away once let go. */
    var drag by mutableStateOf(Offset.Zero)
    var leaving by mutableStateOf(false)
    var height by mutableIntStateOf(0)
    var density = 1f
    private var settling: Job? = null

    fun dismissal(): PictureDismissal = PictureDismissal.of(drag.y / density, 0f, height / density)

    /** A finger is down again: whatever was settling stops where it is. */
    fun hold() {
        settling?.cancel()
    }

    fun follow(pan: Offset) {
        drag += pan
    }

    /** Let go with [velocityY] px/s: away the way it was going, or back to rest. */
    fun release(velocityY: Float) {
        val outcome = PictureDismissal.of(drag.y / density, velocityY / density, height / density)
        settling = scope.launch {
            if (outcome.closes) {
                // On off the screen the way it was going, as the rest of the black goes.
                leaving = true
                val down = if (velocityY == 0f) drag.y >= 0 else velocityY > 0
                val distance = height.toFloat()
                val remaining = max(1f, distance - abs(drag.y))
                val ms = (remaining / max(abs(velocityY), 1f) * 1000).toInt()
                    .coerceIn(PictureViewerSpec.LEAVE_MIN_MS, PictureViewerSpec.LEAVE_MAX_MS)
                animate(Offset.VectorConverter, drag, Offset(drag.x, if (down) distance else -distance), animationSpec = tween(ms, easing = LinearOutSlowInEasing)) { value, _ ->
                    drag = value
                }
                onClose()
            } else {
                animate(
                    Offset.VectorConverter,
                    drag,
                    Offset.Zero,
                    animationSpec = spring(PictureViewerSpec.SPRING_DAMPING, PictureViewerSpec.SPRING_STIFFNESS),
                ) { value, _ -> drag = value }
            }
        }
    }
}

/** One picture page's zoom: its scale and how far it is moved, with what bounds that. */
@Stable
internal class PageZoom {
    var scale by mutableFloatStateOf(1f)
    var offset by mutableStateOf(Offset.Zero)
    /** The picture at rest and its middle, and its page, in px. */
    var picture = Size.Zero
    var middle = Offset.Zero
    var page = IntSize.Zero

    val zoomed: Boolean get() = scale > 1f

    fun clamp(next: Offset, at: Float): Offset {
        val (maxX, maxY) = PictureViewing.panLimit(picture.width, picture.height, at, page.width.toFloat(), page.height.toFloat())
        return Offset(next.x.coerceIn(-maxX, maxX), next.y.coerceIn(-maxY, maxY))
    }

    fun reset() {
        scale = 1f
        offset = Offset.Zero
    }

    /** Double-tapped at [point]: in to 2.5 with that point kept under the finger, or out to whole. */
    suspend fun toggle(point: Offset) {
        val from = scale
        val to = if (from > 1f) 1f else PictureViewerSpec.DOUBLE_TAP_ZOOM
        val start = offset
        val end = if (to == 1f) Offset.Zero else clamp((middle - point) * (to - 1), to)
        animate(0f, 1f, animationSpec = tween(PictureViewerSpec.FADE_MS)) { t, _ ->
            scale = from + (to - from) * t
            offset = start + (end - start) * t
        }
    }
}

/**
 * A page's fingers, read on the page (not the moving picture) so they are
 * where they are on the screen: a tap ([onTap]), a double tap and pinches
 * for a page that [zoom]s, and the drag that puts the viewer away. A
 * sideways drag on a whole picture is left to the pager, untouched.
 */
internal fun Modifier.viewerGestures(motion: ViewerMotion, zoom: PageZoom?, scope: CoroutineScope, onTap: (() -> Unit)?): Modifier = this
    .then(
        if (zoom == null && onTap == null) Modifier
        else Modifier.pointerInput(zoom, onTap) {
            detectTapGestures(
                onTap = onTap?.let { tap -> { _: Offset -> tap() } },
                onDoubleTap = zoom?.let { page -> { point: Offset -> scope.launch { page.toggle(point) } } },
            )
        },
    )
    .pointerInput(zoom) {
        awaitEachGesture {
            val first = awaitFirstDown(requireUnconsumed = false)
            motion.hold()
            val tracker = VelocityTracker()
            tracker.addPosition(first.uptimeMillis, first.position)
            var moved = Offset.Zero
            var gesture: PictureViewing.Gesture? = null
            while (true) {
                val event = awaitPointerEvent()
                // Something under the finger (a scrubber, a button) has it.
                if (event.changes.any { it.isConsumed }) break
                val fingers = event.changes.count { it.pressed }
                if (fingers == 0) break
                val zoomChange = event.calculateZoom()
                val pan = event.calculatePan()
                event.changes.firstOrNull { it.id == first.id }?.let { tracker.addPosition(it.uptimeMillis, it.position) }
                if (gesture == null) {
                    if (motion.leaving) break
                    moved += pan
                    gesture = PictureViewing.decide(fingers, zoomChange, moved.x, moved.y, viewConfiguration.touchSlop, zoom?.zoomed == true, zoom != null)
                    // Across a whole picture: the pager's, untouched.
                    if (gesture == PictureViewing.Gesture.Page) break
                }
                when (gesture) {
                    PictureViewing.Gesture.Dismiss -> motion.follow(pan)
                    PictureViewing.Gesture.Transform -> zoom?.let { page ->
                        page.scale = (page.scale * zoomChange).coerceIn(1f, PictureViewerSpec.MAX_ZOOM)
                        page.offset = if (page.scale > 1f) page.clamp(page.offset + pan, page.scale) else Offset.Zero
                    }
                    else -> Unit
                }
                if (gesture != null) event.changes.forEach { if (it.positionChanged()) it.consume() }
            }
            if (gesture == PictureViewing.Gesture.Dismiss) motion.release(tracker.calculateVelocity().y)
        }
    }

/**
 * One picture's page: the bytes at hand, else its thumbhash in the
 * picture's stated shape, else a spinner, until they come; then the
 * picture, laid out at its own size ([PictureViewing.fitted]).
 */
@Composable
private fun PicturePage(item: ViewerItem, source: ViewerSource, zoom: PageZoom, current: Boolean, motion: ViewerMotion, scope: CoroutineScope, onTap: () -> Unit) {
    // Decoded once per page, not on every recomposition.
    val initial = remember(item.key) { source.cached(item.key) }
    val bytes by produceState(initial, item.key) {
        if (value == null) {
            value = try {
                source.bytes(item.key)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
        }
    }
    val placeholder = rememberThumbHash(item.thumbhash)
    val read = remember(bytes) { bytes?.let(::pictureSize)?.let { image -> image.width?.let { w -> image.height?.let { h -> w to h } } } }
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val insets = WindowInsets.safeDrawing
    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .onSizeChanged { zoom.page = it }
            .viewerGestures(motion, zoom, scope, onTap),
    ) {
        val safe = with(density) {
            PictureViewing.Insets(
                left = insets.getLeft(this, direction).toDp().value,
                top = insets.getTop(this).toDp().value,
                right = insets.getRight(this, direction).toDp().value,
                bottom = insets.getBottom(this).toDp().value,
            )
        }
        val natural = read ?: PictureViewing.restingSize(item, hashedRatio(item.thumbhash), max(maxWidth.value, maxHeight.value))
        val frame = PictureViewing.fitted(maxWidth.value, maxHeight.value, safe, natural)
        SideEffect {
            zoom.picture = Size(frame.width * density.density, frame.height * density.density)
            zoom.middle = Offset((frame.x + frame.width / 2) * density.density, (frame.y + frame.height / 2) * density.density)
        }
        Box(
            Modifier
                .offset(frame.x.dp, frame.y.dp)
                .size(frame.width.dp, frame.height.dp)
                .graphicsLayer {
                    scaleX = zoom.scale
                    scaleY = zoom.scale
                    translationX = zoom.offset.x
                    translationY = zoom.offset.y
                }
                // Inside the layer: its bounds are where the picture is drawn.
                .then(if (current) Modifier.testTag(PictureViewerTags.IMAGE) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            val shown = bytes
            when {
                shown != null -> RemoteImage(
                    model = shown,
                    cacheKey = item.key,
                    contentDescription = item.label,
                    contentScale = ContentScale.Fit,
                    placeholder = placeholder,
                    modifier = Modifier.fillMaxSize(),
                )
                placeholder != null -> Image(placeholder, item.label, Modifier.fillMaxSize(), contentScale = ContentScale.FillBounds)
                else -> CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
            }
        }
    }
}

/** Share, top left: the item in view as a file in the share sheet; a spinner while its bytes come. */
@Composable
private fun ShareButton(source: ViewerSource, item: ViewerItem, modifier: Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var sharing by remember { mutableStateOf(false) }
    IconButton(
        onClick = {
            if (sharing) return@IconButton
            sharing = true
            scope.launch {
                try {
                    val file = source.shareable(item.key, File(context.cacheDir, MediaFiles.DIRECTORY)) ?: return@launch
                    val uri = FileProvider.getUriForFile(context, "${context.packageName}.conversation.media", file)
                    val type = context.contentResolver.getType(uri) ?: if (item.isVideo) "video/*" else "image/*"
                    val send = Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (_: ActivityNotFoundException) {
                } catch (_: IllegalArgumentException) {
                } finally {
                    sharing = false
                }
            }
        },
        colors = IconButtonDefaults.iconButtonColors(contentColor = Color.White),
        modifier = modifier
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .padding(PictureViewing.CLOSE_INSET.dp)
            .size(PictureViewing.CLOSE_SIZE.dp)
            .testTag(PictureViewerTags.SHARE),
    ) {
        if (sharing) CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
        else Icon(MaterialSymbols.Share, stringResource(R.string.artifact_share))
    }
}

/** What a conversation's viewer shows, if anything: every page, and the one it opened on. */
@Composable
internal fun rememberPictureViewer(): PictureViewerState = remember { PictureViewerState() }

class PictureViewerState {
    internal class Showing(val entries: List<ConversationViewing.Entry>, val index: Int)

    internal var showing by mutableStateOf<Showing?>(null)

    /** Opens on [key] among [entries]; a key not among them opens nothing. */
    internal fun show(entries: List<ConversationViewing.Entry>, key: String) {
        val index = entries.indexOfFirst { it.item.key == key }
        if (index >= 0) showing = Showing(entries, index)
    }

    fun close() {
        showing = null
    }
}

/** Draws the conversation's pictures and recordings the viewer was opened on, over everything. */
@Composable
internal fun PictureViewerHost(state: PictureViewerState, store: ConversationMediaStore) {
    val showing = state.showing ?: return
    val source = remember(showing, store) { ConversationViewerSource(showing.entries, store) }
    PictureViewer(remember(showing) { showing.entries.map { it.item } }, showing.index, source, state::close)
}

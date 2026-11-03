package com.slopus.happy.ui.attachments

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.round
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.ui.components.rememberReduceMotion
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/**
 * A composer's pictures coming and going (iOS `AttachmentStripView`, after
 * Telegram's input panel): one that comes grows from [SCALE] in the middle
 * of its place as it fades in, one that goes shrinks to [SCALE] and fades
 * where it was, and the rest slide to their new places, over [DURATION_MS]
 * on Display's `.spring` curve ([EASING]). Pictures already there when the
 * composer is made (a draft restored, a rotation) arrive as they are.
 * Reduce Motion keeps the fades.
 */
object PictureStripMotion {
    const val DURATION_MS = 400
    const val SCALE = 0.2f
    val EASING = CubicBezierEasing(0.38f, 0.7f, 0.125f, 1f)

    fun <T> spec() = tween<T>(DURATION_MS, easing = EASING)
}

/** The pictures a composer has drawn, where, and those on their way out. */
@Stable
class PictureStripState internal constructor(initial: List<AttachmentPreview>) {
    private val seen = initial.mapTo(mutableSetOf()) { it.id }
    private var held = initial.toList()
    internal var frame: LayoutCoordinates? = null
    private val placed = mutableMapOf<String, LayoutCoordinates>()

    /** A picture taken out, drawn over the row where it last was until it has shrunk away. */
    internal class Leaving(val picture: AttachmentPreview, val at: IntOffset, reduceMotion: Boolean) {
        val fade = Animatable(1f)
        val scale = Animatable(1f)
        val shrinks = !reduceMotion
    }

    internal val leaving = mutableStateListOf<Leaving>()

    /** True the first time [id] is drawn, unless it was there from the start. */
    internal fun arrives(id: String): Boolean = seen.add(id)

    internal fun place(id: String, at: LayoutCoordinates) {
        placed[id] = at
    }

    /**
     * Called as the composer composes, before the frame reads [leaving], so
     * a picture taken out is drawn in the very frame the row lets it go.
     * [now] may be the picker's own list, changed in place: what was held is a copy.
     */
    internal fun hold(now: List<AttachmentPreview>, reduceMotion: Boolean) {
        if (now == held) return
        val ids = now.mapTo(mutableSetOf()) { it.id }
        val gone = held.filter { it.id !in ids }
        held = now.toList()
        leaving.removeAll { it.picture.id in ids }
        val box = frame?.takeIf { it.isAttached }
        for (picture in gone) {
            val item = placed.remove(picture.id)?.takeIf { it.isAttached } ?: continue
            if (box == null) continue
            leaving += Leaving(picture, box.localPositionOf(item, Offset.Zero).round(), reduceMotion)
        }
    }
}

/** Kept for the composer's life, so a strip that hides and shows again (compact, the + menu) grows nothing. */
@Composable
fun rememberPictureStrip(images: List<AttachmentPreview>): PictureStripState {
    val strip = remember { PictureStripState(images) }
    strip.hold(images, rememberReduceMotion())
    return strip
}

/**
 * The strip's row ([content]) with the pictures on their way out drawn
 * under it by [thumb], untouchable and unread, the rest sliding over them
 * as on iOS. A lazy row keeps an item it is taking out but never draws it
 * again, so they go here instead.
 */
@Composable
fun PictureStripFrame(strip: PictureStripState, modifier: Modifier = Modifier, thumb: @Composable (AttachmentPreview) -> Unit, content: @Composable () -> Unit) {
    Box(modifier.onPlaced { strip.frame = it }) {
        for (going in strip.leaving) key(going) {
            LaunchedEffect(Unit) {
                coroutineScope {
                    launch { going.fade.animateTo(0f, PictureStripMotion.spec()) }
                    if (going.shrinks) going.scale.animateTo(PictureStripMotion.SCALE, PictureStripMotion.spec())
                }
                strip.leaving.remove(going)
            }
            Box(
                Modifier
                    .graphicsLayer {
                        translationX = going.at.x.toFloat()
                        translationY = going.at.y.toFloat()
                        alpha = going.fade.value
                        scaleX = going.scale.value
                        scaleY = going.scale.value
                    }
                    .pointerInput(Unit) {
                        awaitPointerEventScope {
                            while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                        }
                    }
                    .clearAndSetSemantics {},
            ) { thumb(going.picture) }
        }
        content()
    }
}

/** The motion for the picture [id] in a lazy row of [strip]'s pictures. */
@Composable
fun LazyItemScope.pictureMotion(id: String, strip: PictureStripState): Modifier {
    val reduceMotion = rememberReduceMotion()
    val arrives = remember { strip.arrives(id) }
    val fade = remember { Animatable(if (arrives) 0f else 1f) }
    val scale = remember { Animatable(if (arrives && !reduceMotion) PictureStripMotion.SCALE else 1f) }
    LaunchedEffect(Unit) {
        launch { fade.animateTo(1f, PictureStripMotion.spec()) }
        scale.animateTo(1f, PictureStripMotion.spec())
    }
    return Modifier
        .animateItem(fadeInSpec = null, placementSpec = if (reduceMotion) null else PictureStripMotion.spec(), fadeOutSpec = null)
        .onPlaced { strip.place(id, it) }
        .graphicsLayer {
            alpha = fade.value
            scaleX = scale.value
            scaleY = scale.value
        }
}

/**
 * The strip shown while [visible], and on while its last picture shrinks
 * out: its room closes over the same time, the picture drawn as it goes.
 * [immediate] hides it at once (the composer gone compact).
 */
@Composable
fun PictureStripVisibility(visible: Boolean, immediate: Boolean = false, content: @Composable () -> Unit) {
    AnimatedVisibility(
        visible = visible,
        enter = EnterTransition.None,
        exit = if (immediate) ExitTransition.None else shrinkVertically(PictureStripMotion.spec(), Alignment.Top, clip = false),
    ) { content() }
}

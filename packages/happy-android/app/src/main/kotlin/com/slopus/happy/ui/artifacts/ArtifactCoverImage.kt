package com.slopus.happy.ui.artifacts

import android.graphics.drawable.Animatable
import android.os.Build
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.lifecycle.compose.LifecycleResumeEffect
import coil3.DrawableImage
import coil3.gif.AnimatedImageDecoder
import com.slopus.happy.artifacts.ArtifactSummary
import com.slopus.happy.feed.FeedCover
import com.slopus.happy.feed.FeedCovers
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.components.rememberThumbHash

/**
 * A picture of an artifact read once through [covers] (the Feed's, which
 * keeps it with the connection's media): [key] names it there, [read]
 * fetches it. The image loader decodes it at the size it is drawn, over its
 * [thumbhash] (or whatever is behind it) until it lands, then fades in.
 *
 * [moves] lets an animated cover play (spec "Animated covers"): animated
 * WebP or GIF through Android's AnimatedImageDrawable on API 28 and later,
 * paused whenever the app is not in front and gone once the post leaves the
 * screen. Without it, with animations removed, or on older Android, the
 * first frame is shown. [use] keeps each size apart in the loader's
 * memory, so a list's thumbnail never stands in for a post's picture.
 */
@Composable
internal fun ArtifactPicture(
    key: String,
    thumbhash: String?,
    covers: FeedCovers?,
    scale: ContentScale,
    use: String,
    moves: Boolean = false,
    modifier: Modifier = Modifier,
    read: suspend (FeedCovers) -> ByteArray?,
) {
    val still = rememberReduceMotion()
    val animate = moves && !still && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
    val placeholder = rememberThumbHash(thumbhash)
    key(key) {
        val bytes by produceState(covers?.kept(key), covers) {
            if (value == null) value = covers?.let { read(it) }
        }
        var playing by remember { mutableStateOf<Animatable?>(null) }
        LifecycleResumeEffect(playing) {
            playing?.start()
            onPauseOrDispose { playing?.stop() }
        }
        RemoteImage(
            bytes,
            contentDescription = null,
            modifier = modifier.fillMaxSize(),
            contentScale = scale,
            // A moving decode is kept apart from a still one, so turning animations off shows a still at once.
            cacheKey = if (animate) "$key#$use#moving" else "$key#$use",
            placeholder = placeholder,
            decoder = if (animate) Animated else null,
            onImage = { image -> playing = (image as? DrawableImage)?.drawable as? Animatable },
        )
    }
}

/** A post's cover: the whole file, moving where it is animated. */
@Composable
internal fun ArtifactCoverImage(cover: FeedCover, covers: FeedCovers?, scale: ContentScale, use: String, moves: Boolean = false) =
    ArtifactPicture(cover.key, cover.thumbhash, covers, scale, use, moves) { it.read(cover) }

/** One decoder for every animated cover, so a request's key stays the same between frames. */
private val Animated = AnimatedImageDecoder.Factory()

/** [this] artifact's cover as the lists and the Feed draw it; null without one this phone can draw. */
internal val ArtifactSummary.drawnCover: FeedCover?
    get() = cover?.takeIf { it.drawable }?.let { FeedCover(id, latestVersion, it.path, it.mimeType, it.aspect, background, it.thumbhash) }

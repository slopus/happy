package com.slopus.happy.ui.artifacts

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import com.slopus.happy.artifacts.ArtifactSummary
import com.slopus.happy.feed.FeedCover
import com.slopus.happy.feed.FeedCovers
import com.slopus.happy.ui.components.RemoteImage

/**
 * An artifact's cover, read once through [covers] (the Feed's, which keeps
 * it with the connection's media) and decoded by the image loader at the
 * size it is drawn. It fades in over whatever is behind it, which keeps
 * its place meanwhile. [use] keeps each size apart in the loader's memory,
 * so a list's thumbnail never stands in for a post's picture.
 */
@Composable
internal fun ArtifactCoverImage(cover: FeedCover, covers: FeedCovers?, scale: ContentScale, use: String, modifier: Modifier = Modifier) {
    key(cover.key) {
        val bytes by produceState(covers?.kept(cover), covers) {
            if (value == null) value = covers?.read(cover)
        }
        bytes?.let { RemoteImage(it, contentDescription = null, modifier = modifier.fillMaxSize(), contentScale = scale, cacheKey = "${cover.key}#$use") }
    }
}

/** [this] artifact's cover as the lists and the Feed draw it; null without one this phone can draw. */
internal val ArtifactSummary.drawnCover: FeedCover?
    get() = cover?.takeIf { it.drawable }?.let { FeedCover(id, latestVersion, it.path, it.mimeType, it.aspect, background) }

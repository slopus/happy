package com.slopus.happy.ui.artifacts

import android.media.MediaDataSource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.slopus.happy.artifacts.ArtifactMedia
import com.slopus.happy.artifacts.ArtifactMediaItem
import com.slopus.happy.conversation.ViewerItem
import com.slopus.happy.ui.conversation.PictureViewer
import com.slopus.happy.ui.conversation.PictureViewerTags
import com.slopus.happy.ui.conversation.ViewerSource
import java.io.File
import kotlinx.coroutines.launch

object ArtifactViewerTags {
    const val VIEWER = PictureViewerTags.VIEWER
    const val CLOSE = PictureViewerTags.CLOSE
    const val SHARE = PictureViewerTags.SHARE
    const val VIDEO = PictureViewerTags.VIDEO
    const val PLAY = PictureViewerTags.PLAY
}

/**
 * The artifact's pictures and recordings in the conversation's viewer
 * ([PictureViewer]), as iOS shows them in its `PictureViewController` over
 * `ArtifactMedia`: swiped between in their order, a recording playing in
 * its page read a range at a time, and Share top left: the item as a file
 * named as the artifact names it, so the share sheet can save it.
 */
@Composable
fun ArtifactViewer(items: List<ArtifactMediaItem>, index: Int, media: ArtifactMedia, onClose: () -> Unit) {
    val pages = remember(items, media) {
        items.map { item ->
            val size = media.sizes[item.key]
            ViewerItem(item.key, item.label, item.isVideo, size?.width?.toFloat(), size?.height?.toFloat())
        }
    }
    val scope = rememberCoroutineScope()
    val source = remember(media) {
        object : ViewerSource {
            override fun cached(key: String): ByteArray? = media.cached(key)
            override suspend fun bytes(key: String): ByteArray? = media.data(key)
            // Kept, a recording that plays reads on to the end behind the player.
            override fun video(key: String): MediaDataSource? = media.videoSource(key)?.also { scope.launch { media.play(key) } }
            override val shares: Boolean get() = true
            override suspend fun shareable(key: String, directory: File): File? = media.shareable(key, directory)
        }
    }
    PictureViewer(pages, index, source, onClose)
}

package com.slopus.happy.ui.conversation

import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.view.Surface
import android.view.TextureView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.slopus.happy.R
import com.slopus.happy.artifacts.formatDuration
import com.slopus.happy.conversation.ViewerItem
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay

/** The play button's circle and glyph, over a recording's tile and in its page. */
internal val PlayFill = Color(0x8C000000)
internal val PlayGlyph = Color.White

/**
 * A recording in its page: the platform's player reading it a range at a
 * time ([ViewerSource.video]), started while the page is the one settled in
 * view ([active]) and paused when it isn't, with play/pause (48, on the
 * play fill), a scrubber and the time under it, above the navigation bar.
 * Dragged up or down it puts the viewer away as a picture does; it doesn't
 * zoom. One that can't be read says so.
 */
@Composable
internal fun VideoPage(item: ViewerItem, source: ViewerSource, active: Boolean, current: Boolean, motion: ViewerMotion) {
    val scope = rememberCoroutineScope()
    val video = remember(item.key) { source.video(item.key) }
    val player = remember(item.key) { MediaPlayer() }
    var prepared by remember { mutableStateOf(false) }
    var playing by remember { mutableStateOf(false) }
    var position by remember { mutableIntStateOf(0) }
    var duration by remember { mutableIntStateOf(0) }
    var ratio by remember { mutableFloatStateOf((item.width ?: 16f) / (item.height ?: 9f)) }
    var failed by remember { mutableStateOf(video == null) }
    DisposableEffect(player) {
        try {
            if (video != null) {
                player.setDataSource(video)
                player.setOnPreparedListener {
                    prepared = true
                    duration = it.duration.coerceAtLeast(0)
                }
                player.setOnVideoSizeChangedListener { _, w, h -> if (w > 0 && h > 0) ratio = w.toFloat() / h }
                player.setOnCompletionListener { playing = false }
                player.setOnErrorListener { _, _, _ ->
                    failed = true
                    playing = false
                    true
                }
                player.prepareAsync()
            }
        } catch (_: Exception) {
            failed = true
        }
        onDispose {
            runCatching { player.release() }
            video?.close()
        }
    }
    val started = com.slopus.happy.ui.components.pageStarted()
    LaunchedEffect(prepared, active, started) {
        if (!prepared) return@LaunchedEffect
        if (active && started) {
            player.start()
            playing = true
        } else if (player.isPlaying) {
            player.pause()
            playing = false
        }
    }
    com.slopus.happy.ui.components.StartedEffect(playing) {
        while (playing) {
            position = runCatching { player.currentPosition }.getOrDefault(position)
            delay(250)
        }
    }
    Box(
        Modifier
            .fillMaxSize()
            .viewerGestures(motion, zoom = null, scope = scope, onTap = null)
            .then(if (current) Modifier.testTag(PictureViewerTags.VIDEO) else Modifier)
            .semantics { item.label?.let { contentDescription = it } },
        contentAlignment = Alignment.Center,
    ) {
        AndroidView(
            factory = { context ->
                TextureView(context).apply {
                    surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                        private var surface: Surface? = null
                        override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
                            surface = Surface(texture).also { runCatching { player.setSurface(it) } }
                        }

                        override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = Unit

                        override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
                            runCatching { player.setSurface(null) }
                            surface?.release()
                            surface = null
                            return true
                        }

                        override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
                    }
                }
            },
            modifier = Modifier.fillMaxWidth().aspectRatio(ratio.takeIf { it > 0 && it.isFinite() } ?: (16f / 9f)),
        )
        if (!prepared && !failed) CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
        if (failed) Text(stringResource(R.string.artifact_file_unavailable), color = Color.White, style = happyTextStyle(fontSize = 15, lineHeight = 20))
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            IconButton(
                onClick = {
                    if (!prepared) return@IconButton
                    if (player.isPlaying) {
                        player.pause()
                        playing = false
                    } else {
                        player.start()
                        playing = true
                    }
                },
                modifier = Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(PlayFill)
                    .then(if (current) Modifier.testTag(PictureViewerTags.PLAY) else Modifier),
                colors = IconButtonDefaults.iconButtonColors(contentColor = PlayGlyph),
            ) {
                Icon(
                    if (playing) MaterialSymbols.Pause else MaterialSymbols.PlayArrow,
                    stringResource(if (playing) R.string.artifact_pause else R.string.artifact_play),
                )
            }
            Slider(
                value = if (duration > 0) position.toFloat() / duration else 0f,
                onValueChange = { fraction ->
                    if (prepared && duration > 0) {
                        position = (fraction * duration).toInt()
                        player.seekTo(position)
                    }
                },
                enabled = prepared && duration > 0,
                colors = SliderDefaults.colors(thumbColor = Color.White, activeTrackColor = Color.White, inactiveTrackColor = Color.White.copy(alpha = 0.3f)),
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(formatDuration(position / 1000.0), color = Color.White, style = happyTextStyle(fontSize = 12, lineHeight = 16))
                Text(formatDuration(duration / 1000.0), color = Color.White, style = happyTextStyle(fontSize = 12, lineHeight = 16))
            }
        }
    }
}

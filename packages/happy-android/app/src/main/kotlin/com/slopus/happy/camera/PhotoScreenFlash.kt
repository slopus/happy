package com.slopus.happy.camera

import android.view.Window
import androidx.camera.core.ImageCapture
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** CameraViewController.lightScreen: rendered white,100ms, capture, hold500ms, fade250ms. */
internal class PhotoScreenFlash(private val window: Window?, private val scope: CoroutineScope) : ImageCapture.ScreenFlash {
    private val fade = Animatable(1f)
    private var shown by mutableStateOf(false)
    val alpha: Float get() = if (shown) fade.value else 0f
    private var original: Float? = null
    private var pending: ImageCapture.ScreenFlashListener? = null
    private var work: Job? = null

    override fun apply(expirationTimeMillis: Long, screenFlashListener: ImageCapture.ScreenFlashListener) {
        reset()
        pending = screenFlashListener
        original = window?.attributes?.screenBrightness
        window?.let { it.attributes = it.attributes.apply { screenBrightness = 1f } }
        shown = true
        work = scope.launch {
            fade.snapTo(1f)
            withFrameNanos { }
            delay(100L.coerceAtMost((expirationTimeMillis - System.currentTimeMillis()).coerceAtLeast(0)))
            complete()
        }
    }

    override fun clear() {
        complete()
        work?.cancel()
        work = scope.launch {
            delay(500)
            fade.animateTo(0f, tween(250))
            restore()
        }
    }

    /** Pause, close and disposal can happen before CameraX has called clear. */
    fun reset() {
        work?.cancel()
        work = null
        complete()
        restore()
    }

    private fun complete() {
        val listener = pending
        pending = null
        listener?.onCompleted()
    }

    private fun restore() {
        shown = false
        original?.let { brightness -> window?.let { it.attributes = it.attributes.apply { screenBrightness = brightness } } }
        original = null
    }
}
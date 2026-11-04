package com.slopus.happy.camera

import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Range
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceRequest
import androidx.camera.core.UseCase
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.Observer
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation

enum class CameraFailure { NoCamera, Unavailable }

/**
 * The camera's common provider, preview, lifecycle and display rotation (180° included).
 * QR owns its analyzer; photos own their capture output and physical capture rotation.
 * Only this binding's use cases are unbound. Keeping this composed while the attach tile
 * grows preserves the same session, as Telegram's ChatAttachAlertPhotoLayout:2447–2521.
 */
@OptIn(ExperimentalCamera2Interop::class)
@Composable
internal fun CameraBinding(
    useCases: List<UseCase>,
    onSurface: (SurfaceRequest?) -> Unit,
    onCamera: (Camera?) -> Unit,
    onFailure: (CameraFailure) -> Unit,
    front: Boolean = false,
    onDisplayRotation: (Int) -> Unit = {},
    frameRate: Range<Int>? = null,
    onState: (CameraState?) -> Unit = {},
    onFirstFrame: () -> Unit = {},
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val surface by rememberUpdatedState(onSurface)
    val cameraChanged by rememberUpdatedState(onCamera)
    val failed by rememberUpdatedState(onFailure)
    val stateChanged by rememberUpdatedState(onState)
    val firstFrame by rememberUpdatedState(onFirstFrame)
    val rotated by rememberUpdatedState(onDisplayRotation)
    LaunchedEffect(owner, useCases, front, frameRate) {
        val provider = try {
            ProcessCameraProvider.awaitInstance(context)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Camera unavailable", e)
            failed(CameraFailure.Unavailable)
            return@LaunchedEffect
        }
        val choices = if (front) {
            listOf(CameraSelector.DEFAULT_FRONT_CAMERA, CameraSelector.DEFAULT_BACK_CAMERA)
        } else {
            listOf(CameraSelector.DEFAULT_BACK_CAMERA, CameraSelector.DEFAULT_FRONT_CAMERA)
        }
        val selector = choices.firstOrNull { runCatching { provider.hasCamera(it) }.getOrDefault(false) }
        if (selector == null) {
            failed(CameraFailure.NoCamera)
            return@LaunchedEffect
        }
        val main = ContextCompat.getMainExecutor(context)
        val display = { ContextCompat.getDisplayOrDefault(context) }
        val seenFrame = AtomicBoolean()
        val released = AtomicBoolean()
        rotated(display().rotation)
        val builder = Preview.Builder().setTargetRotation(display().rotation)
        frameRate?.let(builder::setTargetFrameRate)
        Camera2Interop.Extender(builder).setSessionCaptureCallback(object : CameraCaptureSession.CaptureCallback() {
            override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
                // A sensor frame, not a claim about when a compositor displayed its picture.
                if (seenFrame.compareAndSet(false, true)) main.execute { if (!released.get()) firstFrame() }
            }
        })
        val preview = builder.build().apply { setSurfaceProvider { surface(it) } }
        val displays = context.getSystemService(DisplayManager::class.java)
        val turned = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) = Unit
            override fun onDisplayRemoved(displayId: Int) = Unit
            override fun onDisplayChanged(displayId: Int) {
                val rotation = display().rotation
                preview.targetRotation = rotation
                rotated(rotation)
            }
        }
        displays?.registerDisplayListener(turned, Handler(Looper.getMainLooper()))
        var bound: Camera? = null
        val observer = Observer<CameraState> { stateChanged(it) }
        try {
            try {
                val camera = provider.bindToLifecycle(owner, selector, preview, *useCases.toTypedArray())
                bound = camera
                camera.cameraInfo.cameraState.observe(owner, observer)
                cameraChanged(camera)
                Log.d(TAG, "bound ${useCases.map { it.javaClass.simpleName }}")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Camera failed to start", e)
                failed(CameraFailure.Unavailable)
                return@LaunchedEffect
            }
            awaitCancellation()
        } finally {
            released.set(true)
            displays?.unregisterDisplayListener(turned)
            bound?.cameraInfo?.cameraState?.removeObserver(observer)
            cameraChanged(null)
            stateChanged(null)
            surface(null)
            provider.unbind(preview, *useCases.toTypedArray())
            Log.d(TAG, "unbound ${useCases.map { it.javaClass.simpleName }}")
        }
    }
}

private const val TAG = "HappyCamera"

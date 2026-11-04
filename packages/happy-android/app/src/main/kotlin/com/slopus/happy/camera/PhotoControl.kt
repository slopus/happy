package com.slopus.happy.camera

import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureRequest
import android.util.Range
import android.util.Size
import android.util.Log
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.SurfaceOrientedMeteringPointFactory
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import java.util.concurrent.Executor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.abs

internal data class PhotoFocus(val point: Offset, val afLocked: Boolean, val aeLocked: Boolean, val generation: Int)

/** Photo's controls own CameraControl requests; QR keeps its independent focus/zoom policy. */
@Stable
@androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
internal class PhotoControl(private val main: Executor, private val scope: CoroutineScope? = null) {
    var front by mutableStateOf(false)
    var actualFront by mutableStateOf(false)
        private set
    var canFlip by mutableStateOf(false)
    var hasFlash by mutableStateOf(false)
        private set
    var zoomBounds by mutableStateOf(PhotoZoom())
        private set
    var zoom by mutableStateOf(1f)
        private set
    var focus by mutableStateOf<PhotoFocus?>(null)
        private set
    var exposure by mutableStateOf(0f)
        private set
    var exposureSupported by mutableStateOf(false)
        private set
    var dark by mutableStateOf<Boolean?>(null)
    var timer by mutableStateOf(0)
    var countdown by mutableStateOf<Int?>(null)
    private var camera: Camera? = null
    private var aeLockAvailable = false
    private var ranges: List<Range<Int>> = emptyList()
    private var generation = 0
    private var ramp: Job? = null

    fun bind(value: Camera?) {
        ramp?.cancel()
        generation++
        camera = value
        focus = null
        exposure = 0f
        dark = null
        if (value == null) { hasFlash = false; exposureSupported = false; return }
        val info = value.cameraInfo
        actualFront = info.lensFacing == CameraSelector.LENS_FACING_FRONT
        hasFlash = info.hasFlashUnit()
        info.zoomState.value?.let { updateZoom(it.minZoomRatio, it.maxZoomRatio, it.zoomRatio) }
        exposureSupported = info.exposureState.isExposureCompensationSupported
        val camera2 = Camera2CameraInfo.from(info)
        aeLockAvailable = camera2.getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE) == true
        ranges = camera2.getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.toList().orEmpty()
        if (aeLockAvailable) Camera2CameraControl.from(value.cameraControl).addCaptureRequestOptions(CaptureRequestOptions.Builder()
            .setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, false).build())
        expose(0f)
        Log.d("HappyCamera", "controls front=$actualFront flash=$hasFlash zoom=$zoomBounds exposure=$exposureSupported aeLock=$aeLockAvailable fps=$ranges")
    }

    fun updateZoom(min: Float, max: Float, current: Float) {
        zoomBounds = PhotoZoom(min, max)
        zoom = current
    }

    fun zoomTo(ratio: Float, animated: Boolean = false) {
        ramp?.cancel()
        if (animated && scope != null) {
            val target = zoomBounds.clamp(ratio)
            ramp = scope.launch {
                Animatable(zoom).animateTo(target, tween((abs(target - zoom) / 16 * 1000).toInt().coerceAtLeast(1))) { applyZoom(value) }
            }
        } else applyZoom(ratio)
    }

    private fun applyZoom(ratio: Float) {
        val camera = camera ?: return
        zoom = zoomBounds.clamp(ratio)
        camera.cameraControl.setZoomRatio(zoom)
    }

    /** The caller maps with CameraXViewfinder's transformer: no guessed rotation or mirroring. */
    fun focusAt(viewPoint: Offset, surfacePoint: Offset, resolution: Size, lock: Boolean): Boolean {
        val camera = camera ?: return false
        val factory = SurfaceOrientedMeteringPointFactory(resolution.width.toFloat(), resolution.height.toFloat())
        val point = factory.createPoint(surfacePoint.x, surfacePoint.y)
        val af = camera.cameraInfo.isFocusMeteringSupported(FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF).build())
        val ae = camera.cameraInfo.isFocusMeteringSupported(FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AE).build())
        val flags = (if (af) FocusMeteringAction.FLAG_AF else 0) or (if (ae) FocusMeteringAction.FLAG_AE else 0)
        if (flags == 0) return false
        val action = FocusMeteringAction.Builder(point, flags).apply { if (lock) disableAutoCancel() }.build()
        val holdAE = lock && aeLockAvailable
        expose(0f)
        if (aeLockAvailable) Camera2CameraControl.from(camera.cameraControl).addCaptureRequestOptions(CaptureRequestOptions.Builder()
            .setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, false).build())
        val completion = camera.cameraControl.startFocusAndMetering(action)
        val token = ++generation
        focus = PhotoFocus(viewPoint, lock && af, false, token)
        completion.addListener({
            // Don't let an old focus completion relock a new tap or a replacement camera.
            val result = runCatching { completion.get() }
            Log.d("HappyCamera", "focus af=$af ae=$ae lock=$lock completed=${result.isSuccess} focused=${result.getOrNull()?.isFocusSuccessful}")
            if (holdAE && this.camera === camera && generation == token && result.isSuccess) {
                val applied = Camera2CameraControl.from(camera.cameraControl)
                    .addCaptureRequestOptions(CaptureRequestOptions.Builder().setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, true).build())
                applied.addListener({
                    if (this.camera === camera && generation == token && runCatching { applied.get() }.isSuccess) {
                        focus = focus?.copy(aeLocked = true)
                        Log.d("HappyCamera", "AE lock applied")
                    }
                }, main)
            }
        }, main)
        return true
    }

    fun expose(slider: Float) {
        val camera = camera ?: return
        val state = camera.cameraInfo.exposureState
        if (!state.isExposureCompensationSupported) return
        val step = state.exposureCompensationStep.toFloat()
        val index = exposureIndex(slider, step, state.exposureCompensationRange)
        camera.cameraControl.setExposureCompensationIndex(index)
        exposure = (index * step / 2).coerceIn(-1f, 1f)
    }

    fun dismissFocus(token: Int) {
        if (focus?.generation == token && focus?.afLocked == false && focus?.aeLocked == false) focus = null
    }

    fun frameRate(cap: Int) {
        val camera = camera ?: return
        val range = photoFrameRate(ranges, cap) ?: return
        Camera2CameraControl.from(camera.cameraControl).addCaptureRequestOptions(CaptureRequestOptions.Builder()
            .setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, range).build())
        Log.d("HappyCamera", "thermal cap=$cap fps=$range")
    }

    fun resetSession() {
        front = false; timer = 0; countdown = null; focus = null; generation++
        camera?.let {
            it.cameraControl.cancelFocusAndMetering()
            if (aeLockAvailable) Camera2CameraControl.from(it.cameraControl).addCaptureRequestOptions(CaptureRequestOptions.Builder()
                .setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, false).build())
            expose(0f)
            zoomTo(1f)
        }
    }
}
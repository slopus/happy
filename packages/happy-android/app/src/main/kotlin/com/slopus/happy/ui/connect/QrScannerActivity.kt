package com.slopus.happy.ui.connect

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.util.Size
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.compose.CameraXViewfinder
import android.hardware.camera2.CameraCharacteristics
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.SurfaceRequest
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.slopus.happy.camera.CameraBinding
import com.slopus.happy.camera.CameraFailure
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.slopus.happy.HappyApplication
import com.slopus.happy.ui.call.CallFrame
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import java.util.concurrent.Executors

/**
 * The QR scanner ([CameraQrScanner]): [QrScannerScreen] over the back
 * camera, dark whatever the app's theme. It finishes with the first code it
 * reads; close or system back is a cancel.
 */
class QrScannerActivity : ComponentActivity() {
    @OptIn(ExperimentalCoroutinesApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        // Opened from the app, whose graph is built by now: the app stays in
        // the foreground while it shows, and a voice call keeps its bar on top.
        val graph = (application as HappyApplication).graphReady.takeIf { it.isCompleted }?.getCompleted()
        if (graph != null) {
            lifecycleScope.launch {
                repeatOnLifecycle(Lifecycle.State.STARTED) {
                    graph.setForeground(true)
                    try { awaitCancellation() } finally { graph.setForeground(false) }
                }
            }
        }
        setContent {
            HappyTheme(preference = ThemePreference.Dark) {
                ProvideWindowLayout {
                    val scan = Contract.request(intent)
                    if (graph != null) {
                        CallFrame(graph.calls) { QrScannerRoute(scan = scan, onResult = ::finishWith) }
                    } else {
                        QrScannerRoute(scan = scan, onResult = ::finishWith)
                    }
                }
            }
        }
    }

    private fun finishWith(result: ScanResult) {
        if (isFinishing) return
        when (result) {
            is ScanResult.Scanned -> setResult(RESULT_OK, Intent().putExtra(EXTRA_VALUE, result.value))
            is ScanResult.Failed -> setResult(RESULT_FAILED, Intent().putExtra(EXTRA_FAILURE, result.reason.name))
            ScanResult.Cancelled -> setResult(RESULT_CANCELED)
            is ScanResult.Chose -> setResult(RESULT_CHOSE, Intent().putExtra(EXTRA_WAY, result.way.name))
        }
        finish()
    }

    /** Starts the scanner; the result is what it read, a cancel, or why it couldn't. */
    object Contract : ActivityResultContract<ScanRequest, ScanResult>() {
        override fun createIntent(context: Context, input: ScanRequest): Intent = Intent(context, QrScannerActivity::class.java)
            .putExtra(EXTRA_WAYS, input.ways.map { it.name }.toTypedArray())
            .putExtra(EXTRA_SERVER_LABEL, input.serverLabel)

        internal fun request(intent: Intent?) = ScanRequest(
            ways = intent?.getStringArrayExtra(EXTRA_WAYS).orEmpty().mapNotNull { name -> ScannerWay.entries.firstOrNull { it.name == name } },
            serverLabel = intent?.getStringExtra(EXTRA_SERVER_LABEL),
        )

        override fun parseResult(resultCode: Int, intent: Intent?): ScanResult {
            val value = intent?.getStringExtra(EXTRA_VALUE)
            return when {
                resultCode == RESULT_OK && value != null -> ScanResult.Scanned(value)
                resultCode == RESULT_CHOSE -> ScannerWay.entries.firstOrNull { it.name == intent?.getStringExtra(EXTRA_WAY) }
                    ?.let(ScanResult::Chose) ?: ScanResult.Cancelled
                resultCode == RESULT_FAILED -> ScanResult.Failed(
                    ScanFailure.entries.firstOrNull { it.name == intent?.getStringExtra(EXTRA_FAILURE) } ?: ScanFailure.CameraFailed,
                )
                else -> ScanResult.Cancelled
            }
        }
    }

    internal companion object {
        const val EXTRA_VALUE = "value"
        const val EXTRA_FAILURE = "failure"
        const val EXTRA_WAYS = "ways"
        const val EXTRA_SERVER_LABEL = "serverLabel"
        const val EXTRA_WAY = "way"
        const val RESULT_FAILED = Activity.RESULT_FIRST_USER
        const val RESULT_CHOSE = Activity.RESULT_FIRST_USER + 1
    }
}

/**
 * Asks for the camera when the scan starts. While it is denied the screen
 * says so and offers the app's settings; coming back with it granted starts
 * the camera.
 */
@Composable
internal fun QrScannerRoute(scan: ScanRequest = ScanRequest(), onResult: (ScanResult) -> Unit) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val granted = { ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED }
    var access by remember { mutableStateOf(if (granted()) CameraAccess.Granted else CameraAccess.Asking) }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        access = if (ok) CameraAccess.Granted else CameraAccess.Denied
    }
    LaunchedEffect(Unit) {
        if (access == CameraAccess.Asking) request.launch(Manifest.permission.CAMERA)
    }
    LifecycleResumeEffect(Unit) {
        if (access == CameraAccess.Denied && granted()) access = CameraAccess.Granted
        onPauseOrDispose {}
    }

    var surfaceRequest by remember { mutableStateOf<SurfaceRequest?>(null) }
    var camera by remember { mutableStateOf<Camera?>(null) }
    var torchOn by remember { mutableStateOf(false) }
    if (access == CameraAccess.Granted) {
        val window = LocalWindowLayout.current
        QrCameraBinding(
            fill = ScanFocus.fill(viewfinderSide(window.width, window.height).value, window.width.value, window.height.value),
            onSurfaceRequest = { surfaceRequest = it },
            onCamera = { camera = it },
            onDecoded = { text ->
                haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                onResult(ScanResult.Scanned(text))
            },
            onFailed = { onResult(ScanResult.Failed(it)) },
        )
    }
    QrScannerScreen(
        access = access,
        torchOn = camera?.takeIf { it.cameraInfo.hasFlashUnit() }?.let { torchOn },
        onTorch = {
            torchOn = !torchOn
            camera?.cameraControl?.enableTorch(torchOn)
        },
        onBack = { onResult(ScanResult.Cancelled) },
        ways = scan.ways,
        serverLabel = scan.serverLabel,
        onWay = { onResult(ScanResult.Chose(it)) },
        onOpenSettings = {
            context.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
            )
        },
    ) {
        surfaceRequest?.let { CameraXViewfinder(surfaceRequest = it, modifier = Modifier.fillMaxSize()) }
    }
}

/**
 * QR's 720p latest-frame analysis and single analyzer executor, on the common
 * [CameraBinding] provider/preview/lifecycle used by photo capture too.
 *
 * As iOS's scanner since ff88dfcd6: the picture turns with the device (the
 * activity handles rotation itself, so the preview's target rotation
 * follows the display, a turn of 180° included, which no configuration
 * change reports), and a camera that can't focus as near as a code
 * filling the viewfinder ([fill]) is zoomed until it can ([ScanFocus]).
 */
@Composable
private fun QrCameraBinding(
    fill: Float,
    onSurfaceRequest: (SurfaceRequest?) -> Unit,
    onCamera: (Camera?) -> Unit,
    onDecoded: (String) -> Unit,
    onFailed: (ScanFailure) -> Unit,
) {
    val context = LocalContext.current
    val currentOnDecoded by rememberUpdatedState(onDecoded)
    val currentOnFailed by rememberUpdatedState(onFailed)
    val analysis = remember {
        ImageAnalysis.Builder()
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(
                        ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
                    )
                    .build(),
            )
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
    }
    val executor = remember { Executors.newSingleThreadExecutor() }
    val main = remember(context) { ContextCompat.getMainExecutor(context) }
    DisposableEffect(analysis) {
        analysis.setAnalyzer(executor, QrAnalyzer { text -> main.execute { currentOnDecoded(text) } })
        onDispose {
            analysis.clearAnalyzer()
            executor.shutdown()
        }
    }
    CameraBinding(
        useCases = remember(analysis) { listOf(analysis) },
        onSurface = onSurfaceRequest,
        onCamera = { camera ->
            onCamera(camera)
            camera?.let { bound -> focusZoom(bound, fill)?.let { bound.cameraControl.setZoomRatio(it) } }
        },
        onDisplayRotation = { analysis.targetRotation = it },
        onFailure = { currentOnFailed(if (it == CameraFailure.NoCamera) ScanFailure.NoCamera else ScanFailure.CameraFailed) },
    )
}

/** The zoom [ScanFocus] asks of [camera] for a code filling [fill] of the picture, held to what it can do; null at 1. */
@OptIn(ExperimentalCamera2Interop::class)
private fun focusZoom(camera: Camera, fill: Float): Float? {
    val info = Camera2CameraInfo.from(camera.cameraInfo)
    val sensor = info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
    val focal = info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull()
    val zoom = ScanFocus.zoom(
        minimumFocusMm = ScanFocus.minimumFocusMm(info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE)),
        fieldOfView = if (sensor == null || focal == null) 0f else ScanFocus.fieldOfView(maxOf(sensor.width, sensor.height), focal),
        fill = fill,
    )
    val range = camera.cameraInfo.zoomState.value
    Log.d(TAG, "focus zoom $zoom (fill $fill)")
    if (zoom <= 1f) return null
    return range?.let { zoom.coerceIn(it.minZoomRatio, it.maxZoomRatio) } ?: zoom
}

private const val TAG = "QrScanner"

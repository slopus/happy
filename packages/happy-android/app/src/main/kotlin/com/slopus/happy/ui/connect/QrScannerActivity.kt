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
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceRequest
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
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
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import java.util.concurrent.Executors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation

/**
 * The QR scanner ([CameraQrScanner]): [QrScannerScreen] over the back
 * camera, dark whatever the app's theme. It finishes with the first code it
 * reads; close or system back is a cancel.
 */
class QrScannerActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        setContent {
            HappyTheme(preference = ThemePreference.Dark) {
                ProvideWindowLayout {
                    QrScannerRoute(scan = Contract.request(intent), onResult = ::finishWith)
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
        CameraBinding(
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
 * Binds a preview and a [QrAnalyzer] to the back camera (else the front)
 * for as long as it is composed, following the activity's lifecycle.

 */
@Composable
private fun CameraBinding(
    onSurfaceRequest: (SurfaceRequest) -> Unit,
    onCamera: (Camera?) -> Unit,
    onDecoded: (String) -> Unit,
    onFailed: (ScanFailure) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentOnDecoded by rememberUpdatedState(onDecoded)
    val currentOnFailed by rememberUpdatedState(onFailed)
    LaunchedEffect(lifecycleOwner) {
        val provider = try {
            ProcessCameraProvider.awaitInstance(context)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Camera unavailable", e)
            currentOnFailed(ScanFailure.CameraFailed)
            return@LaunchedEffect
        }
        val selector = listOf(CameraSelector.DEFAULT_BACK_CAMERA, CameraSelector.DEFAULT_FRONT_CAMERA)
            .firstOrNull { runCatching { provider.hasCamera(it) }.getOrDefault(false) }
        if (selector == null) {
            currentOnFailed(ScanFailure.NoCamera)
            return@LaunchedEffect
        }
        val preview = Preview.Builder().build().apply { setSurfaceProvider(onSurfaceRequest) }
        val analysis = ImageAnalysis.Builder()
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(
                        ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
                    )
                    .build(),
            )
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        val executor = Executors.newSingleThreadExecutor()
        val main = ContextCompat.getMainExecutor(context)
        analysis.setAnalyzer(executor, QrAnalyzer { text -> main.execute { currentOnDecoded(text) } })
        try {
            try {
                onCamera(provider.bindToLifecycle(lifecycleOwner, selector, preview, analysis))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Camera failed to start", e)
                currentOnFailed(ScanFailure.CameraFailed)
                return@LaunchedEffect
            }
            awaitCancellation()
        } finally {
            onCamera(null)
            analysis.clearAnalyzer()
            provider.unbind(preview, analysis)
            executor.shutdown()
        }
    }
}

private const val TAG = "QrScanner"

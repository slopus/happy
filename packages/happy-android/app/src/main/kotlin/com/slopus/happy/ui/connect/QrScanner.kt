package com.slopus.happy.ui.connect

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import com.slopus.happy.connection.PairingStart
import kotlinx.coroutines.CompletableDeferred
import com.slopus.happy.camera.cameraPresent

/** What one scan came back with. */
sealed interface ScanResult {
    data class Scanned(val value: String) : ScanResult
    data object Cancelled : ScanResult

    /** No camera on this device, or it failed: [reason] says which, the flows say it in words. */
    data class Failed(val reason: ScanFailure) : ScanResult

    /** The person took another way in from the scanner's ⋮ instead of scanning. */
    data class Chose(val way: ScannerWay) : ScanResult
}

/**
 * The other ways in that Add's scanner offers under its ⋮ (iOS's
 * `AccountAdding.otherWays`): a pasted link, restoring a Happy CLI account
 * from its key, the server Happy CLI accounts sign in on, and Happy Cloud
 * (the account menu's +, for a phone with no account yet).
 */
enum class ScannerWay { EnterLink, Restore, Server, Cloud }

/** What the scanner is opened with: the [ways] its ⋮ offers (none, no ⋮) and the custom server's host, under Server. */
data class ScanRequest(val ways: List<ScannerWay> = emptyList(), val serverLabel: String? = null)

/** Why a scan couldn't run. */
enum class ScanFailure {
    /** The device has no camera at all. */
    NoCamera,

    /** The camera is there but couldn't be opened or started. */
    CameraFailed,

    /** The scanner screen itself couldn't be opened. */
    Unavailable,
}

/**
 * Reads one QR code. Frames go in on the scanner's side; only the decoded
 * text comes out, so everything after the scan is tested on the JVM with a
 * fake.
 */
fun interface QrScanner {
    suspend fun scan(request: ScanRequest): ScanResult
}

/**
 * Our own scanner: [QrScannerActivity], a full-screen CameraX preview whose
 * frames ZXing decodes ([QrAnalyzer]), so it works without Google Play
 * services. It asks for the camera itself; a phone without a camera fails at
 * once, and the flows then ask for the link.
 */
class CameraQrScanner(private val context: Context) : QrScanner {
    /** The activity launcher, registered by [rememberQrScanner] in the composition that scans. */
    internal var launcher: ActivityResultLauncher<ScanRequest>? = null
    private var pending: CompletableDeferred<ScanResult>? = null

    override suspend fun scan(request: ScanRequest): ScanResult {
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) || cameraPresent(context) == false) {
            return ScanResult.Failed(ScanFailure.NoCamera)
        }
        val launcher = launcher ?: return ScanResult.Failed(ScanFailure.Unavailable)
        val result = CompletableDeferred<ScanResult>()
        pending?.complete(ScanResult.Cancelled)
        pending = result
        try {
            launcher.launch(request)
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "QR scanner unavailable", e)
            pending = null
            return ScanResult.Failed(ScanFailure.Unavailable)
        }
        return try {
            result.await()
        } finally {
            if (pending === result) pending = null
        }
    }

    internal fun deliver(result: ScanResult) {
        pending?.complete(result)
    }

    private companion object {
        const val TAG = "QrScanner"
    }
}

/** Tests provide a fake; the app uses [CameraQrScanner]. */
val LocalQrScanner: ProvidableCompositionLocal<QrScanner?> = compositionLocalOf { null }

@Composable
fun rememberQrScanner(): QrScanner {
    val provided = LocalQrScanner.current
    if (provided != null) return provided
    val context = LocalContext.current
    val scanner = remember(context) { CameraQrScanner(context) }
    scanner.launcher = rememberLauncherForActivityResult(QrScannerActivity.Contract) { scanner.deliver(it) }
    return scanner
}

/**
 * Where a code goes once classified ([HappyCode]): the Protocol V2 pairing
 * for `happy://direct?` codes, provided at the app's root. Null where
 * nothing can pair (tests, signed-out screens); such a code is then an error.
 */
val LocalAgentPairing: ProvidableCompositionLocal<((String, PairingStart) -> Unit)?> = compositionLocalOf { null }

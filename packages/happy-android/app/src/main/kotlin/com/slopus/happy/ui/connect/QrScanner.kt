package com.slopus.happy.ui.connect

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/** What one scan came back with. */
sealed interface ScanResult {
    data class Scanned(val value: String) : ScanResult
    data object Cancelled : ScanResult

    /** No scanner on this device (no Play services), or it failed. */
    data class Failed(val reason: String) : ScanResult
}

/**
 * Reads one QR code. Frames go in on the scanner's side; only the decoded
 * text comes out, so everything after the scan is tested on the JVM with a
 * fake.
 */
fun interface QrScanner {
    suspend fun scan(): ScanResult
}

/**
 * Google Code Scanner, as expo-camera's `CameraView.launchScanner` uses on
 * Android: Play services shows its own full-screen camera, so the app needs
 * no camera permission and draws no preview (`useCheckCameraPermissions.ts`
 * returns true on Android for that reason). QR codes only, as happy-app asks.
 *
 * Like expo-camera, a device without the Play Store fails at once instead of
 * starting the scan.
 */
class GmsQrScanner(private val context: Context) : QrScanner {
    override suspend fun scan(): ScanResult {
        if (!hasPlayStore(context)) return ScanResult.Failed("Google Play services are not available")
        return try {
            val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
            val task = GmsBarcodeScanning.getClient(context, options).startScan()
            suspendCancellableCoroutine { continuation ->
                task.addOnSuccessListener { barcode ->
                    val value = barcode.rawValue
                    continuation.resume(if (value != null) ScanResult.Scanned(value) else ScanResult.Failed("Unreadable code"))
                }
                task.addOnCanceledListener { continuation.resume(ScanResult.Cancelled) }
                task.addOnFailureListener { error ->
                    Log.w(TAG, "QR scan failed", error)
                    continuation.resume(ScanResult.Failed(error.message ?: "Scan failed"))
                }
            }
        } catch (e: RuntimeException) {
            // expo-camera reports any throw here as Play services being unavailable.
            Log.w(TAG, "QR scanner unavailable", e)
            ScanResult.Failed(e.message ?: "Scanner unavailable")
        }
    }

    private companion object {
        const val TAG = "QrScanner"
        const val PLAY_STORE = "com.android.vending"

        /** expo-camera CameraUtils.hasGooglePlayServices: the Play Store app is installed. */
        fun hasPlayStore(context: Context): Boolean = try {
            context.packageManager.getPackageInfo(PLAY_STORE, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }
}

/** Tests provide a fake; the app uses [GmsQrScanner]. */
val LocalQrScanner: ProvidableCompositionLocal<QrScanner?> = compositionLocalOf { null }

@Composable
fun rememberQrScanner(): QrScanner {
    val provided = LocalQrScanner.current
    val context = LocalContext.current
    return provided ?: remember(context) { GmsQrScanner(context) }
}

/**
 * The scan listeners in useConnectTerminal.ts and useConnectAccount.ts act
 * only on codes with their own prefix; anything else, a cancel or a failed
 * scan is dropped without a word (`launchScanner`'s rejection is never
 * caught there). Returns the link to process, or null.
 */
fun acceptScan(result: ScanResult, prefix: String): String? =
    (result as? ScanResult.Scanned)?.value?.takeIf { it.startsWith(prefix) }

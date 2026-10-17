package io.elevenlabs.audio

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Manager for handling audio permissions in Android
 *
 * This class provides a comprehensive solution for requesting and managing
 * audio recording permissions with proper callbacks and state management.
 */
class AudioPermissionManager {

    companion object {
        const val AUDIO_PERMISSION_REQUEST_CODE = 1001

        private var permissionCallback: ((Boolean) -> Unit)? = null

        /**
         * Check if audio recording permission is granted
         * @param context Android context
         * @return true if permission is granted
         */
        fun hasAudioPermission(context: Context): Boolean {
            return ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
        }

        /**
         * Request audio recording permission from an Activity
         * @param activity The activity to request permission from
         * @return true if permission was granted, false if denied
         */
        suspend fun requestAudioPermission(activity: Activity): Boolean {
            if (hasAudioPermission(activity)) {
                return true
            }

            return suspendCancellableCoroutine { continuation ->
                permissionCallback = { granted ->
                    continuation.resume(granted)
                    permissionCallback = null
                }

                ActivityCompat.requestPermissions(
                    activity,
                    arrayOf(Manifest.permission.RECORD_AUDIO),
                    AUDIO_PERMISSION_REQUEST_CODE
                )
            }
        }

        /**
         * Request audio recording permission from a Fragment
         * @param fragment The fragment to request permission from
         * @return true if permission was granted, false if denied
         */
        suspend fun requestAudioPermission(fragment: Fragment): Boolean {
            val context = fragment.requireContext()
            if (hasAudioPermission(context)) {
                return true
            }

            return suspendCancellableCoroutine { continuation ->
                permissionCallback = { granted ->
                    continuation.resume(granted)
                    permissionCallback = null
                }

                fragment.requestPermissions(
                    arrayOf(Manifest.permission.RECORD_AUDIO),
                    AUDIO_PERMISSION_REQUEST_CODE
                )
            }
        }

        /**
         * Handle permission request result
         * This should be called from onRequestPermissionsResult in your Activity or Fragment
         *
         * @param requestCode The request code from onRequestPermissionsResult
         * @param permissions The permissions array from onRequestPermissionsResult
         * @param grantResults The grant results array from onRequestPermissionsResult
         */
        fun handlePermissionResult(
            requestCode: Int,
            permissions: Array<out String>,
            grantResults: IntArray
        ) {
            if (requestCode == AUDIO_PERMISSION_REQUEST_CODE) {
                val granted = grantResults.isNotEmpty() &&
                    grantResults[0] == PackageManager.PERMISSION_GRANTED

                permissionCallback?.invoke(granted)
            }
        }

        /**
         * Check if the user has permanently denied the audio permission
         * @param activity The activity to check
         * @return true if permission is permanently denied
         */
        fun isPermissionPermanentlyDenied(activity: Activity): Boolean {
            return !ActivityCompat.shouldShowRequestPermissionRationale(
                activity,
                Manifest.permission.RECORD_AUDIO
            ) && !hasAudioPermission(activity)
        }

        /**
         * Check if we should show a rationale for the audio permission
         * @param activity The activity to check
         * @return true if we should show rationale
         */
        fun shouldShowPermissionRationale(activity: Activity): Boolean {
            return ActivityCompat.shouldShowRequestPermissionRationale(
                activity,
                Manifest.permission.RECORD_AUDIO
            )
        }

        /**
         * Get a user-friendly explanation for why audio permission is needed
         * @return Permission rationale message
         */
        fun getPermissionRationale(): String {
            return "This app needs access to your microphone to enable voice conversations with AI agents. " +
                    "Your audio will be processed in real-time for the conversation but not stored or shared."
        }

        /**
         * Get a message to show when permission is permanently denied
         * @return Permanent denial message
         */
        fun getPermanentDenialMessage(): String {
            return "Microphone access has been permanently denied. To enable voice conversations, " +
                    "please go to Settings > Apps > [App Name] > Permissions and enable Microphone access."
        }
    }
}

/**
 * Extension function for Activity to easily request audio permission
 */
suspend fun Activity.requestAudioPermission(): Boolean {
    return AudioPermissionManager.requestAudioPermission(this)
}

/**
 * Extension function for Fragment to easily request audio permission
 */
suspend fun Fragment.requestAudioPermission(): Boolean {
    return AudioPermissionManager.requestAudioPermission(this)
}

/**
 * Extension function for Context to easily check audio permission
 */
fun Context.hasAudioPermission(): Boolean {
    return AudioPermissionManager.hasAudioPermission(this)
}
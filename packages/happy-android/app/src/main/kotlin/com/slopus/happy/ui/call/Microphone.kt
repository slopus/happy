package com.slopus.happy.ui.call

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred

data class MicrophoneAccess(val granted: Boolean, val canAskAgain: Boolean)

/** The activity owns the runtime permission launcher; the call asks it in its own order ([com.slopus.happy.call.CallSession]). */
interface MicrophonePermission {
    suspend fun request(): MicrophoneAccess
    fun openSettings()
}

/** RECORD_AUDIO through the activity's launcher, asked only when a call gets that far. */
@Composable
fun rememberMicrophonePermission(): MicrophonePermission {
    val context = LocalContext.current
    val pending = remember { arrayOfNulls<CompletableDeferred<Boolean>>(1) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        pending[0]?.complete(granted)
        pending[0] = null
    }
    DisposableEffect(Unit) { onDispose { pending[0]?.cancel() } }
    return remember(context, launcher) {
        object : MicrophonePermission {
            override suspend fun request(): MicrophoneAccess {
                if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    return MicrophoneAccess(true, true)
                }
                val result = CompletableDeferred<Boolean>()
                pending[0]?.cancel()
                pending[0] = result
                try {
                    launcher.launch(Manifest.permission.RECORD_AUDIO)
                    val granted = result.await()
                    val canAskAgain = context.activity()?.let {
                        ActivityCompat.shouldShowRequestPermissionRationale(it, Manifest.permission.RECORD_AUDIO)
                    } ?: false
                    return MicrophoneAccess(granted, granted || canAskAgain)
                } finally {
                    if (pending[0] === result) pending[0] = null
                }
            }
            override fun openSettings() {
                context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }
}

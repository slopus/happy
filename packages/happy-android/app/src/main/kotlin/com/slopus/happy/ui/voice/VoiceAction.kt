package com.slopus.happy.ui.voice

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import androidx.lifecycle.Lifecycle
import com.slopus.happy.R
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.voice.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch

/** microphonePermissions.ts: the engine requests RECORD_AUDIO only after entering Connecting. */
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

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/** SessionView.tsx: connected/connecting calls leave stopping to the pill; no mic when offline or embedded. */
@Composable
internal fun rememberVoiceAction(sessionId: String, enabled: Boolean): (() -> Unit)? {
    val controller = LocalVoiceController.current
    val state by controller.state.collectAsStateWithLifecycle()
    val microphone = rememberMicrophonePermission()
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    var alert by remember { mutableStateOf<Alert?>(null) }
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    LaunchedEffect(controller, sessionId, state.status, lifecycle) {
        if (lifecycle == Lifecycle.State.RESUMED) controller.focus(sessionId)
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
    if (!enabled || controller === NoVoice || state.status == VoiceStatus.Connected || state.status == VoiceStatus.Connecting) return null
    return {
        scope.launch {
            alert = voiceStartAlert(controller.start(sessionId, microphone), resources, microphone::openSettings)
        }
    }
}

/** Each start outcome keeps RealtimeSession.ts's original alert; declined paywalls stay silent. */
internal fun voiceStartAlert(result: VoiceStart, resources: android.content.res.Resources, openSettings: () -> Unit): Alert? {
    fun message(id: Int, title: Int = R.string.common_error) = Alert(resources.getString(title), resources.getString(id),
        listOf(AlertButton(resources.getString(R.string.common_ok))))
    return when (result) {
        is VoiceStart.Started, VoiceStart.Declined -> null
        VoiceStart.NotSignedIn -> message(R.string.errors_authentication_failed)
        VoiceStart.LimitReached -> message(R.string.errors_voice_conversation_limit_reached, R.string.errors_voice_limit_reached_title)
        VoiceStart.Unavailable -> message(R.string.errors_voice_service_unavailable)
        // microphonePermissions.ts uses inline English for this system permission alert.
        is VoiceStart.MicrophoneDenied -> Alert(
            "Microphone Access Required",
            if (result.canAskAgain) "Happy needs access to your microphone for voice chat. Please grant permission when prompted."
            else "Happy needs access to your microphone for voice chat. Please enable microphone access in your device settings.",
            buildList {
                add(AlertButton(resources.getString(R.string.common_cancel)))
                if (!result.canAskAgain) add(AlertButton("Open Settings", onClick = openSettings))
            },
        )
    }
}
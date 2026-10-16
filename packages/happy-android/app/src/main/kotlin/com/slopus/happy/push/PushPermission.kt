package com.slopus.happy.push

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

enum class PushPermissionStatus { Granted, Denied, Undetermined }

/** pushRegistration.ts PushPermissionInfo. */
data class PushPermissionInfo(val status: PushPermissionStatus, val canAskAgain: Boolean) {
    val granted: Boolean get() = status == PushPermissionStatus.Granted
}

/** The notification permission as expo-notifications reports and asks for it. */
interface PushPermission {
    fun info(): PushPermissionInfo

    /** Notifications.requestPermissionsAsync: the system prompt (POST_NOTIFICATIONS, Android 13+). */
    suspend fun request(): PushPermissionInfo

    /** The app's notification settings, for when the prompt can't be shown again. */
    fun openSettings()
}

/**
 * requestPushPermissionOrOpenSettings: allowed already, or the prompt if it
 * can still be shown, or the system settings.
 */
suspend fun PushPermission.requestOrOpenSettings(): PushPermissionInfo {
    val existing = info()
    if (existing.granted) return existing
    if (existing.canAskAgain) return request()
    openSettings()
    return existing
}

/**
 * [PushPermission] for this activity. Expo's rules: before Android 13
 * notifications are allowed unless the user turned them off, and then they
 * can't be asked for. From 13 on, POST_NOTIFICATIONS: undetermined until
 * asked once; after a refusal it can be asked again only while the system
 * would still show its prompt (the rationale flag).
 */
@Composable
fun rememberPushPermission(): PushPermission {
    val context = LocalContext.current
    val pending = remember { arrayOfNulls<CompletableDeferred<Boolean>>(1) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        pending[0]?.complete(granted)
        pending[0] = null
    }
    return remember(context, launcher) {
        object : PushPermission {
            private val prefs = context.getSharedPreferences(RegisteredPushTokenStore.PREFS_NAME, Context.MODE_PRIVATE)

            override fun info(): PushPermissionInfo {
                if (NotificationManagerCompat.from(context).areNotificationsEnabled()) {
                    return PushPermissionInfo(PushPermissionStatus.Granted, canAskAgain = true)
                }
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                    return PushPermissionInfo(PushPermissionStatus.Denied, canAskAgain = false)
                }
                if (!prefs.getBoolean(KEY_ASKED, false)) return PushPermissionInfo(PushPermissionStatus.Undetermined, canAskAgain = true)
                val activity = context.findActivity()
                val canAsk = activity != null && ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)
                return PushPermissionInfo(PushPermissionStatus.Denied, canAskAgain = canAsk)
            }

            override suspend fun request(): PushPermissionInfo {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return info()
                val result = CompletableDeferred<Boolean>()
                pending[0]?.cancel()
                pending[0] = result
                prefs.edit().putBoolean(KEY_ASKED, true).apply()
                launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
                result.await()
                return info()
            }

            override fun openSettings() {
                context.startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }
    }
}

private const val KEY_ASKED = "notification-permission-asked"

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/**
 * sync.ts `pushTokenSync`: while signed in, every time the app comes to the
 * foreground, ask for notifications if they can still be asked for, then
 * register this device's push token. Signing out forgets the registration.
 * Builds without Firebase, and devices without an FCM token, skip it all
 * and never prompt (happy-app prompts first and then finds no project id;
 * here there is nothing to prompt for).
 */
@Composable
fun PushRegistrationEffect(graph: AppGraph) {
    val context = LocalContext.current
    val services = remember(context) { PushServices.get(context) }
    val auth by graph.auth.state.collectAsStateWithLifecycle()
    PushRegistrationEffect(
        authToken = (auth as? AuthState.SignedIn)?.credentials?.token,
        supported = { services.fcm.supported },
        permission = rememberPushPermission(),
        sync = { token -> services.registrar.sync(token) },
        forget = services.registrar::forget,
    )
}

/** [PushRegistrationEffect] with its parts passed in, for tests. */
@Composable
fun PushRegistrationEffect(
    authToken: String?,
    supported: () -> Boolean,
    permission: PushPermission,
    sync: suspend (authToken: String) -> Unit,
    forget: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val currentSync by rememberUpdatedState(sync)
    LaunchedEffect(Unit) { NotificationChannels.create(context) }
    LaunchedEffect(authToken, lifecycle) {
        if (authToken == null) {
            forget()
            return@LaunchedEffect
        }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            if (!withContext(Dispatchers.IO) { supported() }) return@repeatOnLifecycle
            var info = permission.info()
            if (!info.granted) {
                if (!info.canAskAgain) return@repeatOnLifecycle
                info = permission.request()
                if (!info.granted) return@repeatOnLifecycle
            }
            try {
                withContext(Dispatchers.IO) { currentSync(authToken) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w("PushRegistration", "Failed to register push token", e)
            }
        }
    }
}

package com.slopus.happy.push

import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import com.slopus.happy.model.settings.PushPermission
import com.slopus.happy.model.settings.PushRegistration
import com.slopus.happy.model.settings.PushTokenSync
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Settings › Account's push rows over FCM: pushRegistration.ts's
 * getPushPermissionInfo, requestPushPermissionOrOpenSettings,
 * getCurrentExpoPushToken, syncCurrentPushToken and removePushToken.
 * Where push is unsupported (no Firebase in the build, no Play services)
 * syncing registers nothing and reports the token last registered, as
 * happy-app does without a project id.
 */
class AppPushRegistration(
    private val permission: NotificationPermission,
    /** Starts Firebase ([FirebaseStart]), so it is asked on Dispatchers.IO. */
    private val supported: () -> Boolean,
    private val registrar: PushRegistrar,
    private val store: RegisteredPushTokenStore,
    private val authToken: () -> String?,
) : PushRegistration {
    override suspend fun permission(): PushPermission = permission.info()

    override suspend fun requestPermissionOrOpenSettings() = permission.requestOrOpenSettings()

    override suspend fun currentToken(): String? {
        if (!permission.info().granted || !withContext(Dispatchers.IO) { supported() }) return store.load()
        return try {
            withContext(Dispatchers.IO) { registrar.currentExpoToken() } ?: store.load()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("PushRegistration", "Failed to get Expo push token", e)
            store.load()
        }
    }

    override suspend fun syncCurrentToken(): PushTokenSync {
        var info = permission.info()
        if (!info.granted) {
            if (!info.canAskAgain) return PushTokenSync(registered = false, token = store.load(), permission = info)
            info = permission.request()
            if (!info.granted) return PushTokenSync(registered = false, token = store.load(), permission = info)
        }
        val token = authToken()
        if (token == null || !withContext(Dispatchers.IO) { supported() }) return PushTokenSync(registered = false, token = store.load(), permission = info)
        return when (val result = withContext(Dispatchers.IO) { registrar.sync(token) }) {
            is PushSyncResult.Registered -> PushTokenSync(registered = true, token = result.token, permission = info)
            PushSyncResult.Unsupported -> PushTokenSync(registered = false, token = store.load(), permission = info)
        }
    }

    override suspend fun removeToken(token: String) {
        val auth = checkNotNull(authToken()) { "Not signed in" }
        registrar.remove(auth, token)
    }
}

/** Account's permission row follows system Settings changes on every return (iOS viewWillAppear). */
@Composable
internal fun RefreshPushPermissionOnResume(registration: PushRegistration, onPermission: (PushPermission) -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val update = rememberUpdatedState(onPermission)
    LaunchedEffect(lifecycle, registration) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            update.value(registration.permission())
        }
    }
}

/** [AppPushRegistration] for this activity's permission prompt. */
@Composable
fun rememberPushRegistration(graph: AppGraph): PushRegistration {
    val context = LocalContext.current
    val services = remember(context) { PushServices.get(context) }
    val permission = rememberNotificationPermission()
    return remember(services, permission, graph) {
        AppPushRegistration(
            permission = permission,
            supported = { services.fcm.supported },
            registrar = services.registrar,
            store = services.store,
            authToken = { (graph.auth.state.value as? AuthState.SignedIn)?.credentials?.token },
        )
    }
}

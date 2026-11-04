package com.slopus.happy.push

import android.content.Context
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.slopus.happy.AppGraph
import com.slopus.happy.HappyApplication
import com.slopus.happy.auth.AuthState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** The push objects, one per process, built from the app's graph on first use. */
class PushServices(context: Context, graph: AppGraph) {
    val fcm = FcmTokenSource(context)
    val store = RegisteredPushTokenStore(context.getSharedPreferences(RegisteredPushTokenStore.PREFS_NAME, Context.MODE_PRIVATE))
    val registrar = PushRegistrar(
        deviceTokens = fcm,
        expo = ExpoPushTokenClient(
            OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build(),
        ),
        api = PushApi(graph.http),
        store = store,
        installationId = InstallationId(context)::getOrCreate,
        applicationId = context.packageName,
        unregisters = graph.pushUnregisters,
    )

    init {
        // Removals a sign-out left behind, from this run or an earlier one.
        graph.pushUnregisters.drain()
    }

    /** Background work that outlives a screen (a rotated FCM token). */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    companion object {
        @Volatile private var instance: PushServices? = null

        /** AuthContext.tsx logout: [graph]'s logout hands this device's push token to [PushUnregisterQueue]. */
        fun unregisterOnLogout(context: Context, graph: AppGraph) = graph.beforeAccountRemoval { authToken, serverUrl, open ->
            get(context).registrar.unregisterOnLogout(authToken, serverUrl, forgetCurrentToken = open)
        }

        fun get(context: Context): PushServices = instance ?: synchronized(this) {
            instance ?: run {
                val app = context.applicationContext
                PushServices(app, (app as HappyApplication).graph).also { instance = it }
            }
        }
    }
}

/**
 * expo-notifications' FirebaseMessagingDelegate, for the two things Happy
 * uses: show a push Expo relayed (data-only FCM messages, which Android does
 * not show by itself) and re-register when FCM rotates the token.
 */
class HappyMessagingService : FirebaseMessagingService() {
    override fun onCreate() {
        // Nothing starts Firebase with the process any more (FirebaseStart), and a push or a new
        // token can be what started it: FirebaseMessagingService's handling reads FirebaseApp.
        FirebaseStart.ensure(this)
        super.onCreate()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        presentPush(
            this,
            RemotePush.from(message.data, message.messageId, message.notification?.title, message.notification?.body),
        )
    }

    override fun onNewToken(token: String) {
        val services = PushServices.get(this)
        val graph = (applicationContext as HappyApplication).graph
        val account = graph.auth.state.value as? AuthState.SignedIn ?: return
        // syncCurrentPushToken registers nothing while notifications are off.
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return
        services.scope.launch {
            try {
                services.registrar.sync(account.credentials.token)
            } catch (e: Exception) {
                Log.w("HappyMessagingService", "Re-registering the push token failed", e)
            }
        }
    }
}

package com.slopus.happy.push

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.slopus.happy.MainActivity
import com.slopus.happy.R
import com.slopus.happy.net.HappyJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URLDecoder
import java.util.UUID

/**
 * notificationRouting.ts getSessionRouteFromNotificationData: the session a
 * notification's data opens, from a `url` with `/session/<id>` in it, else a
 * `sessionId`. [data] may be the JSON text Expo puts in the FCM `body` key.
 */
fun sessionIdFromNotificationData(data: JsonElement?): String? {
    val obj = when (data) {
        is JsonObject -> data
        is JsonPrimitive -> if (data.isString) {
            try {
                HappyJson.parseToJsonElement(data.content) as? JsonObject
            } catch (_: IllegalArgumentException) {
                null
            }
        } else {
            null
        }
        else -> null
    } ?: return null

    (obj["url"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { url ->
        SESSION_IN_URL.find(url.trim())?.groupValues?.get(1)?.let { encoded ->
            val id = try {
                URLDecoder.decode(encoded.replace("+", "%2B"), "UTF-8")
            } catch (_: IllegalArgumentException) {
                encoded
            }.trim()
            if (id.isNotEmpty()) return id
        }
    }
    return (obj["sessionId"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.ifEmpty { null }
}

private val SESSION_IN_URL = Regex("(?:^|/)session/([^/?#]+)")

/**
 * happy-app's `_layout.tsx` channels: `default` (max importance) and
 * `messages` (high), both vibrating 0/250/250/250 with light colour
 * #FF231F7C. happy-server sends session pushes on `messages`.
 */
object NotificationChannels {
    const val DEFAULT = "default"
    const val MESSAGES = "messages"
    private val VIBRATION = longArrayOf(0, 250, 250, 250)
    private const val LIGHT = 0xFF231F7C.toInt()

    // _layout.tsx asks for AndroidImportance.MAX, which expo-notifications passes on as IMPORTANCE_MAX:
    // outside the constructor's annotated range, but the system accepts it.
    @SuppressLint("WrongConstant")
    fun create(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        listOf(
            NotificationChannel(DEFAULT, "Default", NotificationManager.IMPORTANCE_MAX),
            NotificationChannel(MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH),
        ).forEach { channel ->
            channel.vibrationPattern = VIBRATION
            channel.lightColor = LIGHT
            manager.createNotificationChannel(channel)
        }
    }
}

/** The notification part of an FCM data message as Expo's push service sends it. */
data class RemotePush(
    val title: String?,
    val message: String?,
    /** The push's `data`, as JSON text. */
    val body: String?,
    val channelId: String?,
    val tag: String,
) {
    val sessionId: String? get() = body?.let { sessionIdFromNotificationData(JsonPrimitive(it)) }

    companion object {
        /** RemoteNotificationContent / NotificationData keys; the tag as getNotificationIdentifier picks it. */
        fun from(data: Map<String, String>, messageId: String?, notificationTitle: String? = null, notificationBody: String? = null) = RemotePush(
            title = notificationTitle ?: data["title"],
            message = notificationBody ?: data["message"],
            body = data["body"],
            channelId = data["channelId"],
            tag = data["tag"] ?: messageId ?: UUID.randomUUID().toString(),
        )
    }
}

/**
 * Notification taps open MainActivity with the session id as this extra;
 * `DeepLinks.offer` turns it into a session link.
 */
const val EXTRA_PUSH_SESSION_ID = "com.slopus.happy.push.sessionId"
const val ACTION_OPEN_PUSH = "com.slopus.happy.action.OPEN_PUSH"

/** The intent a tap on a push for [sessionId] sends (null: just opens the app). */
fun pushTapIntent(context: Context, sessionId: String?): Intent =
    Intent(context, MainActivity::class.java)
        .setAction(ACTION_OPEN_PUSH)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .apply { if (sessionId != null) putExtra(EXTRA_PUSH_SESSION_ID, sessionId) }

/**
 * ExpoPresentationDelegate for a remote push: the notification icon, title,
 * text (big text style), dismissed on tap, high priority, on the push's
 * channel (`default` when it names none or one that doesn't exist). In the
 * foreground it is silent, as `_layout.tsx`'s handler turns sound and the
 * banner off while the app is active. Each push replaces the one with its
 * tag.
 */
fun presentPush(context: Context, push: RemotePush) {
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return
    NotificationChannels.create(context)
    val channel = push.channelId?.takeIf { context.getSystemService(NotificationManager::class.java).getNotificationChannel(it) != null }
        ?: NotificationChannels.DEFAULT
    val tap = PendingIntent.getActivity(
        context,
        push.tag.hashCode(),
        pushTapIntent(context, push.sessionId),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(context, channel)
        .setSmallIcon(R.drawable.notification_icon)
        .setContentTitle(push.title)
        .setContentText(push.message)
        .setStyle(NotificationCompat.BigTextStyle().bigText(push.message))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setSilent(isAppInForeground())
        .setContentIntent(tap)
        .build()
    try {
        manager.notify(push.tag, 0, notification)
    } catch (_: SecurityException) {
        // POST_NOTIFICATIONS was revoked between the check and the post.
    }
}

internal fun isAppInForeground(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
}

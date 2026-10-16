package com.slopus.happy.push

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.MainActivity
import com.slopus.happy.ui.connect.DeepLink
import com.slopus.happy.ui.connect.DeepLinks
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * Which session a push opens (notificationRouting.ts and its tests), how a
 * push Expo relays is shown (the `_layout.tsx` channels, expo's
 * presentation), and the tap reaching DeepLinks as a session link.
 */
@RunWith(AndroidJUnit4::class)
class PushRoutingTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val manager get() = context.getSystemService(NotificationManager::class.java)

    @After
    fun tearDown() {
        DeepLinks.pending.value?.let(DeepLinks::consume)
    }

    private fun data(vararg pairs: Pair<String, String>) = buildJsonObject { pairs.forEach { (k, v) -> put(k, v) } }

    @Test
    fun theSessionComesFromTheData() {
        // notificationRouting.test.ts
        assertEquals("session-123", sessionIdFromNotificationData(data("sessionId" to "session-123")))
        assertEquals("session 123", sessionIdFromNotificationData(data("sessionId" to "session 123")))
        assertNull(sessionIdFromNotificationData(data("kind" to "done")))
        assertNull(sessionIdFromNotificationData(data("sessionId" to "   ")))
        assertEquals("session-123", sessionIdFromNotificationData(data("url" to "/session/session-123")))

        // A session url wins over sessionId; a url without one falls back to it.
        assertEquals("a b", sessionIdFromNotificationData(data("url" to " happy:///session/a%20b?x=1#y ", "sessionId" to "other")))
        assertEquals("s2", sessionIdFromNotificationData(data("url" to "/settings", "sessionId" to "s2")))
        assertEquals("s3", sessionIdFromNotificationData(data("url" to "/session/%20", "sessionId" to "s3")))
        // decodeURIComponent: a bad escape stays as it is, `+` is not a space.
        assertEquals("50%", sessionIdFromNotificationData(data("url" to "/session/50%")))
        assertEquals("a+b", sessionIdFromNotificationData(data("url" to "/session/a+b")))
        assertNull(sessionIdFromNotificationData(data("url" to "/mysession/x")))

        // Expo hands the data over as JSON text.
        assertEquals("s1", sessionIdFromNotificationData(JsonPrimitive("""{"sessionId":"s1"}""")))
        assertNull(sessionIdFromNotificationData(JsonPrimitive("s1")))
        assertNull(sessionIdFromNotificationData(JsonPrimitive("""["s1"]""")))
        assertNull(sessionIdFromNotificationData(JsonArray(listOf(JsonPrimitive("s1")))))
        assertNull(sessionIdFromNotificationData(buildJsonObject { put("sessionId", 5) }))
        assertNull(sessionIdFromNotificationData(JsonNull))
        assertNull(sessionIdFromNotificationData(null))
    }

    @Test
    fun aPushAsExpoRelaysIt() {
        // What happy-server's sendToAllDevices becomes in FCM: a data message.
        val push = RemotePush.from(
            mapOf(
                "title" to "Claude is done",
                "message" to "Ready for your next prompt",
                "body" to """{"sessionId":"s1"}""",
                "channelId" to "messages",
                "scopeKey" to "@slopus/happy",
                "experienceId" to "@slopus/happy",
                "projectId" to EXPO_PROJECT_ID,
            ),
            messageId = "0:1700000000000000%abc",
        )
        assertEquals(RemotePush("Claude is done", "Ready for your next prompt", """{"sessionId":"s1"}""", "messages", "0:1700000000000000%abc"), push)
        assertEquals("s1", push.sessionId)

        assertEquals("t", RemotePush.from(mapOf("tag" to "t"), messageId = "m").tag)
        assertEquals("Shown", RemotePush.from(mapOf("title" to "Data"), messageId = null, notificationTitle = "Shown").title)
        assertNull(RemotePush.from(emptyMap(), messageId = "m").sessionId)
    }

    @Test
    fun channelsMatchHappyApps() {
        NotificationChannels.create(context)
        val default = manager.getNotificationChannel(NotificationChannels.DEFAULT)
        val messages = manager.getNotificationChannel(NotificationChannels.MESSAGES)
        assertEquals(NotificationManager.IMPORTANCE_MAX, default.importance)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, messages.importance)
        listOf(default, messages).forEach {
            assertArrayEquals(longArrayOf(0, 250, 250, 250), it.vibrationPattern)
            assertEquals(0xFF231F7C.toInt(), it.lightColor)
        }
    }

    @Test
    fun aTapOpensTheSession() {
        presentPush(context, RemotePush("Claude is done", "Ready", """{"sessionId":"s1"}""", "messages", "tag-1"))

        val notification = shadowOf(manager).getNotification("tag-1", 0)
        assertEquals("messages", notification.channelId)
        assertEquals("Claude is done", notification.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("Ready", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(com.slopus.happy.R.drawable.notification_icon, notification.smallIcon.resId)
        assertTrue(notification.flags and Notification.FLAG_AUTO_CANCEL != 0)

        val tap = shadowOf(notification.contentIntent).savedIntent
        assertEquals(MainActivity::class.java.name, tap.component!!.className)
        assertTrue(DeepLinks.offer(tap))
        assertEquals(DeepLink.Session("s1"), DeepLinks.pending.value)
    }

    @Test
    fun aPushWithoutASessionJustOpensTheApp() {
        presentPush(context, RemotePush("Hello", "World", null, "nope", "tag-2"))

        val notification = shadowOf(manager).getNotification("tag-2", 0)
        // A channel that doesn't exist falls back to `default`.
        assertEquals(NotificationChannels.DEFAULT, notification.channelId)
        val tap = shadowOf(notification.contentIntent).savedIntent
        assertEquals(ACTION_OPEN_PUSH, tap.action)
        assertFalse(DeepLinks.offer(tap))
        assertNull(DeepLinks.pending.value)
    }

    @Test
    fun eachPushReplacesTheOneWithItsTag() {
        presentPush(context, RemotePush("One", "1", null, null, "same"))
        presentPush(context, RemotePush("Two", "2", null, null, "same"))
        assertEquals(1, shadowOf(manager).allNotifications.size)
        assertEquals("Two", shadowOf(manager).getNotification("same", 0).extras.getString(Notification.EXTRA_TITLE))
    }
}

package com.slopus.happy.push

import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.OutboxKind
import com.slopus.happy.data.OutboxRecord
import com.slopus.happy.data.OutboxState
import com.slopus.happy.sync.MessageSender
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * sync.ts's background send notifications: "Message not sent" scheduled 30 s
 * after the app goes to the background with unsent messages, cancelled on
 * return or once they are sent; "Message failed" when the watchdog fails
 * them.
 */
@RunWith(AndroidJUnit4::class)
class BackgroundSendNotificationsTest {
    private class Recorder : BackgroundSendNotices {
        val events = mutableListOf<String>()
        override fun schedulePending(delayMs: Long) {
            events += "schedule $delayMs"
        }
        override fun cancelPending() {
            events += "cancel"
        }
        override fun showFailed() {
            events += "failed"
        }
    }

    private fun row(id: String, state: OutboxState, error: String? = null) = OutboxRecord(
        localId = id, sessionId = "s", kind = OutboxKind.USER, recordJson = "{}", content = "c", createdAt = 1,
        state = state, attempts = 0, error = error, serverId = null, serverSeq = null,
    )

    private val failedInBackground = MessageSender.BACKGROUND_FAILURE

    @Test
    fun backgroundWithUnsentSchedulesOnceAndReturningCancels() {
        val recorder = Recorder()
        val watch = BackgroundSendWatch(recorder)
        watch.update(foreground = true, listOf(row("a", OutboxState.QUEUED)))
        watch.update(foreground = false, listOf(row("a", OutboxState.QUEUED)))
        watch.update(foreground = false, listOf(row("a", OutboxState.SENDING), row("b", OutboxState.QUEUED)))
        watch.update(foreground = true, listOf(row("a", OutboxState.SENDING)))
        assertEquals(listOf("schedule 30000", "cancel"), recorder.events)
    }

    @Test
    fun sendingEverythingCancelsAndNothingPendingSchedulesNothing() {
        val recorder = Recorder()
        val watch = BackgroundSendWatch(recorder)
        watch.update(foreground = false, emptyList())
        watch.update(foreground = false, listOf(row("a", OutboxState.SENT)))
        assertEquals(emptyList<String>(), recorder.events)
        watch.update(foreground = false, listOf(row("b", OutboxState.QUEUED)))
        watch.update(foreground = false, listOf(row("b", OutboxState.SENT)))
        assertEquals(listOf("schedule 30000", "cancel"), recorder.events)
    }

    @Test
    fun theWatchdogsFailureCancelsAndAnnouncesOnce() {
        val recorder = Recorder()
        val watch = BackgroundSendWatch(recorder)
        watch.update(foreground = false, listOf(row("a", OutboxState.QUEUED)))
        watch.update(foreground = false, listOf(row("a", OutboxState.FAILED, failedInBackground)))
        watch.update(foreground = true, listOf(row("a", OutboxState.FAILED, failedInBackground)))
        assertEquals(listOf("schedule 30000", "cancel", "failed"), recorder.events)
    }

    @Test
    fun aFailureOnTheReturnPastTheDeadlineIsAnnounced() {
        val recorder = Recorder()
        val watch = BackgroundSendWatch(recorder)
        watch.update(foreground = false, listOf(row("a", OutboxState.SENDING)))
        watch.update(foreground = true, listOf(row("a", OutboxState.SENDING)))
        watch.update(foreground = true, listOf(row("a", OutboxState.FAILED, failedInBackground)))
        assertEquals(listOf("schedule 30000", "cancel", "failed"), recorder.events)
    }

    @Test
    fun otherFailuresAndOnesAlreadyStoredAreNotAnnounced() {
        val recorder = Recorder()
        val watch = BackgroundSendWatch(recorder)
        watch.update(foreground = true, listOf(row("old", OutboxState.FAILED, failedInBackground)))
        watch.update(foreground = true, listOf(row("old", OutboxState.FAILED, failedInBackground), row("x", OutboxState.FAILED, "Session not found")))
        assertEquals(emptyList<String>(), recorder.events)
    }

    @Test
    fun theAlarmPostsMessageNotSentAndFailurePostsMessageFailed() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val notices = AndroidBackgroundSendNotices(context)
        val alarms = shadowOf(context.getSystemService(AlarmManager::class.java))
        val manager = shadowOf(context.getSystemService(NotificationManager::class.java))

        notices.schedulePending(30_000)
        val alarm = alarms.scheduledAlarms.single()
        assertEquals(AlarmManager.ELAPSED_REALTIME_WAKEUP, alarm.type)
        assertTrue(alarm.triggerAtTime >= SystemClock.elapsedRealtime() + 29_000)
        notices.cancelPending()
        assertNull(alarms.nextScheduledAlarm)

        BackgroundSendReceiver().onReceive(context, Intent())
        val pending = manager.getNotification("background-send", 1)
        assertEquals("Message not sent", pending.extras.getString("android.title"))
        assertEquals(NotificationChannels.DEFAULT, pending.channelId)

        notices.showFailed()
        val failed = manager.getNotification("background-send", 2)
        assertEquals("Message failed", failed.extras.getString("android.title"))
        assertEquals(
            "A message failed to send while the app was in background. Open Happy and retry.",
            failed.extras.getString("android.text"),
        )
    }
}

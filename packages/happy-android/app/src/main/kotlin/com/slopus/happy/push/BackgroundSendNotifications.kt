package com.slopus.happy.push

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.slopus.happy.AppGraph
import com.slopus.happy.MainActivity
import com.slopus.happy.R
import com.slopus.happy.data.OutboxRecord
import com.slopus.happy.data.OutboxState
import com.slopus.happy.sync.MessageSender
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** Where [BackgroundSendWatch] sends its decisions: an OS alarm and two notifications. */
interface BackgroundSendNotices {
    /** "Message not sent", [delayMs] from now, even if the process is frozen by then. */
    fun schedulePending(delayMs: Long)

    fun cancelPending()

    /** "Message failed… Open Happy and retry", now. */
    fun showFailed()
}

/**
 * sync.ts's background send watchdog notifications, beside MessageSender's
 * own watchdog (which fails the rows). While the app is in the background
 * with messages still unsent (QUEUED or SENDING), "Message not sent" is
 * scheduled 30 s out; coming back or the outbox draining cancels it. When
 * the watchdog fails rows ([MessageSender.BACKGROUND_FAILURE], in the
 * background or on the return past the deadline) the scheduled one is
 * cancelled and "Message failed" shows. Other failures (a refused send)
 * notify nothing, as in happy-app. Failures already stored at start are not
 * announced again.
 */
class BackgroundSendWatch(private val notices: BackgroundSendNotices) {
    private var scheduled = false
    private var announced: Set<String>? = null

    fun update(foreground: Boolean, outbox: List<OutboxRecord>) {
        val failed = outbox.filter { it.state == OutboxState.FAILED && it.error == MessageSender.BACKGROUND_FAILURE }.mapTo(HashSet()) { it.localId }
        val fresh = announced?.let { failed - it }.orEmpty()
        announced = failed
        if (fresh.isNotEmpty()) {
            cancel()
            notices.showFailed()
        }
        val pending = outbox.any { it.state == OutboxState.QUEUED || it.state == OutboxState.SENDING }
        if (foreground || !pending) {
            cancel()
        } else if (!scheduled) {
            scheduled = true
            notices.schedulePending(MessageSender.BACKGROUND_SEND_TIMEOUT_MS)
        }
    }

    private fun cancel() {
        if (!scheduled) return
        scheduled = false
        notices.cancelPending()
    }
}

/** Runs [BackgroundSendWatch] over the app's foreground state and every session's outbox. */
object BackgroundSendNotifications {
    private var job: Job? = null

    /** Once per process (MainActivity calls it on create). */
    @Synchronized
    fun start(context: Context, graph: AppGraph) {
        if (job != null) return
        job = watch(context, graph, CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate))
    }

    /** [start]'s watch in [scope]; tests run one per graph. */
    internal fun watch(context: Context, graph: AppGraph, scope: CoroutineScope): Job {
        val watch = BackgroundSendWatch(AndroidBackgroundSendNotices(context.applicationContext))
        val outbox: Flow<List<OutboxRecord>> = graph.store.versions
            .map { it.outbox }
            .distinctUntilChanged()
            .map { graph.store.outbox() }
            .flowOn(Dispatchers.IO)
        return scope.launch {
            combine(graph.isForeground, outbox) { foreground, rows -> foreground to rows }
                .collect { (foreground, rows) -> watch.update(foreground, rows) }
        }
    }
}

private const val TAG = "background-send"
private const val PENDING_ID = 1
private const val FAILED_ID = 2

/** Posts on push's `default` channel; a tap opens the app. */
class AndroidBackgroundSendNotices(private val context: Context) : BackgroundSendNotices {
    private val alarms get() = context.getSystemService(AlarmManager::class.java)

    private fun alarm(): PendingIntent = PendingIntent.getBroadcast(
        context,
        PENDING_ID,
        Intent(context, BackgroundSendReceiver::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    override fun schedulePending(delayMs: Long) {
        // Inexact is enough (no exact-alarm permission); it still fires while dozing.
        alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + delayMs, alarm())
    }

    override fun cancelPending() {
        alarms.cancel(alarm())
    }

    override fun showFailed() {
        post(context, FAILED_ID, R.string.push_background_send_failed_title, R.string.push_background_send_failed_body)
    }

    companion object {
        fun post(context: Context, id: Int, title: Int, body: Int) {
            val manager = NotificationManagerCompat.from(context)
            if (!manager.areNotificationsEnabled()) return
            NotificationChannels.create(context)
            val open = PendingIntent.getActivity(
                context,
                id,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val text = context.getString(body)
            val notification = NotificationCompat.Builder(context, NotificationChannels.DEFAULT)
                .setSmallIcon(R.drawable.notification_icon)
                .setContentTitle(context.getString(title))
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setSilent(isAppInForeground())
                .setContentIntent(open)
                .build()
            try {
                manager.notify(TAG, id, notification)
            } catch (_: SecurityException) {
                // POST_NOTIFICATIONS was revoked between the check and the post.
            }
        }
    }
}

/** The scheduled "Message not sent". */
class BackgroundSendReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AndroidBackgroundSendNotices.post(context, PENDING_ID, R.string.push_background_send_pending_title, R.string.push_background_send_pending_body)
    }
}

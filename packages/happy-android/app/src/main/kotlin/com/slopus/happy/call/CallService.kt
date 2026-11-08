package com.slopus.happy.call

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.slopus.happy.MainActivity
import com.slopus.happy.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * What keeps a live call going with the app behind others, the screen off or
 * another app in front: [CallService] while it lasts. Started once the
 * microphone is granted, while the app is in front (Android lets a
 * microphone foreground service start only then), and let go when the call
 * is no longer live. The service lets itself go once it is in the
 * foreground: stopping one that isn't there yet would crash the app. [keep]'s
 * `end` is the notification's Hang up.
 */
class CallKeeper(private val context: Context) {
    /** Whether the service was started for the call on now: without it the call can't hear in the background. */
    val isKept: Boolean get() = kept.value != null

    fun keep(state: StateFlow<CallState>, end: () -> Unit) {
        val already = kept.value != null
        kept.value = Kept(state, end)
        if (already) return
        try {
            ContextCompat.startForegroundService(context, Intent(context, CallService::class.java))
        } catch (error: RuntimeException) {
            // Not allowed from the background (ForegroundServiceStartNotAllowedException): the call stays a foreground one.
            Log.w(TAG, "call service not started", error)
            kept.value = null
        }
    }

    fun release() {
        kept.value = null
    }

    internal class Kept(val state: StateFlow<CallState>, val end: () -> Unit)

    companion object {
        private const val TAG = "CallKeeper"

        /** The call the service is for, if any; the service follows it. */
        internal val kept = MutableStateFlow<Kept?>(null)
    }
}

/**
 * A live call's foreground service, of type microphone: the system's
 * permission to keep capturing from the microphone with no window of ours
 * in front (Play's "communication apps" case). It holds no audio itself: the
 * call's room does. It shows the ongoing call's notification (CallStyle:
 * Happy, its clock, Hang up; a tap opens the app) and goes when the call is
 * let go or stops being live. A tap on Hang up ends the call as End does.
 */
class CallService : Service() {
    private var scope: CoroutineScope? = null
    private var following: Job? = null
    /** The call this service is for now: a later one is another's to end. */
    private var mine: CallKeeper.Kept? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val kept = CallKeeper.kept.value
        if (intent?.action == ACTION_HANG_UP) {
            kept?.end?.invoke()
            if (kept == null) stopSelf()
            return START_NOT_STICKY
        }
        // In the foreground before anything else, even for a call already let go.
        createChannel(this)
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(kept?.state?.value ?: CallState.Connecting), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } catch (error: RuntimeException) {
            // The microphone was taken away between the tap and here: nothing to keep in the background.
            Log.w(TAG, "call service not in the foreground", error)
            stopSelf()
            return START_NOT_STICKY
        }
        follow()
        return START_NOT_STICKY
    }

    /** The notification follows the kept call's muting and clock; a call let go or no longer live lets the service go. */
    @OptIn(ExperimentalCoroutinesApi::class)
    private fun follow() {
        if (following != null) return
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).also { scope = it }
        following = scope.launch {
            CallKeeper.kept.flatMapLatest { kept ->
                mine = kept
                kept?.state?.map { state -> if (shown(state) != null) kept to state else null } ?: flowOf(null)
            }.distinctUntilChanged { a, b -> a?.first === b?.first && shown(a?.second) == shown(b?.second) }.collect { shown ->
                if (shown == null) {
                    ServiceCompat.stopForeground(this@CallService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                    stopSelf()
                    return@collect
                }
                getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(shown.second))
            }
        }
    }

    override fun onDestroy() {
        scope?.cancel()
        scope = null
        // Stopped with its call still kept and live: only the system does that. The call can't hear any more, so it ends.
        val kept = mine?.takeIf { it === CallKeeper.kept.value }
        if (kept != null) {
            CallKeeper.kept.value = null
            if (kept.state.value.isLive) kept.end()
        }
        super.onDestroy()
    }

    private fun notification(state: CallState): android.app.Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val hangUp = PendingIntent.getService(
            this, 1,
            Intent(this, CallService::class.java).setAction(ACTION_HANG_UP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val caller = Person.Builder().setName(getString(R.string.call_title)).setImportant(true).build()
        val active = state as? CallState.Active
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.notification_icon)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, hangUp))
            .setContentIntent(open)
            .setContentText(
                when {
                    active == null -> getString(R.string.voice_status_bar_connecting)
                    active.held -> getString(R.string.call_on_hold)
                    active.muted -> getString(R.string.call_muted)
                    else -> null
                },
            )
            .apply {
                if (active != null) {
                    setUsesChronometer(true)
                    setWhen(System.currentTimeMillis() - (SystemClock.elapsedRealtime() - active.since))
                } else {
                    setShowWhen(false)
                }
            }
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        private const val TAG = "CallService"
        const val CHANNEL = "calls"
        private const val NOTIFICATION_ID = 0x63616c6c
        private const val ACTION_HANG_UP = "com.slopus.happy.call.HANG_UP"

        /** What the notification shows; null once the call isn't live. */
        private fun shown(state: CallState?): Any? = when (state) {
            CallState.Connecting -> state
            is CallState.Active -> Triple(state.muted, state.held, state.since)
            else -> null
        }

        /** The ongoing call's channel: quiet, it only says a call is on. */
        fun createChannel(context: Context) {
            val channel = NotificationChannel(CHANNEL, context.getString(R.string.call_voice_call), NotificationManager.IMPORTANCE_LOW)
            channel.setShowBadge(false)
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}

package com.slopus.happy.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.LocaleList
import android.text.format.DateFormat
import androidx.core.content.ContextCompat
import com.slopus.happy.push.InstallationId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale
import java.util.TimeZone

/**
 * App wiring only: the open connection's computer is told this phone's
 * environment ([UserEnvironmentReports.report]) when it is opened, when the
 * app comes back to the foreground, and when the time zone or locale
 * changes. Another connection is told when it is opened. Each is told only
 * what changed since it was last told.
 */
class UserEnvironmentRuntime(
    private val context: Context,
    private val openId: StateFlow<String?>,
    private val foreground: StateFlow<Boolean>,
    private val client: (String) -> AgentClient?,
    private val installation: InstallationId,
    private val scope: CoroutineScope,
) {
    private val changes = MutableStateFlow(0)

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            changes.value += 1
        }
    }

    fun start() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_TIMEZONE_CHANGED)
            addAction(Intent.ACTION_LOCALE_CHANGED)
        }
        // System broadcasts still reach a receiver no other app can.
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        scope.launch {
            combine(openId, foreground, changes) { id, front, _ -> id.takeIf { front } }.collectLatest { id ->
                val agent = id?.let(client) ?: return@collectLatest
                try {
                    withContext(Dispatchers.IO) { agent.environment.report(agent, current(), installation.getOrCreate()) }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Told again at the next open, foreground or change.
                }
            }
        }
    }

    private fun current(): UserEnvironment {
        val tablet = context.resources.configuration.smallestScreenWidthDp >= 600
        val languages = LocaleList.getDefault().let { list -> List(list.size()) { list[it] } }
        return UserEnvironment.of(
            kind = if (tablet) UserEnvironment.DeviceKind.Tablet else UserEnvironment.DeviceKind.Phone,
            zone = TimeZone.getDefault(),
            locale = Locale.getDefault(Locale.Category.FORMAT),
            languages = languages,
            twentyFourHour = DateFormat.is24HourFormat(context),
        )
    }
}

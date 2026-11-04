package com.slopus.happy.ui.monitor

import androidx.lifecycle.ViewModel
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.monitor.SystemMonitorFeed
import com.slopus.happy.monitor.SystemMonitorSample
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The navigation entry keeps a feed across recreation. Its own scope lives
 * just long enough to persist the last reading after the entry is removed:
 * cancelling viewModelScope first would lose that final write. Only a
 * resumed screen asks for readings or follows reconnects.
 */
internal class MonitorModel(private val session: AgentSession, surfaceId: String) : ViewModel() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val key = "system-monitor:$surfaceId"
    val feed = SystemMonitorFeed(
        scope = scope,
        fetch = {
            val answer = session.client.send("GET", SystemMonitorFeed.path(surfaceId))
            AgentClient.json.decodeFromString(SystemMonitorSample.serializer(), answer.text)
        },
        kept = { withContext(Dispatchers.IO) { session.cachedResource(key) } },
        keep = { withContext(Dispatchers.IO) { session.keepResource(key, it) } },
    )
    private var watching: Job? = null

    fun resume() {
        feed.resume()
        if (watching?.isActive == true) return
        watching = scope.launch { session.status.collect { if (it == AgentLinkStatus.Connected) feed.poke() } }
    }

    fun pause() {
        watching?.cancel()
        watching = null
        feed.pause()
    }

    override fun onCleared() {
        watching?.cancel()
        scope.launch { try { feed.pause().join() } finally { scope.cancel() } }
    }
}
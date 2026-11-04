package com.slopus.happy.ui.calendar

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.calendar.CalendarFeed
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One navigation entry's range reader; both journal listening and reads pause with the screen. */
internal class CalendarModel(private val session: AgentSession) : ViewModel() {
    val feed = CalendarFeed(viewModelScope,
        fetch = { range ->
            AgentClient.json.parseToJsonElement(session.client.send("GET", range.path).text).obj
                ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        },
        kept = { withContext(Dispatchers.IO) { session.cachedResource(it) } },
        keep = { key, value -> withContext(Dispatchers.IO) { session.keepResource(key, value) } },
    )
    private var watching: Job? = null

    fun resume() {
        if (watching?.isActive == true) return
        // Subscribe before starting a range read: an event arriving during
        // that read must invalidate its expanded occurrences.
        watching = viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            session.events.collect { event ->
                when {
                    event.type == AgentEvent.HELLO -> feed.invalidate()
                    event.type.startsWith("calendar_event.") -> {
                        val surfaceId = event.data["surfaceId"].str ?: event.data["event"].obj?.get("surfaceId").str
                        if (surfaceId != null) feed.invalidate(surfaceId)
                    }
                }
            }
        }
        feed.resume()
    }

    fun pause() {
        watching?.cancel()
        watching = null
        feed.pause()
    }
}
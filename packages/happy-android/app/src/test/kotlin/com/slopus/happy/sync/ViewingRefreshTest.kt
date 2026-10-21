package com.slopus.happy.sync

import com.slopus.happy.testing.cancelAndAwait
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.net.ConnectionStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections

/**
 * sync.ts on resume and on reconnect: the open chat is refreshed
 * (onSessionVisible for currentViewingSessionId), its git status included.
 * [AccountSync.viewingRefreshed] names it each time; a closed chat isn't named.
 */
@RunWith(AndroidJUnit4::class)
class ViewingRefreshTest {
    private lateinit var h: AccountHarness
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val refreshed = Collections.synchronizedList(mutableListOf<Set<String>>())

    @Before
    fun setUp() {
        h = AccountHarness()
        h.server.addSession("s1", updatedAt = 100)
        h.server.addSession("s2", updatedAt = 90)
    }

    @After
    fun tearDown() {
        scope.cancelAndAwait()
        h.close()
    }

    private fun follow() {
        // UNDISPATCHED: subscribed before launch returns, so no refresh can beat the collector.
        scope.launch(start = CoroutineStart.UNDISPATCHED) { h.account.viewingRefreshed.collect { refreshed += it } }
    }

    /** A StateFlow conflates: the app must be seen in the background before it comes back. */
    private fun background() {
        h.foreground.value = false
        while (h.server.awaitEvent("app-state")?.jsonObject?.get("state")?.jsonPrimitive?.content != "background") Unit
    }

    @Test
    fun theOpenChatIsRefreshedOnResumeAndOnReconnect() {
        h.startAndSync()
        val chat = scope.launch { h.account.messages.messages("s1").collect {} }
        eventually(message = "chat open") { h.account.messages.viewingSessionIds() == setOf("s1") }
        follow()

        background()
        h.foreground.value = true
        eventually(message = "resume") { refreshed.toList() == listOf(setOf("s1")) }

        h.server.dropSockets()
        eventually(message = "reconnect") { refreshed.size >= 2 && h.account.connectionStatus.value == ConnectionStatus.CONNECTED }
        assertEquals(setOf("s1"), refreshed.last())

        chat.cancel()
        eventually(message = "chat closed") { h.account.messages.viewingSessionIds().isEmpty() }
        val before = refreshed.size
        background()
        h.foreground.value = true
        Thread.sleep(200)
        assertEquals(before, refreshed.size)
    }
}

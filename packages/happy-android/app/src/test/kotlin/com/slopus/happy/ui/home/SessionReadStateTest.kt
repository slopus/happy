package com.slopus.happy.ui.home

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.runtime.CompositionLocalProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.model.AgentAttention
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.testing.SoftwareKeys
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** storage.ts applySessions' unread detector and setCurrentViewingSession. */
@RunWith(AndroidJUnit4::class)
class SessionReadStateTest {
    @get:Rule
    val rule = createComposeRule()

    private val reads = SessionReadState()

    @Test
    fun aChatThatStopsWorkingTurnsUnread() {
        reads.observe(listOf(session("a", thinking = true), session("b")))
        reads.observe(listOf(session("a"), session("b")))
        assertEquals(setOf("a"), reads.unreadSessionIds.value)
    }

    @Test
    fun aGrantedPermissionCountsAsWorkFinished() {
        reads.observe(listOf(session("a", attention = AgentAttention(1, 0))))
        reads.observe(listOf(session("a")))
        assertEquals(setOf("a"), reads.unreadSessionIds.value)
    }

    @Test
    fun goingOfflineOrStillWorkingIsNotFinishing() {
        reads.observe(listOf(session("a", thinking = true), session("b", thinking = true)))
        // a went offline mid-turn; b now waits on a permission.
        reads.observe(listOf(session("a", active = false), session("b", attention = AgentAttention(1, 0))))
        assertEquals(emptySet<String>(), reads.unreadSessionIds.value)
    }

    @Test
    fun theFirstListIsOnlyABaseline() {
        reads.observe(listOf(session("a")))
        assertEquals(emptySet<String>(), reads.unreadSessionIds.value)
    }

    @Test
    fun theViewedChatNeverTurnsUnreadAndViewingReads() {
        reads.observe(listOf(session("a", thinking = true), session("b", thinking = true)))
        reads.setViewing("a")
        reads.observe(listOf(session("a"), session("b")))
        assertEquals(setOf("b"), reads.unreadSessionIds.value)
        reads.setViewing("b")
        assertEquals(emptySet<String>(), reads.unreadSessionIds.value)
        // Releasing a chat that is no longer viewed leaves the viewed one alone.
        reads.release("a")
        assertEquals("b", reads.viewingSessionId.value)
    }

    @Test
    fun resetForgetsEverything() {
        reads.observe(listOf(session("a", thinking = true)))
        reads.observe(listOf(session("a")))
        reads.setViewing("x")
        reads.reset()
        assertEquals(emptySet<String>(), reads.unreadSessionIds.value)
        assertNull(reads.viewingSessionId.value)
        // The next list is a new baseline.
        reads.observe(listOf(session("a")))
        assertEquals(emptySet<String>(), reads.unreadSessionIds.value)
    }

    // useSessionVisibility: the claim survives a screen pushed over the chat and ends with its entry.
    @Test
    fun viewingEffectHoldsUntilTheEntryIsDestroyed() {
        val graph = AppGraph(
            context = ApplicationProvider.getApplicationContext(),
            clientId = "android/test",
            defaultServerUrl = "http://localhost:1",
            secureStoreKeys = SoftwareKeys(),
            databaseName = null,
        )
        val shared = HomeServices.of(graph).reads
        val entry = object : LifecycleOwner {
            val registry = LifecycleRegistry.createUnsafe(this).apply { currentState = Lifecycle.State.RESUMED }
            override val lifecycle: Lifecycle get() = registry
        }
        var shown by mutableStateOf(true)
        rule.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides entry) {
                if (shown) SessionViewingEffect(graph, "a")
            }
        }
        rule.waitForIdle()
        assertEquals("a", shared.viewingSessionId.value)
        // Covered by session info: out of the composition, the entry only stopped.
        entry.registry.currentState = Lifecycle.State.CREATED
        shown = false
        rule.waitForIdle()
        assertEquals("a", shared.viewingSessionId.value)
        // Popped.
        entry.registry.currentState = Lifecycle.State.DESTROYED
        rule.waitForIdle()
        assertNull(shared.viewingSessionId.value)
    }
}

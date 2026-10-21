package com.slopus.happy.voice

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.sync.StoredMessages
import com.slopus.happy.sync.StoredSource
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class StoreVoiceContextTest {
    private fun session(id: String) = SessionRecord(id, 0, 0, 0, true, 0,
        """{"path":"/work","host":"host","summary":{"text":"$id","updatedAt":0}}""", 0, null, 0, "", null)
    private fun message(id: String, seq: Long, text: String) = MessageRecord(id, seq, "$id-$seq", null,
        """{"role":"user","content":{"type":"text","text":"$text"}}""", seq, seq)

    @Test fun connectsWithBoundedCurrentHistoryThenHydratesFocusedAndLiveBackgroundSessions() = runTest {
        val database = HappyDatabase(ApplicationProvider.getApplicationContext<Context>(), null)
        try {
            val store = HappyStore(database)
            store.upsertSessions(listOf(session("a"), session("b"), session("c")))
            store.insertMessages("a", (1L..80L).map { message("a", it, "current-$it") })
            store.insertMessages("b", listOf(message("b", 1, "background-history")))
            val stored = MutableSharedFlow<StoredMessages>()
            val sent = mutableListOf<String>()
            val connection = object : VoiceConnection {
                override val conversationId = "c"
                override suspend fun end() {}
                override fun context(text: String) { sent += text }
                override fun prompt(text: String) { sent += "PROMPT:$text" }
                override suspend fun mute(muted: Boolean) {}
            }
            val dispatcher = StandardTestDispatcher(testScheduler)
            val source = StoreVoiceContext(store, stored, backgroundScope, dispatcher, dispatcher, {})
            val initial = source.initial("a")
            assertTrue(initial.contains("current-80")); assertFalse(initial.contains("current-30"))
            assertFalse(initial.contains("background-history"))
            // A message during the SDK handshake must not disappear between initial context and connect.
            val duringConnect = message("a", 81, "during-connect")
            store.insertMessages("a", listOf(duringConnect))
            stored.emit(StoredMessages("a", listOf(duringConnect)))
            source.connected(connection, VoiceMode.Idle); runCurrent()
            assertTrue(sent.any { it.contains("during-connect") })
            source.focus("b")
            assertTrue(sent.any { it.contains("background-history") })
            val before = sent.size
            source.focus("b")
            assertEquals(before + 1, sent.size) // Focus marker only, no duplicate full context.
            val background = message("c", 1, "new-background")
            store.insertMessages("c", listOf(background))
            stored.emit(StoredMessages("c", listOf(background))); runCurrent()
            assertTrue(sent.any { it.contains("New messages in session: c") && it.contains("new-background") })
            val preload = message("c", 2, "silent-preload")
            store.insertMessages("c", listOf(preload))
            val count = sent.size
            stored.emit(StoredMessages("c", listOf(preload), StoredSource.PRELOAD)); runCurrent()
            assertEquals(count, sent.size)
            source.stop(); runCurrent()
        } finally { database.close() }
    }
}
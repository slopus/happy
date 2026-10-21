package com.slopus.happy.chat

import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.OutboxKind
import com.slopus.happy.data.OutboxRecord
import com.slopus.happy.data.OutboxState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.SessionState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatFeedTest {
    private fun user(id: String, text: String, at: Long, localId: String? = null) = MessageRecord(
        "s", at, id, localId, """{"role":"user","content":{"type":"text","text":${quote(text)}}}""", at, at,
    )

    private fun agent(id: String, text: String, at: Long, thinking: Boolean = false) = MessageRecord(
        "s", at, id, null,
        """{"role":"session","content":{"id":"e-$id","time":$at,"role":"agent","turn":"t","ev":{"t":"text","text":${quote(text)}${if (thinking) ""","thinking":true""" else ""}}}}""",
        at, at,
    )

    private fun quote(text: String) = kotlinx.serialization.json.JsonPrimitive(text).toString()

    private fun session(metadata: String? = """{"path":"/home/me/app","host":"box"}""", agentState: String? = null, active: Boolean = true) =
        SessionRecord("s", 0, 1, 1, active, 5, metadata, 1, agentState, 1, "", null)

    private fun send(localId: String, text: String, state: OutboxState, error: String? = null) = OutboxRecord(
        localId, "s", OutboxKind.USER, """{"role":"user","content":{"type":"text","text":${quote(text)}}}""", "", 5, state, 1, error, null, null,
    )

    /** A send shows from the outbox, then becomes its echo without a second row or a rebuild. */
    // happy-app's normalizer drops what it cannot read; the transcript draws nothing for it.
    @Test
    fun unsupportedRecordsAreNotDrawn() {
        assertEquals(null, ChatReduction.buildRow(ChatMessage.Unsupported("x", 0, "agent.codex.message"), isClaudeFlavor = false))
    }

    @Test
    fun anOutboxSendTurnsIntoItsEcho() {
        val reduction = ChatReduction { 0 }
        val info = ChatSessionInfo.from(session())
        val queued = reduction.apply(ChatPage(emptyList(), outbox = listOf(send("L", "hi", OutboxState.QUEUED))), info)
        val row = queued.rows.single() as ChatRow.User
        assertTrue(row.message.pending)
        val stored = reduction.apply(ChatPage(listOf(user("S", "hi", 6, localId = "L")), outbox = listOf(send("L", "hi", OutboxState.SENT))), info)
        val echoed = stored.rows.single() as ChatRow.User
        assertEquals(row.message.id, echoed.message.id)
        assertFalse(echoed.message.pending)
        assertEquals(1, reduction.apply(ChatPage(listOf(user("S", "hi", 6, localId = "L"))), info).rows.size)
    }

    @Test
    fun aFailedSendCarriesItsErrorAndGoesWhenDiscarded() {
        val reduction = ChatReduction { 0 }
        val info = ChatSessionInfo.from(session())
        val failed = reduction.apply(ChatPage(listOf(user("u1", "earlier", 1)), outbox = listOf(send("L", "hi", OutboxState.FAILED, "HTTP 500"))), info)
        val row = failed.rows.first() as ChatRow.User
        assertEquals("HTTP 500", row.message.sendError)
        assertEquals("L", row.failedLocalId)
        val discarded = reduction.apply(ChatPage(listOf(user("u1", "earlier", 1))), info)
        assertEquals(listOf("earlier"), discarded.rows.map { (it as ChatRow.User).message.text })
    }

    @Test
    fun rowsAreNewestFirstAndHideThinking() {
        val reduction = ChatReduction { 0 }
        val snapshot = reduction.apply(
            ChatPage(listOf(user("u1", "hello", 1), agent("a1", "pondering", 2, thinking = true), agent("a2", "**hi** there", 3))),
            ChatSessionInfo.from(session()),
        )
        assertEquals(listOf(ChatRow.AgentText::class, ChatRow.User::class), snapshot.rows.map { it::class })
        val agentRow = snapshot.rows[0] as ChatRow.AgentText
        assertEquals("**hi** there", agentRow.message.text)
        assertTrue(agentRow.blocks.isNotEmpty())
    }

    @Test
    fun unchangedRowsKeepTheirIdentity() {
        val reduction = ChatReduction { 0 }
        val info = ChatSessionInfo.from(session())
        val first = reduction.apply(ChatPage(listOf(user("u1", "hello", 1))), info)
        val second = reduction.apply(ChatPage(listOf(user("u1", "hello", 1), agent("a1", "reply", 2))), info)
        assertEquals(2, second.rows.size)
        assertSame(first.rows[0], second.rows[1])
        // Nothing new: the same snapshot comes back.
        assertSame(second, reduction.apply(ChatPage(listOf(user("u1", "hello", 1), agent("a1", "reply", 2))), info))
    }

    @Test
    fun removedRecordsRebuildFromScratch() {
        val reduction = ChatReduction { 0 }
        val info = ChatSessionInfo.from(session())
        reduction.apply(ChatPage(listOf(user("u1", "one", 1), user("u2", "two", 2))), info)
        val after = reduction.apply(ChatPage(listOf(user("u2", "two", 2))), info)
        assertEquals(listOf("two"), after.rows.map { ((it as ChatRow.User).display as UserDisplay.Text).text })
    }

    @Test
    fun slashCommandWrappersBecomeChipsAndCaveatsVanish() {
        val reduction = ChatReduction { 0 }
        val snapshot = reduction.apply(
            ChatPage(
                listOf(
                    user("c", "<local-command-caveat>Caveat: generated</local-command-caveat>", 1),
                    user("r", "<command-name>/compact</command-name><command-message>compact</command-message><command-args>keep it short</command-args>", 2),
                ),
            ),
            ChatSessionInfo.from(session()),
        )
        val display = (snapshot.rows.single() as ChatRow.User).display as UserDisplay.Command
        assertEquals("compact", display.commandName)
        assertEquals("keep it short", display.args)
    }

    @Test
    fun loadedFollowsThePage() {
        val reduction = ChatReduction { 0 }
        assertFalse(reduction.apply(ChatPage(emptyList(), loaded = false), null).loaded)
        assertTrue(reduction.apply(ChatPage(emptyList(), hasMoreOlder = true), null).let { it.loaded && it.hasMoreOlder })
    }

    @Test
    fun sessionStateFollowsAgentStateAndPresence() {
        val requests = """{"requests":{"r1":{"tool":"Bash","arguments":{},"createdAt":1}}}"""
        val info = ChatSessionInfo.from(session(agentState = requests))
        assertEquals(SessionState.PermissionRequired, ChatState(session = info, online = true).sessionState)
        assertEquals(SessionState.Disconnected, ChatState(session = info, online = false).sessionState)
        assertEquals(SessionState.Thinking, ChatState(session = ChatSessionInfo.from(session()), online = true, thinking = true).sessionState)
    }

    @Test
    fun sessionInfoReadsTheSharedMetadata() {
        val info = ChatSessionInfo.from(session("""{"path":"/p","host":"h","summary":{"text":"Fix the bug","updatedAt":1},"flavor":"codex"}"""))
        assertEquals("Fix the bug", info.title)
        assertFalse(info.isClaudeFlavor)
        assertTrue(info.usesControlledSessionUi)
        val rig = ChatSessionInfo.from(
            session(
                """{"path":"/p","host":"h","client":{"id":"rig","name":"Happy Agent","version":"1"},"rigMetadataVersion":1}""",
            ),
        )
        assertTrue(rig.isRig)
        assertFalse(rig.usesControlledSessionUi)
    }

    @Test
    fun feedCombinesMessagesSessionAndPresence() = runBlocking {
        val records = MutableStateFlow(ChatPage(listOf(user("u1", "hello", 1))))
        val record = MutableStateFlow<SessionRecord?>(session(active = false))
        val live = MutableStateFlow<SessionPresenceState?>(null)
        val feed = ChatFeed(
            messages = object : ChatMessagesSource {
                override fun messages(sessionId: String): Flow<ChatPage> = records
                override suspend fun loadOlder(sessionId: String) = false
            },
            sessions = object : ChatSessionSource {
                override fun session(sessionId: String): Flow<SessionRecord?> = record
            },
            presence = object : ChatPresenceSource {
                override fun presence(sessionId: String): Flow<SessionPresenceState?> = live
            },
        )
        val offline = feed.state("s").first { it.sessionLoaded && it.snapshot.rows.isNotEmpty() }
        assertFalse(offline.online)
        assertEquals(5, offline.activeAt)
        live.value = SessionPresenceState(online = true, thinking = true, activeAt = 9)
        val thinking = feed.state("s").first { it.thinking }
        assertTrue(thinking.online)
        assertEquals(SessionState.Thinking, thinking.sessionState)
        record.value = null
        val deleted = feed.state("s").first { it.sessionLoaded && it.session == null }
        assertEquals(1, deleted.snapshot.rows.size)
    }
}

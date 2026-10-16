package com.slopus.happy.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** happy-app's sync/reducer/pendingUserMessages.spec.ts. */
class PendingUserMessagesTest {
    private val hold = ReducerOptions(holdUserMessagesUntilAccepted = true)
    private val state = ReducerState()

    private fun optimistic(localId: String, text: String, createdAt: Long) = userMsg(localId, text, localId = localId, createdAt = createdAt)
    private fun echo(serverId: String, localId: String, text: String, createdAt: Long) = userMsg(serverId, text, localId = localId, createdAt = createdAt)
    private fun receipt(id: String, ref: String, createdAt: Long) = eventMsg(id, AgentEvent.UserMessageAccepted(ref), createdAt)
    private fun agentText(id: String, text: String, createdAt: Long, turn: String? = null) = agentMsg(id, createdAt, text(text, id), turn = turn)
    private fun reduce(vararg messages: NormalizedMessage) = state.reduce(messages.toList(), null, hold)
    private fun List<ChatMessage>.user() = filterIsInstance<ChatMessage.UserText>().single()
    private fun order(rows: Collection<ChatMessage>) = rows.sortedBy { it.sortKey }.map {
        when (it) {
            is ChatMessage.UserText -> "USER"
            is ChatMessage.AgentText -> it.text
            else -> it.javaClass.simpleName
        }
    }

    @Test fun `keeps the send-time queue decision through history and acceptance`() {
        for (queued in listOf(false, true)) {
            val s = ReducerState()
            val restored = ChatNormalizer.normalize("server-1", "local-1", 1000, json("""{"role":"user","content":{"type":"text","text":"hello"},"meta":{"expectsAcceptance":true,"queuedWhileBusy":$queued}}"""))!!
            val pending = s.reduce(listOf(restored), null, hold).messages.user()
            assertTrue(pending.pending)
            assertEquals(queued, pending.meta?.queuedWhileBusy)
            val settled = s.reduce(listOf(receipt("accepted:1", "server-1", 2000)), null, hold).messages.user()
            assertFalse(settled.pending)
            assertEquals(queued, settled.meta?.queuedWhileBusy)
        }
    }

    @Test fun `a rejected message stays failed across reload, whichever arrives first`() {
        val failed = ChatNormalizer.normalize(
            "relay-refusal", "rig:refused:server-1", 3000,
            json("""{"role":"session","content":{"id":"refused:server-1","time":3000,"role":"agent","ev":{"t":"user-message-rejected","ref":"server-1","reason":"That model is not available."}},"meta":{"sentFrom":"rig"}}"""),
        )
        assertNotNull(failed)
        val sent = echo("server-1", "local-1", "try this", 1000).copy(meta = MessageMeta.of(json("""{"expectsAcceptance":true}""")))
        for (batches in listOf(listOf(failed!!, sent), listOf(sent, failed))) {
            val s = ReducerState()
            val visible = LinkedHashMap<String, ChatMessage>()
            for (message in batches) for (row in s.reduce(listOf(message), null, hold).messages) visible[row.id] = row
            val row = visible.values.single() as ChatMessage.UserText
            assertEquals(1000L, row.createdAt)
            assertEquals(3000L, row.sortAt)
            assertEquals("That model is not available.", row.sendError)
            assertFalse(row.pending)
        }
    }

    @Test fun `holds a just-sent message and parks it below everything else`() {
        val message = reduce(optimistic("local-1", "steer me", 1000)).messages.user()
        assertTrue(message.pending)
        assertTrue(message.sortKey > System.currentTimeMillis())
        assertEquals(1000L, message.createdAt)
    }

    @Test fun `commits at once in a session that never reports acceptance`() {
        val message = state.reduce(optimistic("local-1", "hello", 1000)).messages.user()
        assertFalse(message.pending)
        assertEquals(1000L, message.sortKey)
    }

    @Test fun `releases the message at the receipt's position`() {
        reduce(optimistic("local-1", "steer me", 1000))
        reduce(echo("server-1", "local-1", "steer me", 1000))
        val released = reduce(receipt("accepted:1", "server-1", 5000))
        val message = released.messages.single() as ChatMessage.UserText
        assertFalse(message.pending)
        assertEquals(5000L, message.sortKey)
        assertEquals(1000L, message.createdAt)
        assertEquals(setOf(message.id), released.settledMessageIds)
    }

    @Test fun `releases the message when the receipt outruns the echo`() {
        reduce(optimistic("local-1", "steer me", 1000))
        assertEquals(0, reduce(receipt("accepted:1", "server-1", 5000)).messages.size)
        val message = reduce(echo("server-1", "local-1", "steer me", 1000)).messages.user()
        assertFalse(message.pending)
        assertEquals(5000L, message.sortKey)
    }

    @Test fun `ignores a receipt for a message this device never sent`() {
        assertEquals(0, reduce(receipt("accepted:9", "server-from-laptop", 5000)).messages.size)
    }

    @Test fun `keeps the interrupted turn above the message and the new turn below it`() {
        val collected = LinkedHashMap<String, ChatMessage>()
        fun collect(result: ReducerResult) = result.messages.forEach { collected[it.id] = it }
        collect(reduce(agentText("a1", "thinking about the old question", 1000)))
        collect(reduce(optimistic("local-1", "actually, do this instead", 2000)))
        collect(reduce(agentText("a2", "still answering the old question", 3000)))
        collect(reduce(echo("server-1", "local-1", "actually, do this instead", 2000)))
        collect(reduce(receipt("accepted:1", "server-1", 4000)))
        collect(reduce(agentText("a3", "on the new instruction now", 5000)))
        assertEquals(
            listOf("thinking about the old question", "still answering the old question", "USER", "on the new instruction now"),
            order(collected.values),
        )
    }

    @Test fun `never holds a message replayed from history`() {
        val message = reduce(echo("server-7", "local-7", "from last week", 1000)).messages.user()
        assertFalse(message.pending)
        assertEquals(1000L, message.sortKey)
    }

    @Test fun `restores pending only for history sent with receipts enabled`() {
        val restored = ChatNormalizer.normalize("server-1", "local-1", 1000, json("""{"role":"user","content":{"type":"text","text":"still waiting"},"meta":{"expectsAcceptance":true}}"""))!!
        val rows = reduce(restored, agentText("tail", "older turn", 2000)).messages.sortedByDescending { it.sortKey }
        assertTrue((rows[0] as ChatMessage.UserText).pending)
        val settled = reduce(receipt("accepted:1", "server-1", 3000)).messages.user()
        assertFalse(settled.pending)
        assertEquals(3000L, settled.sortKey)
        assertFalse(ReducerState().reduce(restored).messages.user().pending)
    }

    @Test fun `keeps messages in receipt order whatever the delivery order`() {
        for (delivery in listOf("receipt-first", "ack-first", "same-batch")) {
            val s = ReducerState()
            val visible = LinkedHashMap<String, ChatMessage>()
            fun collect(result: ReducerResult) = result.messages.forEach { visible[it.id] = it }
            val local = optimistic("local-1", "steer", 1000)
            val accepted = receipt("accepted:1", "server-1", 3000)
            val tail = agentText("tail", "old tail", 2000, turn = "old")
            val answer = agentText("answer", "new answer", 4000, turn = "new")
            val ack = listOf("server-1" to "local-1")
            when (delivery) {
                "receipt-first" -> {
                    collect(s.reduce(listOf(accepted), null, hold))
                    s.registerUserMessageServerIds(ack)
                    collect(s.reduce(listOf(local, tail, answer), null, hold))
                }
                "ack-first" -> {
                    collect(s.reduce(listOf(local, tail), null, hold))
                    s.registerUserMessageServerIds(ack)
                    collect(s.reduce(listOf(accepted, answer), null, hold))
                }
                else -> collect(s.reduce(listOf(local, echo("server-1", "local-1", "steer", 1000), tail, accepted, answer), null, hold))
            }
            assertEquals(delivery, listOf("old tail", "USER", "new answer"), order(visible.values))
            assertEquals(delivery, 3000L, (visible.values.single { it is ChatMessage.UserText } as ChatMessage.UserText).sortAt)
        }
    }

    @Test fun `settles from the receipt the daemon puts on the wire`() {
        val wire = ChatNormalizer.normalize(
            "server-receipt-1", "rig:accepted:msg-1", 4000,
            json("""{"role":"session","content":{"id":"accepted:msg-1","time":4000,"role":"agent","ev":{"t":"user-message-accepted","id":"msg-1","ref":"server-1","runId":"run-1"}},"meta":{"sentFrom":"rig"}}"""),
        )!!
        reduce(optimistic("local-1", "steer me", 1000))
        reduce(echo("server-1", "local-1", "steer me", 1000))
        val message = reduce(wire).messages.user()
        assertFalse(message.pending)
        assertEquals(4000L, message.sortKey)
    }

    @Test fun `settles through the send ack when the echo never arrives`() {
        reduce(optimistic("local-1", "steer me", 1000))
        assertEquals(0, state.registerUserMessageServerIds(listOf("server-1" to "local-1")).size)
        val message = reduce(receipt("accepted:1", "server-1", 5000)).messages.user()
        assertFalse(message.pending)
        assertEquals(5000L, message.sortKey)
    }

    @Test fun `keeps an ack that outran the optimistic insert`() {
        state.registerUserMessageServerIds(listOf("server-1" to "local-1"))
        reduce(receipt("accepted:1", "server-1", 5000))
        val message = reduce(optimistic("local-1", "steer me", 1000)).messages.user()
        assertFalse(message.pending)
        assertEquals(5000L, message.sortKey)
    }

    @Test fun `gives a replayed message its run-order place on a fresh reload`() {
        val result = reduce(
            agentText("a1", "old turn tail", 3000),
            echo("server-1", "local-1", "steer me", 1000),
            receipt("accepted:1", "server-1", 4000),
            agentText("a3", "new turn", 5000),
        )
        assertEquals(listOf("old turn tail", "USER", "new turn"), order(result.messages))
    }

    @Test fun `never repositions a message twice`() {
        reduce(optimistic("local-1", "steer me", 1000))
        reduce(echo("server-1", "local-1", "steer me", 1000))
        reduce(receipt("accepted:1", "server-1", 5000))
        assertEquals(0, reduce(receipt("accepted:replay", "server-1", 9000)).messages.size)
        assertEquals(5000L, state.snapshot().single().sortKey)
    }

    @Test fun `another participant's message is not this account's own`() {
        val other = ChatMessage.UserText("1", null, 0, "hi", author = SessionAuthor("u2", "Sam"))
        val own = other.copy(author = SessionAuthor("u1", "Me", owner = true))
        assertTrue(other.isOtherParticipant)
        assertFalse(own.isOtherParticipant)
        assertFalse(other.copy(author = null).isOtherParticipant)
        assertNull(own.sendError)
    }
}

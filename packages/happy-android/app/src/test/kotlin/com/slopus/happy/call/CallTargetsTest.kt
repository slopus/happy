package com.slopus.happy.call

import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.Wire
import com.slopus.happy.agent.WireDesktopBootstrap
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.FailureReason
import com.slopus.happy.conversation.ToolUse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a call reads of home and of one conversation (iOS `CallContextTests`' directory and complete-words cases). */
class CallTargetsTest {
    @Test
    fun theDirectoryIsHomesConversationsNestedAsItShowsThem() {
        val feed = sidebar()
        val list = CallTarget.from(feed)
        // Exactly the rows that open a conversation, in their order: no filter of the call's own.
        assertEquals(feed.conversations.map { it.agentId }, list.map { it.agentId })
        assertEquals(listOf("arch-agent", "t1-agent", "sub1", "subsub", "t2-agent", "root", "wchat"), list.map { it.agentId })
        assertEquals(
            listOf(CallTarget.Kind.Bot, CallTarget.Kind.Task, CallTarget.Kind.Subtask, CallTarget.Kind.Subtask, CallTarget.Kind.Task,
                CallTarget.Kind.Conversation, CallTarget.Kind.Conversation),
            list.map { it.kind },
        )
        assertEquals(listOf("Release notes", "Fix cache race"), list[3].parents.map { it.title })
        assertEquals(listOf("App", "Feature"), list[6].parents.map { it.title })
        assertEquals(listOf("project", "workspace"), list[6].parents.map { it.kind })
        // Home's own label, a placeholder too.
        assertEquals("New Task", list[4].title)
    }

    @Test
    fun aRowWithoutANameIsUntitledOnOneLine() {
        val feed = AgentFeed(true, listOf(
            AgentFeedRow.Conversation("x", null, com.slopus.happy.agent.ConversationKind.Task, 0),
            AgentFeedRow.Conversation("y", "Two\nlines\tand a tab", com.slopus.happy.agent.ConversationKind.Task, 0, blocked = true),
            AgentFeedRow.Conversation("x", "Twice", com.slopus.happy.agent.ConversationKind.Task, 0),
        ))
        val list = CallTarget.from(feed)
        assertEquals(listOf("Untitled", "Two lines and a tab"), list.map { it.title })
        assertEquals(CallTarget.Status.NeedsInput, list[1].status)
        assertEquals(CallTarget.TITLE_BYTES, CallTarget.clean("é".repeat(300)).toByteArray().size)
    }

    // Complete words, by their own run

    private fun user(id: String, text: String, delivery: Delivery = Delivery.Sent) = ConversationRow.User("$id:user", id, text, emptyList(), emptyList(), delivery)
    private fun said(key: String, text: String) = ConversationRow.Text(key, text, emptyList())
    private fun tool(key: String) = ConversationRow.Tool(key, key, ToolUse("exec_command", "running"))
    private fun end(turn: String, copy: String? = null, reason: String = "completed") = ConversationRow.TurnEnd("$turn:end", turn, reason, 5, 0, copy)
    private val target = CallTarget("a", "A", CallTarget.Kind.Task, CallTarget.Status.Idle)

    /** [rows] as a conversation reads, oldest first, published newest first as [com.slopus.happy.conversation.Conversation] does. */
    private fun conversation(rows: List<ConversationRow>, working: Boolean = true, draft: String = "") =
        ConversationState(created = true, loaded = true, working = working, rows = rows.asReversed(), draft = draft)

    private fun read(rows: List<ConversationRow>, working: Boolean = true) =
        CallTargetState.from(conversation(rows, working), target)

    private fun finals(rows: List<ConversationRow>, working: Boolean = true) =
        read(rows, working).messages.filter { it.role == CallMessage.Role.Assistant }.associate { it.id to it.final }

    /** Complete once the agent went on past them, or its run is over; the person's message coming in after says nothing of that. */
    @Test
    fun wordsAreCompleteOnceTheAgentWentOnPastThem() {
        val rows = mutableListOf<ConversationRow>(said("m1:0", "Checking"))
        assertEquals(mapOf("m1:0" to false), finals(rows))
        // The person's message after them: still being written.
        rows += user("u", "hurry", Delivery.Sending)
        assertEquals(mapOf("m1:0" to false), finals(rows))
        // A tool call after them: complete.
        rows.add(1, tool("t"))
        assertEquals(mapOf("m1:0" to true), finals(rows))
        // More words after the call: those are the ones still growing.
        rows.add(2, said("m2:0", "Found it"))
        assertEquals(mapOf("m1:0" to true, "m2:0" to false), finals(rows))
        assertEquals(mapOf("m1:0" to true, "m2:0" to true), finals(rows, working = false))
    }

    /** The person's new message while the agent writes completes nothing, queued on the phone or taken by the computer. */
    @Test
    fun thePersonsMessageMidStreamCompletesNothing() {
        val streaming = listOf(user("u1", "fix it"), said("a1:0", "Looking"))
        assertEquals(mapOf("a1:0" to false), finals(streaming))
        assertEquals(mapOf("a1:0" to false), finals(streaming + user("u2", "and the tests", Delivery.Sending)))
        assertEquals(mapOf("a1:0" to false), finals(streaming + user("u2", "and the tests", Delivery.Pending)))
    }

    /** A turn end that the next run follows at once, still working: the last run's words are complete and of it, the new run's still grow. */
    @Test
    fun aRunThatStartsTheNextCompletesTheLastOnesWords() {
        val first = listOf(user("u1", "fix it"), said("a1:0", "Done."), end("r1", "Done."))
        assertEquals(mapOf("a1:0" to true), finals(first + user("u2", "next")))
        // When the run ended is the turn's: what lastAgentReply says.
        val timed = (first.last() as ConversationRow.TurnEnd).copy(endedAt = 1_700_000_000_000)
        assertEquals(listOf(1_700_000_000_000L), read(first.dropLast(1) + timed).turns.map { it.endedAt })
        assertEquals(mapOf("a1:0" to true, "a2:0" to false), finals(first + said("a2:0", "On it")))
        val state = read(first + said("a2:0", "On it"))
        assertEquals("r1", state.messages.first { it.id == "a1:0" }.turn)
        assertNull(state.messages.first { it.id == "a2:0" }.turn)
    }

    /** Anything that isn't the agent's own next step in that run (another agent reporting in) completes nothing. */
    @Test
    fun unrelatedChangesCompleteNothing() {
        val streaming = listOf(user("u1", "fix it"), said("a1:0", "Looking"))
        assertEquals(mapOf("a1:0" to false), finals(streaming + ConversationRow.Collaborator("co", "other", "hi", emptyList())))
    }

    @Test
    fun aConversationReadsAsTurnsOfPublicWordsOnly() {
        val rows = listOf(
            user("u1", "fix it"),
            said("a1:0", "Looking"),
            tool("t1"),
            said("a2:0", "Fixed."),
            end("r1", "Fixed."),
            user("u2", "again"),
            ConversationRow.Failure("f", "f", FailureReason.RateLimited("Claude"), retryable = true, resolved = false),
            end("r2", reason = "error"),
            user("u3", "hello", Delivery.Sending),
            said("x:0", "thinking out loud"),
        )
        val state = CallTargetState.from(conversation(rows, draft = "half typed"), target) { reason -> "rate limited: ${(reason as FailureReason.RateLimited).vendor}" }
        assertEquals(listOf(CallTurn("r1", "fix it", "Fixed."), CallTurn("r2", "again", null, "error", "rate limited: Claude")), state.turns)
        assertEquals("hello", state.unanswered?.text)
        assertEquals(CallMessage.Delivery.Queued, state.unanswered?.delivery)
        assertEquals(listOf("Looking", "Fixed.", "thinking out loud"), state.messages.filter { it.role == CallMessage.Role.Assistant }.map { it.text })
        assertEquals(listOf("r1", "r1", null), state.messages.filter { it.role == CallMessage.Role.Assistant }.map { it.turn })
        assertFalse(state.messages.last().final)
        assertTrue(state.hasDraft)
        assertTrue(state.writable)
        assertEquals(CallTarget.Status.Running, state.target.status)
    }

    companion object {
        /**
         * Home from a bootstrap: a bot, a task with a subtask with its own,
         * an archived subtask, a task nobody has named, an archived task, a
         * project with a worktree. Places (Artifacts, todos) open no
         * conversation.
         */
        fun sidebar(): AgentFeed {
            val snapshot = Wire.bootstrap(
                bots = listOf(Wire.bot("arch", "Architect", Wire.agent("arch-agent"))),
                tasks = listOf(
                    Wire.task("t1", "Release notes", Wire.agent("t1-agent", subtasks = listOf(
                        Wire.agent("sub1", title = "Fix cache race", subtask = true, parent = "t1-agent", subtasks = listOf(
                            Wire.agent("subsub", title = "Check the lock", subtask = true, parent = "sub1"),
                        )),
                        Wire.agent("gone", title = "Archived one", subtask = true, parent = "t1-agent", archivedAt = 1),
                    ))),
                    Wire.task("t2", "New Task", Wire.agent("t2-agent")),
                    Wire.task("t3", "Old", Wire.agent("t3-agent"), archived = true),
                ),
                memberships = listOf(Wire.membership("t1", "1"), Wire.membership("t2", "2"), Wire.membership("t3", "3")),
                projects = listOf(Wire.project("p1", "App", listOf(Wire.agent("root", title = "Root chat")))),
                workspaces = listOf(Wire.workspace("w1", "p1", "Feature", listOf(Wire.agent("wchat", title = "Feature chat")))),
            )
            val catalog = AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), snapshot))
            return AgentFeed.derive(catalog)
        }
    }
}

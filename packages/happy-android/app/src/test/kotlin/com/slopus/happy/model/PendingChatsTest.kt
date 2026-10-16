package com.slopus.happy.model

import com.slopus.happy.chat.AgentState
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.sync.HappyAgentSpawnTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingChatsTest {
    private fun pending(id: String, known: List<String>, createdAt: Long = 0, anchor: String = "a", sessionId: String? = null, status: PendingChatStatus = PendingChatStatus.Starting) =
        PendingChat(PENDING_CHAT_PREFIX + id, anchor, sessionId, known, status, createdAt = createdAt)

    private fun session(metadata: String) = Session(
        id = "s", seq = 0, createdAt = 0, updatedAt = 0, active = true, activeAt = 0, projectId = null,
        metadata = SessionMetadata.parse(metadata), metadataVersion = 0, attention = AgentAttention.None, agentStateVersion = 0,
    )

    @Test
    fun aStandInIdIsNeverASessionId() {
        assertTrue(isPendingChatId(PENDING_CHAT_PREFIX + "x"))
        assertFalse(isPendingChatId("session-1"))
    }

    /** worktreeTabs.ts resolveWorktreeTabs: an arrival a stand-in already stands for waits behind it; a named stand-in is gone. */
    @Test
    fun oneChatIsOneTab() {
        val tabs = listOf(SessionRowData("a"), SessionRowData("b"), SessionRowData("new"))
        val resolved = resolveWorktreeTabs(tabs, listOf(pending("p1", known = listOf("a", "b"))))
        assertEquals(listOf("a", "b"), resolved.tabs.map { it.id })
        assertEquals(listOf(PENDING_CHAT_PREFIX + "p1"), resolved.pending.map { it.id })

        // Two starts, one arrival: the older stand-in claims it; the newer still shows.
        val two = resolveWorktreeTabs(tabs, listOf(pending("p1", listOf("a", "b")), pending("p2", listOf("a", "b"))))
        assertEquals(listOf("a", "b"), two.tabs.map { it.id })
        assertEquals(2, two.pending.size)

        val settled = resolveWorktreeTabs(tabs, listOf(pending("p1", listOf("a", "b"), sessionId = "new")))
        assertEquals(listOf("a", "b", "new"), settled.tabs.map { it.id })
        assertTrue(settled.pending.isEmpty())
    }

    @Test
    fun aCheckoutsStandInsAreTheStartingOnesBesideItsTabsOldestFirst() {
        val chats = listOf(
            pending("late", listOf("a"), createdAt = 2),
            pending("early", listOf("a"), createdAt = 1),
            pending("failed", listOf("a"), status = PendingChatStatus.Failed),
            pending("elsewhere", listOf("z"), anchor = "z"),
        )
        assertEquals(listOf("early", "late").map { PENDING_CHAT_PREFIX + it }, pendingChatsBeside(chats, listOf("a", "b")).map { it.id })
    }

    /** newSessionCheckout.ts newSessionLikeSession: the chat's own directory and harness, the composer's picks, nothing typed. */
    @Test
    fun aNewChatLikeThisOneRunsWhereItRuns() {
        val request = newSessionLikeSession(
            session("""{"path":"/home/u/proj/sub","host":"h","homeDir":"/home/u","machineId":"m1","flavor":"codex"}"""),
            ComposerMirror(draft = "typed", permissionMode = "read-only", modelMode = "gpt-5", effortLevel = "high"),
        )
        val draft = request.draft
        assertNull(request.target)
        assertEquals("", draft.input)
        assertEquals("m1", draft.selectedMachineId)
        assertEquals("~/proj/sub", draft.selectedPath)
        assertEquals(AgentType.Codex, draft.agentType)
        assertEquals("read-only", draft.permissionMode)
        assertEquals("gpt-5", draft.modelMode)
        assertEquals("high", draft.effortLevel)
        assertEquals(SessionType.Simple, draft.sessionType)
        assertNull(draft.worktreeKey)

        assertEquals(AgentType.Claude, newSessionLikeSession(session("""{"path":"/p","host":"h"}"""), null).draft.agentType)
    }

    @Test
    fun aHappyAgentChatIsToldItsWorkspaceElseItsProject() {
        val client = """"client":{"id":"rig","name":"Happy Agent","version":"1"}"""
        val workspace = newSessionLikeSession(
            session("""{"path":"/p","host":"h",$client,"workspace":{"id":"w1","kind":"workspace","name":"W"},"project":{"id":"p1","kind":"project","name":"P"},"permissionMode":"yolo"}"""),
            null,
        )
        assertEquals(AgentType.Rig, workspace.draft.agentType)
        assertEquals(SpawnTargetOverride(HappyAgentSpawnTarget.Workspace("w1")), workspace.target)
        assertEquals("yolo", workspace.draft.permissionMode)

        val project = newSessionLikeSession(session("""{"path":"/p","host":"h",$client,"project":{"id":"p1","kind":"project","name":"P"}}"""), null)
        assertEquals(SpawnTargetOverride(HappyAgentSpawnTarget.Project("p1")), project.target)

        // Neither: a plain directory, said explicitly.
        assertEquals(SpawnTargetOverride(null), newSessionLikeSession(session("""{"path":"/p","host":"h",$client}"""), null).target)
    }

    /** storageTypes.ts AgentGoalStatusSchema: only an active goal from a known source, its capabilities as booleans. */
    @Test
    fun theAgentGoalIsParsedBesideTheRestOfTheState() {
        val state = AgentState.parse(
            """{"controlledByUser":true,"agentGoalStatus":{"status":"active","source":"codex","sourceSessionId":" t1 ","text":" Ship it ",
               "capabilities":{"edit":true,"stop":"yes","clear":true}}}""",
        )!!
        assertTrue(state.controlledByUser)
        assertEquals(AgentGoal("codex", "t1", "Ship it", setOf(AgentGoalAction.Edit, AgentGoalAction.Clear)), state.agentGoal)
        assertEquals(listOf(AgentGoalAction.Edit, AgentGoalAction.Clear), state.agentGoal!!.offeredActions())

        // A bad goal drops only the goal.
        val bad = AgentState.parse("""{"controlledByUser":true,"agentGoalStatus":{"status":"active","source":"gemini","sourceSessionId":"t","text":"x"}}""")!!
        assertTrue(bad.controlledByUser)
        assertNull(bad.agentGoal)
        assertNull(AgentState.parse("""{"agentGoalStatus":{"status":"inactive","source":"codex","sourceSessionId":"t","text":"x"}}""")!!.agentGoal)
        assertNull(AgentState.parse("""{"agentGoalStatus":"active"}""")!!.agentGoal)
    }

    /** resolveVisibleAgentGoalStatus: online, and set by the agent session the chat runs now. */
    @Test
    fun aGoalShowsOnlyForTheRunningAgentSession() {
        val goal = AgentGoal("claude", "c1", "Goal")
        val metadata = SessionMetadata.parse("""{"path":"/p","host":"h","claudeSessionId":"c1","codexThreadId":"t9"}""")
        assertEquals(goal, visibleAgentGoal(goal, online = true, metadata))
        assertNull(visibleAgentGoal(goal, online = false, metadata))
        assertNull(visibleAgentGoal(goal.copy(sourceSessionId = "old"), online = true, metadata))
        assertEquals("t9", visibleAgentGoal(goal.copy(source = "codex", sourceSessionId = "t9"), online = true, metadata)?.sourceSessionId)
        assertNull(visibleAgentGoal(goal, online = true, null))
    }
}

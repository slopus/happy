package com.slopus.happy.ui.home

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.HappyAgentSpawnTarget
import com.slopus.happy.model.HomeModelFixtures.cliAvailability
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.Machine
import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.SessionType
import com.slopus.happy.model.Settings
import com.slopus.happy.model.StartPhase
import com.slopus.happy.model.WorktreeSelection
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * useStartSessionFromDraft with fake machine and session RPCs: what it
 * refuses before asking a machine, the request it builds, pending answers
 * retried, a missing directory offered, a worktree made first, Stop handing
 * the composer back while a late session is stopped, and the draft's text
 * cleared only when it was what got sent.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class SessionStarterTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private val cli = machine(
        "m1",
        machineMetadata { put("displayName", "Studio"); cliAvailability(claude = true, codex = true) },
    )
    private val rig = machine(
        "r1",
        machineMetadata {
            put("machineKind", "rig")
            putJsonObject("capabilities") { put("newSession", true); put("worktrees", true) }
        },
    )

    private class FakeMachines : MachineActions {
        val spawns = mutableListOf<SpawnRequest>()
        val worktrees = mutableListOf<Pair<String, String>>()
        val stopped = mutableListOf<Pair<String, String>>()
        var answers = ArrayDeque<suspend () -> SpawnOutcome>()
        var worktree: WorktreeOutcome = WorktreeOutcome.Created("/Users/dev/code/.worktrees/w")
        /** The starter's phase each time it asked for something. */
        val phases = mutableListOf<StartPhase?>()
        var phase: () -> StartPhase? = { null }

        override suspend fun spawnSession(request: SpawnRequest): SpawnOutcome {
            phases += phase()
            spawns += request
            return answers.removeFirstOrNull()?.invoke() ?: SpawnOutcome.Success("s1")
        }

        override suspend fun createWorktree(machineId: String, basePath: String): WorktreeOutcome {
            phases += phase()
            worktrees += machineId to basePath
            return worktree
        }

        override suspend fun stopSession(machineId: String, sessionId: String): ActionResult {
            stopped += machineId to sessionId
            return ActionResult.Success
        }

        override suspend fun stopDaemon(machineId: String): ActionResult = ActionResult.Success
    }

    private class FakeSessions : SessionActions {
        val killed = mutableListOf<String>()
        override suspend fun kill(sessionId: String): ActionResult = ActionResult.Success.also { killed += sessionId }
        override suspend fun archiveOnServer(sessionId: String): ActionResult = ActionResult.Success
        override suspend fun delete(sessionId: String): ActionResult = ActionResult.Success
    }

    private class Harness(
        val starter: SessionStarter,
        val drafts: NewSessionDraftStore,
        val machines: FakeMachines,
        val sessions: FakeSessions,
        val sent: MutableList<Pair<String, String>>,
    ) {
        val phases get() = machines.phases
    }

    private fun TestScope.harness(
        machines: List<Machine> = listOf(cli),
        draft: NewSessionDraft,
        send: suspend (NewSessionDraftStore) -> Boolean = { true },
    ): Harness {
        val prefs = context.getSharedPreferences(NewSessionDraftStore.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val drafts = NewSessionDraftStore(prefs) { 7 }
        drafts.change { draft }
        val fakeMachines = FakeMachines()
        val fakeSessions = FakeSessions()
        val sent = mutableListOf<Pair<String, String>>()
        val starter = SessionStarter(
            machines = { machines },
            sessions = { emptyList() },
            settings = { Settings() },
            drafts = drafts,
            machineActions = fakeMachines,
            sessionActions = fakeSessions,
            sender = { id, text -> sent += id to text; send(drafts) },
            awaitSession = { fakeMachines.phases += fakeMachines.phase(); true },
            scope = this,
            requestId = { "request-1" },
        )
        fakeMachines.phase = { starter.phase.value }
        return Harness(starter, drafts, fakeMachines, fakeSessions, sent)
    }

    private val yes: suspend (String) -> Boolean = { true }

    @Test fun refusesBeforeAskingAnyMachine() = runTest {
        suspend fun refusal(draft: NewSessionDraft, machines: List<Machine> = listOf(cli)) =
            harness(machines, draft).let { h -> h.starter.start(confirmDirectory = yes).also { assertTrue(h.machines.spawns.isEmpty()) } }
        assertEquals(StartResult.Refused(StartRefusal.NoMachine), refusal(NewSessionDraft()))
        assertEquals(StartResult.Refused(StartRefusal.UnknownMachine), refusal(NewSessionDraft(selectedMachineId = "gone")))
        assertEquals(
            StartResult.Refused(StartRefusal.HappyCliOffline),
            refusal(NewSessionDraft(selectedMachineId = "m1"), listOf(cli.copy(active = false))),
        )
        assertEquals(
            StartResult.Refused(StartRefusal.ProjectNeedsHappyAgent),
            refusal(NewSessionDraft(selectedMachineId = "m1", selectedProjectId = "p1")),
        )
        val rigCannotStart = machine("r1", machineMetadata { put("machineKind", "rig") })
        assertEquals(StartResult.Refused(StartRefusal.CannotStartHappyAgent), refusal(NewSessionDraft(selectedMachineId = "r1"), listOf(rigCannotStart)))
    }

    @Test fun spawnsInTheResolvedDirectorySendsThePromptAndClearsTheDraft() = runTest {
        val h = harness(draft = NewSessionDraft(input = " fix the build ", selectedMachineId = "m1", selectedPath = "~/code", agentType = AgentType.Codex))
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        val request = h.machines.spawns.single()
        assertEquals("m1", request.machineId)
        assertEquals(AgentType.Codex, request.agent)
        assertEquals("/Users/dev/code", request.directory)
        assertFalse(request.approvedNewDirectoryCreation)
        assertNull(request.happyAgentTarget)
        assertEquals("request-1", request.clientRequestId)
        assertEquals(listOf("s1" to "fix the build"), h.sent)
        assertEquals("", h.drafts.draft.value.input)
        assertEquals("~/code", h.drafts.draft.value.selectedPath)
        assertEquals(listOf(StartPhase.Spawning, StartPhase.Opening), h.phases)
        assertNull(h.starter.phase.value)
    }

    @Test fun textTypedWhileStartingStaysInTheDraft() = runTest {
        val h = harness(draft = NewSessionDraft(input = "first", selectedMachineId = "m1")) { drafts ->
            drafts.change { it.copy(input = "second thought") }
            true
        }
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals("second thought", h.drafts.draft.value.input)
    }

    @Test fun retriesPendingAnswersWithTheSameRequestId() = runTest {
        val h = harness(draft = NewSessionDraft(selectedMachineId = "m1"))
        h.machines.answers.addAll(listOf({ SpawnOutcome.Pending(500) }, { SpawnOutcome.Pending(null) }))
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(3, h.machines.spawns.size)
        assertEquals(setOf("request-1"), h.machines.spawns.map { it.clientRequestId }.toSet())
        // No prompt, nothing to send.
        assertTrue(h.sent.isEmpty())
    }

    @Test fun offersToCreateAMissingDirectory() = runTest {
        val approved = harness(draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "/new"))
        approved.machines.answers.add { SpawnOutcome.ApproveDirectory("/new") }
        val asked = mutableListOf<String>()
        assertEquals(StartResult.Started("s1"), approved.starter.start { asked += it; true })
        assertEquals(listOf("/new"), asked)
        assertEquals(listOf(false, true), approved.machines.spawns.map { it.approvedNewDirectoryCreation })

        val declined = harness(draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "/new"))
        declined.machines.answers.add { SpawnOutcome.ApproveDirectory("/new") }
        assertEquals(StartResult.Abandoned, declined.starter.start { false })
        assertEquals(1, declined.machines.spawns.size)
    }

    @Test fun createsTheWorktreeFirstAndSpawnsInsideIt() = runTest {
        val h = harness(
            draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "/Users/dev/code", sessionType = SessionType.Worktree, worktreeKey = WorktreeSelection.NEW),
        )
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(listOf("m1" to "/Users/dev/code"), h.machines.worktrees)
        assertEquals("/Users/dev/code/.worktrees/w", h.machines.spawns.single().directory)
        assertEquals(listOf(StartPhase.Worktree, StartPhase.Spawning, StartPhase.Opening), h.phases)

        val failed = harness(draft = h.drafts.draft.value)
        failed.machines.worktree = WorktreeOutcome.Failed("not a git repository")
        assertEquals(StartResult.Failed("not a git repository"), failed.starter.start(confirmDirectory = yes))
        assertTrue(failed.machines.spawns.isEmpty())
    }

    @Test fun happyAgentStartsInItsProjectByIdentity() = runTest {
        val h = harness(listOf(rig), NewSessionDraft(selectedMachineId = "r1", selectedProjectId = "p1", agentType = AgentType.Claude))
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        val request = h.machines.spawns.single()
        assertEquals(AgentType.Rig, request.agent)
        assertEquals(HappyAgentSpawnTarget.Project("p1"), request.happyAgentTarget)
        // Happy Agent resolves its own catalog defaults.
        assertNull(request.modelMode)
        assertTrue(h.machines.worktrees.isEmpty())
    }

    @Test fun stopHandsBackAtOnceAndStopsTheSessionThatArrivesLater() = runTest {
        val h = harness(draft = NewSessionDraft(input = "hi", selectedMachineId = "m1"))
        val late = CompletableDeferred<SpawnOutcome>()
        h.machines.answers.add { late.await() }
        val result = async { h.starter.start(confirmDirectory = yes) }
        runCurrent()
        assertEquals(StartPhase.Spawning, h.starter.phase.value)
        h.starter.cancel()
        assertNull(h.starter.phase.value)
        runCurrent()
        assertEquals(StartResult.Abandoned, result.await())

        late.complete(SpawnOutcome.Success("late"))
        advanceUntilIdle()
        assertEquals(listOf("m1" to "late"), h.machines.stopped)
        assertTrue(h.sent.isEmpty())
        assertEquals("the composer keeps its text", "hi", h.drafts.draft.value.input)
    }

    @Test fun stopWhileOpeningStopsTheSessionItAlreadyHas() = runTest {
        val opened = CompletableDeferred<Boolean>()
        val prefs = context.getSharedPreferences(NewSessionDraftStore.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val drafts = NewSessionDraftStore(prefs).apply { change { NewSessionDraft(input = "hi", selectedMachineId = "r1", agentType = AgentType.Rig) } }
        val machines = FakeMachines()
        val sessions = FakeSessions()
        val starter = SessionStarter(
            { listOf(rig) }, { emptyList() }, { Settings() }, drafts, machines, sessions,
            { _, _ -> true }, { opened.await() }, this,
        )
        val result = async { starter.start(confirmDirectory = yes) }
        runCurrent()
        assertEquals(StartPhase.Opening, starter.phase.value)
        starter.cancel()
        advanceUntilIdle()
        assertEquals(StartResult.Abandoned, result.await())
        // Happy Agent's session is killed, not asked of the daemon.
        assertEquals(listOf("s1"), sessions.killed)
        assertTrue(machines.stopped.isEmpty())
    }
}

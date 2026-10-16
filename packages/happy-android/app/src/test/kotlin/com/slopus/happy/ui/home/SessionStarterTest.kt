package com.slopus.happy.ui.home

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.attachments.AttachmentNotice
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.BotRequest
import com.slopus.happy.model.GitWorktree
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.HappyAgentSpawnTarget
import com.slopus.happy.sync.SendException
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.SpawnSessionOptions
import com.slopus.happy.sync.SpawnSessionResult
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
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.putJsonArray
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
 * cleared only when it was what got sent. Images go with the first message,
 * on their own too; an agent that takes none leaves the session for the
 * next Send, and what the images ran into comes back with the result.
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
            putJsonObject("defaults") { put("providerId", "codex"); put("modelId", "gpt"); put("permissionMode", "auto") }
            putJsonArray("models") {
                addJsonObject {
                    put("code", "gpt"); put("value", "GPT"); put("providerId", "codex"); put("id", "gpt")
                    putJsonArray("thinkingLevels") { add("low"); add("high") }
                    put("defaultThinkingLevel", "high")
                }
            }
            putJsonArray("operatingModes") {
                addJsonObject { put("code", "auto"); put("value", "Auto") }
                addJsonObject { put("code", "read_only"); put("value", "Read only") }
            }
        },
    )

    /** The same Happy Agent, new enough to make bots. */
    private val botRig = machine(
        "b1",
        machineMetadata {
            put("machineKind", "rig")
            putJsonObject("capabilities") { put("newSession", true); put("worktrees", true); put("bots", true) }
            putJsonObject("defaults") { put("providerId", "codex"); put("modelId", "gpt"); put("permissionMode", "auto") }
            putJsonArray("models") {
                addJsonObject {
                    put("code", "gpt"); put("value", "GPT"); put("providerId", "codex"); put("id", "gpt")
                    putJsonArray("thinkingLevels") { add("low"); add("high") }
                    put("defaultThinkingLevel", "high")
                }
            }
            putJsonArray("operatingModes") {
                addJsonObject { put("code", "auto"); put("value", "Auto") }
                addJsonObject { put("code", "read_only"); put("value", "Read only") }
            }
        },
    )

    private class FakeMachines : MachineActions {
        val spawns = mutableListOf<SpawnSessionOptions>()
        val worktrees = mutableListOf<Pair<String, String>>()
        val stopped = mutableListOf<Pair<String, String>>()
        var answers = ArrayDeque<suspend () -> SpawnSessionResult>()
        var worktree: WorktreeOutcome = WorktreeOutcome.Created("/Users/dev/code/.dev/worktree/calm-river", "calm-river")
        /** The starter's phase each time it asked for something. */
        val phases = mutableListOf<StartPhase?>()
        var phase: () -> StartPhase? = { null }

        override suspend fun spawnSession(options: SpawnSessionOptions): SpawnSessionResult {
            phases += phase()
            spawns += options
            return answers.removeFirstOrNull()?.invoke() ?: SpawnSessionResult.Success("s1")
        }

        override suspend fun createWorktree(machineId: String, basePath: String): WorktreeOutcome {
            phases += phase()
            worktrees += machineId to basePath
            return worktree
        }

        override suspend fun listWorktrees(machineId: String, basePath: String): List<GitWorktree> = emptyList()

        override suspend fun stopSession(machineId: String, sessionId: String): OpResult {
            stopped += machineId to sessionId
            return OpResult(true)
        }
    }

    private class FakeSessions : SessionActions {
        val killed = mutableListOf<String>()
        override suspend fun kill(sessionId: String): OpResult = OpResult(true).also { killed += sessionId }
        override suspend fun archiveOnServer(sessionId: String): OpResult = OpResult(true)
        override suspend fun delete(sessionId: String): OpResult = OpResult(true)
    }

    private class FakeSender(private val onSend: suspend () -> Boolean) : FirstMessageSender {
        val sent = mutableListOf<Pair<String, String>>()
        val attachments = mutableListOf<List<AttachmentPreview>>()
        var notices = emptyList<AttachmentNotice>()
        val pinned = mutableListOf<Pair<String, Map<AgentModeField, String?>>>()

        override suspend fun pinModes(sessionId: String, modes: Map<AgentModeField, String?>) {
            pinned += sessionId to modes
        }

        override suspend fun send(sessionId: String, text: String, attachments: List<AttachmentPreview>, isCurrent: () -> Boolean): FirstSend {
            sent += sessionId to text
            this.attachments += attachments
            return FirstSend(onSend(), notices)
        }
    }

    private class Harness(
        val starter: SessionStarter,
        val drafts: NewSessionDraftStore,
        val machines: FakeMachines,
        val sessions: FakeSessions,
        val sender: FakeSender,
    ) {
        val sent get() = sender.sent
        val phases get() = machines.phases
    }

    private fun TestScope.harness(
        machines: List<Machine> = listOf(cli),
        draft: NewSessionDraft,
        faces: BotFaceWearer = BotFaceWearer { _, _ -> null },
        send: suspend (NewSessionDraftStore) -> Boolean = { true },
    ): Harness {
        val prefs = context.getSharedPreferences(NewSessionDraftStore.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val drafts = NewSessionDraftStore(prefs) { 7 }
        drafts.change { draft }
        val fakeMachines = FakeMachines()
        val fakeSessions = FakeSessions()
        val sender = FakeSender { send(drafts) }
        val starter = SessionStarter(
            machines = { machines },
            sessions = { emptyList() },
            settings = { Settings() },
            drafts = drafts,
            machineActions = fakeMachines,
            sessionActions = fakeSessions,
            sender = sender,
            awaitSession = { fakeMachines.phases += fakeMachines.phase(); true },
            scope = this,
            requestId = { "request-1" },
            faces = faces,
        )
        fakeMachines.phase = { starter.phase.value }
        return Harness(starter, drafts, fakeMachines, fakeSessions, sender)
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
        assertEquals("codex", request.agent)
        assertEquals("/Users/dev/code", request.directory)
        assertFalse(request.approvedNewDirectoryCreation)
        assertNull(request.happyAgentTarget)
        assertEquals("request-1", request.clientRequestId)
        assertEquals(listOf("s1" to "fix the build"), h.sent)
        assertEquals("", h.drafts.draft.value.input)
        assertEquals("~/code", h.drafts.draft.value.selectedPath)
        assertEquals(listOf(StartPhase.Spawning, StartPhase.Opening), h.phases)
        assertNull(h.starter.phase.value)
        // The launch picks are pinned on the session before the send (useStartSessionFromDraft).
        val (pinnedId, modes) = h.sender.pinned.single()
        assertEquals("s1", pinnedId)
        assertEquals(request.permissionMode, modes[AgentModeField.PERMISSION_MODE])
        assertTrue(modes.containsKey(AgentModeField.MODEL_MODE))
    }

    @Test fun aRefusedFirstMessageKeepsTheSessionForTheNextSend() = runTest {
        var refuse = true
        val h = harness(draft = NewSessionDraft(input = "hi", selectedMachineId = "m1")) {
            if (refuse) throw SendException("The session has not synced yet.")
            true
        }
        assertEquals(StartResult.Failed("The session has not synced yet."), h.starter.start(confirmDirectory = yes))
        assertEquals("hi", h.drafts.draft.value.input)
        refuse = false
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals("spawned once", 1, h.machines.spawns.size)
        assertEquals(listOf("s1" to "hi", "s1" to "hi"), h.sent)
        assertEquals("", h.drafts.draft.value.input)
    }

    private val image = AttachmentPreview("i1", "file:///cache/a.jpg", 10, 20, "image/jpeg", 100, "a.jpg")

    @Test fun imagesGoWithTheFirstMessageEvenWithoutText() = runTest {
        val h = harness(draft = NewSessionDraft(selectedMachineId = "m1"))
        h.sender.notices = listOf(AttachmentNotice.UploadFailed(1))
        assertEquals(
            StartResult.Started("s1", listOf(AttachmentNotice.UploadFailed(1))),
            h.starter.start(attachments = listOf(image), confirmDirectory = yes),
        )
        assertEquals(listOf("s1" to ""), h.sent)
        assertEquals(listOf(listOf(image)), h.sender.attachments)
    }

    @Test fun anAgentThatTakesNoImagesKeepsTheSessionForTheNextSend() = runTest {
        var accepts = false
        val h = harness(draft = NewSessionDraft(selectedMachineId = "m1")) { accepts }
        h.sender.notices = listOf(AttachmentNotice.NotSupported)
        assertEquals(StartResult.NotSent(listOf(AttachmentNotice.NotSupported)), h.starter.start(attachments = listOf(image), confirmDirectory = yes))
        h.drafts.change { it.copy(input = "describe it instead") }
        accepts = true
        h.sender.notices = emptyList()
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals("spawned once", 1, h.machines.spawns.size)
        assertEquals(listOf("s1" to "", "s1" to "describe it instead"), h.sent)
    }

    @Test fun happyAgentPicksRideTheSpawnNotTheSession() = runTest {
        val h = harness(listOf(rig), NewSessionDraft(input = "go", selectedMachineId = "r1", agentType = AgentType.Rig))
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertTrue(h.sender.pinned.isEmpty())
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
        h.machines.answers.addAll(listOf({ SpawnSessionResult.Pending("request-1", 500) }, { SpawnSessionResult.Pending("request-1", 0) }))
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(3, h.machines.spawns.size)
        assertEquals(setOf("request-1"), h.machines.spawns.map { it.clientRequestId }.toSet())
        // No prompt, nothing to send.
        assertTrue(h.sent.isEmpty())
    }

    @Test fun offersToCreateAMissingDirectory() = runTest {
        val approved = harness(draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "/new"))
        approved.machines.answers.add { SpawnSessionResult.RequestToApproveDirectoryCreation("/new") }
        val asked = mutableListOf<String>()
        assertEquals(StartResult.Started("s1"), approved.starter.start { asked += it; true })
        assertEquals(listOf("/new"), asked)
        assertEquals(listOf(false, true), approved.machines.spawns.map { it.approvedNewDirectoryCreation })

        val declined = harness(draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "/new"))
        declined.machines.answers.add { SpawnSessionResult.RequestToApproveDirectoryCreation("/new") }
        assertEquals(StartResult.Abandoned, declined.starter.start { false })
        assertEquals(1, declined.machines.spawns.size)
    }

    @Test fun createsTheWorktreeFirstAndSpawnsInsideIt() = runTest {
        val h = harness(
            draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "/Users/dev/code", sessionType = SessionType.Worktree, worktreeKey = WorktreeSelection.NEW),
        )
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        assertEquals(listOf("m1" to "/Users/dev/code"), h.machines.worktrees)
        assertEquals("/Users/dev/code/.dev/worktree/calm-river", h.machines.spawns.single().directory)
        assertEquals(listOf(StartPhase.Worktree, StartPhase.Spawning, StartPhase.Opening), h.phases)

        val failed = harness(draft = h.drafts.draft.value)
        failed.machines.worktree = WorktreeOutcome.Failed("not a git repository")
        assertEquals(StartResult.Failed("not a git repository"), failed.starter.start(confirmDirectory = yes))
        assertTrue(failed.machines.spawns.isEmpty())
    }

    @Test fun happyAgentStartsInItsProjectByIdentity() = runTest {
        val h = harness(
            listOf(rig),
            NewSessionDraft(selectedMachineId = "r1", selectedProjectId = "p1", agentType = AgentType.Claude, modelMode = "claude-opus-5-5", permissionMode = "read_only"),
        )
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        val request = h.machines.spawns.single()
        assertEquals("rig", request.agent)
        assertEquals(HappyAgentSpawnTarget.Project("p1"), request.happyAgentTarget)
        // The harness changed, so Happy Agent's own catalog defaults apply, not Claude's picks.
        assertEquals(listOf("codex", "gpt", "auto", "high"), listOf(request.providerId, request.modelId, request.permissionMode, request.effort))
        assertNull(request.modelMode)
        assertTrue(h.machines.worktrees.isEmpty())
    }

    @Test fun happyAgentKeepsThePicksItsCatalogStillOffers() = runTest {
        val h = harness(
            listOf(rig),
            NewSessionDraft(selectedMachineId = "r1", agentType = AgentType.Rig, modelMode = "codex:gone", permissionMode = "read_only", effortLevel = "low"),
        )
        assertEquals(StartResult.Started("s1"), h.starter.start(confirmDirectory = yes))
        val request = h.machines.spawns.single()
        assertEquals(listOf("codex", "gpt", "read_only", "low"), listOf(request.providerId, request.modelId, request.permissionMode, request.effort))
        // A plain directory: no catalog destination.
        assertNull(request.happyAgentTarget)
    }

    @Test fun stopHandsBackAtOnceAndStopsTheSessionThatArrivesLater() = runTest {
        val h = harness(draft = NewSessionDraft(input = "hi", selectedMachineId = "m1"))
        val late = CompletableDeferred<SpawnSessionResult>()
        h.machines.answers.add { late.await() }
        val result = async { h.starter.start(confirmDirectory = yes) }
        runCurrent()
        assertEquals(StartPhase.Spawning, h.starter.phase.value)
        h.starter.cancel()
        assertNull(h.starter.phase.value)
        runCurrent()
        assertEquals(StartResult.Abandoned, result.await())

        late.complete(SpawnSessionResult.Success("late"))
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
            FakeSender { true }, { opened.await() }, this,
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

    /**
     * useStartSessionFromDraft's bot: Happy Agent's spawn with the bot as its
     * destination, whatever harness the draft chose; no first message (the
     * prompt stays in the draft); then "Putting on a face…". A face that
     * fails is reported, never a reason to lose the bot.
     */
    @Test fun aBotIsMadeOnHappyAgentThenWearsItsFace() = runTest {
        val worn = mutableListOf<Pair<String, String>>()
        val h = harness(
            listOf(botRig),
            NewSessionDraft(input = "keep me", selectedMachineId = "b1", selectedPath = "~/code", agentType = AgentType.Claude),
            faces = { id, seed -> worn += id to seed; null },
        )
        val result = h.starter.start(bot = BotRequest("Release Bot", "seed0001"), confirmDirectory = yes)
        assertEquals(StartResult.Started("s1"), result)
        val request = h.machines.spawns.single()
        assertEquals("rig", request.agent)
        assertEquals(HappyAgentSpawnTarget.Bot("Release Bot"), request.happyAgentTarget)
        assertEquals(listOf("s1" to "seed0001"), worn)
        assertTrue(h.sent.isEmpty())
        assertEquals("keep me", h.drafts.draft.value.input)
    }

    @Test fun aFaceThatFailsLeavesTheBotForARetry() = runTest {
        val failure = BotFaceFailure(BotFaceLeg.Uploading, "offline")
        val h = harness(listOf(botRig), NewSessionDraft(selectedMachineId = "b1"), faces = { _, _ -> failure })
        assertEquals(StartResult.Started("s1", faceFailure = failure), h.starter.start(bot = BotRequest("Ada", "s"), confirmDirectory = yes))
        assertTrue(h.sessions.killed.isEmpty())
    }

    @Test fun anOlderHappyAgentOrABadNameMakesNoBot() = runTest {
        val old = harness(listOf(rig), NewSessionDraft(selectedMachineId = "r1"))
        assertEquals(StartResult.Refused(StartRefusal.BotsUnsupported), old.starter.start(bot = BotRequest("Ada", "s"), confirmDirectory = yes))
        val blank = harness(listOf(botRig), NewSessionDraft(selectedMachineId = "b1"))
        assertEquals(StartResult.Failed("Give the bot a name"), blank.starter.start(bot = BotRequest("  ", "s"), confirmDirectory = yes))
        assertTrue(old.machines.spawns.isEmpty() && blank.machines.spawns.isEmpty())
    }
}

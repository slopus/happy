package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.cliAvailability
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * happy-ios MachineTarget (7d4ed9797, 9e58785b4) and what the compose chat
 * reads from the options: which computers can make a bot or a task, online
 * first; where a picked kind goes; why the chosen computer can't take the
 * send; and whether the computers are still arriving.
 */
class MachineTargetTest {
    private fun JsonObjectBuilder.happyAgent(bots: Boolean, tasks: Boolean, sibling: String? = null) {
        put("machineKind", "rig")
        sibling?.let { put("siblingMachineId", it) }
        putJsonObject("capabilities") { put("newSession", true); put("bots", bots); put("tasks", tasks) }
        putJsonArray("models") { addJsonObject { put("id", "m"); put("providerId", "p") } }
    }

    private val cliOnly = machine("cli", machineMetadata(host = "a.local") { put("displayName", "Alpha"); cliAvailability(claude = true) }, activeAt = 9)
    private val cliB = machine("cliB", machineMetadata(host = "b.local") { put("displayName", "Beta"); cliAvailability(claude = true) }, activeAt = 8)
    private val agentB = machine("agentB", machineMetadata(host = "b.local") { happyAgent(bots = true, tasks = true, sibling = "cliB") }, active = false, activeAt = 1_000)
    private val cliC = machine("cliC", machineMetadata(host = "c.local") { put("displayName", "Gamma"); cliAvailability(claude = true) }, activeAt = 7)
    private val agentC = machine("agentC", machineMetadata(host = "c.local") { happyAgent(bots = true, tasks = false, sibling = "cliC") }, activeAt = 7)

    private val machines = listOf(cliOnly, cliB, agentB, cliC, agentC)

    private fun options(draft: NewSessionDraft, kind: ComposeKind, list: List<Machine> = machines, synced: Boolean = true) =
        resolveNewSessionOptions(draft, list, emptyList(), null, kind = kind, machinesSynced = synced)

    @Test fun eachComputerSaysWhatItsHappyAgentMakesAndWhetherItAnswers() {
        val targets = options(NewSessionDraft(selectedMachineId = "cli"), ComposeKind.Session).targets.associateBy { it.id }
        assertEquals(MachineTarget("cli", "Alpha", online = true, happyAgentOnline = false, makesBots = false, makesTasks = false, lastSeenAt = 0), targets["cli"])
        val beta = targets.getValue("cliB")
        assertTrue(beta.online && !beta.happyAgentOnline && beta.makesBots && beta.makesTasks)
        assertEquals(1_000L, beta.lastSeen(ComposeKind.Task))
        assertNull(beta.lastSeen(ComposeKind.Session))
    }

    @Test fun aBotOrTaskListsOnlyComputersThatMakeItThoseThatAnswerFirst() {
        val options = options(NewSessionDraft(selectedMachineId = "cli"), ComposeKind.Bot)
        assertEquals(listOf("cliC", "cliB"), options.targets(ComposeKind.Bot).map { it.id })
        assertEquals(listOf("cliB"), options.targets(ComposeKind.Task).map { it.id })
        assertEquals(listOf("cli", "cliB", "cliC"), options.targets(ComposeKind.Session).map { it.id })
        assertTrue(options.offersBots && options.offersTasks)
    }

    @Test fun aPickedKindGoesWhereItsHappyAgentAnswersKeepingTheChosenOneWhenItCan() {
        val fromAlpha = options(NewSessionDraft(selectedMachineId = "cli"), ComposeKind.Session)
        assertEquals("cliC", fromAlpha.preferredTarget(ComposeKind.Bot)?.id)
        // Every Happy Agent that makes tasks is offline: the one that can, all the same.
        assertEquals("cliB", fromAlpha.preferredTarget(ComposeKind.Task)?.id)
        val onGamma = options(NewSessionDraft(selectedMachineId = "cliC"), ComposeKind.Bot)
        assertEquals("cliC", onGamma.preferredTarget(ComposeKind.Bot)?.id)
        assertNull(options(NewSessionDraft(selectedMachineId = "cli"), ComposeKind.Bot, listOf(cliOnly)).preferredTarget(ComposeKind.Bot))
    }

    @Test fun aBotOrTaskIsHappyAgentsSoItsDaemonDecidesWhetherItIsOffline() {
        // A session there runs Claude on Happy CLI, which answers; on its own the harness would be Happy Agent's.
        val beta = NewSessionDraft(selectedMachineId = "cliB", pickedAgentType = AgentType.Claude)
        assertNull(options(beta, ComposeKind.Session).offline)
        assertEquals(ComposeOffline.HappyAgent, options(NewSessionDraft(selectedMachineId = "cliB"), ComposeKind.Session).offline)
        assertEquals(ComposeOffline.HappyAgent, options(beta, ComposeKind.Task).offline)
        assertEquals(AgentType.Rig, options(beta, ComposeKind.Task).resolvedAgent)
        val gone = options(NewSessionDraft(selectedMachineId = "cli"), ComposeKind.Session, listOf(cliOnly.copy(active = false, activeAt = 42)))
        assertEquals(ComposeOffline.Computer(42), gone.offline)
    }

    @Test fun theComputersAreAwaitedOnlyUntilTheFirstSyncAndOnlyWhileNoneCanTakeTheSend() {
        assertTrue(options(NewSessionDraft(), ComposeKind.Session, emptyList(), synced = false).awaitsComputers)
        assertFalse(options(NewSessionDraft(), ComposeKind.Session, emptyList(), synced = true).awaitsComputers)
        // A Happy CLI computer is in, but no Happy Agent that makes bots yet.
        assertTrue(options(NewSessionDraft(selectedMachineId = "cli"), ComposeKind.Bot, listOf(cliOnly), synced = false).awaitsComputers)
        assertFalse(options(NewSessionDraft(selectedMachineId = "cli"), ComposeKind.Session, listOf(cliOnly), synced = false).awaitsComputers)
    }
}

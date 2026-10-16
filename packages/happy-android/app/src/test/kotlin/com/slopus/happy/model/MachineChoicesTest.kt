package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.cliAvailability
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** sync/machineChoices.spec.ts and firstRunOnboarding.ts's home states. */
class MachineChoicesTest {
    private val CLI = "cli-machine"
    private val RIG = "rig-machine"

    private fun cli(id: String = CLI, active: Boolean = true, activeAt: Long = 0) =
        machine(id, machineMetadata { cliAvailability(claude = true, codex = true) }, active, activeAt)

    private fun rig(id: String = RIG, sibling: String = CLI, active: Boolean = true, activeAt: Long = 0) = machine(
        id,
        machineMetadata {
            put("displayName", "laptop.local — Happy Agent")
            put("machineKind", "rig")
            put("rigOnly", true)
            put("siblingMachineId", sibling)
            putJsonObject("capabilities") { put("newSession", true) }
        },
        active, activeAt,
    )

    @Test
    fun collapsesAHappyCliAndHappyAgentPairIntoOneChoiceNamedByHost() {
        val choices = collectMachineChoices(listOf(cli(), rig()))
        assertEquals(1, choices.size)
        assertEquals(setOf(CLI, RIG), choices[0].machineIds.toSet())
        assertEquals("laptop.local", choices[0].name)
        assertEquals(CLI, choices[0].id)
    }

    @Test
    fun leavesTwoUnpairedComputersApartEvenWithTheSameHost() {
        assertEquals(2, collectMachineChoices(listOf(cli("one"), cli("two"))).size)
    }

    @Test
    fun offersALoneHappyAgentUnderItsHostName() {
        val choices = collectMachineChoices(listOf(rig(RIG, "missing-sibling")))
        assertEquals(1, choices.size)
        assertEquals("laptop.local", choices[0].name)
        assertEquals(RIG, choices[0].id)
    }

    @Test
    fun findsTheComputerFromEitherMachineId() {
        val choices = collectMachineChoices(listOf(cli(), rig()))
        assertEquals(CLI, findMachineChoice(choices, RIG)?.id)
        assertEquals(CLI, findMachineChoice(choices, CLI)?.id)
    }

    @Test
    fun choosesBetweenSeveralHappyAgentRegistrations() {
        val stale = rig("stale-rig", CLI, active = false, activeAt = 500)
        val live = rig("live-rig", CLI, active = true, activeAt = 100)
        val recent = rig("recent-rig", CLI, active = false, activeAt = 900)
        assertEquals("live-rig", collectMachineChoices(listOf(cli(), stale, live, recent))[0].rigMachine?.id)
        assertEquals("recent-rig", collectMachineChoices(listOf(cli(), stale, recent))[0].rigMachine?.id)
        val choices = collectMachineChoices(listOf(recent, stale, cli()))
        assertEquals(1, choices.size)
        assertEquals(3, choices[0].machineIds.size)
        assertEquals(CLI, choices[0].happyMachine?.id)
    }

    @Test
    fun whatAComputerCanRun() {
        val paired = collectMachineChoices(listOf(cli(), rig()))[0]
        val alone = collectMachineChoices(listOf(cli()))[0]
        assertTrue(machineChoiceAgentAvailable(paired, AgentType.Rig))
        assertFalse(machineChoiceAgentAvailable(alone, AgentType.Rig))

        val rigOnly = collectMachineChoices(listOf(rig(RIG, "missing-sibling")))[0]
        assertFalse(machineChoiceAgentAvailable(rigOnly, AgentType.Claude))
        assertTrue(machineChoiceAgentAvailable(rigOnly, AgentType.Rig))

        val bare = collectMachineChoices(listOf(machine("bare", machineMetadata("old.local"))))[0]
        assertTrue(machineChoiceAgentAvailable(bare, AgentType.Claude))
        assertFalse(machineChoiceAgentAvailable(bare, AgentType.Agy))
        assertFalse(machineChoiceAgentAvailable(bare, AgentType.Rig))

        val installed = collectMachineChoices(listOf(machine("agy", machineMetadata { cliAvailability(claude = true, agy = true) })))[0]
        assertEquals(listOf(AgentType.Claude, AgentType.Codex), listMachineChoiceAvailableAgents(alone))
        assertEquals(listOf(AgentType.Claude, AgentType.Agy), listMachineChoiceAvailableAgents(installed))
        assertEquals(listOf(AgentType.Claude, AgentType.Codex, AgentType.Rig), listMachineChoiceAvailableAgents(paired))

        val none = collectMachineChoices(listOf(machine("none", machineMetadata { cliAvailability(agy = false) })))[0]
        assertEquals(emptyList<AgentType>(), listMachineChoiceAvailableAgents(none))
    }

    @Test
    fun keepsAStaleDraftFromStartingAnAgentThisComputerCannotRun() {
        val rigOnly = collectMachineChoices(listOf(rig(RIG, "missing-sibling")))[0]
        assertEquals(AgentType.Rig, resolveChoiceAgent(rigOnly, AgentType.Claude))
        val cliOnly = collectMachineChoices(listOf(cli()))[0]
        assertEquals(AgentType.Claude, resolveChoiceAgent(cliOnly, AgentType.Rig))
        assertEquals(AgentType.Claude, resolveChoiceAgent(cliOnly, AgentType.Gemini))
    }

    @Test
    fun sendsEachAgentToTheDaemonThatRunsIt() {
        val choice = collectMachineChoices(listOf(cli(), rig()))[0]
        assertEquals(RIG, resolveAgentMachine(choice, AgentType.Rig)?.id)
        assertEquals(CLI, resolveAgentMachine(choice, AgentType.Claude)?.id)
        assertNull(resolveAgentMachine(collectMachineChoices(listOf(rig(RIG, "missing-sibling")))[0], AgentType.Claude))
    }

    @Test
    fun worktreeCreationMachine() {
        val paired = collectMachineChoices(listOf(cli(), rig()))[0]
        assertEquals(CLI, resolveWorktreeCreationMachine(paired, AgentType.Rig, false)?.id)
        assertEquals(RIG, resolveWorktreeCreationMachine(collectMachineChoices(listOf(rig(RIG, "missing-sibling")))[0], AgentType.Rig, true)?.id)
        assertNull(resolveWorktreeCreationMachine(paired, AgentType.OpenClaw, false))
        val cliAsleep = collectMachineChoices(listOf(cli(CLI, active = false), rig(RIG, CLI, active = true)))[0]
        assertNull(resolveWorktreeCreationMachine(cliAsleep, AgentType.Rig, false))
    }

    @Test
    fun anAsleepComputerIsStillOffered() {
        val offline = collectMachineChoices(listOf(cli(CLI, active = false, activeAt = 10), rig(RIG, CLI, active = false, activeAt = 20)))[0]
        assertFalse(offline.online)
        assertEquals(20L, offline.activeAt)
        assertTrue(machineChoiceAgentAvailable(offline, AgentType.Rig))
        assertEquals(RIG, resolveAgentMachine(offline, AgentType.Rig)?.id)
    }

    @Test
    fun theHarnessANewSessionStartsWith() {
        val paired = collectMachineChoices(listOf(cli(), rig()))[0]
        assertEquals(AgentType.Rig, resolveNewSessionAgent(paired, AgentType.Claude, null))
        assertEquals(AgentType.Rig, resolveNewSessionAgent(paired, AgentType.Codex, null))
        val asleep = collectMachineChoices(listOf(cli(), rig(RIG, CLI, active = false)))[0]
        assertEquals(AgentType.Rig, resolveNewSessionAgent(asleep, AgentType.Claude, null))
        assertEquals(AgentType.Claude, resolveNewSessionAgent(paired, AgentType.Rig, AgentType.Claude))
        assertEquals(AgentType.Codex, resolveNewSessionAgent(paired, AgentType.Claude, AgentType.Codex))

        val claudeOnly = collectMachineChoices(listOf(machine("claude-only", machineMetadata("desktop.local") { cliAvailability(claude = true) })))[0]
        val rigOnly = collectMachineChoices(listOf(rig("rig-alone", "nobody")))[0]
        assertEquals(AgentType.Claude, resolveNewSessionAgent(claudeOnly, AgentType.Codex, AgentType.Codex))
        assertEquals(AgentType.Rig, resolveNewSessionAgent(rigOnly, AgentType.Codex, AgentType.Codex))
        assertEquals(AgentType.Codex, resolveNewSessionAgent(paired, AgentType.Rig, AgentType.Codex))

        val alone = collectMachineChoices(listOf(cli()))[0]
        assertEquals(AgentType.Claude, resolveNewSessionAgent(alone, AgentType.Claude, null))
        assertEquals(AgentType.Codex, resolveNewSessionAgent(alone, AgentType.Codex, null))
        assertEquals(AgentType.Claude, resolveNewSessionAgent(null, AgentType.Claude, null))
        assertEquals(AgentType.Codex, resolveNewSessionAgent(null, AgentType.Claude, AgentType.Codex))
    }

    // firstRunOnboarding.test.ts

    @Test
    fun homeStates() {
        assertEquals(HomeEmptyState.List, resolveHomeEmptyState(3, false, 0, 0))
        assertEquals(HomeEmptyState.Link, resolveHomeEmptyState(0, false, 0, 0))
        assertEquals(HomeEmptyState.Offline, resolveHomeEmptyState(0, true, 2, 0))
        assertEquals(HomeEmptyState.List, resolveHomeEmptyState(0, true, 1, 1))
        assertEquals(HomeEmptyState.NoSessions, resolveHomeEmptyState(0, false, 1, 1))
        assertTrue(shouldShowOfflineMachinesBanner(2, 0))
        assertFalse(shouldShowOfflineMachinesBanner(2, 1))
        assertFalse(shouldShowOfflineMachinesBanner(0, 0))
    }
}

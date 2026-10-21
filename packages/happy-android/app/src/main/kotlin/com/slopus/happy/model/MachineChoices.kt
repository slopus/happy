package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonPrimitive

/** persistence.ts `NewSessionAgentType`; [wire] is the CLI/RPC id. */
enum class AgentType(val wire: String, val displayName: String) {
    Claude("claude", "Claude Code"),
    Codex("codex", "Codex"),
    Gemini("gemini", "Gemini"),
    OpenClaw("openclaw", "OpenClaw"),
    Agy("agy", "Antigravity"),
    Rig("rig", "Happy");

    /** harnessCatalog.ts RETIRED_HARNESSES: kept for naming old sessions, never offered. */
    val retired: Boolean get() = this == Gemini || this == OpenClaw

    companion object {
        fun fromWire(value: String?): AgentType? = entries.find { it.wire == value }

        /** harnessCatalog.ts HARNESS_ORDER: the ones people reach for first. */
        val Order = listOf(Claude, Codex, Agy, Rig)

        /** harnessCatalog.ts getHarnessName */
        fun harnessName(key: String): String = fromWire(key)?.displayName ?: key
    }
}

/** A machine's reported CLI availability as harnessCatalog.ts reads it: `availability[key] === true`. */
private fun CliAvailability.has(agent: AgentType): Boolean = when (agent) {
    AgentType.Claude -> claude
    AgentType.Codex -> codex
    AgentType.Gemini -> gemini
    AgentType.OpenClaw -> openclaw
    AgentType.Agy -> agy == true
    AgentType.Rig -> rig == true
}

/** harnessCatalog.ts `isHarnessAvailable` */
fun isHarnessAvailable(availability: CliAvailability?, happyAgentAvailable: Boolean, key: AgentType): Boolean = when (key) {
    AgentType.Rig -> happyAgentAvailable
    // Only an explicit installation report advertises Antigravity.
    AgentType.Agy -> availability?.agy == true
    else -> availability == null || availability.has(key)
}

/** newSessionAgentSelection.ts `resolveMachineAgent` */
fun resolveMachineAgent(selected: AgentType, availability: CliAvailability?): AgentType {
    if (selected.retired) {
        return AgentType.Order.find { availability == null || availability.has(it) } ?: AgentType.Claude
    }
    if (availability == null || availability.has(selected)) return selected
    return AgentType.Order.find { availability.has(it) } ?: selected
}

/** rigSessionCreation.ts `isRigMachine` */
fun MachineMetadata?.isRigMachine(): Boolean =
    this != null && (machineKind == "rig" || rigOnly == true || client?.id == "rig" || cliAvailability?.rig == true)

/** The Happy CLI machine a Happy Agent machine names as its pair (passthrough `siblingMachineId`). */
val MachineMetadata.siblingMachineId: String?
    get() = (raw["siblingMachineId"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }

/** machineChoices.ts `getMachineName` */
fun Machine.displayName(): String =
    metadata?.displayName?.takeIf { it.isNotEmpty() } ?: metadata?.host?.takeIf { it.isNotEmpty() } ?: "Unknown machine"

/**
 * One computer as a person picks it (machineChoices.ts `MachineChoice`). A
 * computer running both Happy CLI and Happy Agent registers two machines;
 * this is the computer, and the daemon follows from the agent.
 */
@Immutable
data class MachineChoice(
    /** What a draft stores: Happy CLI's machine whenever this computer has one. */
    val id: String,
    val name: String,
    val machineIds: List<String>,
    val happyMachine: Machine?,
    val rigMachine: Machine?,
    val online: Boolean,
    val activeAt: Long,
)

/** agentSessionPlaces.ts `pairedMachineIds`: the pointer Happy Agent publishes, read both ways. */
fun pairedMachineIds(machine: Machine, machines: List<Machine>): List<String> {
    val ids = linkedSetOf(machine.id)
    machine.metadata?.siblingMachineId?.let(ids::add)
    for (candidate in machines) {
        if (candidate.metadata?.siblingMachineId == machine.id) ids.add(candidate.id)
    }
    return ids.toList()
}

private fun preferLiveliest(machines: List<Machine>): Machine? =
    machines.sortedWith(compareByDescending<Machine> { it.isOnline }.thenByDescending { it.activeAt }).firstOrNull()

private fun computerName(happy: Machine?, rig: Machine?): String {
    val named = happy ?: rig ?: return "Unknown machine"
    // A lone Happy Agent is named by its host, not the suffixed display name it publishes.
    val host = named.metadata?.host
    if (happy == null && !host.isNullOrEmpty()) return host
    return named.displayName()
}

/** Every machine reachable through pairing pointers, followed all the way out. */
private fun connectedMachineIds(start: Machine, machines: List<Machine>, byId: Map<String, Machine>): List<String> {
    val found = linkedSetOf(start.id)
    val pending = ArrayDeque(listOf(start))
    while (pending.isNotEmpty()) {
        val machine = pending.removeLast()
        for (id in pairedMachineIds(machine, machines)) {
            val paired = byId[id] ?: continue
            if (!found.add(id)) continue
            pending.addLast(paired)
        }
    }
    return found.toList()
}

/**
 * machineChoices.ts `collectMachineChoices`: the computers behind the
 * machines, each once. Only published pairings merge machines; a shared host
 * name does not.
 */
fun collectMachineChoices(machines: List<Machine>): List<MachineChoice> {
    val byId = machines.associateBy { it.id }
    val grouped = HashSet<String>()
    val choices = mutableListOf<MachineChoice>()
    for (machine in machines) {
        if (machine.id in grouped) continue
        val ids = connectedMachineIds(machine, machines, byId)
        grouped.addAll(ids)
        val group = ids.map { byId.getValue(it) }
        val rig = preferLiveliest(group.filter { it.metadata.isRigMachine() })
        val happy = preferLiveliest(group.filter { !it.metadata.isRigMachine() })
        choices.add(
            MachineChoice(
                id = (happy ?: rig ?: machine).id,
                name = computerName(happy, rig),
                machineIds = ids,
                happyMachine = happy,
                rigMachine = rig,
                online = group.any { it.isOnline },
                activeAt = group.maxOf { it.activeAt },
            ),
        )
    }
    return choices
}

/** The computer a stored machine id belongs to, whichever of its daemons was stored. */
fun findMachineChoice(choices: List<MachineChoice>, machineId: String?): MachineChoice? {
    if (machineId.isNullOrEmpty()) return null
    return choices.find { machineId in it.machineIds }
}

/** Whether this computer can run [agent]: a missing CLI list is trusted only for a Happy CLI daemon. */
fun machineChoiceAgentAvailable(choice: MachineChoice?, agent: AgentType): Boolean {
    if (choice == null) return false
    if (agent == AgentType.Rig) {
        return isHarnessAvailable(choice.happyMachine?.metadata?.cliAvailability, choice.rigMachine != null, agent)
    }
    val happy = choice.happyMachine ?: return false
    return isHarnessAvailable(happy.metadata?.cliAvailability, choice.rigMachine != null, agent)
}

/** Every non-retired harness this computer can run, in picker order. Empty means setup help. */
fun listMachineChoiceAvailableAgents(choice: MachineChoice?): List<AgentType> =
    AgentType.Order.filter { machineChoiceAgentAvailable(choice, it) }

/** The agent this computer can really run, given what the draft asked for. */
fun resolveChoiceAgent(choice: MachineChoice?, agent: AgentType): AgentType {
    if (choice == null) return agent
    if (machineChoiceAgentAvailable(choice, agent)) {
        val availability = choice.happyMachine?.metadata?.cliAvailability
        return if (agent == AgentType.Rig || availability == null) agent else resolveMachineAgent(agent, availability)
    }
    return AgentType.Order.find { machineChoiceAgentAvailable(choice, it) } ?: agent
}

/**
 * The agent a new session starts with: the last pick where this computer can
 * run it, else Happy where the computer has Happy Agent, else the draft's.
 */
fun resolveNewSessionAgent(choice: MachineChoice?, agent: AgentType, picked: AgentType?): AgentType {
    if (picked != null && machineChoiceAgentAvailable(choice, picked)) return resolveChoiceAgent(choice, picked)
    if (machineChoiceAgentAvailable(choice, AgentType.Rig)) return AgentType.Rig
    return resolveChoiceAgent(choice, picked ?: agent)
}

/** The daemon that runs [agent] here; null is a refusal, never a hand-off to the other daemon. */
fun resolveAgentMachine(choice: MachineChoice?, agent: AgentType): Machine? {
    if (choice == null) return null
    return if (agent == AgentType.Rig) choice.rigMachine else choice.happyMachine
}

/**
 * The daemon that can create a git worktree: Happy CLI for a Happy Agent
 * session while the pair is online, else the agent's own daemon if it supports them.
 */
fun resolveWorktreeCreationMachine(choice: MachineChoice?, agent: AgentType, agentSupportsWorktrees: Boolean): Machine? {
    if (choice == null) return null
    if (agent == AgentType.Rig) {
        val happy = choice.happyMachine
        if (happy != null && happy.isOnline) return happy
    }
    if (!agentSupportsWorktrees) return null
    val agentMachine = resolveAgentMachine(choice, agent)
    return agentMachine?.takeIf { it.isOnline }
}

/**
 * firstRunOnboarding.ts shouldShowFirstRunInstall on a phone or tablet: no
 * computer linked, online or not, takes the home over with the link page,
 * whatever sessions the account still lists.
 */
fun shouldShowFirstRunInstall(machineCount: Int): Boolean = machineCount == 0

/** firstRunOnboarding.ts `HomeEmptyState` */
enum class HomeEmptyState { Link, Offline, NoSessions, List }

/**
 * Which home state applies. An archive-only account with a reachable machine
 * lists its archive control; with no reachable machine the connection
 * problem is what to show.
 */
fun resolveHomeEmptyState(visibleSessionCount: Int, hasArchivedSessions: Boolean, machineCount: Int, onlineMachineCount: Int): HomeEmptyState = when {
    visibleSessionCount > 0 -> HomeEmptyState.List
    machineCount == 0 -> HomeEmptyState.Link
    onlineMachineCount == 0 -> HomeEmptyState.Offline
    hasArchivedSessions -> HomeEmptyState.List
    else -> HomeEmptyState.NoSessions
}

/** The offline plaque: only above a list, and only when every linked computer is offline. */
fun shouldShowOfflineMachinesBanner(machineCount: Int, onlineMachineCount: Int): Boolean =
    machineCount > 0 && onlineMachineCount == 0

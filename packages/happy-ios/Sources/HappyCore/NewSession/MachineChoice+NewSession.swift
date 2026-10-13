import Foundation
import HappyStore
import HappyWire

extension MachineChoice {
    /// Ports harnessCatalog.HARNESS_ORDER; retired Gemini/OpenClaw are omitted.
    public static var agentOrder: [String] {
        ["claude", "codex", "agy", "rig"]
    }

    /// Ports machineChoices.findMachineChoice, including a stored sibling id.
    public static func find(in choices: [MachineChoice], machineId: String?) -> MachineChoice? {
        guard let machineId else { return nil }
        return choices.first { $0.machineIds.contains(machineId) }
    }

    /// Ports machineChoices.machineChoiceAgentAvailable.
    public func agentAvailable(_ agent: String) -> Bool {
        if agent == "rig" { return rigMachine != nil }
        guard let happyMachine else { return false }
        let availability = happyMachine.metadata?["cliAvailability"]
        if agent == "agy" { return availability?["agy"]?.boolValue == true }
        return availability == nil || availability == .null || availability?[agent]?.boolValue == true
    }

    /// Ports machineChoices.listMachineChoiceAvailableAgents.
    public var availableAgents: [String] {
        Self.agentOrder.filter(agentAvailable)
    }

    /// Ports machineChoices.resolveChoiceAgent, replacing retired harnesses.
    public func resolveAgent(_ agent: String) -> String {
        if agent == "gemini" || agent == "openclaw" { return availableAgents.first ?? "claude" }
        return agentAvailable(agent) ? agent : availableAgents.first ?? agent
    }

    /// Ports machineChoices.resolveNewSessionAgent: explicit available pick, Happy, then fallback.
    public func resolveNewSessionAgent(stored: String, picked: String?) -> String {
        if let picked, agentAvailable(picked) { return resolveAgent(picked) }
        if agentAvailable("rig") { return "rig" }
        return resolveAgent(picked ?? stored)
    }

    /// Ports machineChoices.resolveAgentMachine; no substitution of sibling daemons.
    public func machine(forAgent agent: String) -> MachineRecord? {
        agent == "rig" ? rigMachine : happyMachine
    }

    /// Ports machineChoices.resolveWorktreeCreationMachine.
    public func worktreeCreationMachine(agent: String, agentSupportsWorktrees: Bool) -> MachineRecord? {
        if agent == "rig", let happyMachine, happyMachine.active { return happyMachine }
        guard agentSupportsWorktrees, let machine = machine(forAgent: agent), machine.active else { return nil }
        return machine
    }
}

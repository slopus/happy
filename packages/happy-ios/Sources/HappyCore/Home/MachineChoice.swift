import Foundation
import HappyStore
import HappyWire

/// One computer, as a person sees it. Mirrors happy-app's
/// sync/machineChoices.ts.
///
/// Every daemon registers a machine of its own, so a computer that runs both
/// Happy CLI and Happy Agent arrives as two. Happy Agent publishes a
/// `siblingMachineId` pointing at the Happy CLI machine; following those
/// pointers both ways, all the way out, joins one computer's machines.
public struct MachineChoice: Equatable, Sendable {
    /// Happy CLI's machine whenever the computer has one.
    public var id: String
    public var name: String
    /// Every machine on this computer.
    public var machineIds: [String]
    /// The daemon Happy CLI runs here, if any.
    public var happyMachine: MachineRecord?
    /// The daemon Happy Agent runs here, if any.
    public var rigMachine: MachineRecord?
    /// True when any daemon on this computer is reachable.
    public var online: Bool
    public var activeAt: Int64

    /// The computers behind `machines`, each once, in the order their first
    /// machine appears. Two machines that only share a host name stay apart:
    /// they may be different accounts or containers.
    public static func collect(_ machines: [MachineRecord]) -> [MachineChoice] {
        let byId = Dictionary(machines.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var grouped = Set<String>()
        var choices: [MachineChoice] = []
        for machine in machines where !grouped.contains(machine.id) {
            let ids = connectedMachineIds(from: machine, machines: machines, byId: byId)
            grouped.formUnion(ids)
            let group = ids.compactMap { byId[$0] }
            // A computer can collect several Happy Agent registrations; the
            // reachable one wins, then the most recent.
            let rig = preferLiveliest(group.filter { isRigMachine($0.metadata) })
            let happy = preferLiveliest(group.filter { !isRigMachine($0.metadata) })
            choices.append(MachineChoice(
                id: (happy ?? rig ?? machine).id,
                name: computerName(happy: happy, rig: rig),
                machineIds: ids,
                happyMachine: happy,
                rigMachine: rig,
                online: group.contains { $0.active },
                activeAt: group.map(\.activeAt).max() ?? 0
            ))
        }
        return choices
    }

    /// happy-app's `isRigMachine`: any of the marks Happy Agent leaves.
    public static func isRigMachine(_ metadata: JSONValue?) -> Bool {
        metadata?["machineKind"]?.stringValue == "rig"
            || metadata?["rigOnly"]?.boolValue == true
            || metadata?["client"]?["id"]?.stringValue == "rig"
            || metadata?["cliAvailability"]?["rig"]?.boolValue == true
    }

    /// `displayName || host || 'Unknown machine'`; empty strings fall through.
    public static func machineName(_ machine: MachineRecord) -> String {
        nonEmpty(machine.metadata?["displayName"]?.stringValue)
            ?? nonEmpty(machine.metadata?["host"]?.stringValue)
            ?? "Unknown machine"
    }

    /// Happy Agent's display name carries a suffix that only tells it apart
    /// from its sibling, so a computer with only Happy Agent goes by host.
    static func computerName(happy: MachineRecord?, rig: MachineRecord?) -> String {
        guard let named = happy ?? rig else { return "Unknown machine" }
        if happy == nil, let host = nonEmpty(named.metadata?["host"]?.stringValue) {
            return host
        }
        return machineName(named)
    }

    /// Reachable first, then most recently active; ties keep list order.
    static func preferLiveliest(_ machines: [MachineRecord]) -> MachineRecord? {
        var best: MachineRecord?
        for machine in machines {
            guard let current = best else {
                best = machine
                continue
            }
            if machine.active != current.active {
                if machine.active { best = machine }
            } else if machine.activeAt > current.activeAt {
                best = machine
            }
        }
        return best
    }

    /// The machine itself, its sibling pointer, and every machine pointing
    /// at it. Happy Agent writes the pointer, so it is read both ways.
    static func pairedMachineIds(_ machine: MachineRecord, machines: [MachineRecord]) -> [String] {
        var ids = [machine.id]
        if let sibling = nonEmpty(machine.metadata?["siblingMachineId"]?.stringValue), !ids.contains(sibling) {
            ids.append(sibling)
        }
        for candidate in machines where candidate.metadata?["siblingMachineId"]?.stringValue == machine.id {
            if !ids.contains(candidate.id) { ids.append(candidate.id) }
        }
        return ids
    }

    /// Pairing is followed all the way out: two Happy Agent registrations
    /// naming the same Happy CLI machine are one computer, though neither
    /// names the other.
    static func connectedMachineIds(from start: MachineRecord, machines: [MachineRecord], byId: [String: MachineRecord]) -> [String] {
        var found = [start.id]
        var seen: Set<String> = [start.id]
        var pending = [start]
        while let machine = pending.popLast() {
            for id in pairedMachineIds(machine, machines: machines) {
                guard let paired = byId[id], !seen.contains(id) else { continue }
                seen.insert(id)
                found.append(id)
                pending.append(paired)
            }
        }
        return found
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}

import Foundation

/// Latest wire stamp and the stable fields currently rendered. Heartbeats
/// advance latestAt while displayedAt remains unchanged for an online row.
public struct PresenceOverlayValue: Sendable {
    public var active: Bool
    public var thinking: Bool
    public var latestAt: Int64
    public var displayedAt: Int64
    public var thinkingAt: Int64

    public init(active: Bool, thinking: Bool = false, latestAt: Int64, displayedAt: Int64, thinkingAt: Int64 = 0) {
        self.active = active
        self.thinking = thinking
        self.latestAt = latestAt
        self.displayedAt = displayedAt
        self.thinkingAt = thinkingAt
    }
}

/// Mutation comes from the account's presence actor. Projection runs on the
/// shared background snapshot hub; the lock protects both without UI work.
final class PresenceOverlay: @unchecked Sendable {
    private let lock = NSLock()
    private var sessions: [String: PresenceOverlayValue] = [:]
    private var machines: [String: PresenceOverlayValue] = [:]
    private var displayedNow: Int64?

    func setSession(_ id: String, _ value: PresenceOverlayValue) { lock.withLock { sessions[id] = value } }
    func setMachine(_ id: String, _ value: PresenceOverlayValue) { lock.withLock { machines[id] = value } }
    func setClock(_ now: Int64) { lock.withLock { displayedNow = now } }
    func removeSessions(_ ids: Set<String>) { lock.withLock { for id in ids { sessions.removeValue(forKey: id) } } }
    func removeMachines(_ ids: Set<String>) { lock.withLock { for id in ids { machines.removeValue(forKey: id) } } }
    func retain(sessionIDs: Set<String>, machineIDs: Set<String>) {
        lock.withLock {
            sessions = sessions.filter { sessionIDs.contains($0.key) }
            machines = machines.filter { machineIDs.contains($0.key) }
        }
    }

    func home(_ raw: HomeSnapshot) -> HomeSnapshot {
        lock.withLock {
            var value = raw
            value.presenceNow = displayedNow
            for index in value.sessions.indices {
                let row = value.sessions[index]
                guard let presence = sessions[row.id], presence.latestAt >= row.activeAt else { continue }
                value.sessions[index].active = presence.active
                value.sessions[index].thinking = presence.thinking && presence.active
                value.sessions[index].activeAt = presence.displayedAt
                value.sessions[index].thinkingAt = presence.thinkingAt
                LocalStore.settle(old: row, &value.sessions[index])
            }
            value.machines = overlayMachines(raw.machines)
            return value
        }
    }

    /// One session as `home` shows it.
    func session(_ row: SessionRecord) -> SessionRecord {
        lock.withLock {
            guard let presence = sessions[row.id], presence.latestAt >= row.activeAt else { return row }
            var value = row
            value.active = presence.active
            value.thinking = presence.thinking && presence.active
            value.activeAt = presence.displayedAt
            value.thinkingAt = presence.thinkingAt
            LocalStore.settle(old: row, &value)
            return value
        }
    }

    /// One computer as `machineSnapshot` shows it.
    func machine(_ row: MachineRecord) -> MachineRecord {
        lock.withLock {
            guard let presence = machines[row.id], presence.latestAt >= row.activeAt else { return row }
            var value = row
            value.active = presence.active
            value.activeAt = presence.displayedAt
            return value
        }
    }

    func machineSnapshot(_ raw: MachinesSnapshot) -> MachinesSnapshot {
        lock.withLock { overlayMachines(raw) }
    }

    func troubleshooting(_ raw: TroubleshootingSnapshot) -> TroubleshootingSnapshot {
        lock.withLock {
            var value = raw
            value.machines = overlayMachines(MachinesSnapshot(synced: true, machines: raw.machines)).machines
            return value
        }
    }

    private func overlayMachines(_ raw: MachinesSnapshot) -> MachinesSnapshot {
        var value = raw
        for index in value.machines.indices {
            let row = value.machines[index]
            guard let presence = machines[row.id], presence.latestAt >= row.activeAt else { continue }
            value.machines[index].active = presence.active
            value.machines[index].activeAt = presence.displayedAt
        }
        return value
    }
}
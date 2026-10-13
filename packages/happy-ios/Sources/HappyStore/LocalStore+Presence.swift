import GRDB

extension LocalStore {
    /// One coarse checkpoint for every dirty session and machine. Presence
    /// cannot overwrite a newer wire stamp already stored by another merge.
    public func persistPresence(sessions: [String: PresenceOverlayValue], machines: [String: PresenceOverlayValue]) throws {
        guard !sessions.isEmpty || !machines.isEmpty else { return }
        try performWrite { db in
            for (id, presence) in sessions {
                guard var record = try SessionRecord.fetchOne(db, key: id), presence.latestAt >= record.activeAt else { continue }
                let old = record
                record.active = presence.active
                record.activeAt = presence.latestAt
                record.thinking = presence.thinking && presence.active
                record.thinkingAt = presence.latestAt
                Self.settle(old: old, &record)
                if record != old { _ = try record.updateChanges(db, from: old) }
            }
            for (id, presence) in machines {
                guard var record = try MachineRecord.fetchOne(db, key: id), presence.latestAt >= record.activeAt else { continue }
                let old = record
                record.active = presence.active
                record.activeAt = presence.latestAt
                if record != old { _ = try record.updateChanges(db, from: old) }
            }
        }
    }
}
#if canImport(UIKit)
import HappyCore
import UIKit

// SEAM (Secondary ↔ Ops). The Ops workstream is wiring `MachineActions` and
// `GitStatusSync` into `AccountSession`. Until that lands, the session
// info, machine and changes screens build them here, from what the account
// session already exposes, and nowhere else. Once `AccountSession` has its
// own, point these three properties at them and delete the registry.

extension AccountSession {
    var detailMachineActions: MachineActions {
        MachineActions(api: api, store: store, sync: sync, rpc: realtime, metadataTransport: realtime)
    }

    var detailActions: SessionDetailActions {
        SessionDetailActions(sessions: actions, machines: detailMachineActions, store: store, sync: sync, metadataTransport: realtime)
    }

    /// One per account, so screens of the same session share refreshes.
    @MainActor
    var detailGitStatus: GitStatusSync {
        GitStatusRegistry.shared.sync(for: self)
    }
}

@MainActor
private final class GitStatusRegistry {
    static let shared = GitStatusRegistry()

    private struct Entry {
        weak var session: AccountSession?
        let sync: GitStatusSync
    }

    private var entries: [ObjectIdentifier: Entry] = [:]

    func sync(for session: AccountSession) -> GitStatusSync {
        entries = entries.filter { $0.value.session != nil }
        let key = ObjectIdentifier(session)
        if let entry = entries[key] { return entry.sync }
        let sync = GitStatusSync(actions: session.actions, store: session.store)
        entries[key] = Entry(session: session, sync: sync)
        return sync
    }
}
#endif

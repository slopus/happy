#if canImport(UIKit)
import HappyCore
import UIKit

/// Who the people in viewers' slots are: the bootstrap's teammates first,
/// then `GET /v0/users` for anyone it didn't name, asked once each.
@MainActor
final class ViewerPeople {
    private let client: AgentClient
    private let engine: SyncEngine
    private var known: [String: TeamUser] = [:]
    private var asked: Set<String> = []
    private struct Watcher {
        weak var owner: AnyObject?
        let changed: () -> Void
    }
    private var watchers: [Watcher] = []

    init(client: AgentClient, engine: SyncEngine) {
        self.client = client
        self.engine = engine
    }

    func user(_ id: String) -> TeamUser? { known[id] }

    /// `changed` runs whenever someone becomes known, for as long as `owner` lives.
    func watch(_ owner: AnyObject, _ changed: @escaping () -> Void) {
        watchers.append(Watcher(owner: owner, changed: changed))
    }

    /// Names the ones not known yet.
    func want(_ ids: [String]) {
        let missing = ids.filter { known[$0] == nil && !asked.contains($0) }
        guard !missing.isEmpty else { return }
        asked.formUnion(missing)
        let client = client
        let engine = engine
        Task { [weak self] in
            let teammates = await engine.teammates()
            var found = missing.compactMap { teammates[$0] }
            let unnamed = missing.filter { teammates[$0] == nil }
            if !unnamed.isEmpty, let read = try? await client.teamUsers(unnamed) { found += read }
            guard let self else { return }
            // Asked again next time they show, if the computer couldn't say.
            asked.subtract(missing.filter { id in !found.contains { $0.id == id } })
            guard !found.isEmpty else { return }
            for user in found { known[user.id] = user }
            watchers.removeAll { $0.owner == nil }
            for watcher in watchers { watcher.changed() }
        }
    }
}
#endif

#if canImport(UIKit)
import HappyCore
import UIKit

/// One Happy Cloud server's plugins, shared by the Plugins page, a
/// plugin's page and onboarding: read while someone watches, again on
/// `plugins.changed` and a role change, and after every write, whether it
/// was taken or not. A failed read keeps what was read.
@MainActor
final class PluginsModel {
    enum State: Equatable {
        case loading
        case failed
        case loaded(PluginCatalog)

        var catalog: PluginCatalog? {
            if case .loaded(let catalog) = self { return catalog }
            return nil
        }
    }

    private(set) var state: State = .loading
    private let client: AgentClient
    private let store: Store
    private var watchers: [UUID: () -> Void] = [:]
    private var following: Task<Void, Never>?
    private var reading = false
    private var readAgain = false

    init(client: AgentClient, store: Store) {
        self.client = client
        self.store = store
    }

    /// Calls `changed` whenever the state changes, and reads it now.
    func watch(_ changed: @escaping () -> Void) -> Watch {
        let id = UUID()
        watchers[id] = changed
        if watchers.count == 1 { follow() }
        load()
        return Watch { [weak self] in
            guard let self else { return }
            watchers.removeValue(forKey: id)
            if watchers.isEmpty { following?.cancel(); following = nil }
        }
    }

    private func follow() {
        let store = store
        following = Task { [weak self] in
            for await _ in await store.events(matching: PluginCatalog.refreshEvents) {
                guard !Task.isCancelled else { return }
                self?.load()
            }
        }
    }

    /// One read at a time; asked again meanwhile, it reads once more after.
    func load() {
        guard !reading else { readAgain = true; return }
        reading = true
        let client = client
        Task { [weak self] in
            let read = try? await client.pluginCatalog()
            guard let self else { return }
            reading = false
            if let read { adopt(.loaded(read)) }
            else if state.catalog == nil { adopt(.failed) }
            if readAgain { readAgain = false; load() }
        }
    }

    private func adopt(_ next: State) {
        guard next != state else { return }
        state = next
        for watcher in watchers.values { watcher() }
    }

    /// Runs one write, then reads the list again whatever came of it.
    func write<T: Sendable>(_ act: @Sendable (AgentClient) async throws -> T) async throws -> T {
        defer { load() }
        return try await act(client)
    }
}

#endif

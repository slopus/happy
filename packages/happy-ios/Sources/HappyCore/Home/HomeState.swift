import Foundation
import HappyStore

/// What the signed-in home shows, from happy-app's app/(app)/index.tsx
/// (`shouldShowFirstRunInstall`) and SessionsListWrapper.tsx
/// (`resolveHomeEmptyState`).
///
/// happy-app also counts visible sessions: an account with sessions lists
/// them even while its computers are offline. This app has no session list
/// yet, so the computers alone decide.
public enum HomeState: Equatable, Sendable {
    /// Machines have never been fetched for this account. An empty store
    /// says nothing yet, so this must not fall through to `link`: an
    /// account restored from another phone has computers.
    case loading
    /// No computer linked: Link Your Computer.
    case link
    /// Computers linked, none reachable: the offline checklist.
    case offline([MachineChoice])
    /// At least one computer is reachable.
    case ready([MachineChoice])

    public init(_ snapshot: MachinesSnapshot) {
        // Stored machines are worth showing even before the first full
        // fetch (a live `new-machine` can land first); none are not.
        guard snapshot.synced || !snapshot.machines.isEmpty else {
            self = .loading
            return
        }
        let choices = MachineChoice.collect(snapshot.machines)
        if choices.isEmpty {
            self = .link
        } else if choices.contains(where: \.online) {
            self = .ready(choices)
        } else {
            self = .offline(choices)
        }
    }
}

extension AccountSession {
    /// Calls `onChange` with the home state now and whenever the stored
    /// machines change.
    @MainActor
    public func observeHome(onChange: @escaping @MainActor (HomeState) -> Void) -> StoreObservation {
        store.observeMachines { onChange(HomeState($0)) }
    }
}

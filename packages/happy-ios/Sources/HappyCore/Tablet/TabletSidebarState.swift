import Foundation
import HappyStore

/// What the tablet sidebar shows, from the same home snapshot the phone home
/// reads: SidebarView.tsx's top controls and MainView.tsx's sidebar variant.
public struct TabletSidebarState: Equatable, Sendable {
    public enum Content: Equatable, Sendable {
        /// The spinner, before machines are known (`HomeState.loading`).
        case loading
        /// Nothing listed: EmptySessionsTablet. An archive alone lists
        /// nothing here; the archive button above opens it.
        case empty(TabletEmptySessions)
        /// The session list. `offline` is set when every computer is
        /// offline, for the plaque above it (HomeListHeader.tsx).
        case list(SessionList, offline: [MachineChoice]?)
    }

    public var content: Content
    /// `useHasArchivedSessions`: the archive button shows.
    public var hasArchived: Bool
    /// `hideInactiveSessions`: the button reads "Show archived".
    public var hidesArchived: Bool
    /// The first-run screen owns the window and the shell steps aside
    /// (`shouldShowFirstRunInstall`). It follows home's own decision, so
    /// the sidebar disappears exactly when home shows Link Your Computer.
    public var showsInstallStep: Bool

    public init(_ snapshot: HomeSnapshot, clock: SessionList.Clock = SessionList.Clock()) {
        let state = HomeState(snapshot, clock: clock)
        let list = SessionList(snapshot, clock: clock)
        hasArchived = list.hasArchived
        hidesArchived = AccountSettings(snapshot.settings).hideArchivedSessions
        showsInstallStep = state == .link
        switch state {
        case .loading:
            content = .loading
        case .list(let list, let offline) where list.visibleCount > 0:
            content = .list(list, offline: offline)
        default:
            content = .empty(TabletEmptySessions(MachineChoice.collect(snapshot.machines.machines)))
        }
    }
}

/// EmptySessionsTablet.tsx's three faces.
public enum TabletEmptySessions: Equatable, Sendable {
    /// A computer is reachable: "No sessions yet", and Start New Session.
    case online
    /// Computers, none reachable: "<name> is unreachable" for one, "No
    /// machines are reachable" for more, and Troubleshoot.
    case offline([MachineChoice])
    /// No computer: "No sessions yet" and how to connect one, no button.
    case noMachines

    public init(_ choices: [MachineChoice]) {
        if choices.contains(where: \.online) {
            self = .online
        } else if choices.isEmpty {
            self = .noMachines
        } else {
            self = .offline(choices)
        }
    }
}

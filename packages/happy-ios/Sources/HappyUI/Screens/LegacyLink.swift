#if canImport(UIKit)
import HappyAnalytics
import HappyCore
import UIKit

/// A Happy account's link as its headers show it: one per signed-in
/// `AccountSession`, read by its home's title and its chats' subtitles
/// alike. It is the one reader of the session's socket status and catch-up
/// streams, and of the network path, and works the header's state out of
/// them (`headerState`), debounced by its `LinkIndicator`.
@MainActor
final class LegacyLink {
    private static var links: [ObjectIdentifier: LegacyLink] = [:]

    /// The account's link, made the first time a screen asks.
    static func link(for session: AccountSession) -> LegacyLink {
        // A session signed out or switched away from is let go of here.
        links = links.filter { $0.value.session != nil }
        let key = ObjectIdentifier(session)
        if let existing = links[key] { return existing }
        let link = LegacyLink(session: session)
        links[key] = link
        return link
    }

    private weak var session: AccountSession?
    /// `agent_connection_lost`'s name for this account's link.
    private let watchID: String
    let indicator: LinkIndicator
    private var networkWatch: NetworkPathWatch?
    private var following: [Task<Void, Never>] = []

    /// The socket's status, as it last said.
    private(set) var status: RealtimeStatus = HomeConnectionStatus.initial
    /// A connect's catch-up is still landing.
    private(set) var catchingUp = false
    /// Whether the phone has a way out at all (`NetworkPath`).
    private(set) var network = NetworkPath.shared.isSatisfied

    private init(session: AccountSession) {
        self.session = session
        watchID = Self.watchID(session)
        indicator = LinkIndicator(wanted: Self.headerState(status: status, catchingUp: catchingUp, network: network))
        networkWatch = NetworkPath.shared.watch { [weak self] satisfied in
            MainActor.assumeIsolated { self?.receive(network: satisfied) }
        }
        // Both streams end when the session stops.
        let statusUpdates = session.statusUpdates
        let catchUpUpdates = session.catchUpUpdates
        following = [
            Task { [weak self] in
                for await status in statusUpdates { self?.receive(status: status) }
            },
            Task { [weak self] in
                for await catchingUp in catchUpUpdates { self?.receive(catchingUp: catchingUp) }
            },
        ]
    }

    deinit {
        for task in following { task.cancel() }
    }

    /// The socket retries for as long as the account is signed in, so a
    /// socket that is down is one on its way back: "connecting…".
    static func headerState(status: RealtimeStatus, catchingUp: Bool, network: Bool) -> LinkState {
        if !network { return .waitingForNetwork }
        guard status == .connected else { return .connecting }
        return catchingUp ? .syncing : .online
    }

    var headerState: LinkState { Self.headerState(status: status, catchingUp: catchingUp, network: network) }

    static func watchID(_ session: AccountSession) -> String { "relay:\(session.keys.anonID)" }

    /// The socket down, or no network at all, is the relay out of reach.
    private func report() {
        let down = !network || status != .connected
        ConnectionWatch.shared.report(.init(id: watchID, transport: .relay, down: down, code: !network ? .unreachable : .unknown))
    }

    /// What headers show of the link, now and on every change.
    func watch(_ watch: @escaping (LinkState) -> Void) -> Watch {
        indicator.watch(watch)
    }

    // The sources, and the doors tests come in by.

    func receive(status: RealtimeStatus) {
        self.status = status
        indicator.want(headerState)
        report()
    }

    func receive(catchingUp: Bool) {
        self.catchingUp = catchingUp
        indicator.want(headerState)
    }

    func receive(network: Bool) {
        self.network = network
        indicator.want(headerState)
        report()
    }
}
#endif

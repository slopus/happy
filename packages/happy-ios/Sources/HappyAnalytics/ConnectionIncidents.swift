import Foundation
import HappyCore
import HappyWire

/// `agent_connection_lost`: one event per incident, when it ends, and only for
/// one that lasted ten seconds or more in the foreground. An incident is
/// the agent being looked at (`Link`) staying down; it ends when that link
/// is back (`recovered`), when the person moves to another agent or none
/// (`gave_up`) or when the app leaves the foreground (`backgrounded`).
public struct ConnectionIncidents: Equatable, Sendable {
    public static let threshold: TimeInterval = 10

    /// The connection to the agent the app is showing.
    public struct Link: Equatable, Sendable {
        /// Which agent or account, to tell a move from a recovery; never sent.
        public var id: String
        public var transport: AnalyticsEvent.ConnectionTransport
        public var down: Bool
        /// Why it is down, as the last failure said.
        public var code: AnalyticsEvent.ConnectionCode

        public init(id: String, transport: AnalyticsEvent.ConnectionTransport, down: Bool, code: AnalyticsEvent.ConnectionCode = .unknown) {
            self.id = id; self.transport = transport; self.down = down; self.code = code
        }
    }

    struct Incident: Equatable, Sendable {
        var id: String
        var transport: AnalyticsEvent.ConnectionTransport
        var code: AnalyticsEvent.ConnectionCode
        var since: Date
    }

    private(set) var link: Link?
    private(set) var foreground = true
    private(set) var incident: Incident?

    public init(foreground: Bool = true) {
        self.foreground = foreground
    }

    /// The link changed; the incident that ended, if one did.
    public mutating func update(_ next: Link?, at now: Date) -> AnalyticsEvent? {
        link = next
        var ended: AnalyticsEvent?
        if let incident {
            if next?.id != incident.id { ended = end(.gaveUp, at: now) }
            else if next?.down == false { ended = end(.recovered, at: now) }
            else if let code = next?.code, code != .unknown { self.incident?.code = code }
        }
        begin(at: now)
        return ended
    }

    public mutating func setForeground(_ active: Bool, at now: Date) -> AnalyticsEvent? {
        guard foreground != active else { return nil }
        foreground = active
        if !active { return end(.backgrounded, at: now) }
        begin(at: now)
        return nil
    }

    private mutating func begin(at now: Date) {
        guard incident == nil, foreground, let link, link.down else { return }
        incident = Incident(id: link.id, transport: link.transport, code: link.code, since: now)
    }

    private mutating func end(_ outcome: AnalyticsEvent.ConnectionOutcome, at now: Date) -> AnalyticsEvent? {
        guard let incident else { return nil }
        self.incident = nil
        let lasted = now.timeIntervalSince(incident.since)
        guard lasted >= Self.threshold else { return nil }
        return .agentConnectionLost(transport: incident.transport, code: incident.code, outcome: outcome, duration: .init(seconds: lasted))
    }
}

/// The app's one incident tracker. Each connection reports its link as it
/// changes (an agent's status, a Happy account's socket); the app says which
/// one it is showing and when it is in the foreground.
@MainActor
public final class ConnectionWatch {
    public static let shared = ConnectionWatch()

    private var incidents = ConnectionIncidents()
    private var links: [String: ConnectionIncidents.Link] = [:]
    private var activeID: String?
    var log: (AnalyticsEvent) -> Void = { Analytics.shared.log($0) }
    var now: () -> Date = Date.init

    public init() {}

    public func report(_ link: ConnectionIncidents.Link) {
        links[link.id] = link
        apply()
    }

    /// The link the app shows, by its id; nil when it shows none.
    public func setActive(_ id: String?) {
        activeID = id
        apply()
    }

    public func setForeground(_ active: Bool) {
        if let event = incidents.setForeground(active, at: now()) { log(event) }
    }

    /// Analytics turned off: what was being timed, and every link reported
    /// so far, go. Timing starts again from what is reported after.
    func reset() {
        incidents = ConnectionIncidents(foreground: incidents.foreground)
        links = [:]
    }

    private func apply() {
        let link = activeID.flatMap { links[$0] }
        guard link != incidents.link else { return }
        if let event = incidents.update(link, at: now()) { log(event) }
    }
}

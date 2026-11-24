import Foundation

/// Where an account's link to its server or computer stands, as its
/// headers say it (docs/offline-first.md, "The title while away"). Both
/// account kinds work it out from their own sources: the agent from its
/// connection and sync snapshot, the legacy account from its socket and
/// catch-up; home's title and every chat's subtitle read the same one.
/// No link is ever offline: one not connected is asked again with backoff
/// for as long as the account is there, so it is connecting.
public enum LinkState: CaseIterable, Equatable, Sendable {
    /// Connected and caught up.
    case online
    /// Connected, catching up ("updating…").
    case syncing
    /// Reaching the server or computer ("connecting…").
    case connecting
    /// No network path at all ("waiting for network…").
    case waitingForNetwork
    /// The computer's daemon is draining to restart, for an update or by
    /// hand ("agent restarting…"): it answers reads, refuses writes, and a
    /// new process takes over. Until a hello says otherwise.
    case restarting
}

extension LinkState {
    /// Home's: connecting until the stream's hello (`live`), then updating
    /// until home's bootstrap verified the computer (`syncing`). No link is
    /// ever offline: one not connected is asked again with backoff for as
    /// long as it is there, so it is connecting, whatever kept it away.
    public static func home(_ snapshot: HomeSnapshot, network: Bool = true) -> LinkState {
        if !network { return .waitingForNetwork }
        // Said through the reconnect too: the stream drops as the old
        // process goes, and the new one's hello clears it.
        if snapshot.draining { return .restarting }
        guard snapshot.live else { return .connecting }
        return snapshot.loaded && !snapshot.syncing ? .online : .syncing
    }

    /// A chat's: home's until the stream's hello, then updating only until
    /// the chat's own history read lands (`historyRead`). Home's bootstrap
    /// and what waits for it never keep a chat updating.
    public static func chat(home: LinkState, historyRead: Bool) -> LinkState {
        guard home == .online || home == .syncing else { return home }
        return historyRead ? .online : .syncing
    }
}

/// What a header shows of a `LinkState` that keeps changing, as Telegram's
/// title does: a short wobble never shows. "Connecting…" or "updating…"
/// shows only once the link has been away `showAfter` without coming back,
/// and whatever shows stays at least `holdFor`. Live again gives the
/// title back once it has stood `liveFor`: the link's sources say their
/// parts one at a time (a socket connected a moment before its catch-up
/// starts), and a status hands straight to the next without the title
/// flashing between them. "Waiting for network…" is news: it shows
/// straight away, over any hold.
///
/// Pure, with time passed in, so it is tested with a made-up clock: each
/// call says when to call `settle` next, if anything is still to come.
public struct LinkStateDebounce: Equatable, Sendable {
    public static let showAfter: TimeInterval = 0.8
    public static let holdFor: TimeInterval = 0.6
    public static let liveFor: TimeInterval = 0.3

    /// What the header shows now.
    public private(set) var shown: LinkState
    /// What the link is, as last told.
    public private(set) var wanted: LinkState
    /// When `wanted` last left `online`, and last came back to it.
    private var awaySince: TimeInterval
    private var liveSince: TimeInterval
    /// When `shown` last changed.
    private var shownSince: TimeInterval

    /// Starts showing `shown` (online by default: a launch shows the title,
    /// and a slow first connection says so after `showAfter`).
    public init(shown: LinkState = .online, wanted: LinkState, now: TimeInterval) {
        self.shown = shown
        self.wanted = wanted
        awaySince = now
        liveSince = now
        shownSince = now
    }

    /// The link is now `state`. Returns when to `settle`, if a change is due later.
    @discardableResult
    public mutating func want(_ state: LinkState, now: TimeInterval) -> TimeInterval? {
        if wanted == .online, state != .online { awaySince = now }
        if wanted != .online, state == .online { liveSince = now }
        wanted = state
        return settle(now: now)
    }

    /// Shows what is due by `now`. Returns when to call again, if a change
    /// is still to come.
    @discardableResult
    public mutating func settle(now: TimeInterval) -> TimeInterval? {
        let (next, due) = target(now: now)
        if next != shown {
            shown = next
            shownSince = now
            // A change shown starts its own hold.
            return target(now: now).due
        }
        return due
    }

    private func target(now: TimeInterval) -> (state: LinkState, due: TimeInterval?) {
        guard wanted != shown else { return (shown, nil) }
        if wanted == .waitingForNetwork { return (wanted, nil) }
        let held = shownSince + Self.holdFor
        if shown != .online, now < held { return (shown, held) }
        if wanted == .online {
            let stood = liveSince + Self.liveFor
            return now < stood ? (shown, stood) : (wanted, nil)
        }
        if shown != .online { return (wanted, nil) }
        let due = awaySince + Self.showAfter
        return now < due ? (shown, due) : (wanted, nil)
    }
}

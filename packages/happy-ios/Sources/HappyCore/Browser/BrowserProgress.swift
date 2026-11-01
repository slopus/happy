import Foundation

/// The browser's loading bar, as Safari and Telegram draw it.
///
/// WebKit's own `estimatedProgress` can't drive it alone. Through the
/// agent proxy every request first opens a tunnel to the computer, and
/// WebKit counts nothing until bytes arrive: it sits at 0.1 for the whole
/// tunnel setup, often seconds, then jumps to 1 within one frame. So the
/// bar starts at once at a small value, creeps on its own while nothing is
/// heard (`trickle`), takes WebKit's estimate whenever it is further, never
/// goes back within a load, and fills before it fades.
///
/// Pure: the screen calls it as things happen and draws what it says.
public struct BrowserProgress: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        /// Nothing is loading and the bar is gone.
        case hidden
        /// A load is under way.
        case loading
        /// The load is done: the bar fills, then fades.
        case finishing
    }

    /// Where a load starts, before anything is known.
    public static let start = 0.1
    /// How far the bar creeps on its own: the rest is the page's to fill.
    public static let trickleCeiling = 0.7
    /// The share of the way to the ceiling each `trickle` covers, so it
    /// slows as it climbs.
    public static let trickleStep = 0.06

    public private(set) var phase: Phase = .hidden
    /// From 0 to 1.
    public private(set) var value: Double = 0

    public init() {}

    /// A load began: the session connecting, a navigation, a reload. One
    /// already under way goes on from where it is, so a redirect or a
    /// navigation that replaces another never moves the bar back.
    public mutating func begin() {
        guard phase != .loading else { return }
        phase = .loading
        value = Self.start
    }

    /// WebKit's estimate, taken only when it is further.
    public mutating func estimate(_ fraction: Double) {
        guard phase == .loading, fraction.isFinite else { return }
        value = max(value, min(fraction, 1))
    }

    /// A moment passed with the load still going.
    public mutating func trickle() {
        guard phase == .loading, value < Self.trickleCeiling else { return }
        value += (Self.trickleCeiling - value) * Self.trickleStep
    }

    /// The load completed: the bar fills, then fades.
    public mutating func finish() {
        guard phase == .loading else { return }
        phase = .finishing
        value = 1
    }

    /// The bar is gone: faded after `finish`, or the load failed or stopped.
    public mutating func hide() {
        phase = .hidden
        value = 0
    }
}

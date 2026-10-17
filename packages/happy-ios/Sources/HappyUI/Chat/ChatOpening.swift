#if canImport(UIKit)
import QuartzCore
import UIKit

/// Records when deferred chat content settles. This clock is diagnostic:
/// navigation has already started and never waits for this report.
@MainActor
final class ChatOpening {
    /// Records rows as late after this interval; never delays a tap.
    static let cap: CFTimeInterval = 0.150
    /// The pieces allowed beyond the short readiness interval.
    static let mayComeLate: Set<String> = ["rows", "placeholder"]
    /// Finish the diagnostic report even when content has stalled.
    static let limit: CFTimeInterval = 0.400

    /// How an opening went, for the tests and the timing log.
    struct Report: Equatable {
        /// From the start of the opening to its show.
        var elapsed: CFTimeInterval
        /// What was still missing when it was shown: empty unless the cap
        /// was hit, and then only what `mayComeLate` unless the limit was.
        var missing: [String]
        /// When each piece the first look missed came in, from the start.
        var arrivals: [String: CFTimeInterval] = [:]
        var hitCap: Bool { !missing.isEmpty }
    }

    private let started = CACurrentMediaTime()
    private var waiting: Set<String>?
    private var arrivals: [String: CFTimeInterval] = [:]
    private let missing: () -> [String]
    private var show: ((Report) -> Void)?
    private var link: CADisplayLink?

    /// `missing` names what the screen still waits for; `show` runs once.
    init(missing: @escaping () -> [String], show: @escaping (Report) -> Void) {
        self.missing = missing
        self.show = show
        // A piece measured off the main thread lands between frames and
        // says nothing; every frame looks again.
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    /// Looks whether the chat is whole, or out of time, and shows it if so:
    /// every frame, and whenever the screen takes a piece in.
    func check() {
        guard let show else { return }
        let missing = missing()
        let elapsed = CACurrentMediaTime() - started
        for piece in waiting?.subtracting(missing) ?? [] where arrivals[piece] == nil {
            arrivals[piece] = elapsed
        }
        if waiting == nil { waiting = Set(missing) }
        guard Self.shows(missing: missing, elapsed: elapsed) else { return }
        cancel()
        show(Report(elapsed: elapsed, missing: missing, arrivals: arrivals))
    }

    /// Whether a chat still missing `missing` is shown `elapsed` seconds in.
    static func shows(missing: [String], elapsed: CFTimeInterval) -> Bool {
        missing.isEmpty || (elapsed >= cap && missing.allSatisfy(mayComeLate.contains)) || elapsed >= limit
    }

    /// Never shows.
    func cancel() {
        show = nil
        link?.invalidate()
        link = nil
    }

    @objc private func tick() {
        check()
    }

}
#endif

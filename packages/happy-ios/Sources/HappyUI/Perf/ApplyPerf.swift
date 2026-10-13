#if canImport(UIKit)
import Foundation
import HappyCore
import os

/// Every main-thread apply runs inside `ApplyPerf.measure`: an `os_signpost`
/// interval named after its site, and in debug builds a precondition that
/// it is on the main queue and a count of its rows and milliseconds
/// (`ApplyMetrics`), logged once per main queue turn.
@MainActor
enum ApplyPerf {
    private static let signposter = OSSignposter(subsystem: "com.slopus.happy", category: "apply")
    private static let logger = Logger(subsystem: "com.slopus.happy", category: "apply")

    /// `body` applies a precomputed change and returns how many rows it
    /// touched.
    @discardableResult
    static func measure(_ site: ApplySite, _ body: () -> Int) -> Int {
        #if DEBUG
        dispatchPrecondition(condition: .onQueue(.main))
        let start = ContinuousClock.now
        #endif
        let name = signpostName(site)
        let interval = signposter.beginInterval(name, id: signposter.makeSignpostID())
        let rows = body()
        signposter.endInterval(name, interval)
        #if DEBUG
        let milliseconds = start.duration(to: .now).milliseconds
        if milliseconds > ApplyBudget.block {
            logger.debug("apply over budget: \(site.rawValue, privacy: .public) \(String(format: "%.2f", milliseconds), privacy: .public)ms, \(rows) rows")
        }
        if ApplyMetrics.shared.record(site, rows: rows, milliseconds: milliseconds) {
            DispatchQueue.main.async {
                guard let batch = ApplyMetrics.shared.endBatch() else { return }
                logger.debug("apply batch: \(batch.summary, privacy: .public)")
            }
        }
        #endif
        return rows
    }

    private static func signpostName(_ site: ApplySite) -> StaticString {
        switch site {
        case .home: "home"
        case .homeList: "home list"
        case .sidebar: "sidebar"
        case .chatSession: "chat session"
        case .chatSnapshot: "chat snapshot"
        case .chatList: "chat list"
        case .screen: "screen"
        }
    }
}
#endif

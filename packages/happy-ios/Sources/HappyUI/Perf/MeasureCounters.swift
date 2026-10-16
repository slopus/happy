#if canImport(UIKit) && DEBUG
import Foundation

/// How many times each measuring site ran on the main thread, in debug
/// builds: the What's New harness reports them, and the UIKit tests check
/// that a scroll measures nothing.
@MainActor
enum MeasureCounters {
    private static var counts: [String: Int] = [:]

    static func count(_ site: String) {
        counts[site, default: 0] += 1
    }

    static subscript(_ site: String) -> Int {
        counts[site, default: 0]
    }

    static func snapshot() -> [String: Int] {
        counts
    }

    static func reset() {
        counts = [:]
    }
}
#endif

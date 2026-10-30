#if canImport(UIKit)
import Foundation
@testable import HappyUI
import XCTest

/// A watch cancels once, on the main thread, however it goes: invalidated,
/// let go of on the main thread, let go of on another thread, or both.
/// Runs on the iOS 26.3 simulator, where an isolated deinit aborted.
@MainActor
final class HostedWatchTests: XCTestCase {
    private final class Count: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        private var offMain = 0
        func hit() {
            lock.lock(); defer { lock.unlock() }
            value += 1
            if !Thread.isMainThread { offMain += 1 }
        }
        var hits: Int { lock.lock(); defer { lock.unlock() }; return value }
        var hitsOffMain: Int { lock.lock(); defer { lock.unlock() }; return offMain }
    }

    func testLetGoOfOnTheMainThreadCancelsThereOnce() {
        let count = Count()
        var watch: Watch? = Watch { count.hit() }
        XCTAssertNotNil(watch)
        watch = nil
        XCTAssertEqual(count.hits, 1)
        XCTAssertEqual(count.hitsOffMain, 0)
    }

    func testInvalidatedThenLetGoOfCancelsOnce() {
        let count = Count()
        var watch: Watch? = Watch { count.hit() }
        watch?.invalidate()
        watch?.invalidate()
        XCTAssertEqual(count.hits, 1)
        watch = nil
        XCTAssertEqual(count.hits, 1)
    }

    func testACancelThatInvalidatesItsOwnWatchRunsOnce() {
        let count = Count()
        final class Box { var watch: Watch? }
        let box = Box()
        box.watch = Watch { [box] in
            count.hit()
            box.watch?.invalidate()
            box.watch = nil
        }
        box.watch?.invalidate()
        XCTAssertEqual(count.hits, 1)
        XCTAssertNil(box.watch)
    }

    /// Holds the only reference, so clearing it is the last release.
    private final class Holder: @unchecked Sendable {
        var watch: Watch?
        init(_ watch: Watch) { self.watch = watch }
        /// Synchronous, so it may ask which thread it is on.
        func release() -> Bool {
            watch = nil
            return !Thread.isMainThread
        }
    }

    func testLetGoOfOffTheMainThreadCancelsOnTheMainThreadOnce() async {
        let count = Count()
        let holder = Holder(Watch { count.hit() })
        let releasedOffMain = await Task.detached { holder.release() }.value
        XCTAssertTrue(releasedOffMain, "the last release ran off the main thread")
        for _ in 0..<200 where count.hits == 0 { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(count.hits, 1)
        XCTAssertEqual(count.hitsOffMain, 0, "a watch let go of off the main thread still cancels on it")
    }

    func testManyLetGoOfFromManyThreadsEachCancelOnce() async {
        let count = Count()
        let holders = (0..<200).map { _ in Holder(Watch { count.hit() }) }
        await withTaskGroup(of: Void.self) { group in
            for holder in holders {
                group.addTask { _ = holder.release() }
            }
        }
        for _ in 0..<200 where count.hits < 200 { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(count.hits, 200)
        XCTAssertEqual(count.hitsOffMain, 0)
    }
}
#endif

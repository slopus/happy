import Foundation
import XCTest
@testable import HappyCore

/// No parameter defaults to an async closure literal. A public default
/// argument is compiled again into every module that leaves it out, and
/// Apple Swift 6.3.3 (Xcode 26.6) gave such copies different async context
/// sizes: `SocketIOClient.init`'s `{ try await Task.sleep(for: $0) }` needed
/// 144 bytes in HappyCore and was given 128 by the tests' copy, and the task
/// allocator aborted ("freed pointer was not the last allocation"). Defaults
/// name a stored closure instead (`InvalidateSync.taskSleep`), which exists
/// once, in its own module.
final class AsyncDefaultArgumentTests: XCTestCase {
    func testNoParameterDefaultsToAnAsyncClosureLiteral() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
        // `name: @escaping … async … = {`, or a closure that awaits behind a
        // type alias (`Sleep = { try await … }`), on one line.
        let pattern = try NSRegularExpression(pattern: #"\w+:\s*@escaping[^=\n]*(\basync\b[^=\n]*=\s*\{|=\s*\{[^}\n]*\bawait\b)"#)
        var found: [String] = []
        var scanned = 0
        let files = try XCTUnwrap(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
        for case let file as URL in files where file.pathExtension == "swift" {
            scanned += 1
            let text = try String(contentsOf: file, encoding: .utf8)
            for (index, line) in text.components(separatedBy: "\n").enumerated()
            where pattern.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil {
                found.append("\(file.lastPathComponent):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))")
            }
        }
        XCTAssertGreaterThan(scanned, 100, "the sources were found")
        XCTAssertEqual(found, [])
    }

    func testTheSharedDefaultsBehave() async throws {
        let start = ContinuousClock.now
        try await InvalidateSync.taskSleep(.milliseconds(5))
        XCTAssertGreaterThanOrEqual(ContinuousClock.now - start, .milliseconds(5))
        await SessionStarter.Environment.taskSleep(1)
        let appState = await AccountSession.Dependencies.alwaysActive()
        XCTAssertEqual(appState, "active")
        await AccountSession.Dependencies.noDeliveryActivity(true)
        let sleeper = Task { try await InvalidateSync.taskSleep(.seconds(60)) }
        sleeper.cancel()
        await XCTAssertThrowsAsync(try await sleeper.value) { XCTAssertTrue($0 is CancellationError) }
    }
}

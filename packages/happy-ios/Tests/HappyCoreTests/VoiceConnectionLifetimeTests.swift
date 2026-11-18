import Foundation
import XCTest
@testable import HappyCore

/// Calls share one audio device: a new connection's lease comes only once
/// the one before it has let go, after its SDK teardown, and a cancelled
/// wait never holds the device.
@MainActor
final class VoiceConnectionLifetimeTests: XCTestCase {
    func testTheNextLeaseWaitsForTheLastOneToFinish() async throws {
        let lifetime = VoiceConnectionLifetime()
        let first = try await lifetime.acquire()
        var handedOn = false
        let waiting = Task {
            let second = try await lifetime.acquire()
            handedOn = true
            second.finish()
        }
        for _ in 0..<50 { await Task.yield() }
        XCTAssertFalse(handedOn, "the device was handed on before teardown")
        first.finish()
        try await waiting.value
        XCTAssertTrue(handedOn)
    }

    func testACancelledWaitLetsTheNextOneThrough() async throws {
        let lifetime = VoiceConnectionLifetime()
        let first = try await lifetime.acquire()
        let cancelled = Task { try await lifetime.acquire().finish() }
        cancelled.cancel()
        first.finish()
        do {
            try await cancelled.value
            XCTFail("a cancelled wait got the device")
        } catch is CancellationError {}
        let next = try await lifetime.acquire()
        next.finish()
    }
}

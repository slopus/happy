import Foundation
import XCTest
@testable import HappyCore

final class DiffDocumentCacheTests: XCTestCase, @unchecked Sendable {
    private func texts(_ document: DiffDocument) -> [String] {
        document.files.flatMap(\.rows).compactMap(\.line).map(\.text)
    }

    func testTwoOwnersReuseOnlyTheirOwnDocumentsAndCloseIndependently() {
        let first = DiffDocumentCache(), second = DiffDocumentCache()
        let a = first.build(path: "private.swift", oldText: "", newText: "let secret = 1")
        let b = second.build(path: "private.swift", oldText: "", newText: "let secret = 1")
        XCTAssertFalse(a === b, "explicit owners must never reuse the legacy global cache")
        XCTAssertTrue(first.build(path: "private.swift", oldText: "", newText: "let secret = 1") === a)
        XCTAssertTrue(second.build(path: "private.swift", oldText: "", newText: "let secret = 1") === b)
        first.close()
        first.close()
        XCTAssertEqual(first.retainedUsage.count, 0)
        XCTAssertEqual(first.retainedUsage.bytes, 0)
        XCTAssertTrue(first.build(path: "private.swift", oldText: "", newText: "late") === DiffDocument.empty)
        XCTAssertTrue(second.build(path: "private.swift", oldText: "", newText: "let secret = 1") === b)
    }

    func testActualFNV32CollisionAndOptionsCannotAliasPrivateContent() {
        let owner = DiffDocumentCache()
        let a = "GEhgUGw4PN9c", b = "EHlhfLI7VFdy"
        XCTAssertEqual(DiffEngine.fnv1a("path.txt\u{0}\u{0}" + a), 0xf7681e34)
        XCTAssertEqual(DiffEngine.cacheKey("c", "path.txt\u{0}\u{0}" + a, .init()),
                       DiffEngine.cacheKey("c", "path.txt\u{0}\u{0}" + b, .init()))
        let first = owner.build(path: "path.txt", oldText: "", newText: a)
        let second = owner.build(path: "path.txt", oldText: "", newText: b)
        XCTAssertEqual(texts(first), [a])
        XCTAssertEqual(texts(second), [b])
        XCTAssertFalse(first === second)
        XCTAssertTrue(owner.build(path: "path.txt", oldText: "", newText: b) === second)
        XCTAssertEqual(texts(owner.build(path: "path.txt", oldText: "", newText: a)), [a])
        let plain = owner.build(path: "path.txt", oldText: "", newText: a, options: .init(intraline: false))
        XCTAssertFalse(plain === first)
    }

    func testNULSeparatedOldAndNewFieldsRemainDistinct() {
        let owner = DiffDocumentCache()
        let a = owner.build(path: "file.txt", oldText: "a\u{0}b", newText: "c")
        let b = owner.build(path: "file.txt", oldText: "a", newText: "b\u{0}c")
        XCTAssertEqual(texts(a), ["a\u{0}b", "c"])
        XCTAssertEqual(texts(b), ["a", "b\u{0}c"])
        XCTAssertFalse(a === b)
    }

    func testDefault48DocumentLimitEvictsLeastRecentlyUsed() {
        let owner = DiffDocumentCache()
        let first = owner.build(path: "0", oldText: "", newText: "0")
        let second = owner.build(path: "1", oldText: "", newText: "1")
        for index in 2..<48 { _ = owner.build(path: "\(index)", oldText: "", newText: "\(index)") }
        XCTAssertEqual(owner.retainedUsage.count, 48)
        XCTAssertTrue(owner.build(path: "0", oldText: "", newText: "0") === first)
        _ = owner.build(path: "48", oldText: "", newText: "48")
        XCTAssertEqual(owner.retainedUsage.count, 48)
        XCTAssertTrue(owner.build(path: "0", oldText: "", newText: "0") === first)
        XCTAssertFalse(owner.build(path: "1", oldText: "", newText: "1") === second)
    }

    func testPayloadLimitEvictsAndOversizedDocumentsStillRenderWithoutRetention() {
        let owner = DiffDocumentCache(countLimit: 48, payloadLimit: 1600)
        let a = owner.build(path: "a", oldText: "", newText: String(repeating: "a", count: 120))
        XCTAssertEqual(owner.retainedUsage.count, 1)
        let b = owner.build(path: "b", oldText: "", newText: String(repeating: "b", count: 120))
        XCTAssertEqual(owner.retainedUsage.count, 1, "two small documents exceed the combined payload budget")
        XCTAssertLessThanOrEqual(owner.retainedUsage.bytes, 1600)
        XCTAssertTrue(owner.build(path: "b", oldText: "", newText: String(repeating: "b", count: 120)) === b)
        XCTAssertFalse(owner.build(path: "a", oldText: "", newText: String(repeating: "a", count: 120)) === a)
        let huge = String(repeating: "private", count: 1000)
        let oversized = owner.build(path: "huge", oldText: "", newText: huge)
        XCTAssertEqual(texts(oversized), [huge])
        XCTAssertFalse(owner.build(path: "huge", oldText: "", newText: huge) === oversized)
        XCTAssertLessThanOrEqual(owner.retainedUsage.bytes, 1600)
    }

    func testClosingDuringBuildRejectsLateInsertionAndFutureBuilds() async {
        let gate = DocumentBuildGate()
        defer { gate.release() }
        let owner = DiffDocumentCache(countLimit: 48, payloadLimit: 16 * 1024 * 1024,
            buildPatch: { patch, options in
                gate.holdFirstBuild()
                return DiffEngine.buildUncached(patch: patch, options: options)
            }, buildContents: { DiffEngine.buildUncached(path: $0, oldText: $1, newText: $2, options: $3) })
        let patch = "--- a/private\n+++ b/private\n@@ -0,0 +1 @@\n+secret"
        let building = Task.detached { owner.build(patch: patch) }
        await fulfillment(of: [gate.entered], timeout: 5)
        owner.close()
        gate.release()
        let completed = await building.value
        XCTAssertEqual(texts(completed), ["secret"])
        XCTAssertEqual(owner.retainedUsage.count, 0, "a completed build cannot retain private text after close")
        XCTAssertEqual(owner.retainedUsage.bytes, 0)
        XCTAssertTrue(owner.build(patch: patch) === DiffDocument.empty)
        XCTAssertEqual(gate.calls, 1)
        XCTAssertFalse(gate.timedOut)
    }

    func testReusablePurgeRejectsRunningGenerationAndAllowsNextBuild() async {
        let gate = DocumentBuildGate()
        defer { gate.release() }
        let owner = DiffDocumentCache(countLimit: 48, payloadLimit: 16 * 1024 * 1024,
            buildPatch: { patch, options in
                gate.holdFirstBuild()
                return DiffEngine.buildUncached(patch: patch, options: options)
            }, buildContents: { DiffEngine.buildUncached(path: $0, oldText: $1, newText: $2, options: $3) })
        let patch = "--- a/private\n+++ b/private\n@@ -0,0 +1 @@\n+secret"
        let building = Task.detached { owner.build(patch: patch) }
        await fulfillment(of: [gate.entered], timeout: 5)
        owner.clearCache()
        gate.release()
        _ = await building.value
        XCTAssertEqual(owner.retainedUsage.count, 0)
        XCTAssertFalse(owner.isClosed)
        let next = owner.build(patch: patch)
        XCTAssertTrue(owner.build(patch: patch) === next)
        XCTAssertEqual(gate.calls, 2)
        XCTAssertFalse(gate.timedOut)
    }
}

private final class DocumentBuildGate: @unchecked Sendable {
    let entered = XCTestExpectation(description: "document build entered")
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var count = 0
    private var timeout = false
    var calls: Int { lock.withLock { count } }
    var timedOut: Bool { lock.withLock { timeout } }
    func holdFirstBuild() {
        let first = lock.withLock { count += 1; return count == 1 }
        guard first else { return }
        entered.fulfill()
        if semaphore.wait(timeout: .now() + 10) == .timedOut { lock.withLock { timeout = true } }
    }
    func release() { semaphore.signal() }
}
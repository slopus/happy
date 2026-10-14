import Foundation
import XCTest
@testable import HappyCore

final class DiffSyntaxLifecycleTests: XCTestCase, @unchecked Sendable {
    private func part(_ text: String) -> (key: String, input: DiffSyntax.Input) {
        let input = DiffSyntax.Input(language: "swift", lines: [.init(text: text, type: .ctx)])
        return (DiffSyntaxPlan.key(input), input)
    }

    func testCloseDropsQueuedPrivateContentAndHeldTokenizerCannotRefillCache() async {
        let gate = SyntaxLifecycleGate()
        defer { gate.release() }
        let service = DiffSyntaxService(tokenize: { gate.tokenize($0) })
        let first = part("held-private"), queued = part("queued-private")
        service.prefetch([first, queued])
        await fulfillment(of: [gate.entered], timeout: 5)
        XCTAssertEqual(service.retainedUsage.jobs, 2)
        service.close()
        service.close()
        XCTAssertTrue(service.isClosed)
        XCTAssertEqual(service.retainedUsage.jobs, 1, "only uninterruptible in-flight input remains")
        gate.release()
        await service.idle()
        XCTAssertEqual(gate.inputs, ["held-private"])
        XCTAssertEqual(service.retainedUsage.results, 0)
        XCTAssertEqual(service.retainedUsage.resultBytes, 0)
        XCTAssertEqual(service.retainedUsage.jobs, 0)
        XCTAssertEqual(service.retainedUsage.jobBytes, 0)
        XCTAssertEqual(service.result(first.key, first.input).status, .limited)
        service.prefetch([queued])
        await service.idle()
        XCTAssertEqual(gate.inputs, ["held-private"])
        XCTAssertFalse(gate.timedOut)
    }

    func testReusableClearDropsOldGenerationButAdmitsSameKeyAgain() async {
        let gate = SyntaxLifecycleGate()
        defer { gate.release() }
        let service = DiffSyntaxService(tokenize: { gate.tokenize($0) })
        let first = part("held-private"), queued = part("discarded-private")
        service.prefetch([first, queued])
        await fulfillment(of: [gate.entered], timeout: 5)
        service.clearCache()
        service.prefetch([first])
        gate.release()
        await service.idle()
        XCTAssertEqual(gate.inputs, ["held-private", "held-private"])
        XCTAssertNotNil(service.peek(first.key))
        XCTAssertNil(service.peek(queued.key))
        XCTAssertFalse(service.isClosed)
        XCTAssertEqual(service.retainedUsage.results, 1)
        XCTAssertEqual(service.retainedUsage.jobBytes, 0)
        XCTAssertFalse(gate.timedOut)
    }

    func testWeightedQueueChargesInFlightInputUntilTokenizerReturns() async {
        let gate = SyntaxLifecycleGate()
        defer { gate.release() }
        let service = DiffSyntaxService(queuePayloadLimit: 1000, tokenize: { gate.tokenize($0) })
        let first = part(String(repeating: "x", count: 100)), second = part(String(repeating: "y", count: 100))
        service.prefetch([first])
        await fulfillment(of: [gate.entered], timeout: 5)
        let reserved = service.retainedUsage.jobBytes
        XCTAssertGreaterThan(reserved, 500)
        service.prefetch([second])
        XCTAssertEqual(service.retainedUsage.jobs, 1)
        XCTAssertEqual(service.retainedUsage.jobBytes, reserved)
        gate.release()
        await service.idle()
        XCTAssertEqual(gate.inputs, [first.input.lines[0].text])
        XCTAssertNil(service.peek(second.key))
        service.prefetch([second])
        await service.idle()
        XCTAssertNotNil(service.peek(second.key), "the byte reservation is released after completion")
        XCTAssertEqual(service.retainedUsage.jobBytes, 0)
        XCTAssertFalse(gate.timedOut)
    }

    func testHard64JobLimitIncludesRunningJobAndDropsExtras() async {
        let gate = SyntaxLifecycleGate()
        defer { gate.release() }
        let service = DiffSyntaxService(queueCountLimit: 1000, tokenize: { gate.tokenize($0) })
        service.prefetch([part("first")])
        await fulfillment(of: [gate.entered], timeout: 5)
        service.prefetch((1...70).map { part("queued-\($0)") })
        XCTAssertEqual(service.retainedUsage.jobs, 64)
        XCTAssertLessThanOrEqual(service.retainedUsage.jobBytes, 4 * 1024 * 1024)
        gate.release()
        await service.idle()
        XCTAssertEqual(gate.inputs.count, 64)
        XCTAssertNil(service.peek(part("queued-64").key))
        XCTAssertFalse(gate.timedOut)
    }

    func testOversizedQueuedInputIsDroppedWithoutTokenizing() async {
        let gate = SyntaxLifecycleGate(holdFirst: false)
        let service = DiffSyntaxService(queuePayloadLimit: 512, tokenize: { gate.tokenize($0) })
        service.prefetch([part(String(repeating: "x", count: 100)), part(String(repeating: "y", count: DiffSyntax.maxLine + 1))])
        await service.idle()
        XCTAssertTrue(gate.inputs.isEmpty)
        XCTAssertEqual(service.retainedUsage.jobs, 0)
        XCTAssertEqual(service.retainedUsage.jobBytes, 0)
    }

    func testResultPayloadEvictsAndOversizedResultIsNotRetained() {
        let gate = SyntaxLifecycleGate(holdFirst: false)
        let service = DiffSyntaxService(resultPayloadLimit: 300, tokenize: { gate.tokenize($0) })
        let first = part(String(repeating: "a", count: 40)), second = part(String(repeating: "b", count: 40))
        _ = service.result(first.key, first.input)
        _ = service.result(second.key, second.input)
        XCTAssertNil(service.peek(first.key))
        XCTAssertNotNil(service.peek(second.key))
        XCTAssertLessThanOrEqual(service.retainedUsage.resultBytes, 300)
        let huge = part(String(repeating: "c", count: 200))
        _ = service.result(huge.key, huge.input)
        _ = service.result(huge.key, huge.input)
        XCTAssertNil(service.peek(huge.key))
        XCTAssertEqual(gate.inputs.count, 4)
        XCTAssertLessThanOrEqual(service.retainedUsage.resultBytes, 300)
    }

    func testTwoOwnersTokenizeSeparatelyAndClosingOnePreservesOtherCache() async {
        let firstGate = SyntaxLifecycleGate(), secondGate = SyntaxLifecycleGate(holdFirst: false)
        defer { firstGate.release() }
        let first = DiffSyntaxService(tokenize: { firstGate.tokenize($0) })
        let second = DiffSyntaxService(tokenize: { secondGate.tokenize($0) })
        let code = part("same private text")
        let oldWork = Task.detached { first.result(code.key, code.input) }
        await fulfillment(of: [firstGate.entered], timeout: 5)
        let current = second.result(code.key, code.input)
        first.close()
        firstGate.release()
        _ = await oldWork.value
        XCTAssertEqual(first.retainedUsage.results, 0)
        XCTAssertEqual(first.retainedUsage.resultBytes, 0)
        XCTAssertEqual(second.result(code.key, code.input), current)
        XCTAssertEqual(firstGate.inputs, ["same private text"])
        XCTAssertEqual(secondGate.inputs, ["same private text"], "the second owner keeps its independent hit")
        XCTAssertFalse(firstGate.timedOut)
    }
}

private final class SyntaxLifecycleGate: @unchecked Sendable {
    let entered = XCTestExpectation(description: "tokenizer entered")
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private let holdFirst: Bool
    private var seen: [String] = []
    private var timeout = false
    init(holdFirst: Bool = true) { self.holdFirst = holdFirst }
    var inputs: [String] { lock.withLock { seen } }
    var timedOut: Bool { lock.withLock { timeout } }
    func tokenize(_ input: DiffSyntax.Input) -> DiffSyntax.Result {
        let first = lock.withLock { seen.append(input.lines.map(\.text).joined(separator: "\n")); return seen.count == 1 }
        if holdFirst && first {
            entered.fulfill()
            if semaphore.wait(timeout: .now() + 10) == .timedOut { lock.withLock { timeout = true } }
        }
        return DiffSyntax.Result(status: .highlighted, runs: input.lines.map { [.init(.keyword, $0.text.utf16.count)] })
    }
    func release() { semaphore.signal() }
}
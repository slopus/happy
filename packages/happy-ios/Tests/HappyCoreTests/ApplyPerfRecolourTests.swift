import Foundation
import XCTest
@testable import HappyCore

/// A row whose code block's colour isn't ready is drawn plain, then drawn
/// again once, coloured, after the service's next signal; nothing else is
/// measured or changed for it.
final class ApplyPerfRecolourTests: XCTestCase {
    private struct Row: Equatable, Sendable {
        var id: String
        var code: String?
    }

    private struct Plan: Equatable, Sendable {
        var coloured: Bool
    }

    private func planner(_ service: CodeSyntaxService) -> RowPlanner<Row, Plan> {
        RowPlanner { row, _ in
            guard let code = row.code else { return Plan(coloured: false) }
            if case .highlighted = service.tokens(code, language: "ts") { return Plan(coloured: true) }
            return Plan(coloured: false)
        }
    }

    /// A pass whose syntax time is already spent.
    private func late(_ planner: RowPlanner<Row, Plan>, _ rows: [Row], applied: PlannedRows<Row, Plan>, recolour: Int)
        -> (rows: PlannedRows<Row, Plan>, changeset: RowChangeset, measured: Int) {
        SyntaxPass.run(until: .now - .seconds(1)) {
            planner.plan(rows, id: \.id, width: 390, applied: applied, recolour: recolour)
        }
    }

    private let block = (0..<40).map { "const value\($0) = compute(\($0))" }.joined(separator: "\n")

    func testAPendingBlockIsRecolouredOnceAfterItsSignal() async throws {
        let service = CodeSyntaxService()
        let signals = service.completions()
        let planner = planner(service)
        let rows = [Row(id: "text", code: nil), Row(id: "code", code: block), Row(id: "other", code: nil)]

        let first = late(planner, rows, applied: PlannedRows(), recolour: 0)
        XCTAssertEqual(first.rows.plans, [Plan(coloured: false), Plan(coloured: false), Plan(coloured: false)])
        XCTAssertEqual(first.rows.pending, ["code"])
        XCTAssertEqual(first.measured, 3)

        // Before the signal: nothing to do.
        let waiting = late(planner, rows, applied: first.rows, recolour: 0)
        XCTAssertEqual(waiting.measured, 0)
        XCTAssertTrue(waiting.changeset.isEmpty)

        let signal: Void? = try await syncPerfNext(signals)
        XCTAssertNotNil(signal)
        await service.idle()
        let recoloured = late(planner, rows, applied: waiting.rows, recolour: 1)
        XCTAssertEqual(recoloured.measured, 1, "only the pending row")
        XCTAssertEqual(recoloured.changeset, RowChangeset(reconfigures: [1]))
        XCTAssertEqual(recoloured.rows.plans[1], Plan(coloured: true))
        XCTAssertEqual(recoloured.rows.pending, [])

        // Later signals change nothing more.
        let after = late(planner, rows, applied: recoloured.rows, recolour: 2)
        XCTAssertEqual(after.measured, 0)
        XCTAssertTrue(after.changeset.isEmpty)
        service.close()
    }

    /// Another block's signal measures the waiting row again, but while it
    /// is still plain the screen hears nothing.
    func testARowStillWaitingAfterASignalChangesNothingOnScreen() async throws {
        let probe = HeldTokenizer()
        let service = CodeSyntaxService(queueCountLimit: 2, tokenizeLine: { text, grammar, stack in
            probe.gate.pass()
            return SyntaxHighlighter.tokenizeLine(text, grammar: grammar, stack: stack)
        })
        let planner = planner(service)
        let rows = [Row(id: "a", code: block), Row(id: "b", code: block + "\n// b")]
        let first = late(planner, rows, applied: PlannedRows(), recolour: 0)
        XCTAssertEqual(first.rows.pending, ["a", "b"])
        probe.gate.waitUntilHeld()
        let still = late(planner, rows, applied: first.rows, recolour: 1)
        XCTAssertEqual(still.measured, 2)
        XCTAssertTrue(still.changeset.isEmpty, "plain again is no change")
        XCTAssertEqual(still.rows.pending, ["a", "b"])
        probe.gate.open()
        await service.idle()
        let done = late(planner, rows, applied: still.rows, recolour: 2)
        XCTAssertEqual(done.changeset, RowChangeset(reconfigures: [0, 1]))
        XCTAssertEqual(done.rows.plans, [Plan(coloured: true), Plan(coloured: true)])
        service.close()
    }

    /// The pending mark travels with the rows the list applied, so a
    /// planner that never saw them still recolours them.
    func testThePendingMarkComesBackWithTheAppliedRows() async throws {
        let service = CodeSyntaxService()
        let rows = [Row(id: "code", code: block)]
        let first = late(planner(service), rows, applied: PlannedRows(), recolour: 0)
        XCTAssertEqual(first.rows.pending, ["code"])
        await service.idle()
        let fresh = planner(service)
        let reused = late(fresh, rows, applied: first.rows, recolour: 0)
        XCTAssertEqual(reused.measured, 0, "the applied plan is reused")
        XCTAssertEqual(reused.rows.pending, ["code"])
        let recoloured = late(fresh, rows, applied: reused.rows, recolour: 1)
        XCTAssertEqual(recoloured.changeset, RowChangeset(reconfigures: [0]))
        service.close()
    }
}

private final class HeldTokenizer: @unchecked Sendable {
    let gate = ApplyPerfGate()
}

import Foundation
import XCTest
@testable import HappyCore
import HappyStore

/// The section of chats that name no computer is `<status.unknown>` in the
/// screens' language (ProjectHomeList.tsx 128, SessionsList.tsx): the word
/// is read on the main thread and carried in the derivation's input, so no
/// derivation reads a language, and a new word is a new derivation that
/// reconfigures that heading alone.
final class UnknownMachineWordTests: XCTestCase {
    private let snapshot = TabletGroupedListTests.snapshot()

    private func home(_ word: String?, applied: HomeDerivation.Applied = .init()) throws -> (output: HomeUpdate, state: HomeDerivation.Applied) {
        var input = HomeDerivation.Input(snapshot: snapshot, clock: ApplyPerfFixtures.clock)
        if let word { input.unknownMachine = word }
        return try XCTUnwrap(HomeDerivation.derive(input, applied: applied))
    }

    private func sidebar(_ word: String?, applied: TabletSidebarDerivation.Applied = .init()) throws -> (output: TabletSidebarUpdate, state: TabletSidebarDerivation.Applied) {
        var input = TabletSidebarInput(snapshot: snapshot)
        if let word { input.unknownMachine = word }
        return try XCTUnwrap(TabletSidebarDerivation.derive(input, applied: applied, clock: ApplyPerfFixtures.clock))
    }

    private func homeMachines(_ update: HomeUpdate) -> [String] {
        (update.content.list?.rows ?? []).compactMap { row in
            if case .project(.machine(_, let name)) = row { return name }
            return nil
        }
    }

    private func sidebarMachines(_ update: TabletSidebarUpdate) -> [String] {
        (update.frame.grouped?.rows ?? []).compactMap { row in
            if case .machine(_, let name) = row { return name }
            return nil
        }
    }

    func testHomesProjectListNamesTheSectionInTheWordItIsGiven() throws {
        XCTAssertEqual(homeMachines(try home(nil).output).last, "<unknown>")
        XCTAssertEqual(homeMachines(try home("inconnu").output).last, "<inconnu>")
        // The computers' own names are the person's and stay.
        XCTAssertEqual(homeMachines(try home("inconnu").output).dropLast(), homeMachines(try home(nil).output).dropLast())
    }

    func testTheSidebarNamesItsRuleInTheWordItIsGiven() throws {
        XCTAssertEqual(sidebarMachines(try sidebar(nil).output), ["m2", "Studio", "<unknown>"])
        XCTAssertEqual(sidebarMachines(try sidebar("不明").output), ["m2", "Studio", "<不明>"])
    }

    func testANewWordReconfiguresThatHeadingAlone() throws {
        let english = try home(nil)
        let french = try home("inconnu", applied: english.state)
        let rows = try XCTUnwrap(french.output.content.list?.rows)
        XCTAssertFalse(french.output.changeset.isStructural)
        XCTAssertEqual(french.output.changeset.reconfigures.count, 1)
        guard case .project(.machine(nil, "<inconnu>")) = rows[french.output.changeset.reconfigures[0]] else {
            return XCTFail("reconfigured \(rows[french.output.changeset.reconfigures[0]])")
        }

        let tablet = try sidebar(nil)
        let japanese = try sidebar("不明", applied: tablet.state)
        let changeset = try XCTUnwrap(japanese.output.changeset)
        let list = try XCTUnwrap(japanese.output.frame.grouped)
        XCTAssertFalse(changeset.isStructural)
        XCTAssertEqual(changeset.reconfigures.map { list.rows[$0] }, [.machine(id: nil, name: "<不明>")])
        // The same word again: nothing for the main thread.
        var input = TabletSidebarInput(snapshot: snapshot)
        input.unknownMachine = "不明"
        XCTAssertNil(TabletSidebarDerivation.derive(input, applied: japanese.state, clock: ApplyPerfFixtures.clock))
    }
}

import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// Home's rows in the modern home's inset cards: a section's heading is
/// only the gap between two cards, the archive is one card under its
/// toggle, and each row knows its place in its card.
final class HomeCardPlaceTests: XCTestCase {
    private typealias Fixture = TabletGroupedListTests

    private func model(_ sessions: [SessionRecord], grouping: String) -> HomeListModel {
        HomeListModel(
            SessionList(TasksHomeTests.snapshot(sessions, grouping: grouping), clock: ApplyPerfFixtures.clock),
            offline: nil,
            expandedProjects: []
        )
    }

    private func place(_ first: Bool, _ last: Bool, _ separated: Bool) -> HomeCardPlace {
        HomeCardPlace(first: first, last: last, separated: separated)
    }

    func testTheFlatListIsTheLiveCardThenTheArchiveCard() {
        let list = model([
            Fixture.session("a", machine: "m1", path: "/work/happy", at: Fixture.now - Fixture.minute),
            Fixture.session("b", machine: "m1", path: "/work/happy", at: Fixture.now - 2 * Fixture.minute),
            Fixture.session("c", machine: "m1", path: "/work/happy", at: Fixture.now - 3 * Fixture.minute),
            Fixture.session("old", machine: "m1", path: "/work/happy", active: false, at: Fixture.now - Fixture.hour),
            Fixture.session("older", machine: "m1", path: "/work/happy", active: false, at: Fixture.now - 3 * Fixture.day),
        ], grouping: "flat")
        // The two archived chats were a day apart: no day headings.
        XCTAssertEqual(list.ids, [
            .session("a"), .session("b"), .session("c"), .archiveToggle, .session("old"), .session("older"),
        ])
        XCTAssertEqual(list.places, [
            place(true, false, true), place(false, false, true), place(false, true, false),
            nil,
            place(true, false, true), place(false, true, false),
        ])
    }

    func testSectionsAreGapsBetweenCardsAndAProjectsTreeHasNoHairlines() {
        let list = model([
            Fixture.session("b1", machine: "m1", path: "/work/helper", metadata: TasksHomeTests.bot),
            TasksHomeTests.task("t1", taskId: "a"),
            Fixture.session("s1", machine: "m1", path: "/work/happy", title: "Primary"),
            Fixture.session("w1", machine: "m1", path: Fixture.worktreePath),
            Fixture.session("s2", machine: "m1", path: "/work/site"),
        ], grouping: "project")
        // One computer: no heading, and the bots' gap would part nothing.
        XCTAssertEqual(list.rows.map(\.kind), ["bot", "gap", "task", "gap", "project", "worktree", "project"])
        XCTAssertEqual(list.places, [
            place(true, true, false),
            nil,
            place(true, true, false),
            nil,
            // The worktree hangs on its project's tree line; the next
            // project is parted from it by a hairline.
            place(true, false, false), place(false, false, true), place(false, true, false),
        ])
    }

    func testEachComputerHeadsItsCardsBesideAnother() {
        var snapshot = TasksHomeTests.snapshot([
            Fixture.session("s1", machine: "m1", path: "/work/happy"),
            Fixture.session("s2", machine: "m2", path: "/work/site"),
        ])
        snapshot.machines = MachinesSnapshot(synced: true, machines: [
            Fixture.machine("m1", active: true, name: "Studio"),
            Fixture.machine("m2", active: true, name: "Laptop"),
        ])
        let list = HomeListModel(SessionList(snapshot, clock: ApplyPerfFixtures.clock), offline: nil, expandedProjects: [])
        XCTAssertEqual(list.rows.map(\.kind), ["machine", "project", "machine", "project"])
        XCTAssertEqual(list.places, [nil, place(true, true, false), nil, place(true, true, false)])
    }

    func testTheHiddenArchiveKeepsThePlacesOfTheRowsAboveIt() throws {
        var snapshot = TasksHomeTests.snapshot([
            Fixture.session("a", machine: "m1", path: "/work/happy"),
            Fixture.session("old", machine: "m1", path: "/work/happy", active: false, at: Fixture.now - Fixture.hour),
        ], grouping: "flat")
        snapshot.settings = SettingsSnapshot(pending: ["sessionListGrouping": .string("flat"), "hideInactiveSessions": .bool(true)])
        let models = try XCTUnwrap(HomeArchiveModels.make(snapshot: snapshot, expandedProjects: [], draftSessionIds: [], clock: ApplyPerfFixtures.clock, unknownMachine: "unknown"))
        XCTAssertEqual(models.shown.places, [place(true, true, false), nil, place(true, true, false)])
        XCTAssertEqual(models.hidden.places, [place(true, true, false), nil])
        XCTAssertEqual(models.hidden.places, HomeCardPlace.places(models.hidden.rows))
    }
}

private extension HomeListRow {
    var kind: String {
        switch self {
        case .flat(.session): "session"
        case .flat(.archiveToggle), .project(.archiveToggle): "archive"
        case .flat(.dayHeader), .project(.archiveHeader): "day"
        case .project(.machine): "machine"
        case .project(.section): "gap"
        case .project(.bot): "bot"
        case .project(.task): "task"
        case .project(.project): "project"
        case .project(.worktree): "worktree"
        case .project(.worktreeToggle): "toggle"
        case .project(.archived): "archived"
        }
    }
}

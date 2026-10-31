#if canImport(UIKit)
@testable import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// What a change costs the rich tasks: only the item that changed is measured again.
@MainActor
final class TaskListViewTests: XCTestCase {
    func tasks(_ statuses: [String], first: Int = 0) -> RichTasks {
        let cards = statuses.enumerated().map { offset, status in
            let index = first + offset
            return RichTasks.Card(taskId: "t\(index)", name: "Task \(index)", canArchive: true,
                                  agent: AgentWire.Agent(id: "a\(index)", workspaceId: "w", statusLine: .init(text: status, updatedAt: 0)), faces: [], subRows: [])
        }
        return RichTasks(sections: [.init(id: "s", name: "Now", collapsed: false, cards: cards)]).projected()
    }

    func testOneCardsStatusMeasuresOnlyThatCard() {
        let list = TaskListView(frame: CGRect(x: 0, y: 0, width: 304, height: 0))
        list.apply(tasks(["One", "Two", "Three"]))
        let height = list.contentHeight
        XCTAssertEqual(list.measures, 4, "the header and three cards")
        list.apply(tasks(["One", "Two, now longer", "Three"]))
        XCTAssertEqual(list.contentHeight, height)
        XCTAssertEqual(list.measures, 5)
        list.tick()
        XCTAssertEqual(list.contentHeight, height)
        XCTAssertEqual(list.measures, 5, "times that read the same are not measured again")
        // A card arriving above the one on screen: the list around is told how far that one moved.
        list.viewport = CGRect(x: 0, y: 100, width: 304, height: 400)
        list.apply(tasks(["Zero", "One", "Two, now longer", "Three"], first: -1))
        XCTAssertEqual(list.drift, 68)
    }
}
#endif

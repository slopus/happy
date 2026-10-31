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
        XCTAssertEqual(list.measures, 3, "three cards")
        list.apply(tasks(["One", "Two, now longer", "Three"]))
        XCTAssertEqual(list.contentHeight, height)
        XCTAssertEqual(list.measures, 4)
        list.tick()
        XCTAssertEqual(list.contentHeight, height)
        XCTAssertEqual(list.measures, 4, "times that read the same are not measured again")
        // A card arriving above the one on screen: the list around is told how far that one moved.
        list.viewport = CGRect(x: 0, y: 100, width: 304, height: 400)
        list.apply(tasks(["Zero", "One", "Two, now longer", "Three"], first: -1))
        XCTAssertEqual(list.drift, list.result.frames[0].box.height, "a whole card")
    }

    private final class Icons: AgentTransport, @unchecked Sendable {
        var paths: [String] = []
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            paths.append(path)
            return HTTP1Response(status: 200, headers: [:], body: UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { $0.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) })
        }
        func close() async {}
    }

    /// A card's icon is read once per hash: the same again comes from the cache, a new one from the daemon.
    func testIconsAreReadOncePerHash() async {
        let icons = Icons(), images = Images(client: AgentClient(transport: icons, token: "t"))
        let paths = ["a", "a", "b"].compactMap { TaskIcon(type: "library", slug: "kubernetes-deployments", hash: String(repeating: $0, count: 64)).path }
        for path in paths { _ = await images.picture(path, thumbhash: nil, pixels: 180) }
        XCTAssertEqual(icons.paths, [paths[0], paths[2]])
    }
}
#endif

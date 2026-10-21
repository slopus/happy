#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import HappyWire
import UIKit
import XCTest

/// PermissionFooter's list past its cap scrolls, with its buttons and their
/// taps inside the scroller. Needs UIKit, so it runs only in the simulator.
@MainActor
final class PermissionFooterTests: XCTestCase {
    private func footer(maxListHeight: CGFloat) -> (items: [ChatDrawItem], hits: [ChatHit]) {
        let permission = ToolPermission(id: "p1", status: .pending)
        let tool = ToolCall(name: "Bash", state: .running, input: .object(["command": .string("ls")]), createdAt: 0, permission: permission)
        let piece = ChatRowRenderer.permissionFooter(permission, tool: tool, busy: nil, flavor: nil, maxListHeight: maxListHeight, text: .designed)
        let size = piece.measurable.size(fitting: 377)
        return piece.draw(CGRect(origin: CGPoint(x: 8, y: 100), size: size))
    }

    func testAShortListIsDrawnInTheRow() {
        let drawn = footer(maxListHeight: 260)
        XCTAssertFalse(drawn.items.contains { if case .scroller = $0 { true } else { false } })
        XCTAssertFalse(drawn.hits.isEmpty)
    }

    func testAListPastItsCapScrolls() throws {
        let drawn = footer(maxListHeight: 40)
        XCTAssertEqual(drawn.items.count, 1)
        guard case .scroller(let list, let frame, _, let vertical) = try XCTUnwrap(drawn.items.first) else {
            return XCTFail("expected the list's scroller")
        }
        XCTAssertTrue(vertical)
        // 6 in and 4 down from the footer's origin, as tall as the cap.
        XCTAssertEqual(frame.origin, CGPoint(x: 14, y: 104))
        XCTAssertEqual(frame.height, 40)
        XCTAssertGreaterThan(list.size.height, frame.height)
        XCTAssertTrue(drawn.hits.isEmpty, "the taps are the list's")
        XCTAssertFalse(list.hits.isEmpty)
        XCTAssertEqual(list.hits.first?.frame.origin, .zero)
    }
}
#endif

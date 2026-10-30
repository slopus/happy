#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// A live list change must preserve the row under the reader's eye even
/// when the scroll view is already beyond its bottom edge. These tests
/// set that position directly; AgentListScrollUITests covers the actual
/// finger release and UIKit's spring back.
@MainActor
final class HostedSidebarBounceTests: XCTestCase {
    private func fixture() async throws -> (UIWindow, SidebarView, [Row]) {
        LegacyFonts.registerBundledFonts()
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let controller = UIViewController()
        let window = hostedKeyWindow(in: scene, root: controller)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            previous?.makeKey()
        }
        window.layoutIfNeeded()
        let list = SidebarView(frame: controller.view.bounds)
        controller.view.addSubview(list)
        list.contentInset = UIEdgeInsets(top: 100, left: 0, bottom: 34, right: 0)
        let rows = (0..<60).map {
            Row(id: "row:\($0)", nodeId: "\($0)", kind: .space, label: "Task \($0)", agentId: "\($0)")
        }
        list.apply(rows)
        list.layoutIfNeeded()
        return (window, list, rows)
    }

    private func bottom(_ list: SidebarView) -> CGFloat {
        max(-list.contentInset.top, list.contentSize.height + list.contentInset.bottom - list.bounds.height)
    }

    private func checkOverscroll(insert: Bool) async throws {
        let (window, list, rows) = try await fixture()
        list.contentOffset.y = bottom(list) + 60
        list.layoutIfNeeded()
        let overscroll = list.contentOffset.y - bottom(list)
        XCTAssertGreaterThan(overscroll, 50, "the fixture must start beyond its bottom")
        let anchor = try XCTUnwrap(list.visibleRows.first)
        let view = try XCTUnwrap(list.view(for: anchor.id))
        let before = view.convert(.zero, to: window).y
        var updated = rows
        if insert {
            updated.insert(Row(id: "arrived", nodeId: "arrived", kind: .space, label: "New task"), at: 0)
        } else {
            updated.removeFirst()
        }
        list.apply(updated)
        list.layoutIfNeeded()
        XCTAssertEqual(view.convert(.zero, to: window).y, before, accuracy: 0.5, "a live change moved a visible row during the bounce")
        XCTAssertEqual(list.contentOffset.y - bottom(list), overscroll, accuracy: 0.5, "the update snapped away the existing overscroll")
    }

    func testRemovingARowAbovePreservesVisiblePositionAndOverscroll() async throws {
        try await checkOverscroll(insert: false)
    }

    func testInsertingARowAbovePreservesVisiblePositionAndOverscroll() async throws {
        try await checkOverscroll(insert: true)
    }

    func testShrinkingTheListAtRestDoesNotIntroduceOverscroll() async throws {
        let (_, list, rows) = try await fixture()
        list.contentOffset.y = bottom(list)
        list.layoutIfNeeded()
        let visible = Set(list.visibleRows.map(\.id))
        // Remove only rows below the first visible one, including the tail.
        let first = try XCTUnwrap(rows.firstIndex { visible.contains($0.id) })
        list.apply(Array(rows.prefix(first + 2)))
        list.layoutIfNeeded()
        XCTAssertLessThanOrEqual(list.contentOffset.y, bottom(list) + 0.5)
        XCTAssertGreaterThanOrEqual(list.contentOffset.y, -list.contentInset.top - 0.5)
    }
}
#endif
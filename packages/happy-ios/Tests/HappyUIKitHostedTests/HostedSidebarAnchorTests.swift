#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class HostedSidebarAnchorTests: XCTestCase {
    private func fixture() async throws -> (UIWindow, SidebarView, [Row]) {
        LegacyFonts.registerBundledFonts()
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let controller = UIViewController()
        let window = hostedKeyWindow(in: scene, root: controller)
        addTeardownBlock { @MainActor in window.isHidden = true; previous?.makeKey() }
        window.layoutIfNeeded()
        let list = SidebarView(frame: controller.view.bounds)
        list.style = .grouped
        controller.view.addSubview(list)
        list.contentInset = UIEdgeInsets(top: 100, left: 0, bottom: 34, right: 0)
        let rows = (0..<100).map { Row(id: "row:\($0)", nodeId: "\($0)", kind: .space, label: "Task \($0)") }
        list.apply(rows)
        list.layoutIfNeeded()
        list.contentOffset.y = 1300
        list.layoutIfNeeded()
        return (window, list, rows)
    }

    func testDeletingVisibleAnchorKeepsItsNeighborSteady() async throws {
        try await checkAnchor(move: false)
    }

    func testReorderingVisibleAnchorKeepsItsNeighborSteady() async throws {
        try await checkAnchor(move: true)
    }

    func testAdjacentSwapKeepsTheUnchangedVisibleGroupSteady() async throws {
        let (window, list, rows) = try await fixture()
        let first = try XCTUnwrap(list.visibleRows.first)
        let neighbor = try XCTUnwrap(list.visibleRows.dropFirst(2).first)
        let view = try XCTUnwrap(list.view(for: neighbor.id))
        let position = view.convert(CGPoint.zero, to: window)
        var updated = rows
        let index = try XCTUnwrap(updated.firstIndex { $0.id == first.id })
        updated.swapAt(index, index + 1)
        list.apply(updated)
        list.layoutIfNeeded()
        XCTAssertEqual(view.convert(.zero, to: window).y, position.y, accuracy: 0.01)
    }

    private func checkAnchor(move: Bool) async throws {
        let (window, list, rows) = try await fixture()
        let first = try XCTUnwrap(list.visibleRows.first)
        let neighbor = try XCTUnwrap(list.visibleRows.dropFirst().first)
        let view = try XCTUnwrap(list.view(for: neighbor.id))
        let position = view.convert(CGPoint.zero, to: window)
        var updated = rows
        let index = try XCTUnwrap(updated.firstIndex { $0.id == first.id })
        let removed = updated.remove(at: index)
        if move { updated.insert(removed, at: index + 8) }
        list.apply(updated)
        list.layoutIfNeeded()
        XCTAssertEqual(view.convert(.zero, to: window).y, position.y, accuracy: 0.01)
    }

    func testSameSizeUpdatesNeverChangeOffsetEvenDuringOverscroll() async throws {
        let (_, list, rows) = try await fixture()
        let bottom = list.contentSize.height + list.contentInset.bottom - list.bounds.height
        for offset in [-list.contentInset.top - 50, -list.contentInset.top, 1300, bottom, bottom + 60] {
            list.contentOffset.y = offset
            list.layoutIfNeeded()
            let beforeOffset = list.contentOffset
            let beforeSize = list.contentSize
            let beforeBoxes = try XCTUnwrap(list.layoutResult).frames.map(\.box)
            var updated = rows
            for iteration in 0..<12 {
                for index in updated.indices {
                    updated[index].label = "Renamed \(index), update \(iteration)"
                    updated[index].status = iteration.isMultiple(of: 2) ? .working : .waiting
                    updated[index].unread = iteration.isMultiple(of: 3)
                }
                list.apply(updated)
                list.layoutIfNeeded()
                XCTAssertEqual(list.layoutResult?.frames.map(\.box), beforeBoxes)
                XCTAssertEqual(list.contentSize, beforeSize)
                XCTAssertEqual(list.contentOffset, beforeOffset, "same-size update changed the offset at \(offset)")
            }
        }
    }
}
#endif
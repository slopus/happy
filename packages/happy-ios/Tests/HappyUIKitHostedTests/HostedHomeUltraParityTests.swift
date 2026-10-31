#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import UltraView
import XCTest

/// What the legacy home's list did on UITableView, on UltraList: the swipe
/// that archives, the long press that opens the "Session" alert, the open
/// chat's row selected in the sidebar, the status bar's scroll to the top,
/// and VoiceOver reading each row.
@MainActor
final class HostedHomeUltraParityTests: XCTestCase {
    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    private func row(_ list: UltraListView, _ identity: String) -> HomeUltraRow? {
        list.items.first { $0.identity == identity } as? HomeUltraRow
    }

    private func view(_ list: UltraListView, _ identity: String) -> ListRowView? {
        list.items.firstIndex { $0.identity == identity }.flatMap { list.loadedItemView(at: $0) }
    }

    private func scrollViews(in view: UIView) -> [UIScrollView] {
        ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrollViews(in:))
    }

    /// A live session swipes to "Archive Session", one action that a full
    /// swipe doesn't take, as the table's did.
    func testALiveSessionSwipesToArchive() async throws {
        let app = try await HomeApp.legacy(self)
        let list = try XCTUnwrap(app.legacyList)
        let session = try XCTUnwrap(row(list, "session:long-0"))
        XCTAssertEqual(session.trailingSwipeActions.map(\.title), [Strings.SessionInfo.archiveSession])
        XCTAssertTrue(session.trailingSwipeActions.allSatisfy(\.isDestructive))
        let red = UITraitCollection(userInterfaceStyle: .light)
        XCTAssertEqual(session.trailingSwipeActions.first?.color.resolvedColor(with: red), UIColor(Palette.statusError).resolvedColor(with: red), "the table's red")
        XCTAssertFalse(list.swipeActions.allowsFullSwipe)
        let others = list.items.compactMap { $0 as? HomeUltraRow }.filter { !$0.identity.hasPrefix("session:") }
        XCTAssertTrue(others.allSatisfy(\.trailingSwipeActions.isEmpty), "only sessions swipe: \(others.map(\.identity))")
    }

    /// A long press on a session opens its "Session" alert.
    func testALongPressOpensTheSessionAlert() async throws {
        let app = try await HomeApp.legacy(self)
        let list = try XCTUnwrap(app.legacyList)
        let hold = try XCTUnwrap(row(list, "session:long-0")?.longPress, "a session has no long press")
        hold()
        let shown = try await until { app.navigation.presentedViewController is UIAlertController }
        XCTAssertTrue(shown, "no alert: \(String(describing: app.navigation.presentedViewController))")
        let others = list.items.compactMap { $0 as? HomeUltraRow }.filter { !$0.identity.hasPrefix("session:") }
        XCTAssertTrue(others.allSatisfy { $0.longPress == nil }, "only sessions have a long press: \(others.map(\.identity))")
        app.navigation.dismiss(animated: false)
    }

    /// VoiceOver reads a session as a button with its title, and offers
    /// what its long press opens as an action.
    func testVoiceOverReadsASessionAsAButtonWithItsActions() async throws {
        let app = try await HomeApp.legacy(self)
        let list = try XCTUnwrap(app.legacyList)
        let loaded = try await until { self.view(list, "session:long-0") != nil }
        XCTAssertTrue(loaded)
        let cell = try XCTUnwrap(view(list, "session:long-0"))
        XCTAssertTrue(cell.isAccessibilityElement)
        XCTAssertTrue(cell.accessibilityLabel?.contains("Older conversation 0") == true, cell.accessibilityLabel ?? "")
        XCTAssertTrue(cell.accessibilityTraits.contains(.button))
        XCTAssertEqual(cell.accessibilityCustomActions?.map { $0.name }, [Strings.Home.rowActions])
    }

    /// The status bar's tap goes to the list, the one scroll view in the
    /// window that takes it, and brings the list back to its first row.
    func testTheStatusBarTapScrollsTheListToTheTop() async throws {
        let app = try await HomeApp.legacy(self)
        let list = try XCTUnwrap(app.legacyList)
        let claims = scrollViews(in: app.window).filter { $0.scrollsToTop && $0.window != nil && !$0.isHidden }
        XCTAssertEqual(claims.count, 1, "UIKit gives the tap to no one unless exactly one claims it: \(claims)")
        let proxy = try XCTUnwrap(claims.first)
        XCTAssertTrue(proxy.isDescendant(of: list), "the tap goes to \(proxy)")

        let last = list.items.count - 1
        list.scrollTo(.init(index: last, identity: list.items[last].identity), transition: .none)
        let away = try await until { !list.loadedIndexRange.contains(0) }
        XCTAssertTrue(away, "the list never left its top")
        _ = proxy.delegate?.scrollViewShouldScrollToTop?(proxy)
        let top = try await until(seconds: 3) {
            list.loadedIndexRange.contains(0) && abs((list.settledFrame(at: 0)?.minY ?? -1) - list.viewportInsets.top) < 0.5
        }
        XCTAssertTrue(top, "the first row isn't at the top: \(String(describing: list.settledFrame(at: 0))), inset \(list.viewportInsets.top)")
    }

    /// In the sidebar, the open chat's row is drawn selected and read as
    /// selected; another chat opening moves it.
    func testTheOpenChatsRowStaysSelected() async throws {
        let app = try await HomeApp.legacy(self)
        let list = try XCTUnwrap(app.legacyList)
        let sessions = try XCTUnwrap(app.root.children.compactMap { $0 as? SessionListViewController }.first)
        sessions.selectedSessionId = "long-1"
        let selected = try await until { self.row(list, "session:long-1")?.selected == true && self.view(list, "session:long-1")?.accessibilityTraits.contains(.selected) == true }
        XCTAssertTrue(selected)
        XCTAssertEqual(list.items.compactMap { $0 as? HomeUltraRow }.filter(\.selected).map(\.identity), ["session:long-1"])

        sessions.selectedSessionId = "long-2"
        let moved = try await until { self.row(list, "session:long-2")?.selected == true && self.row(list, "session:long-1")?.selected == false }
        XCTAssertTrue(moved)
        sessions.selectedSessionId = nil
        let none = try await until { list.items.compactMap { $0 as? HomeUltraRow }.allSatisfy { !$0.selected } }
        XCTAssertTrue(none)
    }
}
#endif

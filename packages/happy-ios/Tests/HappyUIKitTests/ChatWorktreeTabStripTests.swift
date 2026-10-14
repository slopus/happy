#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The worktree strip's names: measured off the main thread as their labels
/// draw them, once per name, face and text size, and placed at the
/// person's text size in a strip whose heights stay fixed. The frames
/// themselves are WorktreeTabStripLayoutTests', on Linux.
@MainActor
final class ChatWorktreeTabStripTests: XCTestCase {
    private let short = "main"
    private let wide = "修复登录 🚀"
    private let long = "Fix the login redirect when the session cookie expires on Safari"

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    /// The names a strip measured, and how many on the main thread.
    private final class Measured: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [WorktreeTabName] = []
        private var main = 0
        var names: [WorktreeTabName] { lock.withLock { all } }
        var onMain: Int { lock.withLock { main } }

        func record(_ name: WorktreeTabName) {
            let isMain = Thread.isMainThread
            lock.withLock {
                all.append(name)
                if isMain { main += 1 }
            }
        }
    }

    private func counted(_ measured: Measured) -> WorktreeTabNames {
        WorktreeTabNames { name in
            measured.record(name)
            return WorktreeTabNames.size(name)
        }
    }

    private func item(_ id: String, _ title: String, unread: Bool = false) -> ChatWorktreeTabStrip.Item {
        ChatWorktreeTabStrip.Item(id: id, title: title, shimmers: false, blocked: false, unread: unread, pending: false)
    }

    /// A strip at a phone's width in a shown window, at `category`.
    private func strip(_ category: UIContentSizeCategory, names: WorktreeTabNames) -> (UIWindow, UIView, ChatWorktreeTabStrip) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let host = UIView(frame: window.bounds)
        host.traitOverrides.preferredContentSizeCategory = category
        window.addSubview(host)
        let strip = ChatWorktreeTabStrip(frame: CGRect(x: 0, y: 100, width: 393, height: WorktreeTabStripLayout.Metrics.height))
        strip.names = names
        host.addSubview(strip)
        window.isHidden = false
        host.updateTraitsIfNeeded()
        strip.updateTraitsIfNeeded()
        return (window, host, strip)
    }

    private func until(_ condition: () -> Bool) async throws -> Bool {
        for _ in 0..<500 where !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    /// The strip's tab labels' widths once it has laid out.
    private func labelWidths(_ strip: ChatWorktreeTabStrip) -> [CGFloat] {
        strip.layoutIfNeeded()
        return strip.layout?.tabs.map(\.label.width) ?? []
    }

    func testANameMeasuredOffTheMainThreadFitsTheTextItsLabelDraws() async throws {
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
            let host = UIView(frame: window.bounds)
            host.traitOverrides.preferredContentSizeCategory = category
            host.traitOverrides.followsTextSize = true
            window.addSubview(host)
            host.updateTraitsIfNeeded()
            let environment = TextEnvironment(host.traitCollection)
            for title in [short, wide, long] {
                for selected in [false, true] {
                    let name = WorktreeTabName(title: title, selected: selected, environment: environment)
                    let measured = await Task.detached { WorktreeTabNames.size(name) }.value
                    let label = StyledLabel(style: selected ? TextStyles.worktreeTabSelected : TextStyles.worktreeTab, color: Palette.text, lines: 1)
                    label.string = title
                    host.addSubview(label)
                    label.updateTraitsIfNeeded()
                    let text = try XCTUnwrap(label.attributedText)
                    let needed = text.size()
                    let drawn = label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
                    let what = "\(title), \(selected ? "open" : "other"), \(category.rawValue)"
                    // The text as drawn fits, so a tab with room never cuts it
                    // short, and it is rounded up by less than a pixel.
                    XCTAssertGreaterThanOrEqual(measured.width, needed.width - 0.001, what)
                    XCTAssertLessThanOrEqual(measured.width, needed.width + 1 / environment.displayScale + 0.001, what)
                    XCTAssertEqual(measured.width, drawn.width, accuracy: 1, what)
                    XCTAssertEqual(measured.height, drawn.height, accuracy: 1, what)
                    label.removeFromSuperview()
                }
            }
            window.isHidden = true
        }
    }

    func testOnlyNamesNotMeasuredBeforeAreMeasuredAndNoneOnTheMainThread() async throws {
        let measured = Measured()
        let (window, _, strip) = strip(.large, names: counted(measured))
        defer { window.isHidden = true }
        let a = item("a", short), b = item("b", wide), c = item("c", long)
        strip.update(items: [a, b, c], selectedId: "a")
        XCTAssertTrue(strip.items.isEmpty, "placed only once the names are in")
        let placed = try await until { strip.items.count == 3 }
        XCTAssertTrue(placed)
        XCTAssertEqual(measured.names.count, 3)
        strip.setNeedsLayout()
        strip.layoutIfNeeded()
        XCTAssertEqual(measured.names.count, 3, "laying out measures nothing")

        // An unread dot changes no name: placed at once, nothing measured.
        strip.update(items: [a, item("b", wide, unread: true), c], selectedId: "a")
        XCTAssertEqual(strip.items[1].unread, true)
        XCTAssertEqual(measured.names.count, 3)

        // A renamed chat: its name, and only its.
        let renamed = item("c", "Release notes")
        strip.update(items: [a, b, renamed], selectedId: "a")
        let shown = try await until { strip.items.last == renamed }
        XCTAssertTrue(shown)
        XCTAssertEqual(measured.names.count, 4)
        XCTAssertEqual(measured.names.last?.title, "Release notes")

        // Opening another tab: its name in the open face and the last
        // open one's in the other, once each.
        let openA = labelWidths(strip)
        strip.update(items: [a, b, renamed], selectedId: "b")
        let moved = try await until { measured.names.count == 6 && labelWidths(strip) != openA }
        XCTAssertTrue(moved)
        XCTAssertEqual(Set(measured.names.suffix(2).map { "\($0.title) \($0.selected)" }), ["\(short) false", "\(wide) true"])

        // And back: both kept, placed at once.
        strip.update(items: [a, b, renamed], selectedId: "a")
        XCTAssertEqual(labelWidths(strip), openA)
        XCTAssertEqual(measured.names.count, 6)
        XCTAssertEqual(measured.onMain, 0)
    }

    func testALargerTextSizeWidensTheTabsAndKeepsTheStripsHeights() async throws {
        let measured = Measured()
        let (window, host, strip) = strip(.large, names: counted(measured))
        defer { window.isHidden = true }
        strip.update(items: [item("a", short), item("c", long)], selectedId: "a")
        let placed = try await until { strip.items.count == 2 }
        XCTAssertTrue(placed)
        strip.layoutIfNeeded()
        let designed = try XCTUnwrap(strip.layout)
        XCTAssertEqual(designed.tabs[0].label.height, 18, accuracy: 1)

        host.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        host.updateTraitsIfNeeded()
        strip.updateTraitsIfNeeded()
        let grown = try await until {
            strip.layoutIfNeeded()
            return (strip.layout?.tabs.first?.label.height ?? 0) > designed.tabs[0].label.height
        }
        XCTAssertTrue(grown, "the names were not measured again at the new size")
        let large = try XCTUnwrap(strip.layout)
        let multiplier = TextScale(.accessibilityExtraExtraExtraLarge).multiplier
        XCTAssertEqual(large.tabs[0].label.height, 18 * multiplier, accuracy: 1)
        XCTAssertGreaterThan(large.tabs[0].frame.width, designed.tabs[0].frame.width)
        XCTAssertEqual(large.tabs[1].frame.width, WorktreeTabStripLayout.Metrics.tabMaxWidth)
        // RN scales text, never fixed heights: the taller name is centred on
        // its tab and the capsule cuts it.
        XCTAssertEqual(large.tabs.map(\.frame.height), [32, 32])
        XCTAssertEqual(large.pill, designed.pill)
        XCTAssertEqual(large.size, designed.size)
        XCTAssertEqual(measured.names.filter { $0.environment.scale.multiplier == multiplier }.count, 2)
        XCTAssertEqual(measured.onMain, 0)
    }

    func testTheScreenTakingOverOnTheSameAccountPlacesItsTabsWithoutMeasuring() async throws {
        let measured = Measured()
        let names = counted(measured)
        let tabs = [item("a", short), item("c", long)]
        let (window, _, first) = strip(.large, names: names)
        defer { window.isHidden = true }
        first.update(items: tabs, selectedId: "a")
        let placed = try await until { first.items.count == 2 }
        XCTAssertTrue(placed)

        let (nextWindow, _, next) = strip(.large, names: names)
        defer { nextWindow.isHidden = true }
        next.update(items: tabs, selectedId: "a")
        XCTAssertEqual(next.items, tabs, "placed at once")
        XCTAssertEqual(labelWidths(next), labelWidths(first))
        XCTAssertEqual(measured.names.count, 2)

        // Another account's strip keeps its own.
        let elsewhere = Measured()
        let (otherWindow, _, other) = strip(.large, names: counted(elsewhere))
        defer { otherWindow.isHidden = true }
        other.update(items: tabs, selectedId: "a")
        XCTAssertTrue(other.items.isEmpty)
        let measuredAgain = try await until { other.items.count == 2 }
        XCTAssertTrue(measuredAgain)
        XCTAssertEqual(elsewhere.names.count, 2)
    }
}
#endif

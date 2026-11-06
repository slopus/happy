#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import UltraView
import XCTest

/// Search's results on UltraList (`SidebarList`) against the grouped
/// `SidebarView` that drew them before: the same rows draw the same
/// pixels, light and dark; a new set of results starts at the top while
/// the same ones keep their place; the results answer the status bar
/// while they are shown, and home's list once they are gone.
@MainActor
final class HostedSearchResultsListTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    /// What search lists: conversations that answer, then quick actions and
    /// settings, each under a heading that folds nothing.
    static func rows(_ count: Int = 3, prefix: String = "found") -> [Row] {
        var rows: [Row] = (0..<count).map { index in
            Row(id: "space:\(prefix)\(index)", nodeId: "\(prefix)\(index)", kind: .space, label: "Release notes \(index)", mark: .placeholder(seed: "\(prefix)\(index)"), agentId: "a-\(prefix)\(index)", targetKind: "bot")
        }
        rows.append(Row(id: "search:actions", nodeId: "search:actions", kind: .section, label: Strings.quickActions))
        rows.append(Row(id: "search:actions:new-work", nodeId: "search:actions:new-work", kind: .result, label: Strings.newWork, mark: .glyph("compose")))
        rows.append(Row(id: "search:actions:settings", nodeId: "search:actions:settings", kind: .result, label: Strings.openSettingsAction, mark: .glyph("settings-outline")))
        rows.append(Row(id: "search:settings", nodeId: "search:settings", kind: .section, label: Strings.settingsResults))
        rows.append(Row(id: "search:settings:appearance", nodeId: "search:settings:appearance", kind: .result, label: "Appearance", mark: .glyph("color-palette-outline")))
        return rows
    }

    private func host(_ style: UIUserInterfaceStyle) async throws -> (UIWindow, UIViewController) {
        let scene = try await hostedActiveScene()
        let root = UIViewController()
        root.view.backgroundColor = UIColor(Palette.groupedGround)
        let window = hostedKeyWindow(in: scene, root: root)
        window.overrideUserInterfaceStyle = style
        addTeardownBlock { @MainActor in window.isHidden = true }
        return (window, root)
    }

    private func image(_ view: UIView) -> UIImage {
        UIGraphicsImageRenderer(bounds: view.bounds).image { _ in _ = view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
    }

    /// The share of pixels that differ by more than a little, and where.
    private func difference(_ a: UIImage, _ b: UIImage) -> (share: Double, box: CGRect) {
        guard let a = a.cgImage, let b = b.cgImage, a.width == b.width, a.height == b.height else { return (1, .null) }
        func pixels(_ image: CGImage) -> [UInt8] {
            var data = [UInt8](repeating: 0, count: image.width * image.height * 4)
            let context = CGContext(data: &data, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            context?.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return data
        }
        let left = pixels(a), right = pixels(b)
        var differing = 0
        var box = CGRect.null
        for index in stride(from: 0, to: left.count, by: 4) {
            let d = max(abs(Int(left[index]) - Int(right[index])), abs(Int(left[index + 1]) - Int(right[index + 1])), abs(Int(left[index + 2]) - Int(right[index + 2])))
            guard d > 24 else { continue }
            differing += 1
            let pixel = index / 4
            box = box.union(CGRect(x: pixel % a.width, y: pixel / a.width, width: 1, height: 1))
        }
        return (Double(differing) / Double(a.width * a.height), box)
    }

    /// The results as `HomeSearchResultsView` shows them, in a window,
    /// under a bar's room.
    private func results(in root: UIViewController, _ rows: [Row]) async -> HomeSearchResultsView {
        let results = HomeSearchResultsView(frame: root.view.bounds)
        results.insets = UIEdgeInsets(top: 100, left: 0, bottom: 34, right: 0)
        root.view.addSubview(results)
        results.layoutIfNeeded()
        results.show(rows, query: "release")
        await results.list.settle()
        return results
    }

    func testTheResultsDrawWhatTheSidebarDrew() async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let (window, root) = try await host(style)
            // Clear of the status bar, whose soft edge would shade the top row.
            let frame = CGRect(x: 0, y: 120, width: window.bounds.width, height: 700)
            let rows = Self.rows()
            let old = SidebarView(frame: frame)
            old.style = .grouped
            root.view.addSubview(old)
            old.apply(rows)
            old.layoutIfNeeded()
            let new = SidebarList(frame: frame)
            new.startsEachChangeAtTop = true
            root.view.addSubview(new)
            new.layoutIfNeeded()
            new.apply(rows)
            await new.settle()
            // The placeholders land.
            try await Task.sleep(for: .milliseconds(500))
            old.isHidden = true
            let after = image(root.view)
            old.isHidden = false
            new.isHidden = true
            let before = image(root.view)
            new.isHidden = false
            let name = style == .dark ? "dark" : "light"
            if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
                try? before.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("search-parity-sidebarview-\(name).png"))
                try? after.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("search-parity-sidebarlist-\(name).png"))
            }
            let (share, box) = difference(before, after)
            print("SEARCH PARITY \(name): \(share * 100)% of pixels differ, in \(box)")
            XCTAssertLessThan(share, 0.002, "\(name): the results draw differently from the sidebar, in \(box)")
            // A heading reads as one and opens nothing; a result is a button that opens.
            var opened: [String] = []
            new.onSelect = { opened.append($0.id) }
            let heading = try XCTUnwrap(new.view(for: "search:actions"))
            XCTAssertEqual(heading.accessibilityTraits, .header)
            new.tap(heading, at: CGPoint(x: heading.box.midX, y: heading.box.midY))
            let result = try XCTUnwrap(new.view(for: "search:actions:settings"))
            XCTAssertTrue(result.accessibilityTraits.contains(.button))
            new.tap(result, at: CGPoint(x: result.box.midX, y: result.box.midY))
            XCTAssertEqual(opened, ["search:actions:settings"])
            window.isHidden = true
        }
    }

    /// Typing replaces the results: the new ones start at the top, at once,
    /// with nothing gliding; the same results again keep the reader's place.
    func testNewResultsStartAtTheTop() async throws {
        let (_, root) = try await host(.light)
        let results = await results(in: root, Self.rows(60))
        let list = results.list
        XCTAssertEqual(list.contentOffsetY, -100, accuracy: 0.5, "the results start under the bar")
        list.setContentOffsetY(900)
        let deadline = CACurrentMediaTime() + TestTime.budget(1)
        while abs(list.contentOffsetY - 900) > 1, CACurrentMediaTime() < deadline {
            try await Task.sleep(for: .milliseconds(16))
        }
        XCTAssertEqual(list.contentOffsetY, 900, accuracy: 1)

        results.show(Self.rows(60), query: "release")
        await list.settle()
        XCTAssertEqual(list.contentOffsetY, 900, accuracy: 1, "the same results moved")

        results.show(Self.rows(40, prefix: "other"), query: "releases")
        await list.settle()
        XCTAssertEqual(list.contentOffsetY, -100, accuracy: 0.5, "new results didn't start at the top")
        XCTAssertEqual(list.list.items.first?.identity, "space:other0")
        XCTAssertNotNil(list.view(for: "space:other0"))
    }

    /// A finger on the results can take the keyboard down, and a pull from
    /// their top reaches search, which closes it.
    func testTheResultsTakeTheKeyboardAndThePull() async throws {
        let (_, root) = try await host(.light)
        let results = await results(in: root, Self.rows())
        XCTAssertEqual(results.list.list.keyboardDismissMode, .interactive)
        let pan = try XCTUnwrap(results.list.panGestureRecognizer, "the list has no pan to read a pull from")
        XCTAssertTrue(pan.view === results.list.list.contentView)
        XCTAssertTrue(results.list.isAtTop)
        // The bar's soft edge and UI tests read the results as a scroll view.
        XCTAssertEqual(results.list.edge.accessibilityIdentifier, "search-results-list")
    }

    /// Open, the results answer the status bar and home's list doesn't;
    /// closed, home's list answers again.
    func testTheStatusBarTakesTheResultsToTheirTop() async throws {
        let (_, root) = try await host(.light)
        let home = SidebarList(frame: root.view.bounds)
        root.view.addSubview(home)
        let results = await results(in: root, Self.rows(60))
        results.isHidden = true
        XCTAssertFalse(results.list.list.scrollsToTop, "hidden results claim the status bar")
        home.list.scrollsToTop = false
        results.isHidden = false
        XCTAssertTrue(results.list.list.scrollsToTop)
        results.list.layoutIfNeeded()
        func claimants() -> [UIScrollView] {
            func all(_ view: UIView) -> [UIScrollView] { ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap(all) }
            return all(root.view).filter(\.scrollsToTop)
        }
        let claimant = try XCTUnwrap(claimants().first)
        XCTAssertEqual(claimants().count, 1, "more than one list answers the status bar, so none would")
        XCTAssertTrue(claimant.isDescendant(of: results.list.list), "the status bar would move home under the results")

        results.list.setContentOffsetY(600)
        try await Task.sleep(for: .milliseconds(100))
        _ = claimant.delegate?.scrollViewShouldScrollToTop?(claimant)
        for _ in 0..<180 where results.list.contentOffsetY > -99.5 { try await Task.sleep(for: .milliseconds(16)) }
        XCTAssertEqual(results.list.contentOffsetY, -100, accuracy: 0.5, "the status bar didn't take the results to their top")

        results.isHidden = true
        home.list.scrollsToTop = true
        XCTAssertTrue(claimants().allSatisfy { !$0.isDescendant(of: results.list) }, "closed results still answer the status bar")
    }
}
#endif

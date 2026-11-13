#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Every compiled Gen UI example lays out across a phone's chat column with
/// nothing drawn past its sides, and a document with nothing drawable
/// shows its fallback.
@MainActor
final class GenUIRenderTests: XCTestCase {
    static let examples = [
        "01-stats", "02-chart-line", "03-chart-bar", "04-chart-donut", "05-gallery-grid", "06-gallery-carousel",
        "07-list", "08-table", "09-steps", "10-choices", "11-release", "12-labels", "gen-7-02", "gen-7-05", "icons-and-colours",
    ]

    private var folder: URL { Bundle(for: Self.self).resourceURL!.appendingPathComponent("GenUI") }

    private func view(_ name: String, width: CGFloat = 358) throws -> GenUIView {
        let data = try Data(contentsOf: folder.appendingPathComponent("\(name).render.json"))
        let document = try XCTUnwrap(GenUIRenderDocument.parse(data), name)
        XCTAssertNotNil(document.tree(), name)
        let view = GenUIView(document: document, baseURL: folder, freezesMotion: true)
        let height = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        view.frame = CGRect(x: 0, y: 0, width: width, height: height)
        view.layoutIfNeeded()
        return view
    }

    /// Visible element views outside any scrolling row, in `root`'s space.
    private func elements(in root: UIView, _ view: UIView, into list: inout [(GenUIElementView, CGRect)]) {
        for sub in view.subviews where !sub.isHidden {
            if sub is UIScrollView { continue }
            if let element = sub as? GenUIElementView { list.append((element, sub.convert(sub.bounds, to: root))) }
            elements(in: root, sub, into: &list)
        }
    }

    func testEveryExampleLaysOutWithinTheColumn() throws {
        for name in Self.examples {
            let root = try view(name)
            XCTAssertGreaterThan(root.bounds.height, 40, name)
            var list: [(GenUIElementView, CGRect)] = []
            elements(in: root, root, into: &list)
            XCTAssertGreaterThan(list.count, 2, name)
            for (element, frame) in list where frame.height > 0 {
                XCTAssertGreaterThanOrEqual(frame.minX, -0.5, "\(name) \(element.key) starts inside")
                XCTAssertLessThanOrEqual(frame.maxX, root.bounds.width + 0.5, "\(name) \(element.key) ends inside")
                XCTAssertLessThanOrEqual(frame.maxY, root.bounds.height + 0.5, "\(name) \(element.key) ends above the foot")
            }
            XCTAssertFalse(list.contains { $0.0.key == "fallback" }, name)
        }
    }

    func testTextIsNeverCutWhereItMayWrap() throws {
        for name in Self.examples {
            let root = try view(name)
            var list: [(GenUIElementView, CGRect)] = []
            elements(in: root, root, into: &list)
            for (element, frame) in list {
                guard let text = element as? GenUITextView, frame.height > 0 else { continue }
                XCTAssertGreaterThanOrEqual(frame.height + 0.5, text.measure(frame.width).height, "\(name) \(text.key) has its lines")
            }
        }
    }

    func testAnUndrawableDocumentShowsItsFallback() {
        let document = GenUIRenderDocument(fallback: "Revenue was up 18%.", root: "missing", elements: [:])
        let view = GenUIView(document: document, baseURL: nil)
        XCTAssertGreaterThan(view.sizeThatFits(CGSize(width: 358, height: CGFloat.greatestFiniteMagnitude)).height, 0)
        view.frame = CGRect(x: 0, y: 0, width: 358, height: 200)
        view.layoutIfNeeded()
        XCTAssertTrue(view.accessibilityText.contains("Revenue was up 18%."))
    }

    func testAGroupKeepsOneChoiceAndReportsItOnce() throws {
        let root = try view("10-choices")
        var reported: [String] = []
        root.onAction = { key, _ in reported.append(key) }
        var list: [(GenUIElementView, CGRect)] = []
        elements(in: root, root, into: &list)
        let presses = list.compactMap { $0.0 as? GenUIPressView }
        XCTAssertEqual(presses.count, 3)
        let controls = presses.map { $0.subviews.compactMap { $0 as? UIControl }.first! }
        controls[1].sendActions(for: .touchUpInside)
        controls[0].sendActions(for: .touchUpInside)
        XCTAssertEqual(reported, ["choices.1"])
        XCTAssertFalse(controls[0].isEnabled)
        XCTAssertEqual(Double(presses[0].subviews.last?.alpha ?? 1), 0.4, accuracy: 0.001)
    }

    /// The render catalog's `icons`, as `catalog.json` lists them.
    static let catalogIcons = [
        "check", "x", "alert", "info", "clock", "calendar", "user", "users", "file", "folder", "code", "terminal", "git-branch",
        "git-commit", "git-pull-request", "link", "search", "star", "heart", "download", "upload", "play", "pause", "image", "chart",
        "globe", "bolt", "bug", "lock", "sparkles", "arrow-right", "arrow-up-right", "arrow-up", "arrow-down", "arrow-down-right",
        "chevron-right", "dollar", "map-pin", "copy",
    ]

    func testEveryCatalogIconHasASharedGlyph() throws {
        for name in Self.catalogIcons {
            let image = try XCTUnwrap(GenUIIcons.image(name), name)
            XCTAssertEqual(image.renderingMode, .alwaysTemplate, name)
            XCTAssertEqual(image.size, CGSize(width: 24, height: 24), name)
        }
        XCTAssertNil(GenUIIcons.image("no-such-icon"))
        XCTAssertNil(GenUIIcons.image("../genui-check"))
    }

    func testTheSharedThemeIsBundled() throws {
        let theme = try XCTUnwrap(GenUIColors.theme)
        XCTAssertEqual(Set(theme.icons), Set(Self.catalogIcons))
        XCTAssertEqual(theme.palette.count, 8)
        XCTAssertEqual(GenUIColors.series(9), GenUIColors.series(1))
        XCTAssertEqual(GenUITone.accent.ink.light, RGBA(hex: "#007AFF"))
        XCTAssertEqual(GenUITone(name: "brown").ink, theme.ink["brown"])
        // A name the theme doesn't know draws as neutral.
        XCTAssertEqual(GenUITone(name: "chartreuse").ink, GenUITone.neutral.ink)
        XCTAssertFalse(GenUIColors.tints(GenUITone(name: "chartreuse")))
        // A plot colour it doesn't know is the muted series colour.
        XCTAssertEqual(GenUIPlotView.color(.named("chartreuse")), theme.muted)
        XCTAssertEqual(GenUIPlotView.color(.named("brown")), theme.ink["brown"])
        XCTAssertEqual(GenUIPlotView.color(.named("accent")), theme.ink["accent"])
    }
}
#endif

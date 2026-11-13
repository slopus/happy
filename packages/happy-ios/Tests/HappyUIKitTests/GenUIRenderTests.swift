#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import UltraView
import XCTest

/// Every compiled Gen UI example built as Ultraview nodes, its choices
/// kept by the view, and the shared glyphs and colours bundled.
@MainActor
final class GenUIRenderTests: XCTestCase {
    private var folder: URL { Bundle(for: Self.self).resourceURL!.appendingPathComponent("GenUI") }

    private func built(_ name: String, interaction: GenUIInteraction = GenUIInteraction()) throws -> GenUIBuilt {
        let data = try Data(contentsOf: folder.appendingPathComponent("\(name).render.json"))
        let document = try XCTUnwrap(GenUIRenderDocument.parse(data), name)
        let plan = GenUIPlanner(document: document, traits: GenUITraits(text: nil, displayScale: 3)).plan(width: 358)
        return GenUINodeBuilder.build(plan, interaction: interaction, dark: false, runs: .reporting)
    }

    private func count(_ node: UltraNode) -> Int { 1 + node.children.map(count).reduce(0, +) }

    /// Every picture, a carousel's tiles included.
    private func pictures(_ placed: GenUIPlaced) -> Int {
        let own = if case .image = placed.mark { 1 } else { 0 }
        return own + placed.children.map(pictures).reduce(0, +)
    }

    func testEveryExampleBuildsANodePerPlacedElement() throws {
        for name in GenUIPlanTests.examples + ["13-secret", "14-cluster-secret"] {
            let built = try built(name)
            // A placed element is one node; a card's border and a bar's fill add one each.
            XCTAssertGreaterThanOrEqual(count(built.root), built.plan.root.flattened().count, name)
            XCTAssertEqual(built.images.count, pictures(built.plan.root), name)
        }
        XCTAssertEqual(try built("06-gallery-carousel").snaps.count, 1)
    }

    func testACarouselRunsIntoTheMargins() throws {
        let built = try built("06-gallery-carousel")
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 800))
        let block = GenUIBlockView(frame: CGRect(x: 16, y: 0, width: 358, height: built.plan.size.height))
        window.addSubview(block)
        block.apply(built, files: nil)
        let shown = expectation(for: NSPredicate { _, _ in built.snaps.first?.node.view != nil }, evaluatedWith: nil)
        wait(for: [shown], timeout: 5)
        let scroll = try XCTUnwrap(built.snaps.first?.node.view as? UIScrollView)
        XCTAssertEqual(scroll.convert(scroll.bounds, to: window).minX, 0)
        XCTAssertEqual(scroll.convert(scroll.bounds, to: window).maxX, 390)
        var view = scroll.superview
        while let ancestor = view, ancestor !== window {
            XCTAssertFalse(ancestor.clipsToBounds, "\(type(of: ancestor)) cuts the carousel at the column")
            view = ancestor.superview
        }
    }

    func testLongCodeScrollsBothWays() throws {
        let text = (1...40).map { "let line\($0) = compute(\($0)) // a line long enough to run past a phone's column" }.joined(separator: "\\n")
        let json = #"{"genuiRender":1,"compiler":"test","fallback":"x","root":"root","elements":{"root":{"type":"code","props":{"text":"\#(text)"}}}}"#
        let document = try XCTUnwrap(GenUIRenderDocument.parse(Data(json.utf8)))
        let plan = GenUIPlanner(document: document, traits: GenUITraits(text: nil, displayScale: 3)).plan(width: 358)
        let built = GenUINodeBuilder.build(plan, interaction: GenUIInteraction(), dark: false, runs: .reporting)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 800))
        let block = GenUIBlockView(frame: CGRect(x: 16, y: 0, width: 358, height: plan.size.height))
        window.addSubview(block)
        block.apply(built, files: nil)
        var scroll: UIScrollView? { block.firstSubview(of: UIScrollView.self) }
        let shown = expectation(for: NSPredicate { _, _ in (scroll?.contentSize.height ?? 0) > 0 }, evaluatedWith: nil)
        wait(for: [shown], timeout: 5)
        let view = try XCTUnwrap(scroll)
        XCTAssertGreaterThan(view.contentSize.width, view.bounds.width)
        XCTAssertGreaterThanOrEqual(view.contentSize.height, 40 * GenUIMetrics.codeLine)
        XCTAssertEqual(view.bounds.height, plan.size.height - 32)
    }

    func testAGroupKeepsOneChoiceAndReportsItOnce() throws {
        let interaction = GenUIInteraction()
        let built = try built("10-choices", interaction: interaction)
        interaction.adopt(built.choices)
        var reported: [String] = []
        interaction.onAction = { key, _ in reported.append(key) }
        XCTAssertEqual(built.choices.keys.sorted(), ["choices.0", "choices.1", "choices.2"])
        built.choices["choices.1"]?.node.onPress?()
        built.choices["choices.0"]?.node.onPress?()
        XCTAssertEqual(reported, ["choices.1"])
        XCTAssertEqual(interaction.chosen, ["choices": "choices.1"])
        XCTAssertNil(built.choices["choices.0"]?.node.onPress)
        XCTAssertEqual(built.choices["choices.0"]?.node.children.last?.style.opacity, 0.4)
        XCTAssertEqual(built.choices["choices.1"]?.node.children.last?.style.opacity, 1)
    }

    func testAnswerIsKeptWhenTheNodesAreBuiltAgain() throws {
        let interaction = GenUIInteraction()
        let first = try built("10-choices", interaction: interaction)
        interaction.adopt(first.choices)
        first.choices["choices.2"]?.node.onPress?()
        let again = try built("10-choices", interaction: interaction)
        interaction.adopt(again.choices)
        XCTAssertNil(again.choices["choices.0"]?.node.onPress)
        XCTAssertEqual(again.choices["choices.0"]?.node.children.last?.style.opacity, 0.4)
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
        XCTAssertEqual(GenUIPlotShape.color(.named("chartreuse")), theme.muted)
        XCTAssertEqual(GenUIPlotShape.color(.named("brown")), theme.ink["brown"])
        XCTAssertEqual(GenUIPlotShape.color(.named("accent")), theme.ink["accent"])
    }
}
private extension UIView {
    func firstSubview<T: UIView>(of type: T.Type) -> T? {
        for view in subviews {
            if let match = view as? T ?? view.firstSubview(of: type) { return match }
        }
        return nil
    }
}
#endif

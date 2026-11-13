import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// Gen UI render documents read totally: every compiled example keeps all
/// its elements, and a broken document loses only what it must.
final class GenUIRenderDocumentTests: XCTestCase {
    static let examples = [
        "01-stats", "02-chart-line", "03-chart-bar", "04-chart-donut", "05-gallery-grid", "06-gallery-carousel",
        "07-list", "08-table", "09-steps", "10-choices", "11-release", "12-labels", "gen-7-02", "gen-7-05", "icons-and-colours",
    ]

    private func example(_ name: String) throws -> GenUIRenderDocument {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "\(name).render", withExtension: "json", subdirectory: "Fixtures/GenUI"), name)
        return try XCTUnwrap(GenUIRenderDocument.parse(Data(contentsOf: url)), name)
    }

    private func count(_ node: GenUINode?) -> Int {
        guard let node else { return 0 }
        switch node.kind {
        case .box(_, let children), .grid(_, let children), .scroll(_, let children), .press(_, let children):
            return 1 + children.map(count).reduce(0, +)
        case .switcher(let compact, let regular):
            return 1 + count(compact) + count(regular)
        default:
            return 1
        }
    }

    private func document(_ elements: [String: JSONValue], root: String = "root", version: Double = 1) -> GenUIRenderDocument {
        GenUIRenderDocument.parse(.object([
            "genuiRender": .number(version), "fallback": .string("plain text"), "root": .string(root), "elements": .object(elements),
        ]))!
    }

    private func element(_ type: String, _ props: [String: JSONValue] = [:], children: [String]? = nil) -> JSONValue {
        var object: [String: JSONValue] = ["type": .string(type), "props": .object(props)]
        if let children { object["children"] = .array(children.map(JSONValue.string)) }
        return .object(object)
    }

    private func text(_ value: String) -> JSONValue {
        element("text", ["spans": .array([.object(["text": .string(value)])])])
    }

    func testAGenUIArtifactIsNamedAsDesktopNamesIt() {
        XCTAssertEqual(GenUIRenderDocument.path, ".genui/render.json")
        XCTAssertEqual(Search.artifactTypeLabel("gen_ui"), "Gen UI")
        XCTAssertEqual(Search.artifactGlyph("gen_ui"), "apps-outline")
    }

    func testEveryExampleKeepsEveryElement() throws {
        for name in Self.examples {
            let document = try example(name)
            XCTAssertFalse(document.fallback.isEmpty, name)
            let tree = try XCTUnwrap(document.tree(), name)
            XCTAssertEqual(count(tree), document.elements.count, "\(name) drew every element")
        }
    }

    func testExamplesReadTheirProps() throws {
        let stats = try XCTUnwrap(example("01-stats").tree())
        guard case .box(let card, let children) = stats.kind else { return XCTFail("a card") }
        XCTAssertEqual(card.role, .card)
        XCTAssertEqual(card.gap, .blocks)
        XCTAssertEqual(children.map(\.key), ["card.header", "row", "progress", "card.actions"])
        let grid = try XCTUnwrap(example("05-gallery-grid"))
        XCTAssertEqual(grid.viewers["gallery"]?.count, 7)
        let donut = try XCTUnwrap(example("04-chart-donut").tree())
        func plots(_ node: GenUINode) -> [GenUIPlot] {
            switch node.kind {
            case .plot(let plot): [plot]
            case .box(_, let children): children.flatMap(plots)
            default: []
            }
        }
        let plot = try XCTUnwrap(plots(donut).first)
        XCTAssertEqual(plot.kind, .donut)
        XCTAssertEqual(plot.slices.map(\.color), [.index(1), .index(2), .index(3), .index(4)])
        XCTAssertEqual(plot.center?.value, "$898")
        XCTAssertEqual(plot.legend.first?.share, "46%")
    }

    func testAnUnknownPrimitiveDropsItsSubtreeOnly() {
        let doc = document([
            "root": element("box", children: ["a", "hologram", "b"]),
            "a": text("kept"),
            "hologram": element("hologram", children: ["inside"]),
            "inside": text("never drawn"),
            "b": text("also kept"),
        ])
        guard case .box(_, let children) = doc.tree()?.kind else { return XCTFail("a box") }
        XCTAssertEqual(children.map(\.key), ["a", "b"])
    }

    func testUnknownPropsAndValuesReadAsDefaults() {
        let doc = document([
            "root": element("box", ["role": .string("spaceship"), "gap": .string("huge"), "sparkle": .bool(true), "direction": .number(3)], children: ["t", "i"]),
            "t": element("text", ["spans": .array([.object(["text": .string("x"), "blink": .bool(true)])]), "role": .string("shout"), "overflow": .string("explode")]),
            "i": element("image", ["file": .string("a.jpg"), "width": .number(10), "height": .number(10), "thumbhash": .string(""), "alt": .string(""), "shape": .string("hexagon"), "role": .string("poster")]),
        ])
        guard case .box(let box, let children) = doc.tree()?.kind else { return XCTFail("a box") }
        XCTAssertEqual(box, GenUIBox())
        guard case .text(let text) = children[0].kind, case .image(let image) = children[1].kind else { return XCTFail("a text and an image") }
        XCTAssertEqual(text.role, .body)
        XCTAssertEqual(text.overflow, .wrap)
        XCTAssertEqual(image.shape, .landscape)
        XCTAssertEqual(image.role, .figure)
    }

    func testAnElementMissingARequiredPropIsDropped() {
        let doc = document([
            "root": element("box", children: ["noSpans", "noFile", "noAction", "noLabel", "badAction", "noValues", "noAxis", "ok"]),
            "noSpans": element("text", ["spans": .array([])]),
            "noFile": element("image", ["width": .number(1), "height": .number(1), "thumbhash": .string(""), "alt": .string("")]),
            "noAction": element("button", ["label": .string("Go")]),
            "noLabel": element("pill", [:]),
            "badAction": element("button", ["label": .string("Go"), "variant": .string("primary"), "action": .object(["type": .string("teleport")])]),
            "noValues": element("spark", ["values": .array([.number(1)])]),
            "noAxis": element("plot", ["kind": .string("bar"), "x": .array([]), "series": .array([.object(["name": .string("a"), "values": .array([]), "color": .number(1)])]), "summary": .string("s")]),
            "ok": element("pill", ["text": .string("ok")]),
        ])
        guard case .box(_, let children) = doc.tree()?.kind else { return XCTFail("a box") }
        XCTAssertEqual(children.map(\.key), ["ok"])
    }

    func testAPressWithoutAValidActionKeepsItsContentUntappable() {
        let doc = document([
            "root": element("press", ["action": .object(["type": .string("teleport")]), "role": .string("item")], children: ["t"]),
            "t": text("still here"),
        ])
        guard case .press(let press, let children) = doc.tree()?.kind else { return XCTFail("a press") }
        XCTAssertNil(press.action)
        XCTAssertEqual(press.role, .item)
        XCTAssertEqual(children.map(\.key), ["t"])
    }

    func testTonesAndPlotColoursMayBeRawColourNames() {
        let doc = document([
            "root": element("box", children: ["pill", "plot"]),
            "pill": element("pill", ["text": .string("x"), "tone": .string("brown")]),
            "plot": element("plot", [
                "kind": .string("donut"), "x": .array([]), "summary": .string("s"),
                "series": .array([.object(["name": .string("a"), "values": .array([.number(1)]), "color": .string("teal")])]),
                "slices": .array([.object(["label": .string("a"), "value": .number(1), "color": .string("brown")]), .object(["label": .string("b"), "value": .number(1), "color": .number(2)])]),
            ]),
        ])
        guard case .box(_, let children) = doc.tree()?.kind, case .pill(let pill) = children[0].kind, case .plot(let plot) = children[1].kind else { return XCTFail("a pill and a plot") }
        XCTAssertEqual(pill.tone, GenUITone(name: "brown"))
        XCTAssertEqual(plot.series[0].color, .named("teal"))
        XCTAssertEqual(plot.slices.map(\.color), [.named("brown"), .index(2)])
    }

    func testMissingEnumsTakeTheirNamedDefaults() {
        let doc = document([
            "root": element("box", children: ["b", "s", "m", "p", "i"]),
            "b": element("button", ["label": .string("Go"), "action": .object(["type": .string("message"), "text": .string("go")])]),
            "s": element("scroll", children: []),
            "m": element("marker", [:]),
            "p": element("plot", [
                "x": .array([.string("a")]), "y": .object(["min": .number(0), "max": .number(1), "ticks": .array([])]),
                "series": .array([.object(["name": .string("a"), "values": .array([.number(1)]), "color": .number(1)])]), "summary": .string("s"),
            ]),
            "i": element("image", ["file": .string("a.jpg"), "width": .number(1), "height": .number(1), "thumbhash": .string(""), "alt": .string("")]),
        ])
        guard case .box(_, let children) = doc.tree()?.kind, children.count == 5 else { return XCTFail("five children") }
        guard case .button(let button) = children[0].kind, case .scroll(let shape, _) = children[1].kind, case .marker(let marker) = children[2].kind,
              case .plot(let plot) = children[3].kind, case .image(let image) = children[4].kind else { return XCTFail("kinds") }
        XCTAssertEqual(button.variant, .secondary)
        XCTAssertEqual(shape, .landscape)
        XCTAssertEqual(marker.status, .pending)
        XCTAssertEqual(plot.kind, .line)
        XCTAssertEqual(image.shape, .landscape)
    }

    func testAnUndrawableDocumentHasNoTree() {
        XCTAssertNil(document(["root": text("x")], root: "missing").tree())
        XCTAssertNil(document(["root": element("hologram")]).tree())
        XCTAssertNil(document(["root": text("x")], version: 2).tree())
        XCTAssertNil(GenUIRenderDocument.parse(Data("[1, 2]".utf8)))
        XCTAssertNil(GenUIRenderDocument.parse(Data("not json".utf8)))
        XCTAssertEqual(document(["root": element("hologram")]).fallback, "plain text")
    }

    func testCyclesAndSharedChildrenAreDrawnOnce() {
        let doc = document([
            "root": element("box", children: ["a", "a", "loop"]),
            "a": text("once"),
            "loop": element("box", children: ["root", "a"]),
        ])
        guard case .box(_, let children) = doc.tree()?.kind else { return XCTFail("a box") }
        XCTAssertEqual(children.map(\.key), ["a", "loop"])
        guard case .box(_, let inner) = children[1].kind else { return XCTFail("the loop box") }
        XCTAssertTrue(inner.isEmpty)
    }

    func testASwitchWithOneBranchUsesIt() {
        let doc = document([
            "root": .object(["type": .string("switch"), "props": .object([:]), "slots": .object(["regular": .array([.string("r")])])]),
            "r": text("wide"),
        ])
        guard case .switcher(let compact, let regular) = doc.tree()?.kind else { return XCTFail("a switch") }
        XCTAssertNil(compact)
        XCTAssertEqual(regular?.key, "r")
    }
}

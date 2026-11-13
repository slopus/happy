#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The Gen UI plan: every compiled example measured off the main thread,
/// the same height as the drawn renderer, inside its column, and a height
/// that follows only the document, the width and the text size.
final class GenUIPlanTests: XCTestCase {
    static let examples = [
        "01-stats", "02-chart-line", "03-chart-bar", "04-chart-donut", "05-gallery-grid", "06-gallery-carousel",
        "07-list", "08-table", "09-steps", "10-choices", "11-release", "12-labels", "gen-7-02", "gen-7-05", "icons-and-colours",
    ]
    private static let traits = GenUITraits(text: nil, displayScale: 3)

    private var folder: URL { Bundle(for: Self.self).resourceURL!.appendingPathComponent("GenUI") }

    private func document(_ name: String) throws -> GenUIRenderDocument {
        let data = try Data(contentsOf: folder.appendingPathComponent("\(name).render.json"))
        return try XCTUnwrap(GenUIRenderDocument.parse(data), name)
    }

    /// Each example's height at a phone's column (358) and at a wide one
    /// (700), at the designed text size.
    private static let heights: [String: (phone: CGFloat, wide: CGFloat)] = [
        "01-stats": (366, 292),
        "02-chart-line": (358, 435),
        "03-chart-bar": (332, 409),
        "04-chart-donut": (426, 426),
        "05-gallery-grid": (323, 565),
        "06-gallery-carousel": (323, 579),
        "07-list": (440, 376),
        "08-table": (664, 312),
        "09-steps": (482, 438),
        "10-choices": (430, 380),
        "11-release": (854, 909),
        "12-labels": (552, 617),
        "gen-7-02": (765, 1019),
        "gen-7-05": (996, 782),
        "icons-and-colours": (1232, 1117),
    ]

    func testEveryExampleIsPlannedOffMainAtItsHeight() async throws {
        var report: [String] = []
        for name in Self.examples {
            let document = try document(name)
            let planned: [CGFloat] = await withCheckedContinuation { done in
                DispatchQueue.global(qos: .userInitiated).async {
                    dispatchPrecondition(condition: .notOnQueue(.main))
                    let planner = GenUIPlanner(document: document, traits: Self.traits)
                    done.resume(returning: [planner.height(width: 358), planner.height(width: 700)])
                }
            }
            report.append("\"\(name)\": (\(planned[0]), \(planned[1]))")
            let expected = Self.heights[name]
            XCTAssertEqual(planned, expected.map { [$0.phone, $0.wide] }, name)
        }
        print("GENUI_HEIGHTS " + report.joined(separator: ", "))
    }

    func testEveryElementSitsInsideItsColumn() throws {
        for name in Self.examples {
            let plan = GenUIPlanner(document: try document(name), traits: Self.traits).plan(width: 358)
            XCTAssertGreaterThan(plan.size.height, 40, name)
            let placed = plan.root.flattened()
            XCTAssertGreaterThan(placed.count, 2, name)
            for (element, frame) in placed.dropFirst() where frame.height > 0 {
                // A carousel runs out into the margin it was given.
                if case .scroll = element.mark { continue }
                XCTAssertGreaterThanOrEqual(frame.minX, -0.5, "\(name) \(element.key) starts inside")
                XCTAssertLessThanOrEqual(frame.maxX, 358.5, "\(name) \(element.key) ends inside")
                XCTAssertLessThanOrEqual(frame.maxY, plan.size.height + 0.5, "\(name) \(element.key) ends above the foot")
            }
        }
    }

    func testTextIsNeverCutWhereItMayWrap() throws {
        for name in Self.examples {
            let plan = GenUIPlanner(document: try document(name), traits: Self.traits).plan(width: 358)
            for (element, frame) in plan.root.flattened() {
                guard case .text(let text) = element.mark, text.layout.maxLines == 0 else { continue }
                XCTAssertGreaterThanOrEqual(frame.height + 0.5, text.layout.size.height, "\(name) \(element.key) has its lines")
            }
        }
    }

    private func inline(_ type: String, _ props: String) throws -> GenUIPlanner {
        let json = #"{"genuiRender":1,"compiler":"test","fallback":"x","root":"root","elements":{"root":{"type":"\#(type)","props":\#(props)}}}"#
        return GenUIPlanner(document: try XCTUnwrap(GenUIRenderDocument.parse(Data(json.utf8))), traits: Self.traits)
    }

    /// An identifier wider than its column breaks after its `_`s rather
    /// than inside a name; a column it fits draws it as written.
    func testAnIdentifierBreaksAtItsUnderscoresOnlyWhenItsColumnIsTooNarrow() throws {
        XCTAssertEqual(GenUITextElement.breakable("STRIPE_SECRET_KEY"), "STRIPE_\u{200B}SECRET_\u{200B}KEY")
        XCTAssertEqual(GenUITextElement.breakable("_private a__b c_ 1_2"), "_private a__b c_ 1_\u{200B}2")
        let planner = try inline("text", #"{"spans":[{"text":"Set "},{"text":"STRIPE_SECRET_KEY_FOR_THE_TESTS","code":true}],"role":"body"}"#)
        func text(_ width: CGFloat) throws -> (GenUITextMark, CGRect) {
            try XCTUnwrap(planner.plan(width: width).root.flattened().lazy.compactMap { placed, frame -> (GenUITextMark, CGRect)? in
                if case .text(let text) = placed.mark { (text, frame) } else { nil }
            }.first)
        }
        let (narrow, frame) = try text(120)
        XCTAssertTrue(narrow.layout.string.string.contains("\u{200B}"))
        XCTAssertLessThanOrEqual(narrow.layout.size.width, 120)
        XCTAssertGreaterThanOrEqual(frame.height + 0.5, narrow.layout.size.height)
        XCTAssertEqual(narrow.plain, "Set STRIPE_SECRET_KEY_FOR_THE_TESTS", "read as written")
        XCTAssertFalse(try text(700).0.layout.string.string.contains("\u{200B}"))
    }

    /// 13-secret on a phone: the key whose widest piece fits beside its
    /// fixed value stays beside it; the one that doesn't goes above it.
    func testAKeyTooNarrowBesideItsFixedValueGoesAboveIt() throws {
        let plan = GenUIPlanner(document: try document("13-secret"), traits: Self.traits).plan(width: 358)
        let frames = Dictionary(plan.root.flattened().map { ($0.placed.key, $0.frame) }) { first, _ in first }
        let (key0, value0) = (try XCTUnwrap(frames["keyvalue.compact.0.label"]), try XCTUnwrap(frames["keyvalue.compact.0.value"]))
        XCTAssertGreaterThan(value0.minX, key0.maxX, "STRIPE_SECRET_KEY stays beside its value")
        let (key1, value1) = (try XCTUnwrap(frames["keyvalue.compact.1.label"]), try XCTUnwrap(frames["keyvalue.compact.1.value"]))
        XCTAssertGreaterThanOrEqual(value1.minY, key1.maxY, "STRIPE_WEBHOOK_SECRET goes above its value")
        XCTAssertEqual(value1.minX, key1.minX, accuracy: 0.5)
        // Wide, both rows side by side.
        let wide = GenUIPlanner(document: try document("13-secret"), traits: Self.traits).plan(width: 700)
        XCTAssertNil(wide.root.flattened().first { $0.placed.key == "keyvalue.compact.1.label" }, "a wide column shows the grid")
    }

    private func code(lines: Int) throws -> GenUIPlanner {
        let text = (1...lines).map { "let line\($0) = \($0) // a line long enough to run past a phone's column" }.joined(separator: "\\n")
        return try inline("code", #"{"text":"\#(text)\n","language":"swift"}"#)
    }

    func testCodeIsAsTallAsItsLinesUpToTheCapAndScrollsPastIt() throws {
        let five = try code(lines: 5).plan(width: 358)
        let twenty = try code(lines: 20).plan(width: 358)
        let forty = try code(lines: 40).plan(width: 358)
        XCTAssertEqual(twenty.size.height - five.size.height, 15 * GenUIMetrics.codeLine)
        XCTAssertEqual(forty.size.height, twenty.size.height)
        guard let (scroll, frame) = forty.root.flattened().first(where: { if case .scroll = $0.placed.mark { true } else { false } }),
              case .scroll(let mark) = scroll.mark else { return XCTFail("no scroll") }
        XCTAssertGreaterThan(mark.contentSize.width, frame.width, "long lines scroll sideways")
        XCTAssertGreaterThanOrEqual(mark.contentSize.height, 40 * GenUIMetrics.codeLine, "every line can be scrolled to")
    }

    func testAFigureReservesItsPixelRatioCappedAndLeading() throws {
        let photo = try inline("image", #"{"file":"assets/a.jpg","width":1600,"height":1067,"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI","alt":"A photo","shape":"landscape","role":"figure"}"#)
        XCTAssertEqual(photo.height(width: 358), 239)
        let tall = try inline("image", #"{"file":"assets/a.jpg","width":1000,"height":2000,"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI","alt":"A photo","shape":"portrait","role":"figure"}"#)
        let plan = tall.plan(width: 700)
        XCTAssertEqual(plan.size.height, GenUIMetrics.figureMaxHeight)
        XCTAssertEqual(plan.root.frame, CGRect(x: 0, y: 0, width: 210, height: 420))
    }

    func testAPlanIsMadeOncePerWidth() throws {
        let planner = GenUIPlanner(document: try document("11-release"), traits: Self.traits)
        let first = planner.plan(width: 358)
        let again = planner.plan(width: 358)
        guard case .text(let a) = first.root.flattened().first(where: { if case .text = $0.placed.mark { true } else { false } })?.placed.mark,
              case .text(let b) = again.root.flattened().first(where: { if case .text = $0.placed.mark { true } else { false } })?.placed.mark else {
            return XCTFail("no text")
        }
        XCTAssertTrue(a.layout === b.layout)
    }

    func testALargerTextSizeMakesItTaller() throws {
        let document = try document("07-list")
        let designed = GenUIPlanner(document: document, traits: Self.traits).height(width: 358)
        let large = GenUIPlanner(document: document, traits: GenUITraits(text: TextEnvironment(scale: TextScale(.accessibilityLarge), displayScale: 3), displayScale: 3)).height(width: 358)
        XCTAssertGreaterThan(large, designed + 40)
    }

    func testASwitchGoesCompactBelow560OfItsOwnWidth() throws {
        let json = #"""
        {"genuiRender": 1, "fallback": "", "root": "s", "elements": {
          "s": {"type": "switch", "slots": {"compact": ["c"], "regular": ["r"]}},
          "c": {"type": "text", "props": {"spans": [{"text": "compact"}]}},
          "r": {"type": "text", "props": {"spans": [{"text": "regular"}]}}
        }}
        """#
        let planner = GenUIPlanner(document: try XCTUnwrap(GenUIRenderDocument.parse(Data(json.utf8))), traits: Self.traits)
        XCTAssertEqual(planner.plan(width: 559).root.children.first?.key, "c")
        XCTAssertEqual(planner.plan(width: 560).root.children.first?.key, "r")
    }

    func testAnUndrawableDocumentPlansItsFallback() {
        let document = GenUIRenderDocument(fallback: "Revenue was up 18%.", root: "missing", elements: [:])
        let plan = GenUIPlanner(document: document, traits: Self.traits).plan(width: 358)
        guard case .text(let text) = plan.root.mark else { return XCTFail("fallback is text") }
        XCTAssertEqual(text.plain, "Revenue was up 18%.")
        XCTAssertGreaterThan(plan.size.height, 0)
    }
}
#endif

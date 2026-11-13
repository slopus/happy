#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// happy-agent's `docs/genui/render/conformance/measuring.json` (copied at
/// 282c8ea) against the plan. A plan is made from the document, the width
/// and the text size only, so the cases' other conditions (images, theme,
/// presses, choices, host, animation, scrolling) cannot reach it; each
/// measurement is still made by a planner of its own.
final class GenUIMeasuringConformanceTests: XCTestCase {
    private var folder: URL { Bundle(for: Self.self).resourceURL!.appendingPathComponent("GenUI") }

    private func json(_ url: URL) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    }

    /// A case's document: inline, or a path under `render/`, whose
    /// `compiled/` goldens are the fixture folder's own files.
    private func document(_ value: JSONValue) throws -> (GenUIRenderDocument, JSONValue) {
        if let path = value.stringValue {
            let name = (path as NSString).lastPathComponent
            let json = try json(folder.appendingPathComponent(name))
            return (try XCTUnwrap(GenUIRenderDocument.parse(json), path), json)
        }
        return (try XCTUnwrap(GenUIRenderDocument.parse(value)), value)
    }

    func testEveryMeasuringCasePasses() throws {
        let file = try json(folder.appendingPathComponent("conformance/measuring.json"))
        let cases = try XCTUnwrap(file["cases"]?.arrayValue)
        XCTAssertEqual(cases.count, 12)
        for item in cases {
            let name = "\(item["rule"]?.stringValue ?? "") \(item["name"]?.stringValue ?? "")"
            var heights: [(document: String, height: CGFloat)] = []
            for measure in item["measure"]?.arrayValue ?? [] {
                let (document, source) = try document(try XCTUnwrap(measure["document"]))
                let width = CGFloat(try XCTUnwrap(measure["width"]?.numberValue))
                let plan = GenUIPlanner(document: document, traits: GenUITraits(text: nil, displayScale: 3)).plan(width: width)
                heights.append((measure["document"]?.stringValue ?? "inline", plan.size.height))
                for (switchKey, branch) in measure["switch"]?.objectValue ?? [:] {
                    let slot = try XCTUnwrap(source["elements"]?[switchKey]?["slots"]?[try XCTUnwrap(branch.stringValue)]?.arrayValue?.first?.stringValue)
                    let placed = try XCTUnwrap(plan.root.flattened().first { $0.placed.key == switchKey }?.placed, name)
                    XCTAssertEqual(placed.children.map(\.key), [slot], "\(name) at \(width)")
                }
            }
            switch item["expect"]?.stringValue {
            case "same height":
                XCTAssertEqual(Set(heights.map(\.height)).count, 1, "\(name): \(heights)")
            case "same height per document":
                for group in Dictionary(grouping: heights, by: \.document).values {
                    XCTAssertEqual(Set(group.map(\.height)).count, 1, "\(name): \(group)")
                }
            case "switch branches":
                break
            default:
                XCTFail("\(name): unknown expectation")
            }
        }
    }

    func testTheSameDocumentPlannedTwiceIsTheSameHeight() throws {
        for name in GenUIPlanTests.examples + ["13-secret", "14-cluster-secret"] {
            let (document, _) = try document(.string("compiled/\(name).render.json"))
            let traits = GenUITraits(text: nil, displayScale: 3)
            XCTAssertEqual(GenUIPlanner(document: document, traits: traits).height(width: 390), GenUIPlanner(document: document, traits: traits).height(width: 390), name)
        }
    }
}
#endif

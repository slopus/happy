import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Layout HTML parsed exactly as the reference `parseMediaLayoutHtml` parses
/// it (`scripts/generate-media-tree-fixtures.ts`), a presentation's tree as
/// desktop takes it, and the boxes the phone lays out.
final class MediaTreeTests: XCTestCase {
    private static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "media-layout-html", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.decode(Data(contentsOf: url))
    }()

    static func json(_ nodes: [MediaTree.Node]) -> JSONValue {
        func style(_ style: [String: String]) -> JSONValue { .object(style.mapValues { .string($0) }) }
        return .array(nodes.map { node in
            switch node {
            case .element(let tag, let value, let children):
                var object: [String: JSONValue] = ["type": .string("element"), "tag": .string(tag), "children": json(children)]
                if !value.isEmpty { object["style"] = style(value) }
                return .object(object)
            case .item(let index, let alt, let value):
                var object: [String: JSONValue] = ["type": .string("item"), "index": .number(Double(index))]
                if let alt { object["alt"] = .string(alt) }
                if !value.isEmpty { object["style"] = style(value) }
                return .object(object)
            case .text(let text):
                return .object(["type": .string("text"), "text": .string(text)])
            case .lineBreak:
                return .object(["type": .string("break")])
            }
        })
    }

    func testParsesAsTheReference() {
        let sources = Self.vectors["sources"]!.objectValue!.mapValues { Int($0.numberValue!) }
        var failures = 0
        for (index, entry) in Self.vectors["cases"]!.arrayValue!.enumerated() {
            let html = entry["html"]!.stringValue!
            let parsed = MediaTree.parse(html: html) { sources[$0] }
            let placed = entry["placed"]!.arrayValue!.map { Int($0.numberValue!) }
            let same = Self.json(parsed.tree.root) == entry["root"]! && parsed.placed == placed && parsed.truncated == entry["truncated"]!.boolValue!
            if !same, failures < 8 {
                XCTFail("case \(index): \(html.prefix(200).debugDescription)\n got \(Self.json(parsed.tree.root))\nwant \(entry["root"]!)\n placed \(parsed.placed) want \(placed), truncated \(parsed.truncated)")
            }
            if !same { failures += 1 }
        }
        XCTAssertEqual(failures, 0)
    }

    func testStylesNormalizeAsTheReference() {
        XCTAssertEqual(MediaTree.parseStyle("Display: GRID; grid-template-columns: repeat( auto-fill,minmax(200px , 1fr) ); gap:8px  4px"), [
            "display": "grid", "gridTemplateColumns": "repeat(auto-fill, minmax(200px, 1fr))", "gap": "8px 4px",
        ])
        XCTAssertEqual(MediaTree.parseStyle("aspect-ratio: 16/9; color: red; width: calc(100% - 1px)"), ["aspectRatio": "16 / 9"])
        XCTAssertEqual(MediaTree.parseStyle("width: 1px; font-family: 'x'"), [:])
    }

    func testAPresentationsTreePlacesEveryItemOnce() {
        let layout: JSONValue = .object([
            "type": .string("tree"),
            "root": .array([
                .object(["type": .string("element"), "tag": .string("blink"), "style": .object(["display": .string("grid"), "color": .string("red")]), "children": .array([
                    .object(["type": .string("item"), "index": .number(1), "alt": .string("B")]),
                    .object(["type": .string("item"), "index": .number(1)]),
                    .object(["type": .string("item"), "index": .number(7)]),
                    .object(["type": .string("text"), "text": .string("caption")]),
                ])]),
                .object(["type": .string("break")]),
                .object(["type": .string("mystery")]),
            ]),
        ])
        let tree = MediaTree.decode(layout, itemCount: 3)
        XCTAssertEqual(tree?.root, [
            .element(tag: "div", style: ["display": "grid"], children: [.item(index: 1, alt: "B", style: [:]), .text("caption")]),
            .lineBreak,
            .item(index: 0, alt: nil, style: [:]),
            .item(index: 2, alt: nil, style: [:]),
        ])
        XCTAssertNil(MediaTree.decode(.object(["type": .string("columns"), "columns": .number(2)]), itemCount: 2))
    }

    func testBlocksGatherInlineTextIntoParagraphs() {
        let parsed = MediaTree.parse(html: #"<figure style="display: grid; text-align: center"><img src="a"><figcaption>Before <strong>and</strong><br>after</figcaption></figure><span style="tone: muted">tail</span>"#) { $0 == "a" ? 0 : nil }
        XCTAssertEqual(parsed.tree.blocks, [
            .container(style: ["display": "grid", "textAlign": "center"], children: [
                .item(index: 0, alt: nil, style: [:]),
                .container(style: [:], children: [
                    .paragraph(align: "center", runs: [
                        MediaTree.Run(text: "Before "),
                        MediaTree.Run(text: "and", bold: true),
                        MediaTree.Run(text: "\n"),
                        MediaTree.Run(text: "after"),
                    ]),
                ]),
            ]),
            .paragraph(align: nil, runs: [MediaTree.Run(text: "tail", tone: "muted")]),
        ])
    }
}

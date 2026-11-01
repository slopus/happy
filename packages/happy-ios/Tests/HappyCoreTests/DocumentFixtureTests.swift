import Foundation
@testable import HappyCore
import XCTest

/// The Yjs port and block reader against documents the daemon's own code
/// made over yjs 13.6 and BlockNote 0.51.4 (`scripts/generate-document-fixtures.mjs`).
final class DocumentFixtureTests: XCTestCase {
    struct Fixtures {
        let documents: [[String: Any]]
        let merges: [[String: Any]]
    }

    nonisolated(unsafe) static let fixtures: Fixtures = {
        let url = Bundle.module.url(forResource: "documents", withExtension: "json", subdirectory: "Fixtures")!
        let object = try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        return Fixtures(documents: object["documents"] as! [[String: Any]], merges: object["merges"] as! [[String: Any]])
    }()

    static func bytes(_ base64: Any?) -> [UInt8] { Array(Data(base64Encoded: base64 as! String)!) }

    static func doc(_ update: [UInt8], client: Int = 999) throws -> YDoc {
        let doc = YDoc(clientID: client)
        try doc.applyUpdate(update)
        return doc
    }

    func testEveryFixtureReadsAsBlockNoteReadsIt() throws {
        XCTAssertGreaterThan(Self.fixtures.documents.count, 30)
        for fixture in Self.fixtures.documents {
            let name = fixture["name"] as! String
            let doc = try Self.doc(Self.bytes(fixture["update"]))
            XCTAssertFalse(doc.hasPending, name)
            var blocks = DocumentReader.blocks(doc)
            if name == "outside-model" {
                // BlockNote drops what it can't place; the editor keeps it, unsupported.
                XCTAssertEqual(blocks.last?.content, .unsupported("futureBlock"))
                blocks.removeLast()
            }
            let ours = BlockNoteJSON.normalize(blocks.map(BlockNoteJSON.block))
            XCTAssertFalse(ours is NSNull, name)
            XCTAssertEqual(ours, BlockNoteJSON.normalize(fixture["blocks"]), name)
        }
    }

    func testReencodedStateReadsTheSame() throws {
        for fixture in Self.fixtures.documents {
            let name = fixture["name"] as! String
            let update = Self.bytes(fixture["update"])
            let doc = try Self.doc(update)
            let again = try Self.doc(doc.encodeStateAsUpdate())
            XCTAssertEqual(DocumentReader.blocks(again), DocumentReader.blocks(doc), name)
            XCTAssertEqual(again.stateVector(), doc.stateVector(), name)
            // Only what a state vector lacks: nothing, against itself.
            let none = doc.encodeStateAsUpdate(since: doc.stateVector())
            let third = try Self.doc(update)
            try third.applyUpdate(none)
            XCTAssertEqual(DocumentReader.blocks(third), DocumentReader.blocks(doc), name)
        }
    }

    func testConcurrentEditsConvergeAsYjsMerges() throws {
        XCTAssertEqual(Self.fixtures.merges.count, 8)
        for merge in Self.fixtures.merges {
            let name = merge["name"] as! String
            let merged = (merge["merged"] as! [String: Any])["blocks"]
            for order in [["a", "b"], ["b", "a"]] {
                let doc = try Self.doc(Self.bytes(merge["base"]))
                for key in order { try doc.applyUpdate(Self.bytes(merge[key])) }
                XCTAssertEqual(BlockNoteJSON.normalize(DocumentReader.blocks(doc).map(BlockNoteJSON.block)), BlockNoteJSON.normalize(merged), "\(name) \(order)")
            }
        }
    }

    func testUpdatesArrivingBeforeWhatTheyNeedWaitThenApply() throws {
        let merge = Self.fixtures.merges.first { $0["name"] as? String == "split-and-edit" }!
        let base = Self.bytes(merge["base"])
        let a = Self.bytes(merge["a"])
        let doc = YDoc(clientID: 999)
        try doc.applyUpdate(a)
        XCTAssertTrue(doc.hasPending)
        XCTAssertEqual(DocumentReader.blocks(doc), [])
        try doc.applyUpdate(base)
        XCTAssertFalse(doc.hasPending)
        let expected = try Self.doc(base)
        try expected.applyUpdate(a)
        XCTAssertEqual(DocumentReader.blocks(doc), DocumentReader.blocks(expected))
    }
}

/// Blocks in the JSON shape BlockNote's `docToBlocks` gives, for comparing with it.
enum BlockNoteJSON {
    static func block(_ block: DocumentBlock) -> [String: Any] {
        var props: [String: Any] = [:]
        for (key, value) in DocumentSchema.defaults(block.type) { if let json = json(block.props[key] ?? value) { props[key] = json } }
        var out: [String: Any] = ["id": block.id, "type": block.type, "props": props, "children": block.children.map(Self.block)]
        switch block.content {
        case let .inline(runs): out["content"] = inline(runs)
        case let .table(rows): out["content"] = rows.map { $0.map { $0.map(\.text).joined() } }
        case .none, .unsupported: break
        }
        return out
    }

    static func json(_ value: YAny) -> Any? {
        switch value {
        case .undefined: return nil
        case .null: return NSNull()
        case let .bool(b): return b
        case let .number(n): return n
        case let .string(s): return s
        default: return value.jsonString
        }
    }

    /// Runs as BlockNote styled text and links.
    static func inline(_ runs: [DocumentRun]) -> [Any] {
        var out: [Any] = []
        for run in runs {
            var styles: [String: Any] = [:]
            for (key, value) in run.marks where key != "link" {
                styles[key] = DocumentSchema.booleanMarks.contains(key) ? true : (value["stringValue"].flatMap(json) ?? true)
            }
            let text: [String: Any] = ["type": "text", "text": run.text, "styles": styles]
            if let href = run.marks["link"]?["href"]?.stringValue {
                if var last = out.last as? [String: Any], last["type"] as? String == "link", last["href"] as? String == href {
                    last["content"] = (last["content"] as! [Any]) + [text]
                    out[out.count - 1] = last
                } else {
                    out.append(["type": "link", "href": href, "content": [text]])
                }
            } else {
                out.append(text)
            }
        }
        return out
    }

    /// Tables compare by their cells' text; everything else as it is.
    static func normalize(_ value: Any?) -> NSObject {
        func walk(_ value: Any) -> Any {
            if var object = value as? [String: Any] {
                if object["type"] as? String == "table", let content = object["content"] as? [String: Any], let rows = content["rows"] as? [[String: Any]] {
                    object["content"] = rows.map { ($0["cells"] as! [[String: Any]]).map { cell in
                        ((cell["content"] as? [[String: Any]]) ?? []).compactMap { $0["text"] as? String }.joined()
                    } }
                    object["props"] = [:] as [String: Any]
                }
                if object["type"] as? String == "table" { object["props"] = [:] as [String: Any] }
                return object.mapValues(walk)
            }
            if let array = value as? [Any] { return array.map(walk) }
            return value
        }
        let normalized = walk(value ?? NSNull())
        return (try? JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: normalized, options: [.sortedKeys, .fragmentsAllowed]), options: [.fragmentsAllowed]) as? NSObject) ?? NSNull()
    }
}

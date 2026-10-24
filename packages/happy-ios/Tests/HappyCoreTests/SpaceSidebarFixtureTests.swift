import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// The sidebar grammar, applier, differ and desktop's edits against vectors
/// the TypeScript reference produced (`scripts/generate-sidebar-fixtures.ts`).
/// Every case must match byte for byte: the formatted document, the applied
/// operations, the error message and its offset.
final class SpaceSidebarFixtureTests: XCTestCase {
    private static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "space-sidebar-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.decode(Data(contentsOf: url))
    }()

    private func cases(_ key: String) -> [[String: JSONValue]] {
        Self.vectors[key]!.arrayValue!.map { $0.objectValue! }
    }

    func testParseAndFormat() throws {
        for (index, entry) in cases("parse").enumerated() {
            let html = entry["html"]!.stringValue!
            do {
                let document = try SpaceSidebar.parse(html)
                guard let formatted = entry["formatted"]?.stringValue else {
                    XCTFail("parse \(index) should fail with \(entry["error"]!)\n\(html)")
                    continue
                }
                XCTAssertEqual(SpaceSidebar.format(document), formatted, "parse \(index)")
                XCTAssertEqual(SpaceSidebar.format(document, widgets: false), entry["withoutWidgets"]!.stringValue!, "parse \(index)")
                XCTAssertEqual(try SpaceSidebar.parse(formatted), document, "parse \(index) round trip")
            } catch let error as SpaceSidebarError {
                guard let expected = entry["error"] else {
                    XCTFail("parse \(index) failed: \(error.message)\n\(html)")
                    continue
                }
                XCTAssertEqual(error.message, expected["message"]!.stringValue!, "parse \(index)\n\(html)")
                XCTAssertEqual(error.offset, Int(expected["offset"]!.numberValue!), "parse \(index) offset\n\(html)")
            }
        }
    }

    func testApply() throws {
        for (index, entry) in cases("apply").enumerated() {
            let document = try SpaceSidebar.parse(entry["html"]!.stringValue!)
            let base = try entry["base"]?.stringValue.map(SpaceSidebar.parse)
            let operations = entry["operations"]!.arrayValue!.map { SpaceSidebarOperation(json: $0)! }
            do {
                let result = try SpaceSidebar.apply(document, operations, base: base)
                guard let expected = entry["result"]?.stringValue else {
                    XCTFail("apply \(index) should fail with \(entry["error"]!)")
                    continue
                }
                XCTAssertEqual(SpaceSidebar.format(result.document), expected, "apply \(index)")
                XCTAssertEqual(result.operations.map(\.json), entry["applied"]!.arrayValue!, "apply \(index) operations")
            } catch let error as SpaceSidebarError {
                guard let expected = entry["error"] else {
                    XCTFail("apply \(index) failed: \(error.message)")
                    continue
                }
                XCTAssertEqual(error.message, expected["message"]!.stringValue!, "apply \(index)")
                XCTAssertEqual(error.operationIndex.map(Double.init), expected["operationIndex"]!.numberValue, "apply \(index) index")
            }
        }
    }

    func testDiff() throws {
        for (index, entry) in cases("diff").enumerated() {
            let current = try SpaceSidebar.parse(entry["current"]!.stringValue!)
            let proposed = try SpaceSidebar.parse(entry["proposed"]!.stringValue!)
            let operations = try SpaceSidebar.diff(current, proposed, widgets: entry["widgets"]!.boolValue!)
            XCTAssertEqual(operations.map(\.json), entry["operations"]!.arrayValue!, "diff \(index)")
        }
    }

    func testDesktopEdits() throws {
        for (index, entry) in cases("edits").enumerated() {
            let document = try SpaceSidebar.parse(entry["html"]!.stringValue!)
            let id = entry["id"]?.stringValue
            let after = entry["after"]?.stringValue
            let edited: SpaceSidebarDocument?
            switch entry["kind"]!.stringValue! {
            case "move": edited = SidebarDocumentEdits.move(document, id!, after: after)
            case "fold": edited = SidebarDocumentEdits.fold(document, id!)
            case "place": edited = SidebarDocumentEdits.place(document, id!, parent: entry["parent"]?.stringValue, after: after)
            case "insert":
                edited = SidebarDocumentEdits.insert(document, spaceId: entry["spaceId"]!.stringValue!, sectionId: entry["sectionId"]?.stringValue, happySpaceId: entry["happySpaceId"]?.stringValue)
            default:
                func tree(_ value: JSONValue) -> SidebarDocumentEdits.SessionTree {
                    SidebarDocumentEdits.SessionTree(id: value["id"]!.stringValue!, children: value["children"]!.arrayValue!.map(tree))
                }
                edited = SidebarDocumentEdits.revealSessions(document, id!, sessions: entry["sessions"]!.arrayValue!.map(tree))
            }
            XCTAssertEqual(edited.map { SpaceSidebar.format($0) }, entry["result"]!.stringValue, "edit \(index) \(entry["kind"]!)")
        }
    }

    func testDesktopHidesSessions() throws {
        for (index, entry) in cases("hides").enumerated() {
            let document = try SpaceSidebar.parse(entry["html"]!.stringValue!)
            let attached = Set(entry["attached"]!.arrayValue!.compactMap(\.stringValue))
            let edited = SidebarDocumentEdits.hideSessions(document, entry["id"]!.stringValue!, attached: { attached.contains($0) })
            XCTAssertEqual(edited.map { SpaceSidebar.format($0) }, entry["result"]!.stringValue, "hide \(index)")
        }
    }
}

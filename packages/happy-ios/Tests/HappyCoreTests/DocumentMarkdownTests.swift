import Foundation
@testable import HappyCore
import XCTest

/// The Markdown this phone projects is the daemon's, over the whole corpus.
final class DocumentMarkdownTests: XCTestCase {
    func testMarkdownMatchesTheDaemonsProjection() throws {
        var compared = 0
        for fixture in DocumentFixtureTests.fixtures.documents {
            let name = fixture["name"] as! String
            let doc = try DocumentFixtureTests.doc(DocumentFixtureTests.bytes(fixture["update"]))
            XCTAssertEqual(DocumentMarkdown.markdown(DocumentReader.blocks(doc)), fixture["markdown"] as? String, name)
            compared += 1
        }
        for merge in DocumentFixtureTests.fixtures.merges {
            let doc = try DocumentFixtureTests.doc(DocumentFixtureTests.bytes(merge["base"]))
            try doc.applyUpdate(DocumentFixtureTests.bytes(merge["a"]))
            try doc.applyUpdate(DocumentFixtureTests.bytes(merge["b"]))
            XCTAssertEqual(DocumentMarkdown.markdown(DocumentReader.blocks(doc)), (merge["merged"] as! [String: Any])["markdown"] as? String, merge["name"] as! String)
            compared += 1
        }
        XCTAssertEqual(compared, 42)
    }

    func testOmittedFormattingIsNamed() throws {
        let fixture = DocumentFixtureTests.fixtures.documents.first { $0["name"] as? String == "formatting" }!
        let doc = try DocumentFixtureTests.doc(DocumentFixtureTests.bytes(fixture["update"]))
        XCTAssertEqual(DocumentMarkdown.omitted(DocumentReader.blocks(doc)), Set(fixture["omitted"] as! [String]))
    }
}

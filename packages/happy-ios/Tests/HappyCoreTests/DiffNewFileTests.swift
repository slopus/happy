import XCTest
@testable import HappyCore
import HappyWire

// A new file drawn as a listing (desktop's created-file view), and a
// Write's NEW +N.
final class DiffNewFileTests: XCTestCase {
    func testANewFileListsItsLinesWithoutMarkersOrHunks() throws {
        let source = DiffFileItem.Source.contents(path: "a.swift", oldText: "", newText: "import Foundation\n\nfunc main() {\n    print(1)\n}\n")
        let file = try XCTUnwrap(DiffFileItem.document(source, cache: DiffDocumentCache()).files.first)
        let lines = DiffRowSelection.listing(file.rows).map { row -> String in
            guard let line = row.line else { return "not a line" }
            return "\(line.newNo ?? 0) \(line.type.rawValue) \(line.text)"
        }
        XCTAssertEqual(lines, ["1 ctx import Foundation", "2 ctx ", "3 ctx func main() {", "4 ctx     print(1)", "5 ctx }"])
    }

    func testAWriteCountsTheLinesOfWhatItWrote() {
        XCTAssertEqual(ChatToolPresentation.newFileLines(.object(["file_path": .string("/r/a.swift"), "content": .string("a\nb\nc\n")])), 3)
        XCTAssertNil(ChatToolPresentation.newFileLines(.object(["content": .string("a")])))
        XCTAssertNil(ChatToolPresentation.newFileLines(.object(["file_path": .string("/r/a.swift")])))
    }
}

import XCTest
@testable import HappyCore

final class DiffCacheCollisionTests: XCTestCase {
    private let cache = DiffDocumentCache()

    private func texts(_ document: DiffDocument) -> [String] {
        document.files.flatMap(\.rows).compactMap { row in
            if case .line(let line) = row { return line.text }
            return nil
        }
    }

    func testEqualLengthFNV32CollisionCannotReturnAnotherDocumentsText() {
        let firstText = "GEhgUGw4PN9c", secondText = "EHlhfLI7VFdy"
        let firstInput = "path.txt\u{0}\u{0}" + firstText
        let secondInput = "path.txt\u{0}\u{0}" + secondText
        XCTAssertEqual(DiffEngine.fnv1a(firstInput), 0xf7681e34)
        XCTAssertEqual(DiffEngine.cacheKey("c", firstInput, .init()), DiffEngine.cacheKey("c", secondInput, .init()))

        let first = cache.build(path: "path.txt", oldText: "", newText: firstText)
        let second = cache.build(path: "path.txt", oldText: "", newText: secondText)
        XCTAssertEqual(texts(first), [firstText])
        XCTAssertEqual(texts(second), [secondText])
        XCTAssertFalse(first === second)
        XCTAssertTrue(cache.build(path: "path.txt", oldText: "", newText: secondText) === second,
                      "exact input still reuses the cached document")
        let rebuiltFirst = cache.build(path: "path.txt", oldText: "", newText: firstText)
        XCTAssertEqual(texts(rebuiltFirst), [firstText], "alternating collisions remain correct after bucket replacement")
    }

    func testFullInputVerificationPreservesOldAndNewFieldBoundaries() {
        let firstOld = "a\u{0}b", firstNew = "c"
        let secondOld = "a", secondNew = "b\u{0}c"
        XCTAssertEqual("file.txt\u{0}\(firstOld)\u{0}\(firstNew)", "file.txt\u{0}\(secondOld)\u{0}\(secondNew)")
        let first = cache.build(path: "file.txt", oldText: firstOld, newText: firstNew)
        let second = cache.build(path: "file.txt", oldText: secondOld, newText: secondNew)
        XCTAssertEqual(texts(first), [firstOld, firstNew])
        XCTAssertEqual(texts(second), [secondOld, secondNew])
        XCTAssertFalse(first === second)
    }
}
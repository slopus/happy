import XCTest
@testable import HappyCore

final class WorkspaceLineChangesTests: XCTestCase {
    func testOnlyAvailableNonzeroComparisonsAreVisible() throws {
        func decode(_ comparison: String, _ added: Int, _ removed: Int, exact: Bool = true) throws -> WorkspaceLineChanges {
            try JSONDecoder().decode(WorkspaceLineChanges.self, from: Data("""
            {"comparison":"\(comparison)","insertions":\(added),"deletions":\(removed),"countsExact":\(exact),"scannedAt":1}
            """.utf8))
        }
        XCTAssertNil(try decode("unavailable", 3, 2).visible)
        XCTAssertNil(try decode("ready", 0, 0).visible)
        XCTAssertNil(try decode("ready", -1, 2).visible)
        XCTAssertEqual(try decode("ready", 1234, 7, exact: false).visible,
                       GitLineChanges(approximate: true, insertions: 1234, deletions: 7))
    }
}
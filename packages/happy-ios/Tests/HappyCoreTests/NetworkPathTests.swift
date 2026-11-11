import XCTest
@testable import HappyCore

final class NetworkPathTests: XCTestCase {
    /// Another interface is a move; the first one heard, none at all, or
    /// the same one back after none are not.
    func testOnlyAnotherInterfaceIsAMove() {
        XCTAssertTrue(NetworkPath.moves(from: "en0", to: "pdp_ip0"))
        XCTAssertTrue(NetworkPath.moves(from: "pdp_ip0", to: "en0"))
        XCTAssertFalse(NetworkPath.moves(from: "en0", to: "en0"))
        XCTAssertFalse(NetworkPath.moves(from: nil, to: "en0"))
        XCTAssertFalse(NetworkPath.moves(from: "en0", to: nil))
    }
}

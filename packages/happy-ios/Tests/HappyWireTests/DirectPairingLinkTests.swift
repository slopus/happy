import Foundation
import XCTest
@testable import HappyWire

final class DirectPairingLinkTests: XCTestCase {
    private func code(_ changes: [String: Any] = [:]) throws -> String {
        var bundle: [String: Any] = ["v": 1, "a": "tcAddress", "p": 24781, "t": CanonicalBase64URL.encode(Data(repeating: 3, count: 32)), "n": "Mac", "e": 2_000_000_000_000.0]
        bundle.merge(changes) { _, next in next }
        return DirectPairingLink.prefix + CanonicalBase64URL.encode(try JSONSerialization.data(withJSONObject: bundle))
    }
    func testNewAndLegacyAreSeparate() throws {
        let direct = try code(["unknown": true])
        XCTAssertTrue(DirectPairingLink.isDirect(direct))
        XCTAssertEqual(try DirectPairingLink(direct).port, 24781)
        XCTAssertNil(PairingLink(direct))
        let old = PairingLink.terminal(publicKey: Data(repeating: 7, count: 32)).urlString
        XCTAssertFalse(DirectPairingLink.isDirect(old)); XCTAssertNotNil(PairingLink(old))
        XCTAssertNotNil(PairingLink(PairingLink.account(publicKey: Data(repeating: 8, count: 32)).urlString))
    }
    func testMalformedDirectNeverFallsBack() throws {
        for code in ["happy://direct?bad", "happy://direct", "happy://DIRECT?x", "happy://direct?e30=", try code(["p": 65536]), try code(["p": 0]), try code(["t": "bad"]), try code(["n": "bad\nname"])] {
            XCTAssertTrue(DirectPairingLink.isDirect(code)); XCTAssertThrowsError(try DirectPairingLink(code)); XCTAssertNil(PairingLink(code))
        }
    }
    func testExpiryAndVersionHaveActionableErrors() throws {
        XCTAssertThrowsError(try DirectPairingLink(code(["e": 1]))) { XCTAssertEqual($0 as? DirectPairingError, .expired) }
        XCTAssertThrowsError(try DirectPairingLink(code(["v": 2]))) { XCTAssertEqual($0 as? DirectPairingError, .updateRequired) }
        XCTAssertThrowsError(try DirectPairingLink(code(["v": "1"]))) { XCTAssertEqual($0 as? DirectPairingError, .invalidCode) }
    }
    func testCanonicalBinary() {
        XCTAssertNil(CanonicalBase64URL.decode("AB"))
        XCTAssertNil(CanonicalBase64URL.decode("AA="))
        XCTAssertEqual(CanonicalBase64URL.decode("AA"), Data([0]))
    }
}
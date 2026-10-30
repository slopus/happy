import Foundation
import XCTest
@testable import HappyWire

final class PairingLinkTests: XCTestCase {
    private func code(_ changes: [String: Any] = [:]) throws -> String {
        var bundle: [String: Any] = ["v": 1, "a": "tcAddress", "p": 24781, "t": CanonicalBase64URL.encode(Data(repeating: 3, count: 32)), "n": "Mac", "e": 2_000_000_000_000.0]
        bundle.merge(changes) { _, next in next }
        return PairingLink.prefix + CanonicalBase64URL.encode(try JSONSerialization.data(withJSONObject: bundle))
    }
    func testNewAndLegacyAreSeparate() throws {
        let direct = try code(["unknown": true])
        XCTAssertTrue(PairingLink.isAgentConnection(direct))
        XCTAssertEqual(try PairingLink(direct).port, 24781)
        XCTAssertNil(LegacyPairingLink(direct))
        let old = LegacyPairingLink.terminal(publicKey: Data(repeating: 7, count: 32)).urlString
        XCTAssertFalse(PairingLink.isAgentConnection(old)); XCTAssertNotNil(LegacyPairingLink(old))
        XCTAssertNotNil(LegacyPairingLink(LegacyPairingLink.account(publicKey: Data(repeating: 8, count: 32)).urlString))
    }
    func testMalformedAgentPairingNeverFallsBack() throws {
        for code in ["happy://direct?bad", "happy://direct", "happy://DIRECT?x", "happy://direct?e30=", try code(["p": 65536]), try code(["p": 0]), try code(["t": "bad"]), try code(["n": "bad\nname"])] {
            XCTAssertTrue(PairingLink.isAgentConnection(code)); XCTAssertThrowsError(try PairingLink(code)); XCTAssertNil(LegacyPairingLink(code))
        }
    }
    func testExpiryAndVersionHaveActionableErrors() throws {
        XCTAssertThrowsError(try PairingLink(code(["e": 1]))) { XCTAssertEqual($0 as? PairingError, .expired) }
        XCTAssertThrowsError(try PairingLink(code(["v": 2]))) { XCTAssertEqual($0 as? PairingError, .updateRequired) }
        XCTAssertThrowsError(try PairingLink(code(["v": "1"]))) { XCTAssertEqual($0 as? PairingError, .invalidCode) }
    }
    func testCanonicalBinary() {
        XCTAssertNil(CanonicalBase64URL.decode("AB"))
        XCTAssertNil(CanonicalBase64URL.decode("AA="))
        XCTAssertEqual(CanonicalBase64URL.decode("AA"), Data([0]))
    }
}
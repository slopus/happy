import Foundation
import XCTest
@testable import HappyWire

final class AgentOriginTests: XCTestCase {
    func testCanonicalOriginsAndTranscriptAddress() throws {
        for (value, host, port) in [("https://agent.example.com", "agent.example.com", 443), ("https://agent.example.com:8443", "agent.example.com", 8443), ("https://[2001:db8::1]:8443", "2001:db8::1", 8443)] {
            let origin = try AgentOrigin(value)
            XCTAssertEqual(origin.host, host)
            XCTAssertEqual(Int(origin.port), port)
            let payload: [String: Any] = ["v": 2, "u": value, "t": CanonicalBase64URL.encode(Data(repeating: 3, count: 32)), "n": "Mac", "e": 2_000_000_000_000.0]
            let link = try PairingLink(PairingLink.prefix + CanonicalBase64URL.encode(JSONSerialization.data(withJSONObject: payload)))
            XCTAssertEqual(link.address, value)
            XCTAssertEqual(link.publicUrl, value)
            XCTAssertEqual(Int(link.port), port)
        }
    }

    func testNoncanonicalAndUnsafeOriginsAreRejected() {
        for value in ["https://127.1", "https://0177.0.0.1", "https://0x7f000001", "https://[2001:0db8::1]", "https://[2001:db8:0:0:0:0:0:1]", "https://[invalid]", "https://bad^host"] {
            XCTAssertThrowsError(try AgentOrigin(value), value)
        }
        for value in ["http://agent.example.com", "HTTPS://agent.example.com", "https://AGENT.example.com", "https://agent.example.com:443", "https://agent.example.com/", "https://agent.example.com/path", "https://agent.example.com?", "https://agent.example.com#", "https://user:pass@agent.example.com", "https://agent.example.com:0", "https://agent.example.com:65536", "https://agent.example.com:08443", "https://agent.example.com\n", " https://agent.example.com", "https://agent.example.com\\evil", "https://%61gent.example.com"] {
            XCTAssertThrowsError(try AgentOrigin(value), value)
        }
    }
}
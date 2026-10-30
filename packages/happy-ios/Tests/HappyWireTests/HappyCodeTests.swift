import Foundation
import XCTest
@testable import HappyWire

/// Every code Happy draws, in the form its producer writes it.
final class HappyCodeTests: XCTestCase {
    private let key = Data((0..<32).map { UInt8($0) })
    private var keyText: String { CanonicalBase64URL.encode(key) }

    private func direct(_ changes: [String: Any] = [:]) throws -> String {
        var bundle: [String: Any] = ["v": 1, "a": "tcAddress", "p": 24781, "t": CanonicalBase64URL.encode(Data(repeating: 3, count: 32)), "n": "Mac", "e": 2_000_000_000_000.0]
        bundle.merge(changes) { _, next in next }
        return PairingLink.prefix + CanonicalBase64URL.encode(try JSONSerialization.data(withJSONObject: bundle))
    }

    /// happy-cli src/ui/auth.ts:102, and Happy Agent's Link Mobile App QR.
    func testATerminalCodeIsATerminal() {
        XCTAssertEqual(HappyCode("happy://terminal?" + keyText), .terminal(publicKey: key))
        XCTAssertEqual(HappyCode("  happy://terminal?\(keyText)\n"), .terminal(publicKey: key))
    }

    /// happy-app restore/index.tsx:141 and happy-agent src/auth.ts:38.
    func testAnAccountCodeIsAnAccount() {
        XCTAssertEqual(HappyCode("happy:///account?" + keyText), .account(publicKey: key))
    }

    /// happy-cli src/api/webAuth.ts:11, pasted.
    func testTheCLIsWebLinkIsATerminal() {
        XCTAssertEqual(HappyCode("https://app.happy.engineering/terminal/connect#key=" + keyText), .terminal(publicKey: key))
        XCTAssertEqual(HappyCode("https://app.happy.engineering/terminal/connect#key=short"), .invalid(.terminal))
    }

    func testADirectCodeIsDirect() throws {
        guard case .agentConnection(let link) = HappyCode(try direct()) else { return XCTFail() }
        XCTAssertEqual(link.port, 24781)
    }

    func testBrokenHappyCodesSayWhichKind() throws {
        XCTAssertEqual(HappyCode("happy://terminal?"), .invalid(.terminal))
        XCTAssertEqual(HappyCode("happy://terminal?abc"), .invalid(.terminal))
        XCTAssertEqual(HappyCode("happy:///account?abc"), .invalid(.account))
        XCTAssertEqual(HappyCode("happy://direct?bad"), .invalid(.agentConnection(.invalidCode)))
        XCTAssertEqual(HappyCode(try direct(["e": 1])), .invalid(.agentConnection(.expired)))
        XCTAssertEqual(HappyCode(try direct(["v": 2])), .invalid(.agentConnection(.updateRequired)))
    }

    func testAnythingElseIsNotHappy() {
        for text in ["", "hello", "https://happy.engineering", "WIFI:S:home;T:WPA;P:secret;;", "happy://", "happy://something?x"] {
            XCTAssertEqual(HappyCode(text), .notHappy, text)
        }
    }
}

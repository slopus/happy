import Foundation
import XCTest
@testable import HappyWire

/// Codes exactly as their producers print them, made by running each
/// producer's own encoder on a fresh X25519 key (node, the code quoted
/// below), with keys whose text has both `-` and `_`, the characters a
/// plain base64 decoder chokes on.
final class HappyCodeProducerTests: XCTestCase {
    private let terminalKey = Data(hex: "901ba45c19f0ff760913b944a4afa290bd44b9219f720bd1f96e96a4eb032937")
    private let accountKey = Data(hex: "99fbff76ae03bc916b3252ea2d1d1c4362603c39ffb60fdbe03faffc66a9d57d")

    /// happy-cli src/ui/auth.ts:102, `'happy://terminal?' +
    /// encodeBase64Url(keypair.publicKey)`: the QR `happy auth login` draws
    /// and the line under it.
    func testTheCLIsMobileCode() {
        XCTAssertEqual(HappyCode("happy://terminal?kBukXBnw_3YJE7lEpK-ikL1EuSGfcgvR-W6WpOsDKTc"), .terminal(publicKey: terminalKey))
    }

    /// happy-cli src/api/webAuth.ts:11, its web sign-in, pasted.
    func testTheCLIsWebLink() {
        XCTAssertEqual(HappyCode("https://app.happy.engineering/terminal/connect#key=kBukXBnw_3YJE7lEpK-ikL1EuSGfcgvR-W6WpOsDKTc"), .terminal(publicKey: terminalKey))
    }

    /// happy-app restore/index.tsx:141, `'happy:///account?' +
    /// encodeBase64(publicKey, 'base64url')`, and happy-agent src/auth.ts:38,
    /// which writes the same.
    func testTheAppsAndTheAgentsAccountCode() {
        XCTAssertEqual(HappyCode("happy:///account?mfv_dq4DvJFrMlLqLR0cQ2JgPDn_tg_b4D-v_Gap1X0"), .account(publicKey: accountKey))
    }

    /// A terminal key round-trips through the link this app writes, which
    /// is what happy-app's useConnectTerminal.ts reads back.
    func testOurLinkIsTheCLIs() {
        XCTAssertEqual(LegacyPairingLink.terminal(publicKey: terminalKey).urlString, "happy://terminal?kBukXBnw_3YJE7lEpK-ikL1EuSGfcgvR-W6WpOsDKTc")
        XCTAssertEqual(LegacyPairingLink.account(publicKey: accountKey).urlString, "happy:///account?mfv_dq4DvJFrMlLqLR0cQ2JgPDn_tg_b4D-v_Gap1X0")
    }

    /// What a scanner hands over can carry a line break at the end, as a
    /// pasted line does.
    func testSurroundingSpaceIsIgnored() {
        XCTAssertEqual(HappyCode("happy://terminal?kBukXBnw_3YJE7lEpK-ikL1EuSGfcgvR-W6WpOsDKTc\r\n"), .terminal(publicKey: terminalKey))
    }
}

private extension Data {
    init(hex: String) {
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        self.init(bytes)
    }
}

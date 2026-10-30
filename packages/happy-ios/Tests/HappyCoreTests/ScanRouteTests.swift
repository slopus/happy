import Foundation
import HappyCore
import HappyWire
import XCTest

/// Where each code goes from each scan, signed in or not. No code goes
/// nowhere: the wrong kind is a problem the person is told about.
final class ScanRouteTests: XCTestCase {
    private let key = Data(repeating: 9, count: 32)
    private var keyText: String { CanonicalBase64URL.encode(key) }

    private func route(_ text: String, _ intent: ScanIntent, account: Bool) -> ScanRoute {
        ScanRoute.route(HappyCode(text), intent: intent, hasAccount: account)
    }

    private func direct() throws -> String {
        let bundle: [String: Any] = ["v": 1, "a": "tcAddress", "p": 24781, "t": CanonicalBase64URL.encode(Data(repeating: 3, count: 32)), "n": "Mac", "e": 2_000_000_000_000.0]
        return PairingLink.prefix + CanonicalBase64URL.encode(try JSONSerialization.data(withJSONObject: bundle))
    }

    /// Link New Device used to ignore a computer's code, and Pair computer
    /// another device's: both now do what the code asks.
    func testConnectingTakesEitherKindOfRelayCode() {
        XCTAssertEqual(route("happy://terminal?" + keyText, .connect, account: true), .connectComputer(publicKey: key))
        XCTAssertEqual(route("happy:///account?" + keyText, .connect, account: true), .linkDevice(publicKey: key))
    }

    /// Add account with a computer's code: a new account for that computer,
    /// beside the one in use.
    func testAddingAnAccountMakesOneForTheComputer() {
        XCTAssertEqual(route("happy://terminal?" + keyText, .addAccount, account: true), .newAccountForComputer(publicKey: key))
        XCTAssertEqual(route("happy://terminal?" + keyText, .connect, account: false), .newAccountForComputer(publicKey: key))
        XCTAssertEqual(route("happy://terminal?" + keyText, .addAccount, account: false), .newAccountForComputer(publicKey: key))
    }

    func testAnotherDevicesCodeNeedsAnAccountHere() {
        XCTAssertEqual(route("happy:///account?" + keyText, .addAccount, account: true), .linkDevice(publicKey: key))
        XCTAssertEqual(route("happy:///account?" + keyText, .connect, account: false), .problem(.deviceNeedsAccount))
    }

    func testAnAgentPairingCodePairsFromAnywhere() throws {
        let text = try direct()
        for intent in [ScanIntent.connect, .addAccount] {
            for account in [true, false] {
                guard case .connectAgent = route(text, intent, account: account) else { return XCTFail("\(intent) \(account)") }
            }
        }
    }

    func testEveryWrongCodeIsAProblem() {
        for intent in [ScanIntent.connect, .addAccount] {
            for account in [true, false] {
                XCTAssertEqual(route("garbage", intent, account: account), .problem(.notHappy))
                XCTAssertEqual(route("happy://terminal?xx", intent, account: account), .problem(.invalidTerminal))
                XCTAssertEqual(route("happy:///account?xx", intent, account: account), .problem(.invalidAccount))
                XCTAssertEqual(route("happy://direct?bad", intent, account: account), .problem(.agentConnection(.invalidCode)))
            }
        }
    }
}

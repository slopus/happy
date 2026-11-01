import Foundation
import XCTest
@testable import HappyCrypto
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

final class PairingCryptoTests: XCTestCase {
    private func hex(_ text: String) -> Data {
        Data(stride(from: 0, to: text.count, by: 2).map { offset in
            let start = text.index(text.startIndex, offsetBy: offset)
            return UInt8(text[start..<text.index(start, offsetBy: 2)], radix: 16)!
        })
    }
    func testIndependentAPIVectors() throws {
        let phone = try PairingCrypto(privateKey: Data(repeating: 1, count: 32), nonce: Data(repeating: 4, count: 32))
        XCTAssertEqual(phone.publicKey, hex("a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209"))
        XCTAssertEqual(phone.commitment, hex("ae75325169fe3b8d8571df1c5fd015ef9989051a0363e780322a09ebf2430caf"))
        let secrets = try phone.derive(daemonPublicKey: hex("ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59"), daemonNonce: Data(repeating: 5, count: 32), token: Data(repeating: 3, count: 32), address: "tcFixedVectorAddress", port: 24781)
        XCTAssertEqual(secrets.transcriptHash, hex("919140a78d542ec0999e8b045e9b368c94a5cc2d90d6c92e7f14e8d6d302eb08"))
        XCTAssertEqual(secrets.emojiKey, hex("fa42488ee1ceadb6998e8d35792cdda1a1210a63153069fe67f1f1ce57404369"))
        XCTAssertEqual(secrets.confirmKey, hex("152eb695974a86f350d777dd1a7e63abb327eb6af37ee465addbb46ea53cde3f"))
        XCTAssertEqual(secrets.deviceToken, hex("05bf38156a0b81046b4e15f584760e0e8996efe81239e5efe4560fef29c20aeb"))
        XCTAssertEqual(secrets.mac(role: "mobile"), hex("56562cd319819213d10c33fd9e508fffb19343d84b14882ecfc550c058181d85"))
        XCTAssertTrue(secrets.verifyDaemon(hex("81fa0f2f506f539f4ca3f22eeeac675850f3cd902719f14799fc6519266893c9")))
        XCTAssertFalse(secrets.verifyDaemon(secrets.mac(role: "mobile")))
        XCTAssertFalse(secrets.verifyDaemon(Data(repeating: 0, count: 32)))
        XCTAssertEqual(secrets.emoji, ["🌀", "👗", "⏳", "👟"])
    }
    func testEmojiTableAndExamples() {
        XCTAssertEqual(PairingEmoji.table.count, 333)
        XCTAssertEqual(Data(SHA256.hash(data: Data(PairingEmoji.table.joined(separator: "\n").utf8))), hex("c22c3a00d5a68df075fecc8cb8b730a45817a246a5ca70fa3b75d248ac5b54e9"))
        XCTAssertEqual(PairingCrypto.emoji(Data(repeating: 0, count: 32)), ["😉", "😉", "😉", "😉"])
        XCTAssertEqual(PairingCrypto.emoji(Data(0..<32)), ["💍", "☔️", "📅", "🍞"])
        XCTAssertEqual(PairingCrypto.emoji(Data(SHA256.hash(data: Data(0..<32)))), ["🙉", "🇷🇺", "☔️", "✈️"])
    }
    func testPublicOriginIndependentAPIVector() throws {
        let phone = try PairingCrypto(privateKey: Data(repeating: 1, count: 32), nonce: Data(repeating: 4, count: 32))
        let secrets = try phone.derive(daemonPublicKey: hex("ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59"), daemonNonce: Data(repeating: 5, count: 32), token: Data(repeating: 3, count: 32), address: "https://agent.example.com:8443", port: 8443)
        XCTAssertEqual(secrets.transcriptHash, hex("7970d4c0910e3587b6d066c371a2f61a84d0beb96671a071ff6a10e264af4825"))
        XCTAssertEqual(secrets.deviceToken, hex("a175d3b4fea158aade7d1becf944f3d5eed2e62d7e73cbdcc4aec5e0a93a58a8"))
        XCTAssertEqual(secrets.mac(role: "mobile"), hex("33aae926bdc16f2560a9cecdf40f558bb6cf393e0ca5a1931bb0e75bd713502f"))
        XCTAssertTrue(secrets.verifyDaemon(hex("876bd980d032036c848f77faaa191644e31504f10bd2a6713f669dac9bb8849f")))
        XCTAssertEqual(secrets.emoji, ["🇨🇳", "✉️", "🚠", "🍼"])
    }
    func testLowOrderAndMalformedKeysAreRejected() throws {
        let phone = try PairingCrypto()
        for key in [Data(repeating: 0, count: 32), Data([1]) + Data(repeating: 0, count: 31), Data([1])] {
            XCTAssertThrowsError(try phone.derive(daemonPublicKey: key, daemonNonce: Data(repeating: 5, count: 32), token: Data(repeating: 3, count: 32), address: "tcAddress", port: 24781))
        }
    }
    func testDefaultPort443IndependentDaemonVector() throws {
        let phone = try PairingCrypto(privateKey: Data(repeating: 1, count: 32), nonce: Data(repeating: 4, count: 32))
        let secrets = try phone.derive(daemonPublicKey: hex("ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59"), daemonNonce: Data(repeating: 5, count: 32), token: Data(repeating: 3, count: 32), address: "https://agent.example.com", port: 443)
        XCTAssertEqual(secrets.transcriptHash, hex("8a1f7f7897aea5036ac00ffc02588c564eeb7e62fb7b526cce3510480e32358b"))
        XCTAssertEqual(secrets.deviceToken, hex("3fe98bcd45388b9180b5de36c4dfb094ee89d7a86b4c0e78d2bb394a2a5e2132"))
        XCTAssertEqual(secrets.mac(role: "mobile"), hex("c5831f3f84beb716dd93db6eb9dc4161f2d12330e57100ed0fd032a88f5ab8ab"))
        XCTAssertTrue(secrets.verifyDaemon(hex("ccc53b9465872a38e8f1b918971a5c2ea40ca498434704dbe51838a6f9d0cafb")))
        XCTAssertEqual(secrets.emoji, ["🌎", "🍞", "🔴", "🏆"])
    }
}
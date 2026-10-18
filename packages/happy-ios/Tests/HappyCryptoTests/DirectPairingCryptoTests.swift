import Foundation
import XCTest
@testable import HappyCrypto
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

final class DirectPairingCryptoTests: XCTestCase {
    private func hex(_ text: String) -> Data {
        Data(stride(from: 0, to: text.count, by: 2).map { offset in
            let start = text.index(text.startIndex, offsetBy: offset)
            return UInt8(text[start..<text.index(start, offsetBy: 2)], radix: 16)!
        })
    }
    func testIndependentAPIVectors() throws {
        let phone = try DirectPairingCrypto(privateKey: Data(repeating: 1, count: 32), nonce: Data(repeating: 4, count: 32))
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
        XCTAssertEqual(DirectPairingEmoji.table.count, 333)
        XCTAssertEqual(Data(SHA256.hash(data: Data(DirectPairingEmoji.table.joined(separator: "\n").utf8))), hex("c22c3a00d5a68df075fecc8cb8b730a45817a246a5ca70fa3b75d248ac5b54e9"))
        XCTAssertEqual(DirectPairingCrypto.emoji(Data(repeating: 0, count: 32)), ["😉", "😉", "😉", "😉"])
        XCTAssertEqual(DirectPairingCrypto.emoji(Data(0..<32)), ["💍", "☔️", "📅", "🍞"])
        XCTAssertEqual(DirectPairingCrypto.emoji(Data(SHA256.hash(data: Data(0..<32)))), ["🙉", "🇷🇺", "☔️", "✈️"])
    }
    func testLowOrderAndMalformedKeysAreRejected() throws {
        let phone = try DirectPairingCrypto()
        for key in [Data(repeating: 0, count: 32), Data([1]) + Data(repeating: 0, count: 31), Data([1])] {
            XCTAssertThrowsError(try phone.derive(daemonPublicKey: key, daemonNonce: Data(repeating: 5, count: 32), token: Data(repeating: 3, count: 32), address: "tcAddress", port: 24781))
        }
    }
}
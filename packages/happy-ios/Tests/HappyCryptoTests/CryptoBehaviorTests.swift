import Foundation
import XCTest
@testable import HappyCrypto

/// Behaviour that vectors cannot show: rejection of bad input, randomness,
/// and the pairing payloads a terminal or another device must be able to open.
final class CryptoBehaviorTests: XCTestCase {
    func testSecretBoxRejectsTamperingWrongKeyAndTruncation() throws {
        let key = SystemRandom().bytes(32)
        let bundle = try SecretBox.sealBundle(Data("hello".utf8), key: key)

        var tampered = bundle
        tampered[tampered.count - 1] ^= 0x01
        XCTAssertNil(SecretBox.openBundle(tampered, key: key))
        XCTAssertNil(SecretBox.openBundle(bundle, key: SystemRandom().bytes(32)))
        XCTAssertNil(SecretBox.openBundle(Data(bundle.prefix(39)), key: key))
        XCTAssertNil(SecretBox.openBundle(bundle, key: Data(count: 31)))
        XCTAssertEqual(SecretBox.openBundle(bundle, key: key), Data("hello".utf8))
    }

    func testSecretBoxSealsLargeBlobs() throws {
        let key = SystemRandom().bytes(32)
        let blob = SystemRandom().bytes(1_000_003)
        let bundle = try SecretBox.sealBundle(blob, key: key)
        XCTAssertEqual(bundle.count, 24 + 16 + blob.count)
        XCTAssertEqual(SecretBox.openBundle(bundle, key: key), blob)
    }

    func testSealingUsesFreshNonces() throws {
        let key = SystemRandom().bytes(32)
        let a = try SecretBox.sealBundle(Data("same".utf8), key: key)
        let b = try SecretBox.sealBundle(Data("same".utf8), key: key)
        XCTAssertNotEqual(a, b)
        let c = try AESGCMBundle.seal(Data("same".utf8), key: key)
        let d = try AESGCMBundle.seal(Data("same".utf8), key: key)
        XCTAssertNotEqual(c, d)
    }

    func testAESGCMBundleLayoutAndRejections() throws {
        let key = SystemRandom().bytes(32)
        let bundle = try AESGCMBundle.seal(Data("a".utf8), key: key)
        // version + nonce + 1 byte ciphertext + tag
        XCTAssertEqual(bundle.count, 1 + 12 + 1 + 16)
        XCTAssertEqual(bundle.first, 0)

        var wrongVersion = bundle
        wrongVersion[0] = 1
        XCTAssertNil(AESGCMBundle.open(wrongVersion, key: key))
        var tampered = bundle
        tampered[13] ^= 0xff
        XCTAssertNil(AESGCMBundle.open(tampered, key: key))
        XCTAssertNil(AESGCMBundle.open(Data(bundle.prefix(20)), key: key))
        XCTAssertNil(AESGCMBundle.open(bundle, key: SystemRandom().bytes(32)))
    }

    func testDataKeyWrapRoundTripAndForeignKeys() throws {
        let alice = try AccountKeys(secret: SystemRandom().bytes(32))
        let bob = try AccountKeys(secret: SystemRandom().bytes(32))
        let dataKey = SystemRandom().bytes(32)
        let wrapped = try alice.wrapDataKey(dataKey)
        XCTAssertEqual(wrapped.first, 0)
        XCTAssertEqual(alice.unwrapDataKey(wrapped), dataKey)
        XCTAssertNil(bob.unwrapDataKey(wrapped), "another account's key never opens")

        var unversioned = wrapped
        unversioned[0] = 1
        XCTAssertNil(alice.unwrapDataKey(unversioned))
        XCTAssertNil(alice.unwrapDataKey(base64: "not base64!"))
    }

    func testTerminalApprovalCarriesContentPublicKeyOnly() throws {
        let account = try AccountKeys(secret: SystemRandom().bytes(32))
        let terminal = try BoxKeyPair.generate()
        let response = try account.terminalApproval(terminalPublicKey: terminal.publicKey)

        let opened = try XCTUnwrap(Box.openAnonymous(response, recipientSecretKey: terminal.secretKey))
        XCTAssertEqual(opened.first, 0)
        XCTAssertEqual(Data(opened.dropFirst()), account.contentKeyPair.publicKey)
        XCTAssertFalse(opened.range(of: account.secret) != nil, "the master secret must not reach a terminal")
    }

    func testAccountLinkHandsOverTheSecretToTheRequester() throws {
        let account = try AccountKeys(secret: SystemRandom().bytes(32))
        // The new device makes its key pair with crypto_box_seed_keypair.
        let device = try BoxKeyPair(seed: SystemRandom().bytes(32))
        let response = try account.accountLinkApproval(devicePublicKey: device.publicKey)
        XCTAssertEqual(Box.openAnonymous(response, recipientSecretKey: device.secretKey), account.secret)
        XCTAssertNil(Box.openAnonymous(response, recipientSecretKey: try BoxKeyPair.generate().secretKey))
    }

    func testRejectsBadKeyLengths() {
        XCTAssertThrowsError(try AccountKeys(secret: Data(count: 16)))
        XCTAssertThrowsError(try BoxKeyPair(seed: Data(count: 31)))
        XCTAssertThrowsError(try SigningKeyPair(seed: Data(count: 33)))
        XCTAssertThrowsError(try AESGCMBundle.seal(Data(), key: Data(count: 16)))
        XCTAssertNil(Box.openAnonymous(Data(count: 10), recipientSecretKey: Data(count: 32)))
    }

    func testSecretKeyBackupForgivesTyposAndRejectsGarbage() throws {
        let secret = SystemRandom().bytes(32)
        let formatted = SecretKeyBackup.format(secret: secret)
        XCTAssertEqual(formatted.split(separator: "-").count, 11)
        XCTAssertEqual(try SecretKeyBackup.parse(formatted.replacingOccurrences(of: "-", with: " ").lowercased()), secret)
        XCTAssertEqual(try SecretKeyBackup.parse(formatted.replacingOccurrences(of: "O", with: "0")), secret)
        XCTAssertThrowsError(try SecretKeyBackup.parse("----")) { error in
            XCTAssertEqual(error as? SecretKeyBackup.ParseError, .noValidCharacters)
        }
        XCTAssertThrowsError(try SecretKeyBackup.parse("ABCDE-FGHIJ")) { error in
            XCTAssertEqual(error as? SecretKeyBackup.ParseError, .invalidLength(6))
        }
    }

    func testHexRoundTrip() {
        let data = Data([0x00, 0x0f, 0xa0, 0xff])
        XCTAssertEqual(data.hexString, "000fa0ff")
        XCTAssertEqual(Data(hexString: "000FA0ff"), data)
        XCTAssertNil(Data(hexString: "abc"))
        XCTAssertNil(Data(hexString: "zz"))
    }

    func testConstantTimeEquals() {
        XCTAssertTrue(Bytes.constantTimeEquals([1, 2, 3], [1, 2, 3]))
        XCTAssertFalse(Bytes.constantTimeEquals([1, 2, 3], [1, 2, 4]))
        XCTAssertFalse(Bytes.constantTimeEquals([1, 2], [1, 2, 3]))
    }
}

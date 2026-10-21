import Foundation
import XCTest
@testable import HappyCrypto

/// Byte-for-byte compatibility with tweetnacl / node:crypto, i.e. with the
/// server, the CLI, happy-agent and happy-app.
final class CryptoVectorTests: XCTestCase {
    var vectors: Vectors!

    override func setUpWithError() throws {
        vectors = try Vectors.load()
    }

    func testBase64AndBase64URL() throws {
        for item in vectors.base64 {
            let data = try XCTUnwrap(Data(hexString: item.data))
            XCTAssertEqual(Base64.encode(data), item.base64)
            XCTAssertEqual(Base64.encodeURL(data), item.base64url)
            XCTAssertEqual(Base64.decode(item.base64), data)
            XCTAssertEqual(Base64.decodeURL(item.base64url), data)
            // Lenient about padding in both directions.
            XCTAssertEqual(Base64.decode(item.base64.replacingOccurrences(of: "=", with: "")), data)
            XCTAssertEqual(Base64.decodeURL(item.base64url + String(repeating: "=", count: (4 - item.base64url.count % 4) % 4)), data)
        }
    }

    func testHMACSHA512() {
        for item in vectors.hmacSha512 {
            XCTAssertEqual(Hashing.hmacSHA512(key: b64(item.key), data: b64(item.data)), b64(item.mac))
        }
    }

    func testKeyTreeDerivation() {
        for item in vectors.deriveKey {
            XCTAssertEqual(
                KeyTree.deriveKey(master: b64(item.master), usage: item.usage, path: item.path),
                b64(item.key),
                "\(item.usage) \(item.path)"
            )
        }
    }

    func testAccountKeySchedule() throws {
        for item in vectors.accountKeys {
            let keys = try AccountKeys(secret: b64(item.secret))
            XCTAssertEqual(keys.contentKeyPair.secretKey, b64(item.contentSecretKey))
            XCTAssertEqual(keys.contentKeyPair.publicKey, b64(item.contentPublicKey))
            XCTAssertEqual(keys.anonID, item.anonID)
            XCTAssertEqual(keys.signingKeyPair.publicKey, b64(item.signingPublicKey))
            XCTAssertEqual(Base64.encodeURL(keys.secret), item.secretBase64url)
        }
    }

    func testUnwrapsDataKeysSealedByTweetnacl() throws {
        for item in vectors.accountKeys {
            let keys = try AccountKeys(secret: b64(item.secret))
            XCTAssertEqual(keys.unwrapDataKey(base64: item.wrappedDataKey), b64(item.dataKey))
        }
    }

    func testSecretBoxMatchesTweetnacl() throws {
        for item in vectors.secretBox {
            let key = b64(item.key)
            let nonce = b64(item.nonce)
            let plaintext = b64(item.plaintext)
            let bundle = b64(item.bundle)

            let sealed = try SecretBox.sealBundle(plaintext, key: key, random: FixedRandom(nonce))
            XCTAssertEqual(sealed, bundle, "seal, \(plaintext.count) bytes")
            XCTAssertEqual(SecretBox.openBundle(bundle, key: key), plaintext, "open, \(plaintext.count) bytes")
        }
    }

    func testBoxMatchesTweetnacl() throws {
        for item in vectors.box {
            let recipient = try BoxKeyPair(seed: b64(item.recipientSeed))
            XCTAssertEqual(recipient.secretKey, b64(item.recipientSecretKey))
            XCTAssertEqual(recipient.publicKey, b64(item.recipientPublicKey))

            var randomness = b64(item.ephemeralSecretKey)
            randomness.append(b64(item.nonce))
            let sealed = try Box.sealAnonymous(b64(item.plaintext), recipientPublicKey: recipient.publicKey, random: FixedRandom(randomness))
            XCTAssertEqual(sealed, b64(item.bundle))
            XCTAssertEqual(Box.openAnonymous(b64(item.bundle), recipientSecretKey: recipient.secretKey), b64(item.plaintext))
        }
    }

    func testAESGCMMatchesNodeCrypto() throws {
        for item in vectors.aesGcm {
            let key = b64(item.key)
            let sealed = try AESGCMBundle.seal(Data(item.json.utf8), key: key, nonce: b64(item.nonce))
            XCTAssertEqual(sealed, b64(item.bundle))
            let opened = try XCTUnwrap(AESGCMBundle.open(b64(item.bundle), key: key))
            XCTAssertEqual(String(decoding: opened, as: UTF8.self), item.json)
        }
    }

    func testEd25519MatchesTweetnacl() throws {
        for item in vectors.signing {
            let pair = try SigningKeyPair(seed: b64(item.seed))
            XCTAssertEqual(pair.publicKey, b64(item.publicKey))
            // tweetnacl's signature verifies here, and ours verifies too.
            XCTAssertTrue(SigningKeyPair.verify(signature: b64(item.signature), message: b64(item.message), publicKey: pair.publicKey))
            let ours = try pair.sign(b64(item.message))
            XCTAssertEqual(ours.count, 64)
            XCTAssertTrue(SigningKeyPair.verify(signature: ours, message: b64(item.message), publicKey: pair.publicKey))
        }
    }

    func testSecretKeyBackupFormat() throws {
        for item in vectors.secretKeyBackup {
            let secret = try XCTUnwrap(Base64.decodeURL(item.secretBase64url))
            XCTAssertEqual(SecretKeyBackup.format(secret: secret), item.formatted)
            XCTAssertEqual(try SecretKeyBackup.parse(item.formatted), secret)
            XCTAssertEqual(try SecretKeyBackup.normalize(item.formatted.lowercased()), secret)
            XCTAssertEqual(try SecretKeyBackup.normalize(item.secretBase64url), secret)
        }
    }
}

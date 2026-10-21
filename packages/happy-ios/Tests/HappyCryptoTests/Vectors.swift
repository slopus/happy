import Foundation
import XCTest

/// Fixtures/crypto-vectors.json, produced by scripts/generate-crypto-vectors.mjs
/// with tweetnacl and node:crypto.
struct Vectors: Decodable {
    struct Base64Case: Decodable { let data: String; let base64: String; let base64url: String }
    struct HMACCase: Decodable { let key: String; let data: String; let mac: String }
    struct DeriveKeyCase: Decodable { let master: String; let usage: String; let path: [String]; let key: String }
    struct AccountCase: Decodable {
        let secret: String
        let secretBase64url: String
        let contentKeySeed: String
        let contentSecretKey: String
        let contentPublicKey: String
        let anonID: String
        let signingPublicKey: String
        let dataKey: String
        let wrappedDataKey: String
        let terminalSecretKey: String
        let terminalPublicKey: String
    }
    struct SecretBoxCase: Decodable { let key: String; let nonce: String; let plaintext: String; let bundle: String }
    struct BoxCase: Decodable {
        let recipientSeed: String
        let recipientSecretKey: String
        let recipientPublicKey: String
        let ephemeralSecretKey: String
        let nonce: String
        let plaintext: String
        let bundle: String
    }
    struct AESCase: Decodable { let key: String; let nonce: String; let json: String; let bundle: String }
    struct SigningCase: Decodable { let seed: String; let publicKey: String; let message: String; let signature: String }
    struct BackupCase: Decodable { let secretBase64url: String; let formatted: String }

    let base64: [Base64Case]
    let hmacSha512: [HMACCase]
    let deriveKey: [DeriveKeyCase]
    let accountKeys: [AccountCase]
    let secretBox: [SecretBoxCase]
    let box: [BoxCase]
    let aesGcm: [AESCase]
    let signing: [SigningCase]
    let secretKeyBackup: [BackupCase]

    static func load() throws -> Vectors {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "crypto-vectors", withExtension: "json", subdirectory: "Fixtures"),
            "missing Fixtures/crypto-vectors.json"
        )
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }
}

func b64(_ string: String, file: StaticString = #filePath, line: UInt = #line) -> Data {
    guard let data = Data(base64Encoded: string) else {
        XCTFail("bad base64 in fixture: \(string)", file: file, line: line)
        return Data()
    }
    return data
}

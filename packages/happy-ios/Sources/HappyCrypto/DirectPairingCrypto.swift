import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// API.md's transcript binds the address and port into the proof. The
/// derived device token never travels on the wire during pairing.
public struct DirectPairingCrypto: Sendable {
    private static let label = "happy-mobile-pair-v1"
    private let privateKey: Curve25519.KeyAgreement.PrivateKey
    public let publicKey: Data
    public let nonce: Data
    public let commitment: Data

    public init(privateKey: Data? = nil, nonce: Data? = nil) throws {
        let key = try privateKey.map { try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: $0) } ?? Curve25519.KeyAgreement.PrivateKey()
        let nonce = nonce ?? Data((0..<32).map { _ in UInt8.random(in: .min ... .max) })
        guard nonce.count == 32 else { throw CryptoError.invalidInput("pairing nonce") }
        self.privateKey = key; self.nonce = nonce; publicKey = key.publicKey.rawRepresentation
        commitment = Data(SHA256.hash(data: Data("\(Self.label)/commit".utf8) + publicKey + nonce))
    }

    public struct Secrets: Sendable {
        public let transcriptHash: Data
        public let emojiKey: Data
        public let confirmKey: Data
        public let deviceToken: Data
        public var emoji: [String] { DirectPairingCrypto.emoji(Data(SHA256.hash(data: emojiKey))) }
        public func mac(role: String) -> Data {
            Data(HMAC<SHA256>.authenticationCode(for: Data(role.utf8) + transcriptHash, using: SymmetricKey(data: confirmKey)))
        }
        public func verifyDaemon(_ proof: Data) -> Bool {
            HMAC<SHA256>.isValidAuthenticationCode(proof, authenticating: Data("daemon".utf8) + transcriptHash, using: SymmetricKey(data: confirmKey))
        }
    }

    public func derive(daemonPublicKey: Data, daemonNonce: Data, token: Data, address: String, port: UInt16) throws -> Secrets {
        guard daemonPublicKey.count == 32, daemonNonce.count == 32, token.count == 32 else { throw CryptoError.invalidInput("pairing key") }
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: daemonPublicKey)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        guard shared.withUnsafeBytes({ $0.contains { $0 != 0 } }) else { throw CryptoError.invalidInput("pairing shared secret") }
        let fields = [token, commitment, publicKey, daemonPublicKey, nonce, daemonNonce, Data(address.utf8), Data([UInt8(port >> 8), UInt8(port & 255)])]
        let transcript = fields.reduce(into: Data(Self.label.utf8)) { result, field in
            let count = UInt32(field.count)
            result.append(contentsOf: [UInt8((count >> 24) & 255), UInt8((count >> 16) & 255), UInt8((count >> 8) & 255), UInt8(count & 255)])
            result.append(field)
        }
        let hash = Data(SHA256.hash(data: transcript))
        func expand(_ purpose: String) -> Data {
            shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: hash, sharedInfo: Data("\(Self.label) \(purpose)".utf8), outputByteCount: 32).withUnsafeBytes { Data($0) }
        }
        return Secrets(transcriptHash: hash, emojiKey: expand("emoji"), confirmKey: expand("confirm"), deviceToken: expand("device-token"))
    }

    public static func emoji(_ hash: Data) -> [String] {
        guard hash.count == 32 else { return [] }
        return (0..<4).map { index in
            let value = hash.dropFirst(index * 8).prefix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } & 0x7fffffffffffffff
            return DirectPairingEmoji.table[Int(value % UInt64(DirectPairingEmoji.table.count))]
        }
    }
}
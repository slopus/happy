import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Ed25519 keyed by a 32-byte seed, as `crypto_sign_seed_keypair` does.
/// The account's signing key is seeded with the master secret itself.
public struct SigningKeyPair: Sendable {
    public let publicKey: Data
    private let seed: Data

    public init(seed: Data) throws {
        guard seed.count == 32 else {
            throw CryptoError.invalidKeyLength(expected: 32, actual: seed.count)
        }
        self.seed = seed
        publicKey = try Self.privateKey(seed).publicKey.rawRepresentation
    }

    /// A detached 64-byte signature. CryptoKit may randomize signatures, so
    /// they can differ from tweetnacl's for the same input but verify the same.
    public func sign(_ message: Data) throws -> Data {
        do {
            return try Self.privateKey(seed).signature(for: message)
        } catch {
            throw CryptoError.backend("\(error)")
        }
    }

    public static func verify(signature: Data, message: Data, publicKey: Data) -> Bool {
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(signature, for: message)
    }

    private static func privateKey(_ seed: Data) throws -> Curve25519.Signing.PrivateKey {
        do {
            return try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        } catch {
            throw CryptoError.backend("\(error)")
        }
    }
}

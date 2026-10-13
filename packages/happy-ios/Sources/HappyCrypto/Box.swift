import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// An X25519 key pair as NaCl's `crypto_box` uses it.
public struct BoxKeyPair: Sendable, Equatable {
    public let publicKey: Data
    public let secretKey: Data

    /// Uses `secretKey` directly as the X25519 scalar
    /// (tweetnacl `box.keyPair.fromSecretKey`).
    public init(secretKey: Data) throws {
        guard secretKey.count == Box.secretKeyLength else {
            throw CryptoError.invalidKeyLength(expected: Box.secretKeyLength, actual: secretKey.count)
        }
        do {
            let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secretKey)
            self.secretKey = secretKey
            self.publicKey = key.publicKey.rawRepresentation
        } catch {
            throw CryptoError.backend("\(error)")
        }
    }

    /// libsodium `crypto_box_seed_keypair`: the scalar is the first 32 bytes
    /// of SHA-512(seed). This is how happy-app derives its content key pair
    /// and the QR login key pair, so it must not be "simplified" to use the
    /// seed directly.
    public init(seed: Data) throws {
        guard seed.count == Box.seedLength else {
            throw CryptoError.invalidKeyLength(expected: Box.seedLength, actual: seed.count)
        }
        try self.init(secretKey: Data(Hashing.sha512(seed).prefix(32)))
    }

    /// libsodium `crypto_box_keypair`: a random scalar.
    public static func generate(random: RandomSource = SystemRandom()) throws -> BoxKeyPair {
        try BoxKeyPair(secretKey: random.bytes(Box.secretKeyLength))
    }
}

/// NaCl `crypto_box` (X25519 + HSalsa20 + XSalsa20-Poly1305).
public enum Box {
    public static let publicKeyLength = 32
    public static let secretKeyLength = 32
    public static let seedLength = 32
    public static let nonceLength = 24

    public static func seal(_ plaintext: Data, nonce: Data, recipientPublicKey: Data, senderSecretKey: Data) throws -> Data {
        let key = try sharedKey(publicKey: recipientPublicKey, secretKey: senderSecretKey)
        return try SecretBox.seal(plaintext, nonce: nonce, key: key)
    }

    public static func open(_ boxed: Data, nonce: Data, senderPublicKey: Data, recipientSecretKey: Data) -> Data? {
        guard let key = try? sharedKey(publicKey: senderPublicKey, secretKey: recipientSecretKey) else { return nil }
        return SecretBox.open(boxed, nonce: nonce, key: key)
    }

    /// `crypto_box_beforenm`: HSalsa20(X25519(sk, pk), 0^16).
    public static func sharedKey(publicKey: Data, secretKey: Data) throws -> Data {
        guard publicKey.count == publicKeyLength else {
            throw CryptoError.invalidKeyLength(expected: publicKeyLength, actual: publicKey.count)
        }
        guard secretKey.count == secretKeyLength else {
            throw CryptoError.invalidKeyLength(expected: secretKeyLength, actual: secretKey.count)
        }
        let shared: Data
        do {
            let privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secretKey)
            let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
            shared = try privateKey.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
        } catch {
            throw CryptoError.backend("\(error)")
        }
        return Salsa20.hsalsa20(key: shared, input: Data(count: 16))
    }

    /// Happy's anonymous box bundle:
    /// `ephemeralPublicKey(32) || nonce(24) || mac(16) || ciphertext`
    /// (encryptBox in packages/happy-app/sources/encryption/libsodium.ts).
    public static func sealAnonymous(_ plaintext: Data, recipientPublicKey: Data, random: RandomSource = SystemRandom()) throws -> Data {
        let ephemeral = try BoxKeyPair.generate(random: random)
        let nonce = random.bytes(nonceLength)
        var out = ephemeral.publicKey
        out.append(nonce)
        out.append(try seal(plaintext, nonce: nonce, recipientPublicKey: recipientPublicKey, senderSecretKey: ephemeral.secretKey))
        return out
    }

    public static func openAnonymous(_ bundle: Data, recipientSecretKey: Data) -> Data? {
        guard bundle.count >= publicKeyLength + nonceLength + SecretBox.macLength else { return nil }
        let bytes = Data(bundle)
        let ephemeralPublicKey = bytes.prefix(publicKeyLength)
        let nonce = bytes.dropFirst(publicKeyLength).prefix(nonceLength)
        let boxed = bytes.dropFirst(publicKeyLength + nonceLength)
        return open(Data(boxed), nonce: Data(nonce), senderPublicKey: Data(ephemeralPublicKey), recipientSecretKey: recipientSecretKey)
    }
}

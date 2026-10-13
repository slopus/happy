import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// AES-256-GCM in Happy's versioned bundle, used for every record that has
/// its own data encryption key (sessions, machines, artifacts):
///
///     0x00 || nonce(12) || ciphertext || tag(16)
///
/// Matches `AES256Encryption` in happy-app and `encryptWithDataKey` in
/// happy-agent. Only version 0 exists.
public enum AESGCMBundle {
    public static let version: UInt8 = 0
    public static let keyLength = 32
    public static let nonceLength = 12
    public static let tagLength = 16

    public static func seal(_ plaintext: Data, key: Data, random: RandomSource = SystemRandom()) throws -> Data {
        try seal(plaintext, key: key, nonce: random.bytes(nonceLength))
    }

    public static func seal(_ plaintext: Data, key: Data, nonce: Data) throws -> Data {
        guard key.count == keyLength else {
            throw CryptoError.invalidKeyLength(expected: keyLength, actual: key.count)
        }
        guard nonce.count == nonceLength else {
            throw CryptoError.invalidNonceLength(expected: nonceLength, actual: nonce.count)
        }
        do {
            let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce))
            guard let combined = sealed.combined else {
                throw CryptoError.backend("AES.GCM produced no combined representation")
            }
            var out = Data([version])
            out.append(combined)
            return out
        } catch let error as CryptoError {
            throw error
        } catch {
            throw CryptoError.backend("\(error)")
        }
    }

    /// Returns nil for unknown versions, short input or a failed tag check.
    public static func open(_ bundle: Data, key: Data) -> Data? {
        guard key.count == keyLength,
              bundle.count >= 1 + nonceLength + tagLength,
              bundle.first == version
        else { return nil }
        do {
            let box = try AES.GCM.SealedBox(combined: Data(bundle.dropFirst()))
            return try AES.GCM.open(box, using: SymmetricKey(data: key))
        } catch {
            return nil
        }
    }
}

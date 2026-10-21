import Foundation

/// NaCl `crypto_secretbox` (XSalsa20-Poly1305), byte compatible with
/// tweetnacl's `secretbox` and libsodium's `crypto_secretbox_easy`:
/// the boxed output is `mac(16) || ciphertext`.
public enum SecretBox {
    public static let keyLength = 32
    public static let nonceLength = 24
    public static let macLength = 16

    public static func seal(_ plaintext: Data, nonce: Data, key: Data) throws -> Data {
        try validate(key: key, nonce: nonce)
        var buffer = [UInt8](plaintext)
        Salsa20.xsalsa20XOR(&buffer, key: key, nonce: nonce, skip: 32)
        let polyKey = Salsa20.xsalsa20FirstBytes(key: key, nonce: nonce, count: 32)
        let tag = Poly1305.authenticate(message: buffer, key: polyKey)
        var out = Data(tag)
        out.append(contentsOf: buffer)
        return out
    }

    /// Returns nil when the MAC does not verify (wrong key, tampering,
    /// truncation). Never throws on hostile input.
    public static func open(_ boxed: Data, nonce: Data, key: Data) -> Data? {
        guard (try? validate(key: key, nonce: nonce)) != nil, boxed.count >= macLength else { return nil }
        let tag = [UInt8](boxed.prefix(macLength))
        var buffer = [UInt8](boxed.dropFirst(macLength))
        let polyKey = Salsa20.xsalsa20FirstBytes(key: key, nonce: nonce, count: 32)
        let expected = Poly1305.authenticate(message: buffer, key: polyKey)
        guard Bytes.constantTimeEquals(tag, expected) else { return nil }
        Salsa20.xsalsa20XOR(&buffer, key: key, nonce: nonce, skip: 32)
        return Data(buffer)
    }

    /// Happy's self-describing bundle: `nonce(24) || mac(16) || ciphertext`
    /// (encryptSecretBox / encryptBlob in happy-app).
    public static func sealBundle(_ plaintext: Data, key: Data, random: RandomSource = SystemRandom()) throws -> Data {
        let nonce = random.bytes(nonceLength)
        var out = nonce
        out.append(try seal(plaintext, nonce: nonce, key: key))
        return out
    }

    public static func openBundle(_ bundle: Data, key: Data) -> Data? {
        guard bundle.count >= nonceLength + macLength else { return nil }
        let nonce = Data(bundle.prefix(nonceLength))
        return open(Data(bundle.dropFirst(nonceLength)), nonce: nonce, key: key)
    }

    private static func validate(key: Data, nonce: Data) throws {
        guard key.count == keyLength else {
            throw CryptoError.invalidKeyLength(expected: keyLength, actual: key.count)
        }
        guard nonce.count == nonceLength else {
            throw CryptoError.invalidNonceLength(expected: nonceLength, actual: nonce.count)
        }
    }
}

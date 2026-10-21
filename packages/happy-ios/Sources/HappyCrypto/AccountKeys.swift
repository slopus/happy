import Foundation

/// Every key the app derives from the 32-byte account secret, mirroring
/// `Encryption.create` in packages/happy-app/sources/sync/encryption/encryption.ts.
///
/// Only the current protocol is supported: records carry their own data
/// encryption key, wrapped to the content key pair. Records without one
/// (the legacy "encrypt with the master secret" path) are not opened.
public struct AccountKeys: Sendable {
    /// The account master secret. Never leaves the device except when the
    /// user links another of their own devices.
    public let secret: Data
    /// Opens per-record data encryption keys. Its public half is what a
    /// terminal receives when it is connected (auth v2).
    public let contentKeyPair: BoxKeyPair
    /// Proves account ownership to the server (`POST /v1/auth`).
    public let signingKeyPair: SigningKeyPair
    /// Stable, non-reversible analytics id (first 16 hex chars).
    public let anonID: String

    public init(secret: Data) throws {
        guard secret.count == 32 else {
            throw CryptoError.invalidKeyLength(expected: 32, actual: secret.count)
        }
        self.secret = secret
        let contentSeed = KeyTree.deriveKey(master: secret, usage: "Happy EnCoder", path: ["content"])
        contentKeyPair = try BoxKeyPair(seed: contentSeed)
        signingKeyPair = try SigningKeyPair(seed: secret)
        anonID = String(KeyTree.deriveKey(master: secret, usage: "Happy Coder", path: ["analytics", "id"]).hexString.prefix(16))
    }

    // MARK: Data encryption keys

    /// Opens a server-stored data encryption key: `0x00 || box bundle`
    /// sealed to the content public key. Returns nil instead of throwing so
    /// one foreign or malformed key never aborts a whole sync batch.
    public func unwrapDataKey(base64 wrapped: String) -> Data? {
        guard let bytes = Base64.decode(wrapped) else { return nil }
        return unwrapDataKey(bytes)
    }

    public func unwrapDataKey(_ wrapped: Data) -> Data? {
        guard wrapped.first == 0 else { return nil }
        guard let key = Box.openAnonymous(Data(wrapped.dropFirst()), recipientSecretKey: contentKeyPair.secretKey),
              key.count == AESGCMBundle.keyLength
        else { return nil }
        return key
    }

    /// Wraps a fresh data encryption key for upload (new session, machine).
    public func wrapDataKey(_ key: Data, random: RandomSource = SystemRandom()) throws -> Data {
        var out = Data([0])
        out.append(try Box.sealAnonymous(key, recipientPublicKey: contentKeyPair.publicKey, random: random))
        return out
    }

    // MARK: Pairing responses

    /// Answer to a terminal's `happy://terminal?` request, auth v2: the
    /// terminal receives the content public key, never the master secret.
    public func terminalApproval(terminalPublicKey: Data, random: RandomSource = SystemRandom()) throws -> Data {
        var payload = Data([0])
        payload.append(contentKeyPair.publicKey)
        return try Box.sealAnonymous(payload, recipientPublicKey: terminalPublicKey, random: random)
    }

    /// Answer to another device's `happy:///account?` request. This hands
    /// over the master secret, so it is only offered for the user's own
    /// devices from an explicit "Link New Device" action.
    public func accountLinkApproval(devicePublicKey: Data, random: RandomSource = SystemRandom()) throws -> Data {
        try Box.sealAnonymous(secret, recipientPublicKey: devicePublicKey, random: random)
    }
}

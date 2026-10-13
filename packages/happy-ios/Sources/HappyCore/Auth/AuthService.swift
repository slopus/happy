import Foundation
import HappyCrypto
import HappyWire

/// Signing in without an existing session: create an account, restore one
/// from its secret key, or receive one from another device by QR.
/// Mirrors packages/happy-app/sources/auth/.
public struct AuthService: Sendable {
    private let api: HappyAPI
    private let random: RandomSource

    public init(api: HappyAPI, random: RandomSource = SystemRandom()) {
        self.api = api
        self.random = random
    }

    /// A new account is just a new random secret the server has not seen.
    public func createAccount() async throws -> Credentials {
        try await signIn(secret: random.bytes(32))
    }

    /// Restores from the backup key (`XXXXX-XXXXX-...`) or the raw
    /// base64url secret.
    public func restore(secretKey: String) async throws -> Credentials {
        try await signIn(secret: SecretKeyBackup.normalize(secretKey))
    }

    /// `POST /v1/auth`: sign a random challenge with the account's Ed25519
    /// key. The server creates the account on first sight of the key.
    public func signIn(secret: Data) async throws -> Credentials {
        let keys = try AccountKeys(secret: secret)
        let challenge = random.bytes(32)
        let signature = try keys.signingKeyPair.sign(challenge)
        let response = try await api.authenticate(AuthRequest(
            publicKey: keys.signingKeyPair.publicKey.base64EncodedString(),
            challenge: challenge.base64EncodedString(),
            signature: signature.base64EncodedString()
        ))
        return Credentials(token: response.token, secret: secret)
    }

    /// Starts a QR login (this device receives the account).
    public func startQRLogin() throws -> QRLogin {
        try QRLogin(api: api, keyPair: BoxKeyPair(seed: random.bytes(32)))
    }
}

public enum QRLoginError: Error, Equatable, Sendable {
    /// The approving device's answer could not be opened with our key.
    case undecryptableResponse
}

/// This device shows `happy:///account?<key>`; the user's other, signed-in
/// device scans it and seals the account secret to our key.
///
/// The key pair lives only as long as this object, and is derived the way
/// happy-app's `generateAuthKeyPair` does (crypto_box_seed_keypair).
public struct QRLogin: Sendable {
    public let link: PairingLink
    private let api: HappyAPI
    private let keyPair: BoxKeyPair

    init(api: HappyAPI, keyPair: BoxKeyPair) {
        self.api = api
        self.keyPair = keyPair
        self.link = .account(publicKey: keyPair.publicKey)
    }

    /// Registers the request. Call before showing the QR code.
    public func register() async throws {
        _ = try await api.requestAccountAuth(publicKey: keyPair.publicKey)
    }

    /// Polls until the other device answers. Cancel the calling task to stop.
    public func waitForApproval(pollInterval: Duration = .seconds(1)) async throws -> Credentials {
        while true {
            try Task.checkCancellation()
            if let credentials = try await poll() {
                return credentials
            }
            try await Task.sleep(for: pollInterval)
        }
    }

    /// One poll. Nil while the request is still pending.
    public func poll() async throws -> Credentials? {
        switch try await api.requestAccountAuth(publicKey: keyPair.publicKey) {
        case .requested:
            return nil
        case .authorized(let token, let response):
            guard let bundle = Base64.decode(response),
                  let secret = Box.openAnonymous(bundle, recipientSecretKey: keyPair.secretKey),
                  secret.count == 32
            else { throw QRLoginError.undecryptableResponse }
            return Credentials(token: token, secret: secret)
        }
    }
}

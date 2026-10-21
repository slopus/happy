import Foundation
import HappyCrypto
import HappyWire

public struct DirectDeviceCredentials: Codable, Equatable, Sendable {
    public let address: String
    public let port: UInt16
    public let deviceID: String
    public let deviceToken: String
}

/// An unfinished handshake owns its tunnel and secrets, and stores nothing.
/// Only a valid daemon MAC produces credentials for the account owner.
public actor DirectPairingService {
    private static let route = "/v0/mobile-connector/handshake"
    private let link: DirectPairingLink
    private let transport: any DirectTransport
    private var handshakeID: String?
    private var secrets: DirectPairingCrypto.Secrets?
    private var expiresAt: Date
    private var cancelled = false
    private let suppliedCrypto: DirectPairingCrypto?

    public init(link: DirectPairingLink, transport: (any DirectTransport)? = nil, crypto: DirectPairingCrypto? = nil) {
        self.link = link
        self.transport = transport ?? TailcatHTTPTransport(address: link.address, port: link.port)
        expiresAt = link.expiresAt
        suppliedCrypto = crypto
    }

    public func start(deviceName: String) async throws -> [String] {
        try checkActive()
        let crypto = try suppliedCrypto ?? DirectPairingCrypto()
        let printableName = String(String.UnicodeScalarView(deviceName.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }))
        let safeName = String(printableName.prefix(128))
        let body = try JSONSerialization.data(withJSONObject: ["commitment": CanonicalBase64URL.encode(crypto.commitment), "device": ["name": safeName.isEmpty ? "iPhone" : safeName, "platform": "ios"]])
        let response = try await transport.request(Self.route, credential: CanonicalBase64URL.encode(link.token), method: "POST", body: body)
        struct Started: Decodable { let handshakeId: String; let publicKey: String; let nonce: String; let expiresAt: Double }
        let start: Started = try decode(response)
        guard CanonicalBase64URL.decode(start.handshakeId)?.count == 32,
              let key = CanonicalBase64URL.decode(start.publicKey), key.count == 32,
              let nonce = CanonicalBase64URL.decode(start.nonce), nonce.count == 32,
              start.expiresAt.isFinite else { throw DirectPairingError.invalidResponse }
        // Record the credential even if cancellation arrived during start, so
        // cleanup can reject a handshake whose one-time token was consumed.
        handshakeID = start.handshakeId
        expiresAt = min(link.expiresAt, Date(timeIntervalSince1970: start.expiresAt / 1000))
        try checkActive()
        let derived = try crypto.derive(daemonPublicKey: key, daemonNonce: nonce, token: link.token, address: link.address, port: link.port)
        let reveal = try JSONSerialization.data(withJSONObject: ["publicKey": CanonicalBase64URL.encode(crypto.publicKey), "nonce": CanonicalBase64URL.encode(crypto.nonce)])
        let status: Status = try decode(try await transport.request(Self.route + "/reveal", credential: start.handshakeId, method: "POST", body: reveal))
        try checkActive(); try status.check()
        guard status.status == "verifying" else { throw DirectPairingError.invalidResponse }
        secrets = derived
        return derived.emoji
    }

    public func confirm() async throws -> DirectDeviceCredentials {
        try checkActive()
        guard let handshakeID, let secrets else { throw DirectPairingError.invalidResponse }
        let body = try JSONSerialization.data(withJSONObject: ["mac": CanonicalBase64URL.encode(secrets.mac(role: "mobile"))])
        var status: Status = try decode(try await transport.request(Self.route + "/confirm", credential: handshakeID, method: "POST", body: body))
        while true {
            try checkActive(); try status.check()
            if status.status == "completed" {
                guard let id = status.deviceId, !id.isEmpty, id.count <= 128,
                      let mac = status.mac.flatMap(CanonicalBase64URL.decode), secrets.verifyDaemon(mac) else { throw DirectPairingError.invalidProof }
                self.secrets = nil
                await transport.close()
                return DirectDeviceCredentials(address: link.address, port: link.port, deviceID: id, deviceToken: CanonicalBase64URL.encode(secrets.deviceToken))
            }
            status = try decode(try await transport.request(Self.route + "?wait=25", credential: handshakeID))
        }
    }

    public func cancel() async {
        guard !cancelled else { return }
        cancelled = true; secrets = nil
        // Reject best-effort without holding UI dismissal for a dead tunnel.
        let transport = transport; let id = handshakeID
        await withTaskGroup(of: Void.self) { group in
            if let id { group.addTask { _ = try? await transport.request(Self.route + "/reject", credential: id, method: "POST") } }
            group.addTask { try? await Task.sleep(for: .seconds(2)) }
            await group.next(); group.cancelAll()
        }
        await transport.close()
    }

    private func checkActive() throws {
        try Task.checkCancellation()
        guard !cancelled else { throw CancellationError() }
        guard expiresAt > Date() else { throw DirectPairingError.expired }
    }

    private func decode<T: Decodable>(_ response: DirectHTTPResponse) throws -> T {
        if response.status == 401 { throw DirectPairingError.expired }
        guard response.status == 200 else { throw DirectPairingError.invalidResponse }
        do { return try JSONDecoder().decode(T.self, from: response.body) }
        catch { throw DirectPairingError.invalidResponse }
    }

    private struct Status: Decodable {
        let status: String; let deviceId: String?; let mac: String?
        func check() throws {
            switch status {
            case "verifying", "completed": break
            case "expired": throw DirectPairingError.expired
            case "rejected": throw DirectPairingError.rejected
            default: throw DirectPairingError.invalidResponse
            }
        }
    }
}
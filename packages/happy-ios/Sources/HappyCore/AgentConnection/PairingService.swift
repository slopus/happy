import Foundation
import HappyCrypto
import HappyWire

public struct AgentConnectionCredentials: Codable, Equatable, Sendable {
    public let address: String
    public let port: UInt16
    public let deviceID: String
    public let deviceToken: String
}

/// An unfinished handshake owns its tunnel and secrets, and stores nothing.
/// Only a valid daemon MAC produces credentials for the account owner.
public actor PairingService {
    private static let route = "/v0/mobile-connector/handshake"
    private let link: PairingLink
    private let transport: any AgentTransport
    private var handshakeID: String?
    private var secrets: PairingCrypto.Secrets?
    private var expiresAt: Date
    private var cancelled = false
    private let suppliedCrypto: PairingCrypto?

    public init(link: PairingLink, transport: (any AgentTransport)? = nil, crypto: PairingCrypto? = nil) {
        self.link = link
        self.transport = transport ?? TailcatHTTPTransport(address: link.address, port: link.port)
        expiresAt = link.expiresAt
        suppliedCrypto = crypto
    }

    public func start(deviceName: String) async throws -> [String] {
        try checkActive()
        let crypto = try suppliedCrypto ?? PairingCrypto()
        let printableName = String(String.UnicodeScalarView(deviceName.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }))
        let safeName = String(printableName.prefix(128))
        let body = try JSONSerialization.data(withJSONObject: ["commitment": CanonicalBase64URL.encode(crypto.commitment), "device": ["name": safeName.isEmpty ? "iPhone" : safeName, "platform": "ios"]])
        let response = try await transport.request(Self.route, credential: CanonicalBase64URL.encode(link.token), method: "POST", body: body)
        struct Started: Decodable { let handshakeId: String; let publicKey: String; let nonce: String; let expiresAt: Double }
        let start: Started = try decode(response)
        guard CanonicalBase64URL.decode(start.handshakeId)?.count == 32,
              let key = CanonicalBase64URL.decode(start.publicKey), key.count == 32,
              let nonce = CanonicalBase64URL.decode(start.nonce), nonce.count == 32,
              start.expiresAt.isFinite else { throw PairingError.invalidResponse }
        // Record the credential even if cancellation arrived during start, so
        // cleanup can reject a handshake whose one-time token was consumed.
        handshakeID = start.handshakeId
        expiresAt = min(link.expiresAt, Date(timeIntervalSince1970: start.expiresAt / 1000))
        try checkActive()
        let derived = try crypto.derive(daemonPublicKey: key, daemonNonce: nonce, token: link.token, address: link.address, port: link.port)
        let reveal = try JSONSerialization.data(withJSONObject: ["publicKey": CanonicalBase64URL.encode(crypto.publicKey), "nonce": CanonicalBase64URL.encode(crypto.nonce)])
        let status: Status = try decode(try await transport.request(Self.route + "/reveal", credential: start.handshakeId, method: "POST", body: reveal))
        try checkActive(); try status.check()
        guard status.status == "verifying" else { throw PairingError.invalidResponse }
        secrets = derived
        return derived.emoji
    }

    public func confirm() async throws -> AgentConnectionCredentials {
        try checkActive()
        guard let handshakeID, let secrets else { throw PairingError.invalidResponse }
        let body = try JSONSerialization.data(withJSONObject: ["mac": CanonicalBase64URL.encode(secrets.mac(role: "mobile"))])
        var status: Status = try decode(try await transport.request(Self.route + "/confirm", credential: handshakeID, method: "POST", body: body))
        while true {
            try checkActive(); try status.check()
            if status.status == "completed" {
                guard let id = status.deviceId, !id.isEmpty, id.count <= 128,
                      let mac = status.mac.flatMap(CanonicalBase64URL.decode), secrets.verifyDaemon(mac) else { throw PairingError.invalidProof }
                self.secrets = nil
                await transport.close()
                return AgentConnectionCredentials(address: link.address, port: link.port, deviceID: id, deviceToken: CanonicalBase64URL.encode(secrets.deviceToken))
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
        guard expiresAt > Date() else { throw PairingError.expired }
    }

    private func decode<T: Decodable>(_ response: HTTP1Response) throws -> T {
        if response.status == 401 { throw PairingError.expired }
        guard response.status == 200 else { throw PairingError.invalidResponse }
        do { return try JSONDecoder().decode(T.self, from: response.body) }
        catch { throw PairingError.invalidResponse }
    }

    private struct Status: Decodable {
        let status: String; let deviceId: String?; let mac: String?
        func check() throws {
            switch status {
            case "verifying", "completed": break
            case "expired": throw PairingError.expired
            case "rejected": throw PairingError.rejected
            default: throw PairingError.invalidResponse
            }
        }
    }
}
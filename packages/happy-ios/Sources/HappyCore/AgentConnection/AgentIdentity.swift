import Foundation
import HappyWire

enum AgentIdentity {
    /// A serialized config+image read. ETag, not ThumbHash, identifies bytes.
    static func refresh(_ account: AgentConnection, transport: any AgentTransport, token: String) async throws -> AgentConnection {
        func check(_ response: HTTP1Response) throws {
            if response.status == 401 || response.status == 403 { throw PairingError.revoked }
            guard response.status == 200 else { throw PairingError.unavailable }
        }
        let health = try await transport.request("/v0/health", credential: token)
        try check(health)
        struct Health: Decodable { struct Version: Decodable { let `protocol`: Int }; let ready: Bool; let version: Version }
        let state = try JSONDecoder().decode(Health.self, from: health.body)
        guard state.version.protocol >= 27 else { throw PairingError.updateRequired }
        guard state.ready else { throw PairingError.unavailable }
        let response = try await transport.request("/v0/config", credential: token)
        try check(response)
        struct Configuration: Decodable {
            struct Config: Decodable {
                struct Node: Decodable { struct Avatar: Decodable { let thumbhash: String }; let name: String; let avatar: Avatar? }
                let node: Node?
            }
            let config: Config
        }
        let config = try JSONDecoder().decode(Configuration.self, from: response.body)
        var updated = account
        if let node = config.config.node {
            guard !node.name.isEmpty, node.name.count <= 128, !node.name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw PairingError.invalidResponse }
            updated.name = AgentName.friendly(node.name)
            updated.thumbhash = node.avatar?.thumbhash
            if node.avatar == nil { updated.avatar = nil; updated.avatarETag = nil }
            else {
                let image = try await transport.request("/v0/node/avatar", credential: token, headers: account.avatarETag.map { ["If-None-Match": $0] } ?? [:])
                if image.status == 401 || image.status == 403 { throw PairingError.revoked }
                switch image.status {
                case 200:
                    guard image.body.count <= 8 * 1024 * 1024, image.headers["content-type"]?.lowercased().hasPrefix("image/") == true else { throw PairingError.invalidResponse }
                    updated.avatar = image.body; updated.avatarETag = image.headers["etag"]
                case 304: break
                case 404: updated.avatar = nil; updated.avatarETag = nil
                default: throw PairingError.unavailable
                }
            }
        }
        updated.status = .connected
        return updated
    }
}
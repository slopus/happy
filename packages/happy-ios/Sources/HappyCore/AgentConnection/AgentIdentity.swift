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
        struct Health: Decodable { struct Version: Decodable { let `protocol`: Int }; let ready: Bool; let version: Version; let instanceId: String? }
        let state = try JSONDecoder().decode(Health.self, from: health.body)
        guard state.version.protocol >= 27 else { throw PairingError.updateRequired }
        guard state.ready else { throw PairingError.unavailable }
        let response = try await transport.request("/v0/config", credential: token)
        var updated = account
        updated.instanceId = state.instanceId.flatMap { HappyLink.isInstanceID($0) ? $0 : nil }
        // A member with no profile yet is connected, and asked their name;
        // the server's own name and picture are read once they have one.
        if response.status == 403, Self.profileRequired(response) {
            updated.status = .connected
            return updated
        }
        try check(response)
        struct Configuration: Decodable {
            struct Config: Decodable {
                struct Node: Decodable { struct Avatar: Decodable { let thumbhash: String }; let name: String; let avatar: Avatar? }
                let node: Node?
            }
            let config: Config
        }
        let config = try JSONDecoder().decode(Configuration.self, from: response.body)
        if let node = config.config.node {
            try take(name: node.name, thumbhash: node.avatar?.thumbhash, into: &updated)
            if node.avatar != nil { updated = try await avatar(updated, transport: transport, token: token) }
        }
        updated.status = .connected
        return updated
    }

    /// A bootstrap's `health` and `config.node` (`SyncEngine.Computer`)
    /// taken in as `refresh` reads them, for the account whose engine
    /// runs: whether its picture's bytes must be read again. Neither part
    /// there keeps what was known of it.
    static func take(_ computer: SyncEngine.Computer, into account: AgentConnection) throws -> (account: AgentConnection, readsAvatar: Bool) {
        var updated = account
        if let health = computer.health {
            guard (health["version"]?["protocol"]?.numberValue ?? 0) >= 27 else { throw PairingError.updateRequired }
            updated.instanceId = health["instanceId"]?.stringValue.flatMap { HappyLink.isInstanceID($0) ? $0 : nil }
        }
        // Null is a computer outside a team; a bootstrap without it says nothing.
        if let owner = computer.owner { updated.member = owner.stringValue.flatMap { $0.isEmpty ? nil : $0 } }
        var readsAvatar = false
        if let node = computer.node {
            guard let name = node["name"]?.stringValue else { throw PairingError.invalidResponse }
            let thumbhash = node["avatar"]?["thumbhash"]?.stringValue
            try take(name: name, thumbhash: thumbhash, into: &updated)
            readsAvatar = thumbhash != nil && (thumbhash != account.thumbhash || account.avatar == nil)
        }
        updated.status = .connected
        return (updated, readsAvatar)
    }

    private static func take(name: String, thumbhash: String?, into account: inout AgentConnection) throws {
        guard !name.isEmpty, name.count <= 128, !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw PairingError.invalidResponse }
        account.name = AgentName.friendly(name)
        account.thumbhash = thumbhash
        if thumbhash == nil { account.avatar = nil; account.avatarETag = nil }
    }

    /// The computer's picture's bytes, on a file client; its ETag says
    /// when they are unchanged.
    static func avatar(_ account: AgentConnection, transport: any AgentTransport, token: String) async throws -> AgentConnection {
        var updated = account
        let image = try await transport.request("/v0/node/avatar", credential: token, headers: account.avatarETag.map { ["If-None-Match": $0] } ?? [:], category: .file)
        if image.status == 401 || image.status == 403 { throw PairingError.revoked }
        switch image.status {
        case 200:
            guard image.body.count <= 8 * 1024 * 1024, image.headers["content-type"]?.lowercased().hasPrefix("image/") == true else { throw PairingError.invalidResponse }
            updated.avatar = image.body; updated.avatarETag = image.headers["etag"]
        case 304: break
        case 404: updated.avatar = nil; updated.avatarETag = nil
        default: throw PairingError.unavailable
        }
        return updated
    }

    /// Happy's `403` `profile_required`: the member has no profile yet.
    static func profileRequired(_ response: HTTP1Response) -> Bool {
        struct Failure: Decodable { let code: String? }
        return SignInRequired.isHappyError(contentType: response.headers["content-type"], body: response.body)
            && (try? JSONDecoder().decode(Failure.self, from: response.body))?.code == "profile_required"
    }
}

import Foundation
import HappyWire

extension HappyAPI {
    /// Server chooses the active ref. Credentials accompany only our own
    /// origin; redirects, credentials in URLs and oversized bodies fail closed.
    func downloadAvatar(_ source: AvatarImageSource) async throws -> Data {
        let collection = source.scope == .session ? "sessions" : "projects"
        let grant = try makeRequest("POST", "/v1/\(collection)/\(Self.escape(source.id))/avatar/request-download")
        let response = try await transport.sendImage(grant, limit: 16 * 1024)
        guard (200..<300).contains(response.status), let value = try? JSONValue.decode(response.body),
              value["ref"]?.stringValue == source.descriptor.ref,
              let raw = value["downloadUrl"]?.stringValue,
              var parts = URLComponents(string: raw),
              ["http", "https"].contains(parts.scheme ?? ""), parts.user == nil, parts.password == nil else {
            throw APIError.decoding("Avatar grant unavailable")
        }
        if ["localhost", "127.0.0.1", "::1", "[::1]"].contains(parts.host ?? "") {
            parts.scheme = serverURL.scheme
            parts.host = serverURL.host
            parts.port = serverURL.port
        }
        guard let url = parts.url, url.host != nil else { throw APIError.decoding("Invalid avatar download") }
        func port(_ url: URL) -> Int? { url.port ?? (url.scheme == "https" ? 443 : url.scheme == "http" ? 80 : nil) }
        var headers: [String: String] = [:]
        if url.scheme == serverURL.scheme, url.host == serverURL.host, port(url) == port(serverURL), let token {
            headers = ["Authorization": "Bearer \(token)", "X-Happy-Client": clientID]
        }
        try Task.checkCancellation()
        let blob = try await transport.sendImage(HTTPRequest(method: "GET", url: url, headers: headers), limit: AccountPictures.maxBytes)
        guard (200..<300).contains(blob.status) else { throw APIError.decoding("Avatar download unavailable") }
        return blob.body
    }
}

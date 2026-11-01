import Foundation
import HappyWire

// The artifact catalog's pages, the Surface catalog, a todo list's routes
// and a System Monitor's snapshot (happy-agent API.md, "Artifacts" and
// "Surfaces").
extension AgentClient {
    /// One page of the catalog, newest created first, at most `limit` long.
    public func artifacts(pageCursor: String?, limit: Int) async throws -> JSONValue {
        var query = ["limit=\(limit)"]
        if let pageCursor { query.append("pageCursor=\(Self.escape(pageCursor))") }
        return try await decode(JSONValue.self, "GET", "/v0/artifacts?" + query.joined(separator: "&"))
    }
}

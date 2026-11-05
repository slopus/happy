import Foundation
import HappyWire

/// A page of a paged vault read and where the next one starts.
public struct VaultPage<Item: Sendable>: Sendable {
    public var items: [Item]
    public var next: String?

    public init(items: [Item], next: String?) {
        self.items = items
        self.next = next
    }
}

/// Where a moved entry goes: the vault's root or a folder.
public enum VaultParent: Equatable, Hashable, Sendable {
    case root
    case folder(String)

    public init(_ id: String?) { self = id.map(Self.folder) ?? .root }

    public var id: String? {
        if case .folder(let id) = self { return id }
        return nil
    }
}

/// The vault routes the library uses (happy-agent API.md, "Vault
/// Surfaces"); `AgentClient` is the account's. Folders and files are
/// one kind of entry here, and two kinds of route there: those that
/// address one say which it is.
public protocol VaultRoutes: Sendable {
    func vaultEntries(_ surfaceId: String, parentId: String?, pageCursor: String?) async throws -> VaultPage<VaultEntry>
    func vaultEntry(_ surfaceId: String, _ entryId: String, folder: Bool) async throws -> VaultLocation
    func vaultTrash(_ surfaceId: String, pageCursor: String?) async throws -> VaultPage<VaultTrashItem>
    func vaultVersions(_ surfaceId: String, _ fileId: String, pageCursor: String?) async throws -> VaultPage<VaultVersion>
    func vaultVersion(_ surfaceId: String, _ fileId: String, number: Int?) async throws -> VaultVersion
    func vaultActivity(_ surfaceId: String, _ entryId: String, folder: Bool, pageCursor: String?) async throws -> VaultPage<VaultActivity>
    /// A folder, or a file from an upload (an app when `name` ends in `.artifact`).
    func createVaultEntry(_ surfaceId: String, id: String, parentId: String?, name: String, folder: Bool, uploadId: String?, mutationId: String) async throws -> VaultEntry
    func updateVaultEntry(_ surfaceId: String, _ entryId: String, folder: Bool, name: String?, parent: VaultParent?, ifMatch: String, mutationId: String) async throws -> VaultEntry
    func deleteVaultEntry(_ surfaceId: String, _ entryId: String, folder: Bool, ifMatch: String, mutationId: String) async throws -> VaultEntry
    func restoreVaultEntry(_ surfaceId: String, _ entryId: String, folder: Bool, parent: VaultParent?, name: String?, ifMatch: String, mutationId: String) async throws -> VaultEntry
    /// `operationId` names the person's one action: asked again, the computer
    /// answers as it did the first time instead of making another version.
    func createVaultVersion(_ surfaceId: String, _ fileId: String, uploadId: String?, fromVersion: Int?, operationId: String, ifMatch: String, mutationId: String) async throws -> (entry: VaultEntry, version: VaultVersion?)
    func pinVaultVersion(_ surfaceId: String, _ fileId: String, number: Int, pinned: Bool, mutationId: String) async throws -> VaultVersion
    func vaultSettings(_ surfaceId: String) async throws -> VaultSettings
    func updateVaultSettings(_ surfaceId: String, retention: VaultRetention, mutationId: String) async throws -> VaultSettings
    func createVaultUpload(size: Int) async throws -> VaultUpload
    func vaultUpload(_ uploadId: String) async throws -> VaultUpload
    /// Bytes `start..<start + bytes.count` of the upload; `sent` hears them go.
    func appendVaultUpload(_ uploadId: String, bytes: Data, start: Int, total: Int, sent: @escaping @Sendable (Int) -> Void) async throws -> VaultUpload
    func discardVaultUpload(_ uploadId: String) async throws
    func teamUsers(_ ids: [String]) async throws -> [TeamUser]
}

extension AgentClient: VaultRoutes {
    static func vaultPath(_ surfaceId: String, _ rest: String = "") -> String {
        "/v0/surfaces/vault/\(escape(surfaceId))" + rest
    }

    /// `/folders/:id` or `/files/:id`, and what its answers name the item.
    private static func itemPath(_ surfaceId: String, _ id: String, folder: Bool, _ rest: String = "") -> String {
        vaultPath(surfaceId, "/\(folder ? "folders" : "files")/\(escape(id))" + rest)
    }

    private static func filePath(_ surfaceId: String, _ fileId: String, _ rest: String = "") -> String {
        itemPath(surfaceId, fileId, folder: false, rest)
    }

    private static func key(folder: Bool) -> String { folder ? "folder" : "file" }

    private static func query(_ items: [(String, String?)]) -> String {
        let pairs = items.compactMap { key, value in value.map { "\(key)=\(escape($0))" } }
        return pairs.isEmpty ? "" : "?" + pairs.joined(separator: "&")
    }

    private func json(_ method: String, _ path: String, body: JSONValue? = nil, headers: [String: String] = [:]) async throws -> JSONValue {
        let response = try await send(method, path, json: body, headers: headers)
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: response.body) else { throw AgentClientError.invalidResponse }
        return json
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ json: JSONValue?) throws -> T {
        guard let json, let value = try? JSONDecoder().decode(T.self, from: JSONEncoder().encode(json)) else { throw AgentClientError.invalidResponse }
        return value
    }

    /// The items of a list a newer daemon may add kinds to: those this app
    /// can't read are left out.
    private static func list<T: Decodable>(_ type: T.Type, _ json: JSONValue?) -> [T] {
        (json?.arrayValue ?? []).compactMap { try? decode(T.self, $0) }
    }

    private static func body(_ fields: [String: JSONValue?]) -> JSONValue {
        .object(fields.compactMapValues { $0 })
    }

    public func vaultEntries(_ surfaceId: String, parentId: String?, pageCursor: String?) async throws -> VaultPage<VaultEntry> {
        let answer = try await json("GET", Self.vaultPath(surfaceId, "/items") + Self.query([("parentId", parentId), ("limit", "500"), ("pageCursor", pageCursor)]))
        return VaultPage(items: Self.list(VaultEntry.self, answer["items"]), next: answer["nextPageCursor"]?.stringValue)
    }

    public func vaultEntry(_ surfaceId: String, _ entryId: String, folder: Bool) async throws -> VaultLocation {
        let answer = try await json("GET", Self.itemPath(surfaceId, entryId, folder: folder))
        return VaultLocation(
            entry: try Self.decode(VaultEntry.self, answer[Self.key(folder: folder)]),
            path: answer["path"]?.stringValue ?? "",
            ancestors: Self.list(VaultLocation.Ancestor.self, answer["ancestors"]),
            inTrash: answer["inTrash"]?.boolValue ?? false
        )
    }

    public func vaultTrash(_ surfaceId: String, pageCursor: String?) async throws -> VaultPage<VaultTrashItem> {
        let answer = try await json("GET", Self.vaultPath(surfaceId, "/trash") + Self.query([("limit", "500"), ("pageCursor", pageCursor)]))
        return VaultPage(items: Self.list(VaultTrashItem.self, answer["items"]), next: answer["nextPageCursor"]?.stringValue)
    }

    public func vaultVersions(_ surfaceId: String, _ fileId: String, pageCursor: String?) async throws -> VaultPage<VaultVersion> {
        let answer = try await json("GET", Self.filePath(surfaceId, fileId, "/versions") + Self.query([("limit", "200"), ("pageCursor", pageCursor)]))
        return VaultPage(items: Self.list(VaultVersion.self, answer["versions"]), next: answer["nextPageCursor"]?.stringValue)
    }

    public func vaultVersion(_ surfaceId: String, _ fileId: String, number: Int?) async throws -> VaultVersion {
        let answer = try await json("GET", Self.filePath(surfaceId, fileId, "/versions/\(number.map(String.init) ?? "latest")"))
        return try Self.decode(VaultVersion.self, answer["version"])
    }

    public func vaultActivity(_ surfaceId: String, _ entryId: String, folder: Bool, pageCursor: String?) async throws -> VaultPage<VaultActivity> {
        let answer = try await json("GET", Self.itemPath(surfaceId, entryId, folder: folder, "/activity") + Self.query([("limit", "200"), ("pageCursor", pageCursor)]))
        return VaultPage(items: Self.list(VaultActivity.self, answer["activity"]), next: answer["nextPageCursor"]?.stringValue)
    }

    public func createVaultEntry(_ surfaceId: String, id: String, parentId: String?, name: String, folder: Bool, uploadId: String?, mutationId: String) async throws -> VaultEntry {
        let body = Self.body([
            "id": .string(id), "parentId": parentId.map(JSONValue.string) ?? .null, "name": .string(name),
            "uploadId": folder ? nil : uploadId.map(JSONValue.string), "mutationId": .string(mutationId),
        ])
        let answer = try await json("POST", Self.vaultPath(surfaceId, folder ? "/folders" : "/files"), body: body)
        return try Self.decode(VaultEntry.self, answer[Self.key(folder: folder)])
    }

    public func updateVaultEntry(_ surfaceId: String, _ entryId: String, folder: Bool, name: String?, parent: VaultParent?, ifMatch: String, mutationId: String) async throws -> VaultEntry {
        let body = Self.body([
            "name": name.map(JSONValue.string), "parentId": parent.map { $0.id.map(JSONValue.string) ?? .null }, "mutationId": .string(mutationId),
        ])
        let answer = try await json("PATCH", Self.itemPath(surfaceId, entryId, folder: folder), body: body, headers: ["If-Match": ifMatch])
        return try Self.decode(VaultEntry.self, answer[Self.key(folder: folder)])
    }

    public func deleteVaultEntry(_ surfaceId: String, _ entryId: String, folder: Bool, ifMatch: String, mutationId: String) async throws -> VaultEntry {
        let answer = try await json("POST", Self.itemPath(surfaceId, entryId, folder: folder, "/delete"), body: .object(["mutationId": .string(mutationId)]), headers: ["If-Match": ifMatch])
        return try Self.decode(VaultEntry.self, answer[Self.key(folder: folder)])
    }

    public func restoreVaultEntry(_ surfaceId: String, _ entryId: String, folder: Bool, parent: VaultParent?, name: String?, ifMatch: String, mutationId: String) async throws -> VaultEntry {
        let body = Self.body([
            "parentId": parent.map { $0.id.map(JSONValue.string) ?? .null }, "name": name.map(JSONValue.string), "mutationId": .string(mutationId),
        ])
        let answer = try await json("POST", Self.itemPath(surfaceId, entryId, folder: folder, "/restore"), body: body, headers: ["If-Match": ifMatch])
        return try Self.decode(VaultEntry.self, answer[Self.key(folder: folder)])
    }

    public func createVaultVersion(_ surfaceId: String, _ fileId: String, uploadId: String?, fromVersion: Int?, operationId: String, ifMatch: String, mutationId: String) async throws -> (entry: VaultEntry, version: VaultVersion?) {
        let body = Self.body([
            "uploadId": uploadId.map(JSONValue.string), "fromVersion": fromVersion.map { .number(Double($0)) },
            "operationId": .string(operationId), "mutationId": .string(mutationId),
        ])
        let answer = try await json("POST", Self.filePath(surfaceId, fileId, "/versions"), body: body, headers: ["If-Match": ifMatch])
        let version: VaultVersion? = answer["version"] == .null || answer["version"] == nil ? nil : try Self.decode(VaultVersion.self, answer["version"])
        return (try Self.decode(VaultEntry.self, answer["file"]), version)
    }

    public func pinVaultVersion(_ surfaceId: String, _ fileId: String, number: Int, pinned: Bool, mutationId: String) async throws -> VaultVersion {
        let path = Self.filePath(surfaceId, fileId, "/versions/\(number)/\(pinned ? "pin" : "unpin")")
        return try Self.decode(VaultVersion.self, try await json("POST", path, body: .object(["mutationId": .string(mutationId)]))["version"])
    }

    public func vaultSettings(_ surfaceId: String) async throws -> VaultSettings {
        try Self.decode(VaultSettings.self, try await json("GET", Self.vaultPath(surfaceId, "/settings"))["settings"])
    }

    public func updateVaultSettings(_ surfaceId: String, retention: VaultRetention, mutationId: String) async throws -> VaultSettings {
        let policy = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(retention))
        let answer = try await json("PATCH", Self.vaultPath(surfaceId, "/settings"), body: .object(["retention": policy, "mutationId": .string(mutationId)]))
        return try Self.decode(VaultSettings.self, answer["settings"])
    }

    public func createVaultUpload(size: Int) async throws -> VaultUpload {
        try Self.decode(VaultUpload.self, try await json("POST", "/v0/vault-uploads", body: .object(["size": .number(Double(size))]))["upload"])
    }

    public func vaultUpload(_ uploadId: String) async throws -> VaultUpload {
        try Self.decode(VaultUpload.self, try await json("GET", "/v0/vault-uploads/\(Self.escape(uploadId))")["upload"])
    }

    public func appendVaultUpload(_ uploadId: String, bytes: Data, start: Int, total: Int, sent: @escaping @Sendable (Int) -> Void) async throws -> VaultUpload {
        let headers = bytes.isEmpty ? [:] : ["Content-Range": "bytes \(start)-\(start + bytes.count - 1)/\(total)"]
        let response = try await send("PUT", "/v0/vault-uploads/\(Self.escape(uploadId))", raw: bytes, headers: headers, category: .file, sent: sent)
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: response.body) else { throw AgentClientError.invalidResponse }
        return try Self.decode(VaultUpload.self, json["upload"])
    }

    public func discardVaultUpload(_ uploadId: String) async throws {
        _ = try await send("DELETE", "/v0/vault-uploads/\(Self.escape(uploadId))")
    }

    // MARK: Content

    /// A file version's bytes, whole or one range (`latest` for nil).
    public func vaultContent(_ surfaceId: String, _ entryId: String, version: Int?, range: String? = nil) async throws -> HTTP1Response {
        try await send("GET", Self.vaultContentPath(surfaceId, entryId, version: version), headers: range.map { ["Range": $0] } ?? [:], category: .file)
    }

    /// One file of an artifact version; `path` is the manifest's, each segment escaped on its own.
    public func vaultArtifactFile(_ surfaceId: String, _ entryId: String, version: Int, path: String, range: String? = nil) async throws -> HTTP1Response {
        let escaped = path.split(separator: "/", omittingEmptySubsequences: false).map { Self.escape(String($0)) }.joined(separator: "/")
        return try await send("GET", Self.filePath(surfaceId, entryId, "/versions/\(version)/artifact/\(escaped)"), headers: range.map { ["Range": $0] } ?? [:], category: .file)
    }

    public static func vaultContentPath(_ surfaceId: String, _ entryId: String, version: Int?) -> String {
        filePath(surfaceId, entryId, "/versions/\(version.map(String.init) ?? "latest")/content")
    }

    /// A folder (nil: the whole vault) as a zip.
    public static func vaultZipPath(_ surfaceId: String, folderId: String?) -> String {
        folderId.map { itemPath(surfaceId, $0, folder: true, "/zip") } ?? vaultPath(surfaceId, "/zip")
    }

    /// An artifact version as its `.artifact` file.
    public static func vaultArtifactZipPath(_ surfaceId: String, _ fileId: String, version: Int) -> String {
        filePath(surfaceId, fileId, "/versions/\(version)/zip")
    }
}

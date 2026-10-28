import Foundation
import HappyWire

/// A refused or failed Happy Agent request.
public enum DirectAgentError: Error, Equatable, Sendable {
    /// The daemon answered with an error status; `code` is its error code.
    case status(Int, code: String?, message: String?)
    /// The device was unpaired.
    case revoked
    /// An answer that could not be read.
    case invalidResponse

    public var status: Int? {
        if case .status(let status, _, _) = self { return status }
        return nil
    }
}

/// The Happy Agent API over one paired device's private tunnel. Every route is
/// one a device token may use (happy-agent `API.md`, "Mobile connector").
public final class DirectAgentClient: Sendable {
    let transport: any DirectTransport
    private let token: String

    init(transport: any DirectTransport, token: String) {
        self.transport = transport
        self.token = token
    }

    public func close() async { await transport.close() }

    // MARK: Requests

    /// `raw` is sent as is, in place of `json` (an upload's bytes).
    func send(_ method: String, _ path: String, json: JSONValue? = nil, raw: Data? = nil, headers: [String: String] = [:]) async throws -> DirectHTTPResponse {
        let body = try raw ?? json.map { try JSONEncoder().encode($0) }
        let response = try await transport.request(method: method, path: path, credential: token, body: body, headers: headers)
        if response.status == 401 { throw DirectAgentError.revoked }
        guard (200..<300).contains(response.status) || response.status == 304 || response.status == 206 else {
            struct Failure: Decodable { let error: String?; let code: String? }
            let failure = try? JSONDecoder().decode(Failure.self, from: response.body)
            throw DirectAgentError.status(response.status, code: failure?.code, message: failure?.error)
        }
        return response
    }

    func decode<T: Decodable>(_ type: T.Type, _ method: String, _ path: String, json: JSONValue? = nil) async throws -> T {
        let response = try await send(method, path, json: json)
        do { return try JSONDecoder().decode(T.self, from: response.body) }
        catch { throw DirectAgentError.invalidResponse }
    }

    // MARK: Health and settings

    public func health() async throws -> AgentWire.Health {
        try await decode(AgentWire.Health.self, "GET", "/v0/health")
    }

    public func artifacts(pageCursor: String? = nil) async throws -> JSONValue {
        let query = pageCursor.map { "?pageCursor=\(Self.escape($0))" } ?? ""
        return try await decode(JSONValue.self, "GET", "/v0/artifacts\(query)")
    }

    public func userSetting(_ key: String) async throws -> JSONValue? {
        struct Response: Decodable { let setting: AgentWire.Setting }
        do { return try await decode(Response.self, "GET", "/v0/user-settings/\(Self.escape(key))").setting.value }
        catch DirectAgentError.status(404, _, _) { return nil }
    }

    public func setUserSetting(_ key: String, _ value: JSONValue) async throws {
        _ = try await send("PUT", "/v0/user-settings/\(Self.escape(key))", json: .object(["value": value]))
    }

    // MARK: Spaces

    public func sidebar(widgets: Bool) async throws -> AgentWire.SidebarResponse {
        try await decode(AgentWire.SidebarResponse.self, "GET", widgets ? "/v0/spaces/sidebar?widgets=true" : "/v0/spaces/sidebar")
    }

    public func applySidebarOperations(mutationId: String, baseVersion: Int, operations: [SpaceSidebarOperation]) async throws -> AgentWire.OperationsResponse {
        let json: JSONValue = .object([
            "mutationId": .string(mutationId), "baseVersion": .number(Double(baseVersion)),
            "operations": .array(operations.map(\.json)),
        ])
        let value = try await decode(JSONValue.self, "POST", "/v0/spaces/sidebar/operations", json: json)
        guard let artifactId = value["artifactId"]?.stringValue, let version = value["version"]?.numberValue,
              let html = value["html"]?.stringValue else { throw DirectAgentError.invalidResponse }
        let operations = try (value["operations"]?.arrayValue ?? []).map {
            guard let operation = SpaceSidebarOperation(json: $0) else { throw DirectAgentError.invalidResponse }
            return operation
        }
        return AgentWire.OperationsResponse(artifactId: artifactId, version: Int(version), html: html, operations: operations)
    }

    public func createStemCell(id: String, mutationId: String, sectionId: String?, identity: StemCellIdentity?) async throws -> AgentWire.CreateStemCellResponse {
        var object: [String: JSONValue] = ["id": .string(id), "mutationId": .string(mutationId), "sectionId": sectionId.map(JSONValue.string) ?? .null]
        if let identity {
            object["taskId"] = .string(identity.taskId)
            object["workspaceId"] = .string(identity.workspaceId)
            object["agentId"] = .string(identity.agentId)
        }
        return try await decode(AgentWire.CreateStemCellResponse.self, "POST", "/v0/spaces/stem-cells", json: .object(object))
    }

    /// Closes new work nobody wrote in; the daemon refuses once it has a message.
    public func removeSpace(_ spaceId: String, mutationId: String) async throws {
        _ = try await send("PATCH", "/v0/spaces/\(Self.escape(spaceId))", json: .object(["removed": .bool(true), "mutationId": .string(mutationId)]))
    }

    public func reportAttention(_ state: String) async throws {
        _ = try await send("POST", "/v0/spaces/attention", json: .object(["state": .string(state)]))
    }

    public func tidy(mutationId: String) async throws {
        _ = try await send("POST", "/v0/spaces/tidy", json: .object(["mutationId": .string(mutationId)]))
    }

    // MARK: Bots and tasks

    /// Every bot as sent, so its embedded agent can be normalized.
    public func bots() async throws -> [JSONValue] {
        try await decode(JSONValue.self, "GET", "/v0/bots")["bots"]?.arrayValue ?? []
    }

    /// The tasks the person joined, as sent.
    public func tasks() async throws -> [JSONValue] {
        try await decode(JSONValue.self, "GET", "/v0/tasks?scope=joined")["tasks"]?.arrayValue ?? []
    }

    public func renameTask(_ taskId: String, name: String) async throws {
        try await rename("/v0/tasks/\(Self.escape(taskId))", key: "task", name: name)
    }

    public func renameBot(_ botId: String, name: String) async throws {
        try await rename("/v0/bots/\(Self.escape(botId))", key: "bot", name: name)
    }

    public func leaveTask(_ taskId: String) async throws {
        _ = try await send("POST", "/v0/tasks/\(Self.escape(taskId))/leave", json: .object(["mutationId": .string(ClientID.make())]))
    }

    public func archiveTask(_ taskId: String) async throws {
        try await archive("/v0/tasks/\(Self.escape(taskId))", key: "task")
    }

    public func archiveBot(_ botId: String) async throws {
        try await archive("/v0/bots/\(Self.escape(botId))", key: "bot")
    }

    /// A subtask's conversation (`POST /v0/agents/:agentId/archive`).
    public func archiveAgent(_ agentId: String) async throws {
        _ = try await send("POST", "/v0/agents/\(Self.escape(agentId))/archive", json: .object(["mutationId": .string(ClientID.make())]))
    }

    /// Archival names the version it archives (`If-Match`).
    private func archive(_ path: String, key: String) async throws {
        guard let version = try await decode(JSONValue.self, "GET", path)[key]?["version"]?.stringValue else { throw DirectAgentError.invalidResponse }
        _ = try await send("POST", path + "/archive", json: .object([:]), headers: ["If-Match": version])
    }

    /// A rename names the version it renames (`If-Match`); one that lost a
    /// race reads the newer version and renames that.
    private func rename(_ path: String, key: String, name: String) async throws {
        let mutationId = ClientID.make()
        for attempt in 0..<2 {
            guard let version = try await decode(JSONValue.self, "GET", path)[key]?["version"]?.stringValue else { throw DirectAgentError.invalidResponse }
            do {
                _ = try await send("PATCH", path, json: .object(["name": .string(name), "mutationId": .string(mutationId)]), headers: ["If-Match": version])
                return
            } catch DirectAgentError.status(409, _, _) where attempt == 0 {
                continue
            }
        }
    }

    // MARK: Surfaces

    /// The joined Surfaces; nil where the daemon serves none (`404`, `501`).
    public func surfaces() async throws -> [AgentWire.Surface]? {
        struct Response: Decodable { let surfaces: [Lossy<AgentWire.Surface>] }
        do { return try await decode(Response.self, "GET", "/v0/surfaces").surfaces.compactMap(\.value) }
        catch DirectAgentError.status(404, _, _), DirectAgentError.status(501, _, _) { return nil }
    }

    /// A todo list's active todos, then its completed ones.
    public func todos(_ surfaceId: String) async throws -> [AgentWire.Todo] {
        struct Response: Decodable { let todos: [Lossy<AgentWire.Todo>] }
        let path = "/v0/surfaces/todo/\(Self.escape(surfaceId))"
        async let active = decode(Response.self, "GET", path)
        async let completed = decode(Response.self, "GET", path + "?scope=completed")
        return try await (active.todos + completed.todos).compactMap(\.value)
    }

    /// A new todo at the top of the list; `id` is the retry key.
    public func addTodo(_ surfaceId: String, id: String, text: String) async throws {
        _ = try await send("POST", "/v0/surfaces/todo/\(Self.escape(surfaceId))", json: .object(["id": .string(id), "text": .string(text), "mutationId": .string(ClientID.make())]))
    }

    /// A document as Markdown, its read-only projection.
    public func document(_ surfaceId: String) async throws -> String {
        try await decode(JSONValue.self, "GET", "/v0/surfaces/document/\(Self.escape(surfaceId))")["document"]?["text"]?.stringValue ?? ""
    }

    // MARK: Conversations

    public func agent(_ agentId: String) async throws -> AgentWire.Agent {
        try await decode(AgentWire.Agent.self, "GET", "/v0/agents/\(Self.escape(agentId))")
    }

    public func bootstrap(_ agentId: String) async throws -> AgentWire.Bootstrap {
        try await decode(AgentWire.Bootstrap.self, "GET", "/v0/agents/\(Self.escape(agentId))/bootstrap")
    }

    /// The same snapshot, read for a conversation's detail.
    public func sessionDetail(_ agentId: String) async throws -> AgentWire.Detail {
        try await decode(AgentWire.Detail.self, "GET", "/v0/agents/\(Self.escape(agentId))/bootstrap")
    }

    /// Newest runs first page, or the runs before `before`, or the messages after `after`.
    public func messages(_ agentId: String, before: String? = nil, after: String? = nil, limit: Int = 50) async throws -> AgentWire.MessagesResponse {
        var query = "limit=\(limit)&omitToolData=true"
        if let before { query += "&before=\(Self.escape(before))" }
        if let after { query += "&after=\(Self.escape(after))" }
        return try await decode(AgentWire.MessagesResponse.self, "GET", "/v0/agents/\(Self.escape(agentId))/messages?\(query)")
    }

    /// The mode a conversation with no last composer mode sends with (`GET /v0/config` `defaults`).
    /// What new work is sent with when nothing was picked: desktop's
    /// default selection, the declared model at its own default effort.
    public func defaultMode() async throws -> AgentWire.Mode {
        try await modelCatalog().defaultMode()
    }

    /// The models every account offers, in the daemon's order.
    public func modelCatalog() async throws -> StemCellModelCatalog {
        try await modelCatalogResponse().catalog
    }

    /// The catalog with the response it was read from, to keep offline.
    public func modelCatalogResponse() async throws -> (catalog: StemCellModelCatalog, text: String) {
        let body = try await send("GET", "/v0/config").body
        guard let catalog = StemCellModelCatalog(response: body) else { throw DirectAgentError.invalidResponse }
        return (catalog, String(decoding: body, as: UTF8.self))
    }

    /// Each account's plan usage, by provider ID.
    public func accountUsage() async throws -> [String: StemCellAccountUsage] {
        StemCellAccountUsage.project(try await decode(JSONValue.self, "GET", "/v0/usage"))
    }

    /// Asks for fresher readings of these accounts; they arrive as
    /// `provider.usage.updated`.
    public func refreshAccountUsage(_ providerIds: [String]) async throws {
        _ = try await send("POST", "/v0/usage/refresh", json: .object(["providerIds": .array(providerIds.map { .string($0) })]))
    }

    /// The mode the agent's last message carried; nil before its first.
    public func agentMode(_ agentId: String) async throws -> AgentWire.Mode? {
        struct Response: Decodable { let mode: AgentWire.Mode? }
        return try await decode(Response.self, "GET", "/v0/agents/\(Self.escape(agentId))/mode").mode
    }

    /// Always steering, as desktop sends: mid-turn it is taken at the next
    /// boundary rather than waiting behind the run; idle, it starts one.
    public func sendMessage(_ agentId: String, id: String, text: String, images: [(mimeType: String, data: Data)], mode: AgentWire.Mode) async throws {
        var object: [String: JSONValue] = [
            "id": .string(id), "text": .string(text), "delivery": .string("steer"),
            "clientMetadata": .object(["composer": .string("mobile")]),
        ]
        if !images.isEmpty {
            object["content"] = .array(images.map {
                .object(["type": .string("image"), "mimeType": .string($0.mimeType), "data": .string($0.data.base64EncodedString())])
            })
        }
        object["mode"] = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(mode))
        _ = try await send("POST", "/v0/agents/\(Self.escape(agentId))/send", json: .object(object))
    }

    /// The composer's draft as the computer keeps it for this person.
    public func draft(_ agentId: String) async throws -> AgentWire.Draft {
        struct Response: Decodable { var draft: AgentWire.Draft }
        return try await decode(Response.self, "GET", "/v0/agents/\(Self.escape(agentId))/draft").draft
    }

    /// Saves the draft, or clears it with nil. A write older than the one
    /// kept is ignored; the answer is what is kept either way.
    public func saveDraft(_ agentId: String, value: AgentWire.DraftValue?, updatedAt: Double, mutationId: String) async throws -> AgentWire.Draft {
        struct Response: Decodable { var draft: AgentWire.Draft }
        let draft: JSONValue = try value.map { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode($0)) } ?? .null
        let body: JSONValue = .object(["draft": draft, "updatedAt": .number(updatedAt), "mutationId": .string(mutationId)])
        return try await decode(Response.self, "PUT", "/v0/agents/\(Self.escape(agentId))/draft", json: body).draft
    }

    public func abort(_ agentId: String) async throws {
        _ = try await send("POST", "/v0/agents/\(Self.escape(agentId))/abort", json: .object([:]))
    }

    public func markRead(_ agentId: String) async throws {
        _ = try await send("POST", "/v0/agents/\(Self.escape(agentId))/read", json: .object([:]))
    }

    /// A media item's bytes, whole or one range of them.
    public func media(_ agentId: String, toolCallId: String, index: Int, range: ClosedRange<Int>? = nil) async throws -> DirectHTTPResponse {
        let headers = range.map { ["Range": "bytes=\($0.lowerBound)-\($0.upperBound)"] } ?? [:]
        return try await send("GET", "/v0/agents/\(Self.escape(agentId))/tool-calls/\(Self.escape(toolCallId))/media/\(index)", headers: headers)
    }

    // MARK: Sidebar proposals

    /// A proposal Prioritizing made, with its latest document.
    public func sidebarProposal(_ artifactId: String) async throws -> AgentWire.SidebarProposalResponse {
        try await decode(AgentWire.SidebarProposalResponse.self, "GET", "/v0/spaces/sidebar/proposals/\(Self.escape(artifactId))")
    }

    /// Takes the proposal as the person's own change of the sidebar.
    public func acceptSidebarProposal(_ artifactId: String, mutationId: String) async throws -> AgentWire.SidebarProposal {
        struct Answer: Decodable { let proposal: AgentWire.SidebarProposal }
        return try await decode(Answer.self, "POST", "/v0/spaces/sidebar/proposals/\(Self.escape(artifactId))/accept", json: .object(["mutationId": .string(mutationId)])).proposal
    }

    /// Keeps the sidebar as it is.
    public func declineSidebarProposal(_ artifactId: String, mutationId: String) async throws -> AgentWire.SidebarProposal {
        struct Answer: Decodable { let proposal: AgentWire.SidebarProposal }
        return try await decode(Answer.self, "POST", "/v0/spaces/sidebar/proposals/\(Self.escape(artifactId))/decline", json: .object(["mutationId": .string(mutationId)])).proposal
    }

    // MARK: Artifacts

    /// An artifact object, a deleted one's too (`GET /v0/artifacts/:artifactId`).
    public func artifact(_ artifactId: String) async throws -> JSONValue {
        guard let artifact = try await decode(JSONValue.self, "GET", "/v0/artifacts/\(Self.escape(artifactId))")["artifact"] else { throw DirectAgentError.invalidResponse }
        return artifact
    }

    /// One version of an artifact, `nil` for the latest: its entry, its files
    /// and how it wants to be shown.
    public func artifactVersion(_ artifactId: String, version: Int?) async throws -> AgentWire.ArtifactVersion {
        struct Answer: Decodable { let version: AgentWire.ArtifactVersion }
        return try await decode(Answer.self, "GET", "/v0/artifacts/\(Self.escape(artifactId))/versions/\(version.map(String.init) ?? "latest")").version
    }

    /// One file of a numbered version, whole or one range of it. `path` is
    /// the manifest's, each segment escaped on its own. `range` is a `Range` header as a player sent it.
    public func artifactFile(_ artifactId: String, version: Int, path: String, range: String? = nil) async throws -> DirectHTTPResponse {
        let headers = range.map { ["Range": $0] } ?? [:]
        let escaped = path.split(separator: "/", omittingEmptySubsequences: false).map { Self.escape(String($0)) }.joined(separator: "/")
        return try await send("GET", "/v0/artifacts/\(Self.escape(artifactId))/versions/\(version)/files/\(escaped)", headers: headers)
    }

    /// One answer holds at most 8 MiB, so a whole file is read in ranges
    /// of this size.
    public static let rangeChunk = 4 * 1024 * 1024

    /// Reads a file a range at a time through `fetch` (nil: the whole file,
    /// for one that is empty). `each` takes the pieces in order, with the
    /// first answer's head on the first and the file's whole length.
    public static func read(
        isolation: isolated (any Actor)? = #isolation,
        _ fetch: (ClosedRange<Int>?) async throws -> DirectHTTPResponse,
        each: (_ piece: Data, _ head: DirectHTTPResponse?, _ total: Int) async throws -> Void
    ) async throws {
        var offset = 0
        var total = Int.max
        while offset < total {
            try Task.checkCancellation()
            let response: DirectHTTPResponse
            do {
                response = try await fetch(offset...(offset + rangeChunk - 1))
            } catch DirectAgentError.status(416, _, _) where offset == 0 {
                let whole = try await fetch(nil)
                return try await each(whole.body, whole, whole.body.count)
            }
            // A server that ignores ranges answers with the whole file.
            if response.status == 200, offset == 0 { return try await each(response.body, response, response.body.count) }
            guard response.status == 206, !response.body.isEmpty,
                  let length = length(contentRange: response.headers["content-range"]) else { throw DirectAgentError.invalidResponse }
            if offset == 0 { total = length }
            try await each(response.body, offset == 0 ? response : nil, total)
            offset += response.body.count
        }
    }

    /// A single `Range` no longer than one answer may hold, as a server may
    /// answer: `bytes=0-` asks for the first piece, and a player asks on.
    /// Anything else (several ranges, a suffix) is left as it is.
    public static func bounded(range header: String) -> String {
        let spec = header.trimmingCharacters(in: .whitespaces)
        guard spec.hasPrefix("bytes="), !spec.contains(",") else { return header }
        let bounds = spec.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard bounds.count == 2, let start = Int(bounds[0].trimmingCharacters(in: .whitespaces)) else { return header }
        let last = start + rangeChunk - 1
        let end = Int(bounds[1].trimmingCharacters(in: .whitespaces)).map { min($0, last) } ?? last
        return "bytes=\(start)-\(end)"
    }

    /// The whole length in a `Content-Range` such as `bytes 0-1/28560`.
    public static func length(contentRange: String?) -> Int? {
        contentRange?.split(separator: "/").last.flatMap { Int($0) }
    }

    /// A daemon-relative image such as a bot's avatar.
    public func image(_ path: String) async throws -> Data {
        guard path.hasPrefix("/v0/") else { throw DirectAgentError.invalidResponse }
        return try await send("GET", path).body
    }

    // MARK: Events

    /// The journal as it happens, from `after` when given. The first frame is
    /// `hello`; the stream ends when the connection does, or when nothing,
    /// not even a heartbeat, has come for `silence`.
    public func events(after cursor: String?) async throws -> AsyncThrowingStream<ServerSentEvent, Error> {
        let response = try await transport.stream(path: "/v0/events/stream", credential: token, headers: cursor.map { ["Last-Event-ID": $0] } ?? [:])
        if response.status == 401 { throw DirectAgentError.revoked }
        guard response.status == 200 else { throw DirectAgentError.status(response.status, code: nil, message: nil) }
        let body = response.body
        let transport = transport
        return AsyncThrowingStream { continuation in
            let reader = Task {
                var parser = ServerSentEventParser()
                var watchdog = Self.watch(continuation, transport: transport)
                defer { watchdog.cancel() }
                do {
                    for try await bytes in body {
                        watchdog.cancel()
                        watchdog = Self.watch(continuation, transport: transport)
                        for frame in parser.append(bytes) { continuation.yield(frame) }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in reader.cancel() }
        }
    }

    /// The daemon writes a heartbeat every 15 seconds. A computer whose
    /// daemon restarted or went to sleep never closes the tunnel's stream,
    /// so this long without a byte means it is gone, and so is the tunnel.
    static let silence: Duration = .seconds(40)

    private static func watch(_ continuation: AsyncThrowingStream<ServerSentEvent, Error>.Continuation, transport: any DirectTransport) -> Task<Void, Never> {
        Task {
            guard (try? await Task.sleep(for: silence)) != nil else { return }
            await transport.reset()
            continuation.finish(throwing: DirectPairingError.unavailable)
        }
    }

    static func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? component
    }
}

/// The task, workspace and conversation a client names for new work.
public struct StemCellIdentity: Equatable, Sendable {
    public let taskId: String
    public let workspaceId: String
    public let agentId: String

    public static func make() -> StemCellIdentity {
        StemCellIdentity(taskId: ClientID.make(), workspaceId: ClientID.make(), agentId: ClientID.make())
    }
}

extension DirectAccounts {
    /// A client for a paired device, sharing nothing with its identity refresh.
    public func agentClient(for accountID: String) -> DirectAgentClient? {
        guard let credential = credential(for: accountID) else { return nil }
        return DirectAgentClient(transport: makeTransport(credential), token: credential.deviceToken)
    }
}

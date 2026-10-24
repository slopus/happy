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

    func send(_ method: String, _ path: String, json: JSONValue? = nil, headers: [String: String] = [:]) async throws -> DirectHTTPResponse {
        let body = try json.map { try JSONEncoder().encode($0) }
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

    public func userSetting(_ key: String) async throws -> JSONValue? {
        do { return try await decode(AgentWire.Setting.self, "GET", "/v0/user-settings/\(Self.escape(key))").value }
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

    // MARK: Conversations

    public func agent(_ agentId: String) async throws -> AgentWire.Agent {
        try await decode(AgentWire.Agent.self, "GET", "/v0/agents/\(Self.escape(agentId))")
    }

    public func bootstrap(_ agentId: String) async throws -> AgentWire.Bootstrap {
        try await decode(AgentWire.Bootstrap.self, "GET", "/v0/agents/\(Self.escape(agentId))/bootstrap")
    }

    /// Newest runs first page, or the runs before `before`, or the messages after `after`.
    public func messages(_ agentId: String, before: String? = nil, after: String? = nil, limit: Int = 50) async throws -> AgentWire.MessagesResponse {
        var query = "limit=\(limit)&omitToolData=true"
        if let before { query += "&before=\(Self.escape(before))" }
        if let after { query += "&after=\(Self.escape(after))" }
        return try await decode(AgentWire.MessagesResponse.self, "GET", "/v0/agents/\(Self.escape(agentId))/messages?\(query)")
    }

    /// The mode a conversation with no last composer mode sends with (`GET /v0/config` `defaults`).
    public func defaultMode() async throws -> AgentWire.Mode {
        let config = try await decode(JSONValue.self, "GET", "/v0/config")
        guard let defaults = config["config"]?["defaults"], let providerId = defaults["providerId"]?.stringValue,
              let modelId = defaults["modelId"]?.stringValue else { throw DirectAgentError.invalidResponse }
        return AgentWire.Mode(providerId: providerId, modelId: modelId, effort: defaults["effort"]?.stringValue ?? "medium", serviceTier: nil, permissionMode: defaults["permissionMode"]?.stringValue ?? "auto")
    }

    public func sendMessage(_ agentId: String, id: String, text: String, images: [(mimeType: String, data: Data)], mode: AgentWire.Mode) async throws {
        var object: [String: JSONValue] = [
            "id": .string(id), "text": .string(text), "delivery": .string("queue"),
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

    /// A daemon-relative image such as a bot's avatar.
    public func image(_ path: String) async throws -> Data {
        guard path.hasPrefix("/v0/") else { throw DirectAgentError.invalidResponse }
        return try await send("GET", path).body
    }

    // MARK: Events

    /// The journal as it happens, from `after` when given. The first frame is
    /// `hello`; the stream ends when the connection does.
    public func events(after cursor: String?) async throws -> AsyncThrowingStream<ServerSentEvent, Error> {
        let response = try await transport.stream(path: "/v0/events/stream", credential: token, headers: cursor.map { ["Last-Event-ID": $0] } ?? [:])
        if response.status == 401 { throw DirectAgentError.revoked }
        guard response.status == 200 else { throw DirectAgentError.status(response.status, code: nil, message: nil) }
        let body = response.body
        return AsyncThrowingStream { continuation in
            let reader = Task {
                var parser = ServerSentEventParser()
                do {
                    for try await bytes in body {
                        for frame in parser.append(bytes) { continuation.yield(frame) }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in reader.cancel() }
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

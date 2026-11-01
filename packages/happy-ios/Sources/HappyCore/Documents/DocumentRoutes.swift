import Foundation
import HappyWire

/// Who made a change, as the daemon names them.
public struct DocumentActor: Equatable, Sendable, Codable {
    public var userId: String?
    public var agentId: String?

    public init(userId: String?, agentId: String?) {
        self.userId = userId
        self.agentId = agentId
    }
}

/// One entry of a document's permanent change log, without its bytes.
public struct DocumentChange: Equatable, Sendable, Codable {
    public var seq: Int
    public var actor: DocumentActor
    /// `api` (a person's editor), `tool` (an agent) or `conversion`.
    public var source: String
    public var mutationId: String?
    public var createdAt: Double
    public var size: Int
}

/// `GET /state`: the document, or what a state vector lacks, as one update.
public struct DocumentState: Equatable, Sendable {
    public var seq: Int
    public var update: [UInt8]
    public var stateVector: [Int: Int]
}

/// A live `document.update` frame.
public struct DocumentUpdateFrame: Equatable, Sendable, Decodable {
    public var surfaceId: String
    public var seq: Int
    public var update: String
    public var mutationId: String?
    public var actor: DocumentActor
    public var source: String
}

/// A live `document.presence` frame: one other editor's awareness, or its leaving.
public struct DocumentPresenceFrame: Equatable, Sendable, Decodable {
    public var surfaceId: String
    public var clientKey: String
    public var revision: Int
    public var active: Bool
    public var awarenessClientId: Int?
    public var update: String?
}

/// The collaborative document routes (happy-agent-client `HappyAgentClient`,
/// `getSurfaceDocumentState` … `sendSurfaceDocumentPresence`).
extension AgentClient {
    private static func documentPath(_ surfaceId: String, _ route: String? = nil) -> String {
        "/v0/surfaces/document/\(escape(surfaceId))" + (route.map { "/" + $0 } ?? "")
    }

    /// Whether the computer keeps documents as shared Yjs state
    /// (`capabilities.collaborativeDocuments`); older ones only serve Markdown.
    public func collaborativeDocuments() async throws -> Bool {
        try await decode(JSONValue.self, "GET", "/v0/health")["capabilities"]?["collaborativeDocuments"]?.boolValue == true
    }

    /// The document as of now, of `seq`, or only what `stateVector` lacks.
    public func documentState(_ surfaceId: String, stateVector: [Int: Int]? = nil, seq: Int? = nil) async throws -> DocumentState {
        struct Response: Decodable { let seq: Int; let update: String; let stateVector: String }
        var query: [String] = []
        if let stateVector { query.append("stateVector=" + Self.escape(Data(YDoc.encodeStateVector(stateVector)).base64EncodedString())) }
        if let seq { query.append("seq=\(seq)") }
        let path = Self.documentPath(surfaceId, "state") + (query.isEmpty ? "" : "?" + query.joined(separator: "&"))
        let response = try await send("GET", path, category: .file)
        guard let body = try? JSONDecoder().decode(Response.self, from: response.body),
              let update = Data(base64Encoded: body.update), let vector = Data(base64Encoded: body.stateVector),
              let decoded = try? YDoc.decodeStateVector(Array(vector)) else { throw AgentClientError.invalidResponse }
        return DocumentState(seq: body.seq, update: Array(update), stateVector: decoded)
    }

    /// Stores one change; the same `mutationId` again returns its first `seq`.
    public func sendDocumentUpdate(_ surfaceId: String, mutationId: String, update: [UInt8]) async throws -> Int {
        struct Response: Decodable { let seq: Int }
        let json: JSONValue = .object(["mutationId": .string(mutationId), "update": .string(Data(update).base64EncodedString())])
        return try await decode(Response.self, "POST", Self.documentPath(surfaceId, "updates"), json: json).seq
    }

    /// The change log, oldest first, after `afterSeq`.
    public func documentChanges(_ surfaceId: String, afterSeq: Int = 0, limit: Int = 200) async throws -> (changes: [DocumentChange], next: Int?) {
        struct Response: Decodable { let updates: [Lossy<DocumentChange>]; let nextAfterSeq: Int? }
        let response = try await decode(Response.self, "GET", Self.documentPath(surfaceId, "updates") + "?afterSeq=\(afterSeq)&limit=\(limit)")
        return (response.updates.compactMap(\.value), response.nextAfterSeq)
    }

    /// The Markdown projection, now or as of `seq`.
    public func documentMarkdown(_ surfaceId: String, seq: Int? = nil) async throws -> (text: String, seq: Int?) {
        let path = Self.documentPath(surfaceId) + (seq.map { "?seq=\($0)" } ?? "")
        let document = try await decode(JSONValue.self, "GET", path)["document"]
        guard let text = document?["text"]?.stringValue else { throw AgentClientError.invalidResponse }
        return (text, document?["seq"]?.numberValue.map { Int($0) })
    }

    /// Sends this document's live frames to the stream named `streamId`; answers its head `seq`.
    @discardableResult
    public func subscribeDocument(_ surfaceId: String, streamId: String) async throws -> Int {
        struct Response: Decodable { let seq: Int }
        return try await decode(Response.self, "POST", Self.documentPath(surfaceId, "subscribe"), json: .object(["streamId": .string(streamId)])).seq
    }

    public func unsubscribeDocument(_ surfaceId: String, streamId: String) async throws {
        _ = try await send("POST", Self.documentPath(surfaceId, "unsubscribe"), json: .object(["streamId": .string(streamId)]))
    }

    /// Relays an awareness update to the document's other editors; never stored.
    public func sendDocumentPresence(_ surfaceId: String, streamId: String, awarenessClientId: Int, update: [UInt8]) async throws {
        let json: JSONValue = .object([
            "streamId": .string(streamId),
            "awarenessClientId": .number(Double(awarenessClientId)),
            "update": .string(Data(update).base64EncodedString()),
        ])
        _ = try await send("POST", Self.documentPath(surfaceId, "presence"), json: json, category: .realtime)
    }

    /// A new document Surface, joined by its maker; answers its ID.
    public func createDocument(name: String, text: String? = nil) async throws -> AgentWire.Surface {
        struct Response: Decodable { let surface: AgentWire.Surface }
        var body: [String: JSONValue] = ["type": .string("document"), "name": .string(name)]
        if let text { body["text"] = .string(text) }
        return try await decode(Response.self, "POST", "/v0/surfaces", json: .object(body)).surface
    }

    /// Renames a Surface for everyone in it (`capabilities.surfaceEditing`); the latest name wins.
    public func renameSurface(_ surfaceId: String, name: String, mutationId: String = ClientID.make()) async throws {
        _ = try await send("PATCH", "/v0/surfaces/\(Self.escape(surfaceId))", json: .object(["name": .string(name), "mutationId": .string(mutationId)]))
    }
}

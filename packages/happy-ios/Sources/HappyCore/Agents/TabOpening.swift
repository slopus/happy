import Foundation
import HappyWire

/// Opening content adds one tab to this authenticated member's list.
/// Wire names stay `surface` for old clients and persisted records.
public enum TabOpening {
    public struct Reference: Equatable, Sendable {
        public var kind: String
        public var id: String
        public var name: String
    }

    public enum Action: Equatable, Sendable {
        case none
        case join(String)
        case create(Reference)
    }

    public static func action(kind: String, id: String, snapshot: JSONValue) -> Action {
        if kind == "surface" { return .join(id) }
        let reference: Reference
        if kind == "agent" {
            let owners = ["bot", "task"].flatMap { kind in
                (snapshot[kind + "s"]?.arrayValue ?? []).compactMap { owner -> Reference? in
                    guard owner["agent"]?["id"]?.stringValue == id, let ownerId = owner["id"]?.stringValue else { return nil }
                    return Reference(kind: kind, id: ownerId, name: owner["name"]?.stringValue ?? "Untitled")
                }
            }
            guard let owner = owners.first else { return .none }
            reference = owner
        } else if kind == "artifact" {
            reference = Reference(kind: kind, id: id, name: "Untitled")
        } else { return .none }
        let user = snapshot["profile"]?["userId"]?.stringValue
        let matches = (snapshot["surfaces"]?.arrayValue ?? []).filter {
            $0["target"]?["state"]?.stringValue == "available"
                && $0["target"]?["type"]?.stringValue == reference.kind
                && $0["target"]?[reference.kind + "Id"]?.stringValue == reference.id
        }
        if matches.contains(where: { surface in
            (surface["members"]?.arrayValue ?? []).contains { $0["userId"]?.stringValue == user }
        }) { return .none }
        if let own = matches.first(where: { $0["creatorUserId"]?.stringValue == user }), let tabId = own["id"]?.stringValue {
            return .join(tabId)
        }
        return .create(reference)
    }
}

extension AgentClient {
    public func tab(_ id: String) async throws -> AgentWire.Surface {
        struct Response: Decodable { var surface: AgentWire.Surface }
        return try await decode(Response.self, "GET", "/v0/surfaces/\(Self.escape(id))").surface
    }

    public func tabAgent(kind: String, id: String) async throws -> String? {
        guard kind == "bot" || kind == "task" else { return nil }
        let snapshot = try await decode(JSONValue.self, "GET", "/v0/bootstrap/desktop")
        return snapshot[kind + "s"]?.arrayValue?.first(where: { $0["id"]?.stringValue == id })?["agent"]?["id"]?.stringValue
    }

    func openTab(kind: String, id: String, mutationId: String) async throws {
        var snapshot = kind == "surface" ? JSONValue.null : try await decode(JSONValue.self, "GET", "/v0/bootstrap/desktop")
        if kind != "surface", var fields = snapshot.objectValue {
            let catalog = try await decode(JSONValue.self, "GET", "/v0/surfaces")
            fields["surfaces"] = catalog["surfaces"] ?? .array([])
            snapshot = .object(fields)
        }
        switch TabOpening.action(kind: kind, id: id, snapshot: snapshot) {
        case .none: return
        case .join(let tabId):
            _ = try await send("POST", "/v0/surfaces/\(Self.escape(tabId))/join", json: .object(["mutationId": .string(mutationId)]))
        case .create(let reference):
            _ = try await send("POST", "/v0/surfaces", json: .object([
                "id": .string(mutationId), "mutationId": .string(mutationId),
                "type": .string(reference.kind), "name": .string(reference.name),
                reference.kind + "Id": .string(reference.id),
            ]))
        }
    }
}
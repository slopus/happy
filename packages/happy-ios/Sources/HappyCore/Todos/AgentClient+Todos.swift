import Foundation
import HappyWire

// A todo list's routes (happy-agent API.md, "Todo routes"), and a new
// Surface of any kind ("Surface catalog and members").
extension AgentClient: TodoRoutes {
    private static func todoPath(_ surfaceId: String, _ todoId: String? = nil, _ route: String? = nil) -> String {
        "/v0/surfaces/todo/\(escape(surfaceId))" + (todoId.map { "/" + escape($0) } ?? "") + (route.map { "/" + $0 } ?? "")
    }

    private func decodeTodo(_ response: HTTP1Response) throws -> TodoItem {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: response.body), let todo = json["todo"].flatMap(TodoItem.init(json:)) else {
            throw AgentClientError.invalidResponse
        }
        return todo
    }

    public func todos(_ surfaceId: String, scope: TodoItem.Status) async throws -> [TodoItem] {
        let json = try await decode(JSONValue.self, "GET", Self.todoPath(surfaceId) + "?scope=\(scope.rawValue)")
        return (json["todos"]?.arrayValue ?? []).compactMap(TodoItem.init(json:))
    }

    public func todo(_ surfaceId: String, _ todoId: String) async throws -> TodoItem {
        try decodeTodo(try await send("GET", Self.todoPath(surfaceId, todoId)))
    }

    /// A new todo at the top; `id` is the creation's retry key, so a
    /// repeat answers the todo made the first time.
    public func createTodo(_ surfaceId: String, id: String, text: String, mutationId: String) async throws -> TodoItem {
        let body: JSONValue = .object(["id": .string(id), "text": .string(text), "mutationId": .string(mutationId)])
        return try decodeTodo(try await send("POST", Self.todoPath(surfaceId), json: body))
    }

    public func updateTodo(_ surfaceId: String, _ todoId: String, text: String?, status: TodoItem.Status?, ifMatch: String, mutationId: String) async throws -> TodoItem {
        var body: [String: JSONValue] = ["mutationId": .string(mutationId)]
        if let text { body["text"] = .string(text) }
        if let status { body["status"] = .string(status.rawValue) }
        return try decodeTodo(try await send("PATCH", Self.todoPath(surfaceId, todoId), json: .object(body), headers: ["If-Match": ifMatch]))
    }

    public func deleteTodo(_ surfaceId: String, _ todoId: String, ifMatch: String, mutationId: String) async throws -> TodoItem {
        try decodeTodo(try await send("DELETE", Self.todoPath(surfaceId, todoId), json: .object(["mutationId": .string(mutationId)]), headers: ["If-Match": ifMatch]))
    }

    public func reorderTodo(_ surfaceId: String, _ todoId: String, afterId: String?, ifMatch: String, mutationId: String) async throws -> TodoItem {
        let body: JSONValue = .object(["afterId": afterId.map(JSONValue.string) ?? .null, "mutationId": .string(mutationId)])
        return try decodeTodo(try await send("POST", Self.todoPath(surfaceId, todoId, "reorder"), json: body, headers: ["If-Match": ifMatch]))
    }

    /// Every revision, oldest first, following the pages.
    public func todoVersions(_ surfaceId: String, _ todoId: String) async throws -> [TodoRevision] {
        var revisions: [TodoRevision] = []
        var after: String?
        for _ in 0..<50 {
            let query = "?limit=200" + (after.map { "&afterVersion=\(Self.escape($0))" } ?? "")
            let json = try await decode(JSONValue.self, "GET", Self.todoPath(surfaceId, todoId, "versions") + query)
            revisions += (json["versions"]?.arrayValue ?? []).compactMap(TodoRevision.init(json:))
            guard let next = json["nextAfterVersion"]?.stringValue, next != after else { break }
            after = next
        }
        return revisions
    }

    /// A new Surface of `type`, joined by its maker. `id` is the retry
    /// key: a repeat answers the one made the first time.
    public func createSurface(type: String, name: String, id: String = TodoID.make(), mutationId: String = ClientID.make()) async throws -> AgentWire.Surface {
        struct Response: Decodable { let surface: AgentWire.Surface }
        let body: JSONValue = .object(["id": .string(id), "type": .string(type), "name": .string(name), "mutationId": .string(mutationId)])
        return try await decode(Response.self, "POST", "/v0/surfaces", json: body).surface
    }
}

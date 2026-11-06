import Foundation
import HappyWire

/// The routes the Feed's lookups read one thing by ID with (API.md
/// "Showing an entry"); `AgentClient` is the account's.
public protocol FeedLookupRoutes: Sendable {
    func agent(_ agentId: String) async throws -> AgentWire.Agent
    func teamUsers(_ ids: [String]) async throws -> [TeamUser]
    func artifact(_ artifactId: String) async throws -> JSONValue
    func todo(_ surfaceId: String, _ todoId: String) async throws -> TodoItem
    /// `GET /v0/projects/:id` (`kind` "project") or `/v0/workspaces/:id`.
    func place(_ kind: String, _ id: String) async throws -> JSONValue
}

extension AgentClient: FeedLookupRoutes {
    public func place(_ kind: String, _ id: String) async throws -> JSONValue {
        let answer = try await decode(JSONValue.self, "GET", "/v0/\(kind == "project" ? "projects" : "workspaces")/\(Self.escape(id))")
        guard let object = answer[kind] else { throw AgentClientError.invalidResponse }
        return object
    }
}

/// What the Feed names that the rest of the account doesn't sync: agents
/// outside the bootstrap (deeper workspaces, older archives), the people
/// who acted, projects and workspaces a place names, the todo an entry's
/// newest change made, and artifacts past the catalog's pages. Each is
/// read by ID once it is named, kept on the phone with what it read
/// (docs/offline-first.md), and read again when an event says it changed
/// (a todo edited, an agent or person renamed), so a row follows it.
///
/// One read runs at a time, only while the computer is reachable; a thing
/// the computer says isn't there isn't asked for again until the stream
/// comes back.
public actor FeedLookups {
    /// References to look up, by kind.
    public struct Wanted: Equatable, Sendable {
        public var agents: Set<String> = []
        public var people: Set<String> = []
        public var projects: Set<String> = []
        public var workspaces: Set<String> = []
        public var artifacts: Set<String> = []
        /// `FeedDirectory.todoKey`s.
        public var todos: Set<String> = []

        public init() {}

        public var isEmpty: Bool { self == Wanted() }

        public mutating func formUnion(_ other: Wanted) {
            agents.formUnion(other.agents)
            people.formUnion(other.people)
            projects.formUnion(other.projects)
            workspaces.formUnion(other.workspaces)
            artifacts.formUnion(other.artifacts)
            todos.formUnion(other.todos)
        }

        mutating func subtract(_ other: Wanted) {
            agents.subtract(other.agents)
            people.subtract(other.people)
            projects.subtract(other.projects)
            workspaces.subtract(other.workspaces)
            artifacts.subtract(other.artifacts)
            todos.subtract(other.todos)
        }
    }

    /// A project or workspace as read.
    public struct Place: Codable, Equatable, Sendable {
        public var name: String
        public var status: String?
        public var avatar: DesktopSnapshot.Project.Avatar?

        public init(name: String, status: String? = nil, avatar: DesktopSnapshot.Project.Avatar? = nil) {
            self.name = name
            self.status = status
            self.avatar = avatar
        }
    }

    /// What was read, and what is kept.
    public struct Found: Codable, Equatable, Sendable {
        /// Agents' titles by ID ("" untitled).
        public var agents: [String: String] = [:]
        public var people: [String: TeamUser] = [:]
        public var projects: [String: Place] = [:]
        public var workspaces: [String: Place] = [:]
        public var artifacts: [String: ArtifactSummary] = [:]
        public var todos: [String: TodoItem] = [:]

        public init() {}

        var held: Wanted {
            var held = Wanted()
            held.agents = Set(agents.keys)
            held.people = Set(people.keys)
            held.projects = Set(projects.keys)
            held.workspaces = Set(workspaces.keys)
            held.artifacts = Set(artifacts.keys)
            held.todos = Set(todos.keys)
            return held
        }

        /// Only what `wanted` names.
        func keeping(_ wanted: Wanted) -> Found {
            var found = self
            found.agents = agents.filter { wanted.agents.contains($0.key) }
            found.people = people.filter { wanted.people.contains($0.key) }
            found.projects = projects.filter { wanted.projects.contains($0.key) }
            found.workspaces = workspaces.filter { wanted.workspaces.contains($0.key) }
            found.artifacts = artifacts.filter { wanted.artifacts.contains($0.key) }
            found.todos = todos.filter { wanted.todos.contains($0.key) }
            return found
        }
    }

    /// The checkpoint it is kept under.
    public static let resource = "feed-lookups"

    private let routes: FeedLookupRoutes
    private let keep: FeedKeep
    private var found = Found()
    private var listeners: [UUID: AsyncStream<Found>.Continuation] = [:]
    /// Named and not held: what the Feed names now, as last said.
    private var queue = Wanted()
    /// Held, and said to have changed.
    private var again = Wanted()
    /// Answered as not there, on this connection.
    private var missing = Wanted()
    private var live = false
    private var started = false
    private var reading: Task<Void, Never>?
    private var lastKept: Found?

    public init(routes: FeedLookupRoutes, keep: FeedKeep) {
        self.routes = routes
        self.keep = keep
    }

    /// What was found now and after every change.
    public func states() -> AsyncStream<Found> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: Found.self, bufferingPolicy: .bufferingNewest(1))
        listeners[id] = continuation
        continuation.yield(found)
        continuation.onTermination = { [weak self] _ in Task { await self?.unlisten(id) } }
        return stream
    }

    private func unlisten(_ id: UUID) { listeners[id] = nil }

    public var current: Found { found }

    /// What was kept. Once.
    public func start() async {
        guard !started else { return }
        started = true
        if let kept = await keep.read(Self.resource),
           let value = try? JSONDecoder().decode(Found.self, from: JSONEncoder().encode(kept)) {
            found = value
            lastKept = value
            publish()
        }
    }

    public func stop() {
        reading?.cancel(); reading = nil
        live = false
        for listener in listeners.values { listener.finish() }
        listeners = [:]
    }

    /// The stream opened: what wasn't there is asked for again with the
    /// next `want`, which the engine makes at once. `gap`: events may have
    /// been missed, so everything held is read again too.
    public func connected(gap: Bool) {
        live = true
        missing = Wanted()
        if gap { again.formUnion(found.held) }
    }

    public func disconnected() {
        live = false
        reading?.cancel(); reading = nil
    }

    /// The Feed names these now, in place of what it named before: anything
    /// not held is read. `referenced`, when given, is everything the Feed
    /// names, and anything held beyond it is let go.
    public func want(_ wanted: Wanted, referenced: Wanted? = nil) async {
        if let referenced {
            let kept = found.keeping(referenced)
            if kept != found {
                found = kept
                publish()
                await save()
            }
        }
        var next = wanted
        next.subtract(found.held)
        next.subtract(missing)
        queue = next
        read()
    }

    /// Whether `receive` reads anything of `event`: the stream need not
    /// hand over the others, an agent's words and its updates without a
    /// new title above all, which come many times a second.
    public static func reads(_ event: JSONValue) -> Bool {
        switch event["type"]?.stringValue {
        case "agent.updated": event["payload"]?["changes"]?["title"] != nil
        case "profile.updated", "todo.created", "todo.updated", "project.updated", "workspace.updated", "artifact.updated", "artifact.deleted": true
        default: false
        }
    }

    /// One event from the stream: a thing held that it says changed is
    /// taken in or read again.
    public func receive(_ event: JSONValue) async {
        guard let type = event["type"]?.stringValue else { return }
        let payload = event["payload"] ?? .null
        var again = Wanted()
        switch type {
        case "agent.updated":
            if let id = payload["agentId"]?.stringValue, found.agents[id] != nil {
                if let title = payload["changes"]?["title"]?.stringValue { await take { $0.agents[id] = title } } else if payload["changes"]?["title"] == .null { await take { $0.agents[id] = "" } }
            }
        case "profile.updated":
            if let id = payload["userId"]?.stringValue, found.people[id] != nil { again.people.insert(id) }
        case "todo.created":
            if let todo = payload["todo"].flatMap(TodoItem.init(json:)) {
                let key = FeedDirectory.todoKey(todo.surfaceId, todo.id)
                // One named before its event came: here now.
                if found.todos[key] != nil || queue.todos.contains(key) || missing.todos.contains(key) {
                    missing.todos.remove(key)
                    queue.todos.remove(key)
                    await take { $0.todos[key] = todo }
                }
            }
        case "todo.updated":
            if let surfaceId = payload["surfaceId"]?.stringValue, let todoId = payload["todoId"]?.stringValue,
               found.todos[FeedDirectory.todoKey(surfaceId, todoId)] != nil {
                again.todos.insert(FeedDirectory.todoKey(surfaceId, todoId))
            }
        case "project.updated", "workspace.updated":
            let kind = type == "project.updated" ? "project" : "workspace"
            if let id = payload["\(kind)Id"]?.stringValue {
                if kind == "project", found.projects[id] != nil { again.projects.insert(id) }
                if kind == "workspace", found.workspaces[id] != nil { again.workspaces.insert(id) }
            }
        case "artifact.updated", "artifact.deleted":
            if let id = payload["artifactId"]?.stringValue, found.artifacts[id] != nil { again.artifacts.insert(id) }
        default:
            return
        }
        guard !again.isEmpty else { return }
        self.again.formUnion(again)
        read()
    }

    private func take(_ change: (inout Found) -> Void) async {
        var next = found
        change(&next)
        guard next != found else { return }
        found = next
        publish()
        await save()
    }

    // MARK: Reading

    private func read() {
        guard live, reading == nil, !(queue.isEmpty && again.isEmpty) else { return }
        reading = Task { [weak self] in
            await self?.drain()
        }
    }

    private func drain() async {
        defer { reading = nil }
        while live, !Task.isCancelled, !(queue.isEmpty && again.isEmpty) {
            var batch = queue
            batch.formUnion(again)
            queue = Wanted()
            again = Wanted()
            // What this pass read, laid over what is held once it is done,
            // so an event taken in meanwhile stands.
            var next = Found()
            var gone = Wanted()
            var failed = Wanted()
            let routes = routes
            for id in batch.agents.sorted() {
                switch await Self.read({ try await routes.agent(id) }) {
                case .found(let agent): next.agents[id] = agent.title ?? ""
                case .gone: gone.agents.insert(id)
                case .failed: failed.agents.insert(id)
                }
            }
            let people = batch.people.sorted()
            for start in stride(from: 0, to: people.count, by: 100) {
                let ids = Array(people[start..<min(start + 100, people.count)])
                switch await Self.read({ try await routes.teamUsers(ids) }) {
                case .found(let read):
                    for user in read { next.people[user.id] = user }
                    gone.people.formUnion(Set(ids).subtracting(read.map(\.id)))
                case .gone: gone.people.formUnion(ids)
                case .failed: failed.people.formUnion(ids)
                }
            }
            for id in batch.projects.sorted() {
                switch await Self.read({ try await routes.place("project", id) }) {
                case .found(let json): next.projects[id] = Self.place(json)
                case .gone: gone.projects.insert(id)
                case .failed: failed.projects.insert(id)
                }
            }
            for id in batch.workspaces.sorted() {
                switch await Self.read({ try await routes.place("workspace", id) }) {
                case .found(let json): next.workspaces[id] = Self.place(json)
                case .gone: gone.workspaces.insert(id)
                case .failed: failed.workspaces.insert(id)
                }
            }
            for id in batch.artifacts.sorted() {
                switch await Self.read({ try await routes.artifact(id) }) {
                case .found(let json): next.artifacts[id] = ArtifactSummary(json: json)
                case .gone: gone.artifacts.insert(id)
                case .failed: failed.artifacts.insert(id)
                }
            }
            for key in batch.todos.sorted() {
                let parts = key.split(separator: "/", maxSplits: 1).map(String.init)
                guard parts.count == 2 else { continue }
                switch await Self.read({ try await routes.todo(parts[0], parts[1]) }) {
                case .found(let todo): next.todos[key] = todo
                case .gone: gone.todos.insert(key)
                case .failed: failed.todos.insert(key)
                }
            }
            guard !Task.isCancelled else {
                again.formUnion(batch)
                return
            }
            missing.formUnion(gone)
            // Away: asked again when the stream comes back.
            missing.formUnion(failed)
            await take { held in
                held.agents.merge(next.agents) { _, read in read }
                held.people.merge(next.people) { _, read in read }
                held.projects.merge(next.projects) { _, read in read }
                held.workspaces.merge(next.workspaces) { _, read in read }
                held.artifacts.merge(next.artifacts) { _, read in read }
                held.todos.merge(next.todos) { _, read in read }
                // Gone from the computer: gone here.
                gone.agents.forEach { held.agents[$0] = nil }
                gone.people.forEach { held.people[$0] = nil }
                gone.projects.forEach { held.projects[$0] = nil }
                gone.workspaces.forEach { held.workspaces[$0] = nil }
                gone.artifacts.forEach { held.artifacts[$0] = nil }
                gone.todos.forEach { held.todos[$0] = nil }
            }
        }
    }

    private enum Outcome<Value: Sendable>: Sendable {
        case found(Value)
        /// The computer says there is no such thing.
        case gone
        /// It couldn't be asked.
        case failed
    }

    private static func read<Value: Sendable>(_ read: @Sendable () async throws -> Value) async -> Outcome<Value> {
        do { return .found(try await read()) } catch AgentClientError.status(404, _, _) { return .gone } catch { return .failed }
    }

    /// A project or workspace object as kept; nil for one without a name.
    private static func place(_ json: JSONValue) -> Place? {
        guard let name = json["name"]?.stringValue else { return nil }
        let avatar = json["avatar"].flatMap { try? JSONDecoder().decode(DesktopSnapshot.Project.Avatar.self, from: JSONEncoder().encode($0)) }
        return Place(name: name, status: json["status"]?.stringValue, avatar: avatar)
    }

    private func publish() {
        for listener in listeners.values { listener.yield(found) }
    }

    private func save() async {
        guard found != lastKept, let value = try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(found)) else { return }
        lastKept = found
        await keep.write(Self.resource, value)
    }
}

import Foundation
import HappyWire

// One pipeline, its versions and what a version defines (API.md,
// "Pipelines"; the definition as hc-pipelines' definition.rs reads it):
// its input type, concurrency, who may start it, what it may reach, and
// its nodes and edges. Read for a person to look at, not to run: a part
// this app can't read is left out rather than guessed at.

/// A type, in the strict subset of JSON Schema definitions use.
public struct PipelineType: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable {
        case string, number, integer, boolean, null, array, object
    }

    public var kind: Kind
    /// `[<type>, "null"]`: `null` is accepted too.
    public var nullable: Bool
    /// `enum`: the only values accepted, as JSON.
    public var values: [String]?
    /// An array's items: one type, or none for an array this app can't read.
    public var items: [PipelineType]
    /// An object's fields, by name.
    public var fields: [PipelineField]
    public var description: String?

    public init(kind: Kind, nullable: Bool = false, values: [String]? = nil, items: [PipelineType] = [], fields: [PipelineField] = [], description: String? = nil) {
        self.kind = kind
        self.nullable = nullable
        self.values = values
        self.items = items
        self.fields = fields
        self.description = description
    }
}

/// One field of an object type.
public struct PipelineField: Equatable, Sendable {
    public var name: String
    public var type: PipelineType
    public var required: Bool

    public init(name: String, type: PipelineType, required: Bool) {
        self.name = name
        self.type = type
        self.required = required
    }
}

/// What a pipeline, or one node of it, is granted. Nothing is the default:
/// a node with nothing may compute and nothing else.
public struct PipelinePermissions: Equatable, Sendable {
    public struct Grant: Equatable, Sendable {
        public var id: String
        /// `read` or `write`.
        public var access: String
    }

    public struct Compute: Equatable, Sendable {
        public var pools: [String]
        public var computers: [String]
        /// How many computers a run may hold at once; unlimited when nil.
        public var maxLeases: Int?
    }

    public var tools: [String] = []
    public var vaults: [Grant] = []
    public var secrets: [String] = []
    public var repositories: [Grant] = []
    /// Agents it may send a message to.
    public var agents: [String] = []
    /// Pipelines it may run as a child.
    public var pipelines: [String] = []
    public var egressHosts: [String] = []
    /// On the pipeline, nil grants no computer. On a node, nil is the pipeline's.
    public var compute: Compute?

    public init() {}

    /// It grants nothing a node could reach beyond computing.
    public var isEmpty: Bool {
        tools.isEmpty && vaults.isEmpty && secrets.isEmpty && repositories.isEmpty && agents.isEmpty && pipelines.isEmpty
            && egressHosts.isEmpty && (compute.map { $0.pools.isEmpty && $0.computers.isEmpty } ?? true)
    }
}

/// One node as a version defines it.
public struct PipelineDefinitionNode: Equatable, Sendable {
    public struct Acquire: Equatable, Sendable {
        public var name: String
        public var pool: String?
        public var computer: String?
    }

    public var id: String
    /// `code`, `agent` or `pipeline`.
    public var kind: String
    public var model: String?
    public var effort: String?
    public var instructions: String?
    public var source: String?
    /// A `pipeline` node's pipeline, by ID.
    public var pipeline: String?
    public var input: PipelineType?
    public var inputSchema: JSONValue?
    public var output: PipelineType?
    public var outputSchema: JSONValue?
    /// Nil when the node names none: it is granted nothing.
    public var permissions: PipelinePermissions?
    public var acquire: [Acquire]
    public var uses: [String]
    public var passes: [String]
    public var timeoutSeconds: Int
    /// `all` or `any`: which edges into it must fire before it runs.
    public var join: String
}

/// A version's definition.
public struct PipelineDefinition: Equatable, Sendable {
    public enum Mode: String, Equatable, Sendable {
        case independent, supersede, queue
    }

    public var input: PipelineType?
    public var inputSchema: JSONValue?
    public var mode: Mode
    /// A template over the input (`{{input.branch}}`); one group for every run when nil.
    public var group: String?
    public var batch: Bool
    /// The agents or bots that may start it.
    public var triggerAgents: [String]
    /// The ceiling for every node.
    public var permissions: PipelinePermissions
    public var root: String
    public var nodes: [String: PipelineDefinitionNode]
    public var edges: [PipelineGraph.Edge]

    public var graph: PipelineGraph {
        PipelineGraph(root: root, nodes: nodes.mapValues { node in
            PipelineGraph.Node(id: node.id, kind: node.kind, model: node.model, pipelineId: node.pipeline,
                               leases: Set(node.acquire.map(\.name) + node.uses + node.passes))
        }, edges: edges)
    }

    /// What a run gives back (`result.outputs`): the output of every node
    /// no success edge leaves, by node ID. Only a root with no edge out is
    /// always there; the others are there when the run reaches them.
    public var outputs: [PipelineField] {
        let rootEnds = !edges.contains { $0.from == root }
        return graph.order.compactMap { id -> PipelineField? in
            guard let node = nodes[id], !edges.contains(where: { $0.from == id && $0.on == "success" }) else { return nil }
            return PipelineField(name: id, type: node.output ?? PipelineType(kind: .object), required: rootEnds && id == root)
        }
    }

    /// `outputs` as JSON Schema, for reading it raw.
    public var outputSchema: JSONValue {
        let ends = outputs
        var properties: [String: JSONValue] = [:]
        for field in ends { properties[field.name] = nodes[field.name]?.outputSchema ?? .object([:]) }
        return .object(["type": .string("object"), "properties": .object(properties),
                        "required": .array(ends.filter(\.required).map { .string($0.name) })])
    }
}

/// Who published a version.
public enum PipelineAuthor: Equatable, Sendable {
    case user(String?)
    /// An agent, with the member it acted for.
    case agent(String, user: String?)
}

/// One version of a pipeline; `definition` only where it was read with it.
public struct PipelineVersion: Equatable, Sendable {
    public var number: Int
    public var digest: String
    public var message: String
    public var author: PipelineAuthor?
    public var createdAt: Double
    public var definition: PipelineDefinition?
}

/// One pipeline as its page shows it, its head version whole.
public struct PipelineDetail: Equatable, Sendable {
    public var id: String
    public var name: String
    public var description: String?
    public var enabled: Bool
    public var head: PipelineVersion
    public var lastRun: PipelineRunSummary?
    public var createdBy: String?
    public var createdAt: Double
    public var updatedAt: Double
}

extension PipelineRead {
    static func type(_ value: JSONValue?, depth: Int = 0) -> PipelineType? {
        guard let value, depth < 16 else { return nil }
        var nullable = false
        let name: String?
        if let types = value["type"]?.arrayValue {
            let names = types.compactMap(\.stringValue)
            nullable = names.contains("null")
            name = names.first { $0 != "null" } ?? (nullable ? "null" : nil)
        } else {
            name = value["type"]?.stringValue
        }
        guard let kind = name.flatMap(PipelineType.Kind.init(rawValue:)) else { return nil }
        let values = value["enum"]?.arrayValue?.compactMap { entry -> String? in
            if case .null = entry { return nil }
            return (try? entry.encodedString()) ?? entry.stringValue
        }
        var type = PipelineType(kind: kind, nullable: nullable && kind != .null, values: values, description: text(value["description"]))
        switch kind {
        case .array:
            type.items = self.type(value["items"], depth: depth + 1).map { [$0] } ?? []
        case .object:
            let required = Set(strings(value["required"]))
            type.fields = (value["properties"]?.objectValue ?? [:]).compactMap { name, field in
                self.type(field, depth: depth + 1).map { PipelineField(name: name, type: $0, required: required.contains(name)) }
            }.sorted { $0.name < $1.name }
        default: break
        }
        return type
    }

    static func permissions(_ value: JSONValue?) -> PipelinePermissions? {
        guard let value, value.objectValue != nil else { return nil }
        func grants(_ field: JSONValue?) -> [PipelinePermissions.Grant] {
            (field?.arrayValue ?? []).compactMap { grant in
                grant["id"]?.stringValue.map { PipelinePermissions.Grant(id: $0, access: grant["access"]?.stringValue ?? "read") }
            }
        }
        var permissions = PipelinePermissions()
        permissions.tools = strings(value["tools"])
        permissions.vaults = grants(value["vaults"])
        permissions.secrets = strings(value["secrets"])
        permissions.repositories = grants(value["repositories"])
        permissions.agents = strings(value["agents"])
        permissions.pipelines = strings(value["pipelines"])
        permissions.egressHosts = strings(value["egress"]?["hosts"])
        if let compute = value["compute"], compute.objectValue != nil {
            permissions.compute = PipelinePermissions.Compute(pools: strings(compute["pools"]), computers: strings(compute["computers"]),
                                                              maxLeases: integer(compute["maxLeases"]))
        }
        return permissions
    }

    static func definitionNode(_ id: String, _ value: JSONValue) -> PipelineDefinitionNode? {
        guard let kind = value["kind"]?.stringValue, ["code", "agent", "pipeline"].contains(kind) else { return nil }
        let compute = value["compute"]
        let acquire = (compute?["acquire"]?.arrayValue ?? []).compactMap { lease in
            lease["name"]?.stringValue.map { PipelineDefinitionNode.Acquire(name: $0, pool: text(lease["pool"]), computer: text(lease["computer"])) }
        }
        return PipelineDefinitionNode(
            id: id, kind: kind, model: text(value["model"]), effort: text(value["effort"]), instructions: text(value["instructions"]),
            source: text(value["source"]), pipeline: text(value["pipeline"]), input: type(value["input"]), inputSchema: value["input"],
            output: type(value["output"]), outputSchema: value["output"], permissions: permissions(value["permissions"]),
            acquire: acquire, uses: strings(compute?["use"]), passes: strings(compute?["pass"]),
            timeoutSeconds: integer(value["timeoutSeconds"]) ?? 3600, join: value["join"]?.stringValue == "any" ? "any" : "all")
    }

    static func definition(_ value: JSONValue?) -> PipelineDefinition? {
        guard let value, let root = value["root"]?.stringValue, let entries = value["nodes"]?.objectValue else { return nil }
        var nodes: [String: PipelineDefinitionNode] = [:]
        for (id, entry) in entries {
            // A node of a kind this app doesn't know: the graph would be half read.
            guard let node = definitionNode(id, entry) else { return nil }
            nodes[id] = node
        }
        guard nodes[root] != nil else { return nil }
        let edges = (value["edges"]?.arrayValue ?? []).compactMap { edge -> PipelineGraph.Edge? in
            guard let from = edge["from"]?.stringValue, let to = edge["to"]?.stringValue, let on = edge["on"]?.stringValue,
                  nodes[from] != nil, nodes[to] != nil, on == "success" || on == "failure" else { return nil }
            return PipelineGraph.Edge(from: from, to: to, on: on)
        }
        let concurrency = value["concurrency"]
        return PipelineDefinition(
            input: type(value["input"]), inputSchema: value["input"],
            mode: concurrency?["mode"]?.stringValue.flatMap(PipelineDefinition.Mode.init(rawValue:)) ?? .independent,
            group: text(concurrency?["group"]), batch: concurrency?["batch"]?.boolValue == true,
            triggerAgents: strings(value["triggers"]?["agents"]), permissions: permissions(value["permissions"]) ?? PipelinePermissions(),
            root: root, nodes: nodes, edges: edges)
    }

    static func author(_ value: JSONValue?) -> PipelineAuthor? {
        switch value?["kind"]?.stringValue {
        case "user": return .user(text(value?["userId"]))
        case "agent": return text(value?["agentId"]).map { .agent($0, user: text(value?["userId"])) }
        default: return nil
        }
    }

    static func version(_ value: JSONValue?) -> PipelineVersion? {
        guard let value, let number = integer(value["number"]) else { return nil }
        return PipelineVersion(number: number, digest: value["digest"]?.stringValue ?? "", message: value["message"]?.stringValue ?? "",
                               author: author(value["author"]), createdAt: self.number(value["createdAt"]) ?? 0, definition: definition(value["definition"]))
    }
}

extension PipelineDetail {
    /// `GET /v0/pipelines/:id` → `{ pipeline }`, its head with its definition.
    public static func read(_ answer: JSONValue) -> PipelineDetail? {
        let value = answer["pipeline"]
        guard let id = value?["id"]?.stringValue, let head = PipelineRead.version(value?["head"]) else { return nil }
        return PipelineDetail(id: id, name: PipelineRead.text(value?["name"]) ?? id, description: PipelineRead.text(value?["description"]),
                              enabled: value?["enabled"]?.boolValue != false, head: head, lastRun: PipelineRead.runSummary(value?["lastRun"]),
                              createdBy: PipelineRead.text(value?["createdBy"]), createdAt: PipelineRead.number(value?["createdAt"]) ?? 0,
                              updatedAt: PipelineRead.number(value?["updatedAt"]) ?? 0)
    }
}

extension AgentClient {
    static func pipelinePath(_ id: String) -> String { "/v0/pipelines/\(escape(id))" }

    /// One pipeline with its head version whole; nil for an answer this app can't read.
    public func pipeline(_ id: String) async throws -> PipelineDetail? {
        PipelineDetail.read(try await decode(JSONValue.self, "GET", Self.pipelinePath(id)))
    }

    /// Its versions, newest first, without their definitions.
    public func pipelineVersions(_ id: String) async throws -> [PipelineVersion] {
        let answer = try await decode(JSONValue.self, "GET", Self.pipelinePath(id) + "/versions")
        return (answer["versions"]?.arrayValue ?? []).compactMap(PipelineRead.version).sorted { $0.number > $1.number }
    }

    /// One version with its definition.
    public func pipelineVersion(_ id: String, number: Int) async throws -> PipelineVersion? {
        PipelineRead.version(try await decode(JSONValue.self, "GET", Self.pipelinePath(id) + "/versions/\(number)")["version"])
    }

    /// One pipeline's runs, newest first, from `cursor` on; archived pipelines' too.
    public func pipelineRuns(of id: String, name: String, cursor: String? = nil) async throws -> PipelineRunPage {
        let query = cursor.map { "?cursor=\(Self.escape($0))" } ?? ""
        let answer = try await decode(JSONValue.self, "GET", Self.pipelinePath(id) + "/runs" + query)
        return PipelineRunPage(runs: (answer["runs"]?.arrayValue ?? []).compactMap { PipelineRead.runListEntry($0, pipelineId: id, name: name) },
                               nextCursor: PipelineRead.text(answer["nextCursor"]))
    }
}

import Foundation
import HappyWire

// One run, its nodes, its log, and the graph of the version it pinned
// (API.md, "Runs", "Node log"), read as desktop's pipelineRead.ts reads
// them: a node, lease or log entry this app can't read drops out.

public enum PipelineNodeRunState: String, Equatable, Sendable, CaseIterable {
    case pending, running, succeeded, failed, skipped, aborted

    /// Ended, whatever the outcome.
    public var ended: Bool { self != .pending && self != .running }
}

/// What a node said about itself: a line and, optionally, how far along it is.
public struct PipelineStatusLine: Equatable, Sendable {
    public var text: String
    /// From 0 to 1, when the node said.
    public var progress: Double?
    public var at: Double

    public init(text: String, progress: Double? = nil, at: Double) {
        self.text = text
        self.progress = progress
        self.at = at
    }
}

/// Tokens and cost one model spent on one agent node.
public struct PipelineModelUsage: Equatable, Sendable {
    public var provider: String
    /// The model's full ID, as definitions name it: `openai/gpt-6.1-terra`.
    public var model: String
    public var input: Double
    public var output: Double
    public var cacheRead: Double
    public var cacheWrite: Double
    public var reasoning: Double
    /// US dollars; nil when the provider didn't price it.
    public var costUsd: Double?

    public init(provider: String, model: String, input: Double = 0, output: Double = 0, cacheRead: Double = 0, cacheWrite: Double = 0, reasoning: Double = 0, costUsd: Double? = nil) {
        self.provider = provider
        self.model = model
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.reasoning = reasoning
        self.costUsd = costUsd
    }
}

/// A named computer a run holds, handed from node to node.
public struct PipelineLease: Equatable, Sendable {
    public var name: String
    public var computerId: String
    /// The nodes holding it now; empty once released.
    public var holders: [String]
    public var releasedAt: Double?
}

public struct PipelineFailure: Equatable, Sendable {
    public var code: String
    public var message: String
}

/// One node's execution inside a run.
public struct PipelineNodeRun: Equatable, Sendable {
    public var nodeId: String
    /// `code`, `agent` or `pipeline`.
    public var kind: String
    public var state: PipelineNodeRunState
    public var status: PipelineStatusLine?
    /// The last 50, oldest first.
    public var statuses: [PipelineStatusLine]
    public var input: JSONValue?
    public var output: JSONValue?
    public var failure: PipelineFailure?
    public var agentId: String?
    public var childRunId: String?
    public var startedAt: Double?
    public var endedAt: Double?
    /// An agent node's spend so far, by provider then model; nil before
    /// its first inference and on other nodes.
    public var usage: [PipelineModelUsage]?
}

/// One run with every node's execution, its leases and its child runs.
public struct PipelineRun: Equatable, Sendable {
    public var id: String
    public var pipelineId: String
    public var version: Int
    public var state: PipelineRunState
    public var trigger: PipelineRunTrigger?
    public var parentRunId: String?
    public var rootRunId: String
    public var group: String?
    public var createdAt: Double
    public var startedAt: Double?
    public var endedAt: Double?
    public var input: JSONValue?
    /// By node, the outputs of the leaves the run reached; nil until it ends.
    public var result: [String: JSONValue]?
    /// As the server lists them, by ID.
    public var nodes: [PipelineNodeRun]
    public var leases: [PipelineLease]
    public var childRunIds: [String]

    /// The runs its pipeline nodes made or joined, each once, oldest first;
    /// a node's child shows from the moment the node names it.
    public var children: [String] {
        var seen = Set<String>()
        return (childRunIds + nodes.compactMap(\.childRunId)).filter { seen.insert($0).inserted }
    }

    /// Its parent, then its children: the runs a run page shows beside it.
    public var relativeIds: [String] {
        var seen = Set<String>()
        return ((parentRunId.map { [$0] } ?? []) + children).filter { seen.insert($0).inserted }
    }

    /// The nodes of this run waiting on one child run; several when they joined one batch run.
    public func nodes(waitingOn childRunId: String) -> [String] {
        nodes.filter { $0.childRunId == childRunId }.map(\.nodeId)
    }
}

/// A run beside the one on screen, its parent or a child, as far as a run
/// page shows it: what it runs, how it stands, how far through its nodes.
public struct PipelineRunRelative: Equatable, Sendable {
    public var id: String
    public var pipelineId: String
    public var version: Int
    public var state: PipelineRunState
    public var startedAt: Double?
    public var endedAt: Double?
    public var nodesEnded: Int
    public var nodesRunning: Int
    /// What its version defines; nil until that version is read.
    public var nodesTotal: Int?
    /// The newest status line among its running nodes.
    public var status: PipelineStatusLine?

    public init(_ run: PipelineRun, nodesTotal: Int?) {
        id = run.id
        pipelineId = run.pipelineId
        version = run.version
        state = run.state
        startedAt = run.startedAt
        endedAt = run.endedAt
        let running = run.nodes.filter { $0.state == .running }
        nodesEnded = run.nodes.filter(\.state.ended).count
        nodesRunning = running.count
        self.nodesTotal = nodesTotal
        status = running.compactMap(\.status).max { $0.at < $1.at }
    }
}

/// The graph of one version, as far as a run page needs it: each node's
/// kind and what it names, and the order to list them in.
public struct PipelineGraph: Equatable, Sendable {
    public struct Node: Equatable, Sendable {
        public var id: String
        public var kind: String
        /// An agent node's model.
        public var model: String?
        /// A pipeline node's pipeline.
        public var pipelineId: String?
        /// The leases it acquires, uses or passes on, by name.
        public var leases: Set<String>
    }

    public struct Edge: Equatable, Sendable {
        public var from: String
        public var to: String
        /// `success` or `failure`.
        public var on: String
    }

    public var root: String
    public var nodes: [String: Node]
    public var edges: [Edge]

    /// The nodes in graph order: by how many steps the longest path from
    /// the root takes to reach them, then by ID. A node no edge reaches
    /// comes after the rest.
    public var order: [String] {
        var depth: [String: Int] = [root: 0]
        // Longest paths in a DAG: relax every edge as many times as there are nodes.
        for _ in 0..<max(1, nodes.count) {
            var moved = false
            for edge in edges {
                guard let from = depth[edge.from] else { continue }
                if (depth[edge.to] ?? -1) < from + 1, from + 1 <= nodes.count {
                    depth[edge.to] = from + 1
                    moved = true
                }
            }
            if !moved { break }
        }
        return nodes.keys.sorted { left, right in
            let (a, b) = (depth[left] ?? .max, depth[right] ?? .max)
            return a != b ? a < b : left < right
        }
    }

    /// The edges leaving `id`, for what it leads to.
    public func next(_ id: String) -> [Edge] { edges.filter { $0.from == id } }
}

/// One thing a node did, in the order it did it. A command or tool call is
/// written as it starts and rewritten in place, under its `seq`, as it ends.
public struct PipelineLogEntry: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// A `print()` in a code node; `stderr` for the error stream.
        case output(text: String, stderr: Bool)
        /// A shell command on a computer the node holds.
        case command(PipelineLogCommand)
        /// `fetch()`, a granted tool, or an agent's tool call.
        case tool(name: String, summary: String, state: String, durationMs: Double?, error: String?)
        /// What an agent node's model said.
        case message(String)
        case status(text: String, progress: Double?)
    }

    public var seq: Int
    public var at: Double
    public var kind: Kind
}

public struct PipelineLogCommand: Equatable, Sendable {
    public var id: String
    public var command: String
    public var cwd: String?
    public var lease: String?
    /// `running`, `exited` or `aborted`.
    public var state: String
    public var exitCode: Int?
    public var durationMs: Double?
    /// The last 64 KiB, so far while it runs.
    public var output: String
    public var outputTruncated: Bool

    /// Aborted, or exited with anything but 0.
    public var failed: Bool { state == "aborted" || (state == "exited" && exitCode != 0) }
}

/// One read of a node's log after a sequence number.
public struct PipelineLogPage: Equatable, Sendable {
    public var entries: [PipelineLogEntry]
    /// What to read after next time.
    public var nextAfter: Int
    /// How many of the oldest entries the server let go.
    public var dropped: Int
    /// Entries already read that were rewritten since, such as a command that finished.
    public var changed: [PipelineLogEntry]
}

extension PipelineRead {
    static func strings(_ value: JSONValue?) -> [String] { (value?.arrayValue ?? []).compactMap(\.stringValue) }

    static func fraction(_ value: JSONValue?) -> Double? { number(value).map { min(1, max(0, $0)) } }

    static func status(_ value: JSONValue?) -> PipelineStatusLine? {
        guard let text = value?["text"]?.stringValue else { return nil }
        return PipelineStatusLine(text: text, progress: fraction(value?["progress"]), at: number(value?["at"]) ?? 0)
    }

    /// `{ [provider]: { [model]: { input, output, cacheRead, cacheWrite, reasoning, costUsd? } } }`.
    static func usage(_ value: JSONValue?) -> [PipelineModelUsage]? {
        guard let providers = value?.objectValue else { return nil }
        func count(_ field: JSONValue?) -> Double { max(0, number(field) ?? 0) }
        let usage = providers.flatMap { provider, models in
            (models.objectValue ?? [:]).compactMap { model, spent -> PipelineModelUsage? in
                guard spent.objectValue != nil else { return nil }
                let cost = number(spent["costUsd"])
                return PipelineModelUsage(provider: provider, model: model, input: count(spent["input"]), output: count(spent["output"]),
                                          cacheRead: count(spent["cacheRead"]), cacheWrite: count(spent["cacheWrite"]), reasoning: count(spent["reasoning"]),
                                          costUsd: cost.flatMap { $0 < 0 ? nil : $0 })
            }
        }.sorted { ($0.provider, $0.model) < ($1.provider, $1.model) }
        return usage.isEmpty ? nil : usage
    }

    static func nodeRun(_ value: JSONValue) -> PipelineNodeRun? {
        guard let nodeId = value["nodeId"]?.stringValue,
              let state = value["state"]?.stringValue.flatMap(PipelineNodeRunState.init(rawValue:)),
              let kind = value["kind"]?.stringValue, ["code", "agent", "pipeline"].contains(kind) else { return nil }
        let failure = value["failure"]?["code"]?.stringValue.map { PipelineFailure(code: $0, message: value["failure"]?["message"]?.stringValue ?? "") }
        func present(_ field: JSONValue?) -> JSONValue? { field == .null ? nil : field }
        return PipelineNodeRun(nodeId: nodeId, kind: kind, state: state, status: status(value["status"]),
                               statuses: (value["statuses"]?.arrayValue ?? []).compactMap(status),
                               input: present(value["input"]), output: present(value["output"]), failure: failure,
                               agentId: text(value["agentId"]), childRunId: text(value["childRunId"]),
                               startedAt: number(value["startedAt"]), endedAt: number(value["endedAt"]), usage: usage(value["usage"]))
    }

    static func lease(_ value: JSONValue) -> PipelineLease? {
        guard let name = value["name"]?.stringValue, let computerId = value["computerId"]?.stringValue else { return nil }
        return PipelineLease(name: name, computerId: computerId, holders: strings(value["holders"]), releasedAt: number(value["releasedAt"]))
    }

    static func logEntry(_ value: JSONValue) -> PipelineLogEntry? {
        guard let seq = integer(value["seq"]) else { return nil }
        let at = number(value["at"]) ?? 0
        let text = value["text"]?.stringValue ?? ""
        let kind: PipelineLogEntry.Kind
        switch value["kind"]?.stringValue {
        case "output": kind = .output(text: text, stderr: value["stream"]?.stringValue == "stderr")
        case "message": kind = .message(text)
        case "status": kind = .status(text: text, progress: fraction(value["progress"]))
        case "command":
            guard let id = value["id"]?.stringValue, let command = value["command"]?.stringValue,
                  let state = value["state"]?.stringValue, ["running", "exited", "aborted"].contains(state) else { return nil }
            kind = .command(PipelineLogCommand(id: id, command: command, cwd: self.text(value["cwd"]), lease: self.text(value["lease"]), state: state,
                                               exitCode: integer(value["exitCode"]), durationMs: number(value["durationMs"]),
                                               output: value["output"]?.stringValue ?? "", outputTruncated: value["outputTruncated"]?.boolValue == true))
        case "tool":
            guard value["id"]?.stringValue != nil, let name = value["name"]?.stringValue,
                  let state = value["state"]?.stringValue, ["running", "ok", "error"].contains(state) else { return nil }
            kind = .tool(name: name, summary: value["summary"]?.stringValue ?? "", state: state, durationMs: number(value["durationMs"]), error: self.text(value["error"]))
        default:
            // A kind this app doesn't know yet is left out rather than guessed at.
            return nil
        }
        return PipelineLogEntry(seq: seq, at: at, kind: kind)
    }
}

extension PipelineRun {
    /// `GET /v0/pipeline-runs/:runId` (and abort's answer) → `{ run }`.
    public static func read(_ answer: JSONValue) -> PipelineRun? {
        guard let run = answer["run"], let id = run["id"]?.stringValue, let pipelineId = run["pipelineId"]?.stringValue,
              let state = PipelineRead.state(run["state"]), let version = PipelineRead.integer(run["version"]) else { return nil }
        let result = run["result"]?.objectValue.map { $0["outputs"]?.objectValue ?? [:] }
        return PipelineRun(id: id, pipelineId: pipelineId, version: version, state: state, trigger: PipelineRead.trigger(run["trigger"]),
                           parentRunId: PipelineRead.text(run["parentRunId"]), rootRunId: PipelineRead.text(run["rootRunId"]) ?? id,
                           group: PipelineRead.text(run["group"]), createdAt: PipelineRead.number(run["createdAt"]) ?? 0,
                           startedAt: PipelineRead.number(run["startedAt"]), endedAt: PipelineRead.number(run["endedAt"]),
                           input: run["input"] == .null ? nil : run["input"], result: result,
                           nodes: (run["nodes"]?.arrayValue ?? []).compactMap(PipelineRead.nodeRun),
                           leases: (run["leases"]?.arrayValue ?? []).compactMap(PipelineRead.lease),
                           childRunIds: PipelineRead.strings(run["childRunIds"]))
    }
}

extension PipelineGraph {
    /// A version's definition (`GET /v0/pipelines/:id/versions/:n` → `{ version: { definition } }`).
    /// The cluster never stores one that doesn't validate, so one this app
    /// can't read is a contract it doesn't know yet: nil, not half a graph.
    public static func read(definition value: JSONValue?) -> PipelineGraph? {
        guard let root = value?["root"]?.stringValue, let entries = value?["nodes"]?.objectValue else { return nil }
        var nodes: [String: Node] = [:]
        for (id, node) in entries {
            guard let kind = node["kind"]?.stringValue, ["code", "agent", "pipeline"].contains(kind) else { return nil }
            let compute = node["compute"]
            let leases = Set((compute?["acquire"]?.arrayValue ?? []).compactMap { $0["name"]?.stringValue }
                + PipelineRead.strings(compute?["use"]) + PipelineRead.strings(compute?["pass"]))
            nodes[id] = Node(id: id, kind: kind, model: PipelineRead.text(node["model"]), pipelineId: node["pipeline"]?.stringValue, leases: leases)
        }
        guard nodes[root] != nil else { return nil }
        let edges = (value?["edges"]?.arrayValue ?? []).compactMap { edge -> Edge? in
            guard let from = edge["from"]?.stringValue, let to = edge["to"]?.stringValue, let on = edge["on"]?.stringValue,
                  on == "success" || on == "failure" else { return nil }
            return Edge(from: from, to: to, on: on)
        }
        guard edges.allSatisfy({ nodes[$0.from] != nil && nodes[$0.to] != nil }) else { return nil }
        return PipelineGraph(root: root, nodes: nodes, edges: edges)
    }
}

extension PipelineLogPage {
    /// `GET …/nodes/:nodeId/log?after=&limit=` → `{ entries, nextAfter, dropped, changed }`.
    public static func read(_ answer: JSONValue, after: Int) -> PipelineLogPage {
        let entries = (answer["entries"]?.arrayValue ?? []).compactMap(PipelineRead.logEntry)
        return PipelineLogPage(entries: entries, nextAfter: PipelineRead.integer(answer["nextAfter"]) ?? entries.last?.seq ?? after,
                               dropped: PipelineRead.integer(answer["dropped"]) ?? 0,
                               changed: (answer["changed"]?.arrayValue ?? []).compactMap(PipelineRead.logEntry))
    }
}

extension AgentClient {
    static func pipelineRunPath(_ runId: String) -> String { "/v0/pipeline-runs/\(escape(runId))" }

    /// One run; nil for an answer this app can't read.
    public func pipelineRun(_ runId: String) async throws -> PipelineRun? {
        PipelineRun.read(try await decode(JSONValue.self, "GET", Self.pipelineRunPath(runId)))
    }

    /// The graph of one version of a pipeline; nil when this app can't read it.
    public func pipelineGraph(_ pipelineId: String, version: Int) async throws -> PipelineGraph? {
        let answer = try await decode(JSONValue.self, "GET", "/v0/pipelines/\(Self.escape(pipelineId))/versions/\(version)")
        return PipelineGraph.read(definition: answer["version"]?["definition"])
    }

    /// One node's log after `after`, oldest first.
    public func pipelineNodeLog(runId: String, nodeId: String, after: Int, limit: Int) async throws -> PipelineLogPage {
        let path = Self.pipelineRunPath(runId) + "/nodes/\(Self.escape(nodeId))/log?after=\(after)&limit=\(limit)"
        return PipelineLogPage.read(try await decode(JSONValue.self, "GET", path), after: after)
    }

    /// Aborts a queued or running run; an ended one comes back as it is.
    public func abortPipelineRun(_ runId: String) async throws -> PipelineRun? {
        PipelineRun.read(try await decode(JSONValue.self, "POST", Self.pipelineRunPath(runId) + "/abort"))
    }
}

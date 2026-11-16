import Foundation
import HappyWire

// Pipelines on Happy Cloud (API.md, "Pipelines"): a fixed, versioned graph
// of work the cluster runs to completion. The phone reads them and aborts
// runs; agents author and start them. Every answer is read here, as
// desktop's `pipelineRead.ts` reads it: tolerant of what it doesn't know,
// so one odd entry drops out rather than failing the list.

public enum PipelineRunState: String, Equatable, Sendable, CaseIterable {
    case queued, running, succeeded, failed, aborted, superseded

    /// Queued or running: it can still be aborted, and its time still runs.
    public var abortable: Bool { self == .queued || self == .running }
}

/// A pipeline's newest run, as its list row shows it.
public struct PipelineRunSummary: Equatable, Sendable {
    public var id: String
    public var state: PipelineRunState
    /// Milliseconds, as every time here.
    public var createdAt: Double
    public var endedAt: Double?

    public init(id: String, state: PipelineRunState, createdAt: Double, endedAt: Double? = nil) {
        self.id = id
        self.state = state
        self.createdAt = createdAt
        self.endedAt = endedAt
    }
}

/// One row of the pipelines list.
public struct PipelineSummary: Equatable, Sendable {
    public var id: String
    public var name: String
    public var description: String?
    public var headVersion: Int
    public var enabled: Bool
    public var lastRun: PipelineRunSummary?

    public init(id: String, name: String, description: String? = nil, headVersion: Int, enabled: Bool = true, lastRun: PipelineRunSummary? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.headVersion = headVersion
        self.enabled = enabled
        self.lastRun = lastRun
    }
}

/// How a run came to be: an agent's `run_pipeline`, or a `pipeline` node of
/// a parent run.
public enum PipelineRunTrigger: Equatable, Sendable {
    /// Nil when the server no longer names the agent.
    case agent(String?)
    case pipeline(runId: String, nodeId: String)
}

/// One run among every pipeline's runs (`GET /v0/pipeline-runs`): its
/// entry, and which pipeline it ran.
public struct PipelineRunListEntry: Equatable, Sendable {
    public var id: String
    public var version: Int
    public var state: PipelineRunState
    /// Nil for a trigger this app can't read.
    public var trigger: PipelineRunTrigger?
    public var parentRunId: String?
    public var createdAt: Double
    public var startedAt: Double?
    public var endedAt: Double?
    public var pipelineId: String
    public var pipelineName: String
    /// Its pipeline was archived: the run still reads, the pipeline's page doesn't.
    public var pipelineArchived: Bool

    public init(id: String, version: Int, state: PipelineRunState, trigger: PipelineRunTrigger?, parentRunId: String? = nil, createdAt: Double,
                startedAt: Double? = nil, endedAt: Double? = nil, pipelineId: String, pipelineName: String, pipelineArchived: Bool = false) {
        self.id = id
        self.version = version
        self.state = state
        self.trigger = trigger
        self.parentRunId = parentRunId
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.pipelineId = pipelineId
        self.pipelineName = pipelineName
        self.pipelineArchived = pipelineArchived
    }
}

/// A page of runs, newest first; `nextCursor` is nil on the last page.
public struct PipelineRunPage: Equatable, Sendable {
    public var runs: [PipelineRunListEntry]
    public var nextCursor: String?

    public init(runs: [PipelineRunListEntry], nextCursor: String?) {
        self.runs = runs
        self.nextCursor = nextCursor
    }
}

enum PipelineRead {
    static func text(_ value: JSONValue?) -> String? {
        guard let text = value?.stringValue, !text.isEmpty else { return nil }
        return text
    }

    static func number(_ value: JSONValue?) -> Double? {
        guard let number = value?.numberValue, number.isFinite else { return nil }
        return number
    }

    static func integer(_ value: JSONValue?) -> Int? { number(value).map { Int($0) } }

    static func state(_ value: JSONValue?) -> PipelineRunState? { value?.stringValue.flatMap(PipelineRunState.init(rawValue:)) }

    static func runSummary(_ value: JSONValue?) -> PipelineRunSummary? {
        guard let value, let id = value["id"]?.stringValue, let state = state(value["state"]) else { return nil }
        return PipelineRunSummary(id: id, state: state, createdAt: number(value["createdAt"]) ?? 0, endedAt: number(value["endedAt"]))
    }

    static func summary(_ value: JSONValue) -> PipelineSummary? {
        guard let id = value["id"]?.stringValue, let head = integer(value["head"]?["number"]) else { return nil }
        return PipelineSummary(id: id, name: text(value["name"]) ?? id, description: text(value["description"]), headVersion: head,
                               enabled: value["enabled"]?.boolValue != false, lastRun: runSummary(value["lastRun"]))
    }

    static func trigger(_ value: JSONValue?) -> PipelineRunTrigger? {
        switch value?["kind"]?.stringValue {
        // An agent the server no longer names (its agent removed) is still an agent's run.
        case "agent": return .agent(text(value?["agentId"]))
        case "pipeline":
            guard let runId = value?["runId"]?.stringValue, let nodeId = value?["nodeId"]?.stringValue else { return nil }
            return .pipeline(runId: runId, nodeId: nodeId)
        default: return nil
        }
    }

    static func runListEntry(_ value: JSONValue) -> PipelineRunListEntry? {
        guard let id = value["id"]?.stringValue, let state = state(value["state"]), let version = integer(value["version"]),
              let pipelineId = value["pipelineId"]?.stringValue else { return nil }
        return PipelineRunListEntry(id: id, version: version, state: state, trigger: trigger(value["trigger"]), parentRunId: text(value["parentRunId"]),
                                    createdAt: number(value["createdAt"]) ?? 0, startedAt: number(value["startedAt"]), endedAt: number(value["endedAt"]),
                                    pipelineId: pipelineId, pipelineName: text(value["pipelineName"]) ?? pipelineId,
                                    pipelineArchived: value["pipelineArchived"]?.boolValue == true)
    }
}

extension PipelineSummary {
    /// `GET /v0/pipelines` → `{ pipelines }`, by name.
    public static func list(_ answer: JSONValue) -> [PipelineSummary] {
        (answer["pipelines"]?.arrayValue ?? []).compactMap(PipelineRead.summary)
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
}

extension PipelineRunPage {
    /// `GET /v0/pipeline-runs?cursor=` → `{ runs, nextCursor }`, newest first.
    public static func read(_ answer: JSONValue) -> PipelineRunPage {
        PipelineRunPage(runs: (answer["runs"]?.arrayValue ?? []).compactMap(PipelineRead.runListEntry), nextCursor: PipelineRead.text(answer["nextCursor"]))
    }

    /// A first page read again over what is kept, newest first. A reader
    /// who paged past the first page keeps the older runs they read, below
    /// the fresh page; one who didn't takes the page as it is
    /// (`pipelineRunsMerge`).
    public static func merge(_ previous: [PipelineRunListEntry], page: [PipelineRunListEntry], complete: Bool) -> [PipelineRunListEntry] {
        if complete { return page }
        let fresh = Set(page.map(\.id))
        let oldest = page.last?.createdAt ?? .infinity
        return page + previous.filter { !fresh.contains($0.id) && $0.createdAt <= oldest }
    }
}

extension AgentClient {
    /// The team's pipelines, by name.
    public func pipelines() async throws -> [PipelineSummary] {
        PipelineSummary.list(try await decode(JSONValue.self, "GET", "/v0/pipelines"))
    }

    /// Every pipeline's runs, newest first, from `cursor` (a run ID) on.
    public func pipelineRuns(cursor: String? = nil) async throws -> PipelineRunPage {
        let query = cursor.map { "?cursor=\(Self.escape($0))" } ?? ""
        return PipelineRunPage.read(try await decode(JSONValue.self, "GET", "/v0/pipeline-runs" + query))
    }
}

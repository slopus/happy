#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
import HappyWire

/// A Happy Cloud server's pipelines and runs as happy-cluster answers
/// them (API.md, "Pipelines"), for `ClusterServer` before a server with
/// real runs is at hand. Times are set from when it was made, so running
/// runs count from a minute or so. `advance` moves it on as the cluster
/// would: the running deploy and its child succeed, the queued sweep
/// starts, and a new run of Triage inbox comes in.
struct ClusterPipelines {
    struct Run {
        var id: String
        var pipeline: String
        var version: Int
        var state: String
        var trigger: String
        var parent: String?
        var created: Double
        var started: Double?
        var ended: Double?
    }

    static let names = [
        "deploy": "Deploy preview", "build": "Build and sign", "sweep": "Nightly test sweep",
        "notes": "Release notes", "triage": "Triage inbox", "importer": "Old importer",
    ]

    let now: Double
    private(set) var runs: [Run]
    /// Runs at the end the first page leaves for the second.
    let pageSize = 8

    init(now: Date = Date()) {
        let now = (now.timeIntervalSince1970 * 1000).rounded()
        self.now = now
        func ago(_ seconds: Double) -> Double { now - seconds * 1000 }
        let agent = { (id: String) in #"{"kind":"agent","agentId":"\#(id)"}"# }
        let node = { (run: String, node: String) in #"{"kind":"pipeline","runId":"\#(run)","nodeId":"\#(node)"}"# }
        runs = [
            Run(id: "r1", pipeline: "deploy", version: 7, state: "running", trigger: agent("t1-agent"), created: ago(72), started: ago(72)),
            Run(id: "r2", pipeline: "build", version: 4, state: "running", trigger: node("r1", "build"), parent: "r1", created: ago(50), started: ago(50)),
            Run(id: "r3", pipeline: "sweep", version: 12, state: "queued", trigger: agent("cos-agent"), created: ago(40)),
            Run(id: "r4", pipeline: "sweep", version: 12, state: "failed", trigger: agent("cos-agent"), created: ago(3 * 3600), started: ago(3 * 3600), ended: ago(3 * 3600 - 843)),
            Run(id: "r5", pipeline: "build", version: 4, state: "succeeded", trigger: node("r6", "build"), parent: "r6", created: ago(24 * 60), started: ago(24 * 60), ended: ago(20 * 60)),
            Run(id: "r6", pipeline: "deploy", version: 6, state: "superseded", trigger: agent("t1-agent"), created: ago(25 * 60), started: ago(25 * 60), ended: ago(19 * 60)),
            Run(id: "r7", pipeline: "importer", version: 2, state: "succeeded", trigger: #"{"kind":"agent","agentId":null}"#, created: ago(26 * 3600), started: ago(26 * 3600), ended: ago(26 * 3600 - 95)),
            Run(id: "r8", pipeline: "notes", version: 3, state: "aborted", trigger: agent("gone-agent"), created: ago(2 * 86400), started: ago(2 * 86400), ended: ago(2 * 86400 - 30)),
            Run(id: "r9", pipeline: "notes", version: 2, state: "succeeded", trigger: agent("cos-agent"), created: ago(4 * 86400), started: ago(4 * 86400), ended: ago(4 * 86400 - 212)),
            Run(id: "r10", pipeline: "sweep", version: 11, state: "succeeded", trigger: agent("cos-agent"), created: ago(9 * 86400), started: ago(9 * 86400), ended: ago(9 * 86400 - 3910)),
            Run(id: "r11", pipeline: "build", version: 3, state: "succeeded", trigger: node("r-old", "build"), parent: "r-old", created: ago(10 * 86400), started: ago(10 * 86400), ended: ago(10 * 86400 - 260)),
        ]
    }

    /// What happens next, at `now`: the deploy and its build succeed, the
    /// queued sweep starts, a new triage run comes in.
    mutating func advance(at now: Date = Date()) {
        let at = (now.timeIntervalSince1970 * 1000).rounded()
        for index in runs.indices {
            switch runs[index].id {
            case "r1", "r2": runs[index].state = "succeeded"; runs[index].ended = at
            case "r3": runs[index].state = "running"; runs[index].started = at
            default: break
            }
        }
        runs.insert(Run(id: "r12", pipeline: "triage", version: 1, state: "running", trigger: #"{"kind":"agent","agentId":"cos-agent"}"#, created: at, started: at), at: 0)
    }

    private func json(_ run: Run) -> String {
        func number(_ value: Double?) -> String { value.map { String(Int64($0)) } ?? "null" }
        let parent = run.parent.map { "\"\($0)\"" } ?? "null"
        let name = Self.names[run.pipeline] ?? run.pipeline
        return #"{"id":"\#(run.id)","version":\#(run.version),"state":"\#(run.state)","trigger":\#(run.trigger),"parentRunId":\#(parent),"createdAt":\#(number(run.created)),"startedAt":\#(number(run.started)),"endedAt":\#(number(run.ended)),"pipelineId":"\#(run.pipeline)","pipelineName":"\#(name)","pipelineArchived":\#(run.pipeline == "importer")}"#
    }

    private var pipelines: String {
        let heads = ["build": 4, "deploy": 7, "notes": 3, "sweep": 12, "triage": 1]
        let list = heads.keys.sorted().map { id -> String in
            let last = runs.first { $0.pipeline == id }
            let lastRun = last.map { #"{"id":"\#($0.id)","state":"\#($0.state)","createdAt":\#(Int64($0.created)),"endedAt":\#($0.ended.map { String(Int64($0)) } ?? "null")}"# } ?? "null"
            let head = heads[id] ?? 1
            return #"{"id":"\#(id)","name":"\#(Self.names[id] ?? id)","description":null,"enabled":\#(id != "notes"),"head":{"number":\#(head),"digest":"d\#(head)","message":"","createdAt":\#(Int64(now))},"lastRun":\#(lastRun),"createdBy":"steve","createdAt":\#(Int64(now)),"updatedAt":\#(Int64(now))}"#
        }
        return #"{"pipelines":[\#(list.joined(separator: ","))]}"#
    }

    /// The answer to a pipelines route, nil for any other.
    func answer(_ method: String, _ path: String) -> String? {
        guard method == "GET" else { return nil }
        if path == "/v0/pipelines" { return pipelines }
        guard path.hasPrefix("/v0/pipeline-runs"), !path.hasPrefix("/v0/pipeline-runs/") else { return nil }
        let cursor = URLComponents(string: path)?.queryItems?.first { $0.name == "cursor" }?.value
        let start = cursor.flatMap { id in runs.firstIndex { $0.id == id }.map { $0 + 1 } } ?? 0
        let page = Array(runs.dropFirst(start).prefix(pageSize))
        let next = start + page.count < runs.count ? page.last.map { "\"\($0.id)\"" } ?? "null" : "null"
        return #"{"runs":[\#(page.map(json).joined(separator: ","))],"nextCursor":\#(next)}"#
    }
}
#endif

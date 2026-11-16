#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
import HappyWire

/// A Happy Cloud server's pipelines and runs as happy-cluster answers
/// them (API.md, "Pipelines"), for `ClusterServer` before a server with
/// real runs is at hand: the runs list, each run with its nodes, the
/// graphs of the versions they pinned, the nodes' logs, and abort. Times
/// are set from when it was made, so running runs count from a minute or
/// so. `tick` adds a line to the running migration's log; `advance` moves
/// it on as the cluster would: the running deploy and its child succeed,
/// the queued sweep starts, and a new run of Triage inbox comes in.
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
    /// `advance` has happened, at this time.
    private var advanced: Double?
    /// Lines `tick` added to the running migration's output.
    private var ticks = 0
    /// Abort is refused (`-abortrefused`), as when the server can't reach its worker.
    var refusesAbort = false
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
        advanced = at
        for index in runs.indices {
            switch runs[index].id {
            case "r1", "r2":
                // One aborted before stays aborted.
                guard runs[index].state == "running" else { continue }
                runs[index].state = "succeeded"
                runs[index].ended = at
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

    /// A route's answer, and the events it journals.
    struct Answer {
        var status = 200
        var body: String
        var events: [(type: String, payload: String)] = []
    }

    /// The answer to a pipelines route, nil for any other.
    mutating func answer(_ method: String, _ path: String) -> Answer? {
        let route = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        let parts = route.split(separator: "/").map(String.init)
        if method == "POST", parts.count == 4, parts[1] == "pipeline-runs", parts[3] == "abort" { return abort(parts[2]) }
        guard method == "GET" else { return nil }
        if route == "/v0/pipelines" { return Answer(body: pipelines) }
        if route == "/v0/pipeline-runs" {
            let cursor = URLComponents(string: path)?.queryItems?.first { $0.name == "cursor" }?.value
            let start = cursor.flatMap { id in runs.firstIndex { $0.id == id }.map { $0 + 1 } } ?? 0
            let page = Array(runs.dropFirst(start).prefix(pageSize))
            let next = start + page.count < runs.count ? page.last.map { "\"\($0.id)\"" } ?? "null" : "null"
            return Answer(body: #"{"runs":[\#(page.map(json).joined(separator: ","))],"nextCursor":\#(next)}"#)
        }
        // /v0/pipelines/:id/versions/:n
        if parts.count == 5, parts[1] == "pipelines", parts[3] == "versions", let number = Int(parts[4]) {
            guard let graph = Self.graphs[parts[2]] else { return missing }
            return Answer(body: Self.encode(["version": ["number": number, "message": "", "definition": graph] as [String: Any]]))
        }
        guard parts.count >= 3, parts[1] == "pipeline-runs", let run = runs.first(where: { $0.id == parts[2] }) else {
            return parts.count >= 3 && parts[1] == "pipeline-runs" ? missing : nil
        }
        if parts.count == 3 { return Answer(body: Self.encode(["run": detail(run)])) }
        // /v0/pipeline-runs/:id/nodes/:nodeId/log
        guard parts.count == 6, parts[3] == "nodes", parts[5] == "log" else { return missing }
        guard let node = nodes(run).first(where: { $0.id == parts[4] }) else { return missing }
        let after = URLComponents(string: path)?.queryItems?.first { $0.name == "after" }?.value.flatMap(Int.init) ?? 0
        let entries = log(run, node)
        let newer = entries.filter { ($0["seq"] as? Int ?? 0) > after }
        // The migration's command grows while it runs, and closes.
        let changed = run.id == "r1" && node.id == "migrate" ? entries.filter { $0["kind"] as? String == "command" && ($0["seq"] as? Int ?? 0) <= after } : []
        return Answer(body: Self.encode(["entries": newer, "nextAfter": newer.last?["seq"] ?? after, "dropped": 0, "changed": changed]))
    }

    private var missing: Answer { Answer(status: 404, body: #"{"code":"not_found","error":"No such run."}"#) }

    /// Aborts a queued or running run and the child runs under it; an
    /// ended one comes back as it is.
    private mutating func abort(_ id: String) -> Answer? {
        guard let index = runs.firstIndex(where: { $0.id == id }) else { return missing }
        if refusesAbort, ["queued", "running"].contains(runs[index].state) {
            return Answer(status: 503, body: #"{"code":"unavailable","error":"The run’s worker didn’t answer. Try again."}"#)
        }
        var events: [(type: String, payload: String)] = []
        let at = (Date().timeIntervalSince1970 * 1000).rounded()
        var aborting = [id]
        while let next = aborting.popLast() {
            guard let position = runs.firstIndex(where: { $0.id == next }), ["queued", "running"].contains(runs[position].state) else { continue }
            runs[position].state = "aborted"
            runs[position].ended = at
            events.append(("pipeline.run.updated", #"{"pipelineId":"\#(runs[position].pipeline)","runId":"\#(next)"}"#))
            aborting += runs.filter { $0.parent == next }.map(\.id)
        }
        return Answer(body: Self.encode(["run": detail(runs[index])]), events: events)
    }

    /// Another line in the running migration's log, while the deploy runs.
    mutating func tick() -> [(type: String, payload: String)] {
        guard runs.first(where: { $0.id == "r1" })?.state == "running" else { return [] }
        ticks += 1
        return [("pipeline.node.log", #"{"runId":"r1","nodeId":"migrate"}"#), ("pipeline.node.updated", #"{"pipelineId":"deploy","runId":"r1","nodeId":"migrate"}"#)]
    }

    // MARK: Graphs

    /// Each pipeline's definition; every version of one has the same graph here.
    static var graphs: [String: [String: Any]] { [
        "deploy": definition(root: "checkout", [
            "checkout": ["kind": "code"],
            "build": ["kind": "pipeline", "pipeline": "build"],
            "migrate": ["kind": "code", "compute": ["acquire": [["name": "box", "pool": "linux"]]] as [String: Any]],
            "review": ["kind": "agent", "model": "anthropic/claude-opus-5"],
            "release": ["kind": "code"],
            "notify": ["kind": "code"],
        ], ["checkout>build", "checkout>migrate", "checkout>review", "build>release", "migrate>release", "review>release", "build!notify"]),
        "build": definition(root: "fetch", [
            "fetch": ["kind": "code", "compute": ["acquire": [["name": "mac", "pool": "macos"]], "pass": ["mac"]] as [String: Any]],
            "compile": ["kind": "code", "compute": ["use": ["mac"], "pass": ["mac"]] as [String: Any]],
            "sign": ["kind": "code", "compute": ["use": ["mac"]] as [String: Any]],
            "upload": ["kind": "code"],
        ], ["fetch>compile", "compile>sign", "sign>upload"]),
        "sweep": definition(root: "plan", [
            "plan": ["kind": "agent", "model": "openai/gpt-6.1-sol"],
            "tests": ["kind": "code", "compute": ["acquire": [["name": "runner", "pool": "linux"]]] as [String: Any]],
            "triage": ["kind": "agent", "model": "openai/gpt-6.1-sol"],
            "report": ["kind": "code"],
        ], ["plan>tests", "tests>triage", "tests!report"]),
        "notes": definition(root: "collect", ["collect": ["kind": "code"], "write": ["kind": "agent", "model": "anthropic/claude-opus-5"], "publish": ["kind": "code"]],
                            ["collect>write", "write>publish"]),
        "triage": definition(root: "read", ["read": ["kind": "code"], "sort": ["kind": "agent", "model": "openai/gpt-6.1-terra"]], ["read>sort"]),
        "importer": definition(root: "import", ["import": ["kind": "code"]], []),
    ] }

    /// `a>b` runs b when a succeeds, `a!b` when it fails.
    private static func definition(root: String, _ nodes: [String: [String: Any]], _ edges: [String]) -> [String: Any] {
        let edges = edges.map { edge -> [String: Any] in
            let failure = edge.contains("!")
            let ends = edge.split(whereSeparator: { $0 == ">" || $0 == "!" }).map(String.init)
            return ["from": ends[0], "to": ends[1], "on": failure ? "failure" : "success"]
        }
        return ["root": root, "nodes": nodes, "edges": edges]
    }

    // MARK: Runs

    /// One node's run, as `GET /v0/pipeline-runs/:id` lists it.
    struct Node {
        var id: String
        var kind = "code"
        var state: String
        var started: Double?
        var ended: Double?
        /// Its status lines, oldest first; the last is its status.
        var statuses: [(String, Double?)] = []
        var input: Any = NSNull()
        var output: Any = NSNull()
        var failure: (code: String, message: String)?
        var agent: String?
        var child: String?
        var usage: [String: Any]?
    }

    /// What `run` holds now: its nodes, its leases, its children.
    private func detail(_ run: Run) -> [String: Any] {
        let nodes = nodes(run)
        let input: [String: Any] = switch run.pipeline {
        case "deploy": ["branch": "main", "preview": true]
        case "build": ["commit": "9f2c1ab", "target": "ios"]
        case "sweep": ["suite": "nightly", "shards": 4]
        case "notes": ["since": "v2026.11.0"]
        default: ["source": "inbox"]
        }
        var result: Any = NSNull()
        if ["succeeded", "failed"].contains(run.state) {
            let graph = Self.graphs[run.pipeline]
            let leaves = nodes.filter { node in
                node.state == "succeeded" && !((graph?["edges"] as? [[String: Any]]) ?? []).contains { edge in
                    edge["from"] as? String == node.id && nodes.contains { $0.id == edge["to"] as? String && $0.state != "skipped" }
                }
            }
            result = ["outputs": Dictionary(leaves.map { ($0.id, $0.output) }, uniquingKeysWith: { first, _ in first })]
        }
        let leases: [[String: Any]] = switch run.pipeline {
        case "deploy" where run.started != nil:
            [["name": "box", "computerId": "linux-04", "holders": run.state == "running" && nodes.contains { $0.id == "migrate" && $0.state == "running" } ? ["migrate"] : [],
              "releasedAt": run.state == "running" ? NSNull() as Any : (run.ended ?? now) as Any]]
        case "build" where run.started != nil:
            [["name": "mac", "computerId": "mac-mini-2", "holders": run.state == "running" ? ["compile"] : [], "releasedAt": run.state == "running" ? NSNull() as Any : (run.ended ?? now) as Any]]
        case "sweep" where run.started != nil && run.state != "running":
            [["name": "runner", "computerId": "linux-11", "holders": [], "releasedAt": (run.ended ?? now) as Any]]
        default: []
        }
        return [
            "id": run.id, "pipelineId": run.pipeline, "version": run.version, "state": run.state,
            "trigger": (try? JSONSerialization.jsonObject(with: Data(run.trigger.utf8))) ?? NSNull(),
            "parentRunId": run.parent as Any? ?? NSNull(), "rootRunId": root(run), "group": run.pipeline == "deploy" ? "preview-main" as Any : NSNull(),
            "createdAt": run.created, "startedAt": run.started as Any? ?? NSNull(), "endedAt": run.ended as Any? ?? NSNull(),
            "input": input, "result": result, "leases": leases,
            "childRunIds": Array(runs.filter { $0.parent == run.id }.map(\.id).reversed()),
            "nodes": nodes.map { node -> [String: Any] in
                let statuses = node.statuses.enumerated().map { index, line -> [String: Any] in
                    ["text": line.0, "progress": line.1 as Any? ?? NSNull(), "at": (node.started ?? now) + Double(index + 1) * 4000]
                }
                var json: [String: Any] = [
                    "nodeId": node.id, "kind": node.kind, "state": node.state, "status": statuses.last as Any? ?? NSNull(), "statuses": statuses,
                    "input": node.input, "output": node.output,
                    "failure": node.failure.map { ["code": $0.code, "message": $0.message] } as Any? ?? NSNull(),
                    "agentId": node.agent as Any? ?? NSNull(), "childRunId": node.child as Any? ?? NSNull(),
                    "startedAt": node.started as Any? ?? NSNull(), "endedAt": node.ended as Any? ?? NSNull(),
                ]
                if node.kind == "agent" { json["usage"] = node.usage as Any? ?? NSNull() }
                return json
            },
        ]
    }

    private func root(_ run: Run) -> String {
        var run = run
        while let parent = run.parent, let next = runs.first(where: { $0.id == parent }) { run = next }
        return run.parent ?? run.id
    }

    /// The node runs `run` has: those it reached, in order of starting.
    private func nodes(_ run: Run) -> [Node] {
        let started = run.started ?? now
        func at(_ seconds: Double) -> Double { started + seconds * 1000 }
        let ended = run.ended
        let live = run.state == "running"
        /// A node still working when the run was aborted or superseded ends with it.
        func stopped(_ node: Node) -> Node {
            guard node.state == "running" || node.state == "pending", let ended else { return node }
            var node = node
            node.state = "aborted"
            node.ended = ended
            return node
        }
        let opus = ["anthropic": ["anthropic/claude-opus-5": ["input": 18234, "output": 912, "cacheRead": 12288, "cacheWrite": 0, "reasoning": 340, "costUsd": 0.0421]]]
        var nodes: [Node]
        switch run.pipeline {
        case "deploy":
            let done = run.state == "succeeded"
            let child = runs.first { $0.parent == run.id }
            let built = done || child?.state == "succeeded"
            nodes = [
                Node(id: "checkout", state: "succeeded", started: at(0), ended: at(6), input: ["branch": "main"], output: ["commit": "9f2c1ab", "branch": "main"]),
                Node(id: "build", kind: "pipeline", state: built ? "succeeded" : "running", started: at(22), ended: built ? child?.ended ?? ended : nil,
                     statuses: [("Waiting on Build and sign", nil)], input: ["commit": "9f2c1ab", "target": "ios"],
                     output: built ? ["upload": ["build": "2026.11.15-412", "url": "https://builds.acme.dev/412"]] as Any : NSNull(),
                     child: child?.id),
                Node(id: "migrate", state: done ? "succeeded" : "running", started: at(8), ended: done ? ended : nil,
                     statuses: [("Connecting to the preview database", nil), ("Applying migration 1 of 5", 0.2), ("Applying migration 2 of 5", 0.4), ("Applying migration 3 of 5", 0.6)]
                        + (done ? [("All 5 migrations applied", 1)] : []),
                     input: ["commit": "9f2c1ab"], output: done ? ["applied": 5] as Any : NSNull()),
                Node(id: "review", kind: "agent", state: done ? "succeeded" : "running", started: at(8), ended: done ? ended : nil,
                     statuses: [("Reading the diff", 0.3)], input: ["commit": "9f2c1ab"],
                     output: done ? ["verdict": "ship", "notes": "Migrations are reversible; the new screen has tests."] as Any : NSNull(),
                     agent: "node-agent-review", usage: opus),
            ]
            if done {
                nodes.append(Node(id: "release", state: "succeeded", started: ended, ended: ended, output: ["url": "https://preview.acme.dev/9f2c1ab"]))
                nodes.append(Node(id: "notify", state: "skipped"))
            }
        case "build":
            let done = run.state == "succeeded"
            nodes = [
                Node(id: "fetch", state: "succeeded", started: at(0), ended: at(4), output: ["path": "/work/acme"]),
                Node(id: "compile", state: done ? "succeeded" : "running", started: at(4), ended: done ? ended : nil,
                     statuses: [("Compiling 412 files", 0.35)], output: done ? ["warnings": 3] as Any : NSNull()),
            ]
            if done {
                nodes.append(Node(id: "sign", state: "succeeded", started: ended, ended: ended, output: ["signed": true]))
                nodes.append(Node(id: "upload", state: "succeeded", started: ended, ended: ended, output: ["build": "2026.11.15-412", "url": "https://builds.acme.dev/412"]))
            }
        case "sweep":
            guard run.started != nil else { return [] }
            let unpriced: [String: Any] = ["openai": ["openai/gpt-6.1-sol": ["input": 52310, "output": 2210, "cacheRead": 40960, "cacheWrite": 0, "reasoning": 1180, "costUsd": 0.1874]],
                                           "local": ["local/qwen-coder": ["input": 8120, "output": 640, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0]]]
            nodes = [Node(id: "plan", kind: "agent", state: live ? "running" : "succeeded", started: at(0), ended: live ? nil : at(48),
                          statuses: [("Picking the shards", 0.5)], input: ["suite": "nightly"], output: live ? NSNull() : ["shards": ["ui", "core", "sync", "web"]] as Any,
                          agent: "node-agent-plan", usage: live ? [:] : unpriced)]
            if run.state == "failed" {
                nodes.append(Node(id: "tests", state: "failed", started: at(48), ended: at(820), statuses: [("Shard 3 of 4", 0.75)], input: ["shards": ["ui", "core", "sync", "web"]],
                                  failure: ("exception", """
                                  Traceback (most recent call last):
                                    File "main.py", line 31, in main
                                      raise RuntimeError(f"{failed} tests failed in shard {shard}")
                                  RuntimeError: 2 tests failed in shard sync
                                  """)))
                nodes.append(Node(id: "triage", kind: "agent", state: "skipped"))
                nodes.append(Node(id: "report", state: "succeeded", started: at(820), ended: at(843), output: ["posted": "#eng-alerts"]))
            } else if !live {
                nodes.append(Node(id: "tests", state: "succeeded", started: at(48), ended: at(3800), output: ["passed": 2210]))
                nodes.append(Node(id: "triage", kind: "agent", state: "succeeded", started: at(3800), ended: at(3900), output: ["issues": 0], agent: "node-agent-t", usage: unpriced))
                nodes.append(Node(id: "report", state: "skipped"))
            }
        case "notes":
            nodes = [
                Node(id: "collect", state: "succeeded", started: at(0), ended: at(9), output: ["changes": 14]),
                Node(id: "write", kind: "agent", state: run.state == "succeeded" ? "succeeded" : "running", started: at(9), ended: run.state == "succeeded" ? ended : nil,
                     statuses: [("Drafting", 0.4)], agent: "node-agent-notes", usage: opus),
            ]
            if run.state == "succeeded" { nodes.append(Node(id: "publish", state: "succeeded", started: ended, ended: ended, output: ["url": "https://acme.dev/notes"])) }
        case "triage":
            nodes = [
                Node(id: "read", state: "succeeded", started: at(0), ended: live ? at(0) : at(3), output: ["messages": 12]),
                Node(id: "sort", kind: "agent", state: live ? "running" : "succeeded", started: at(0), ended: live ? nil : ended, statuses: [("Sorting 12 messages", 0.1)],
                     agent: "node-agent-sort", usage: live ? nil : opus),
            ]
        default:
            nodes = [Node(id: "import", state: "succeeded", started: at(0), ended: ended, output: ["rows": 1280])]
        }
        return nodes.map(stopped)
    }

    // MARK: Logs

    /// The entries `node` of `run` logged, in order.
    private func log(_ run: Run, _ node: Node) -> [[String: Any]] {
        var entries: [[String: Any]] = []
        var at = node.started ?? now
        func add(_ entry: [String: Any]) {
            at += 1500
            var entry = entry
            entry["seq"] = entries.count + 1
            entry["at"] = at
            entries.append(entry)
        }
        func out(_ text: String, stderr: Bool = false) { add(["kind": "output", "stream": stderr ? "stderr" : "stdout", "text": text]) }
        func command(_ id: String, _ line: String, lease: String?, state: String = "exited", exit: Int? = 0, ms: Double?, output: String) {
            add(["kind": "command", "id": id, "command": line, "cwd": "/work/acme", "lease": lease as Any? ?? NSNull(), "state": state,
                 "exitCode": exit as Any? ?? NSNull(), "durationMs": ms as Any? ?? NSNull(), "output": output, "outputTruncated": false])
        }
        func tool(_ id: String, _ name: String, _ summary: String, state: String = "ok", ms: Double? = 420, error: String? = nil) {
            add(["kind": "tool", "id": id, "name": name, "summary": summary, "state": state, "durationMs": ms as Any? ?? NSNull(), "error": error as Any? ?? NSNull()])
        }
        func message(_ text: String) { add(["kind": "message", "text": text]) }
        func status(_ text: String, _ progress: Double?) { add(["kind": "status", "text": text, "progress": progress as Any? ?? NSNull()]) }
        guard node.started != nil else { return [] }
        switch (run.pipeline, node.id) {
        case ("deploy", "checkout"):
            command("sh-1", "git fetch --depth 1 origin main", lease: nil, ms: 1840, output: "From github.com:acme/app\n * branch            main       -> FETCH_HEAD\n")
            command("sh-2", "git rev-parse --short HEAD", lease: nil, ms: 35, output: "9f2c1ab\n")
            out("Checked out 9f2c1ab on main")
        case ("deploy", "migrate"):
            status("Connecting to the preview database", nil)
            command("sh-1", "psql \"$PREVIEW_DB\" -c 'select version()'", lease: "box", ms: 610, output: " PostgreSQL 17.2 on x86_64-pc-linux-gnu\n(1 row)\n")
            status("Applying migration 1 of 5", 0.2)
            out("0041_add_projects_archived: ok (212 ms)")
            status("Applying migration 2 of 5", 0.4)
            out("0042_backfill_project_owner: ok (3.1 s)")
            out("warning: 12 projects had no owner; set to the workspace admin", stderr: true)
            status("Applying migration 3 of 5", 0.6)
            let finished = run.state != "running" || advanced != nil
            let lines = (1...max(1, ticks + 3)).map { "  copied batch \($0) of 40 (\($0 * 2500) rows)" }.joined(separator: "\n")
            command("sh-2", "./migrate up 0043_split_events --batch 2500", lease: "box", state: finished ? (run.state == "aborted" ? "aborted" : "exited") : "running",
                    exit: finished && run.state != "aborted" ? 0 : nil, ms: finished ? 48_200 : nil, output: "0043_split_events: copying events\n" + lines + "\n")
            for tick in 0..<ticks { out("0043_split_events: batch \(tick + 4) of 40 committed") }
            if run.state == "succeeded" {
                out("0044_events_index: ok (840 ms)")
                out("0045_drop_old_events: ok (95 ms)")
                status("All 5 migrations applied", 1)
            }
        case ("deploy", "review"):
            message("I'll read the diff between the last preview and 9f2c1ab, then check the migrations can be rolled back.")
            tool("call-1", "read_file", "migrations/0043_split_events.sql", ms: 120)
            tool("call-2", "sh", "git diff --stat preview..9f2c1ab", ms: 380)
            command("sh-call-2", "git diff --stat preview..9f2c1ab", lease: nil, ms: 380,
                    output: " app/projects/archive.swift       |  84 +++++++++\n migrations/0043_split_events.sql | 120 ++++++++++++\n 2 files changed, 204 insertions(+)\n")
            message("The new migration copies events in batches and keeps the old table until 0045, so it can be rolled back until then.")
            tool("call-3", "web_fetch", "https://ci.acme.dev/runs/9f2c1ab", state: "error", ms: 5000, error: "Timed out after 5 s")
            status("Reading the diff", 0.3)
            if run.state == "running" { tool("call-4", "read_file", "app/projects/archive.swift", state: "running", ms: nil) }
            else { message("Ship it: migrations are reversible and the new screen has tests.") }
        case ("build", "compile"):
            let done = node.state == "succeeded"
            command("sh-1", "xcodebuild -scheme Acme -configuration Release build", lease: "mac", state: done ? "exited" : node.state == "aborted" ? "aborted" : "running",
                    exit: done ? 0 : nil, ms: done ? 412_000 : nil,
                    output: (1...64).map { "CompileSwift normal arm64 Sources/Acme/File\($0).swift" }.joined(separator: "\n") + "\n")
        case ("sweep", "tests"):
            out("Running shard ui (612 tests)")
            command("sh-1", "swift test --filter UITests", lease: "runner", ms: 198_000, output: "Test Suite 'UITests' passed.\n\t Executed 612 tests, with 0 failures\n")
            out("Running shard sync (418 tests)")
            command("sh-2", "swift test --filter SyncTests", lease: "runner", exit: 1, ms: 241_000, output: """
                Test Case 'SyncTests.testResumeAfterGap' started.
                SyncTests.swift:212: error: XCTAssertEqual failed: ("41") is not equal to ("42")
                Test Case 'SyncTests.testResumeAfterGap' failed (2.104 seconds).
                Test Case 'SyncTests.testOfflineQueue' failed (0.512 seconds).
                Test Suite 'SyncTests' failed.
                \t Executed 418 tests, with 2 failures

                """)
            out("""
                Traceback (most recent call last):
                  File "main.py", line 31, in main
                    raise RuntimeError(f"{failed} tests failed in shard {shard}")
                RuntimeError: 2 tests failed in shard sync
                """, stderr: true)
        case (_, _) where node.kind == "agent":
            message("Done.")
        default:
            if node.state == "succeeded" { out("ok") }
        }
        return entries
    }

    static func encode(_ value: [String: Any]) -> String {
        String(data: (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
    }
}
#endif

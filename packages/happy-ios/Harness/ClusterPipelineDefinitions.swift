#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation

/// What each fixture pipeline's versions define, as hc-pipelines stores
/// them, and their history: Deploy preview grants a little of everything
/// and supersedes per branch; Build and sign queues and batches per target
/// and no agent may start it; Release notes is granted nothing; Triage inbox
/// takes a bare string. Deploy preview's versions before 7 have no review, before 8 no smoke test.
extension ClusterPipelines {
    /// Who published each version, newest first, and why.
    static var history: [String: [(message: String, author: [String: Any])]] { [
        "deploy": [
            ("Add a smoke test before release", agentAuthor("t1-agent")),
            ("Review the migrations before release", agentAuthor("t1-agent")),
            ("Run migrations beside the build", ["kind": "user", "userId": "steve"]),
            ("Notify the channel when the build fails", agentAuthor("gone-agent", user: "olga")),
            ("", ["kind": "user", "userId": "olga"]),
            ("Supersede per branch", ["kind": "user", "userId": "steve"]),
            ("Pin the checkout to the branch head", agentAuthor("cos-agent")),
            ("First deploy", ["kind": "user", "userId": "steve"]),
        ],
        "build": [("Batch waiting builds", agentAuthor("cos-agent")), ("Sign on the same Mac", ["kind": "user", "userId": "steve"]),
                  ("Upload to the build store", agentAuthor("cos-agent")), ("First build", ["kind": "user", "userId": "steve"])],
        "notes": [("Shorter notes", agentAuthor("cos-agent")), ("Publish to the site", agentAuthor("cos-agent")), ("First notes", ["kind": "user", "userId": "steve"])],
        "triage": [("First triage", agentAuthor("cos-agent"))],
        "sweep": (1...12).reversed().map { number in
            number == 1 ? ("First sweep", ["kind": "user", "userId": "steve"]) : ("Shard \(["by size", "by time", "by module"][number % 3])", agentAuthor("cos-agent"))
        },
    ] }

    private static func agentAuthor(_ id: String, user: String? = "steve") -> [String: Any] {
        ["kind": "agent", "agentId": id, "userId": user as Any? ?? NSNull()]
    }

    static func string(_ description: String? = nil, values: [String]? = nil, nullable: Bool = false) -> [String: Any] {
        var type: [String: Any] = ["type": nullable ? ["string", "null"] as Any : "string"]
        if let values { type["enum"] = values }
        if let description { type["description"] = description }
        return type
    }

    static func object(_ properties: [String: [String: Any]], required: [String], nullable: Bool = false) -> [String: Any] {
        ["type": nullable ? ["object", "null"] as Any : "object", "properties": properties, "required": required]
    }

    static var empty: [String: Any] { object([:], required: []) }

    /// Version `number` of `pipeline`'s definition; nil for one it never had.
    static func definition(_ pipeline: String, _ number: Int) -> [String: Any]? {
        let commit = object(["commit": string(), "target": string(values: ["ios", "android"])], required: ["commit", "target"])
        let upload = object(["build": string(), "url": string()], required: ["build", "url"])
        func code(_ input: [String: Any], _ output: [String: Any], source: String, extra: [String: Any] = [:]) -> [String: Any] {
            ["kind": "code", "input": input, "output": output, "source": source].merging(extra) { _, new in new }
        }
        func main(_ body: String) -> String { "def main(input):\n" + body.split(separator: "\n").map { "    " + $0 }.joined(separator: "\n") + "\n" }
        switch pipeline {
        case "deploy" where number <= 9:
            var nodes: [String: [String: Any]] = [
                "checkout": code(object(["branch": string()], required: ["branch"]), object(["commit": string(), "branch": string()], required: ["commit", "branch"]),
                                 source: main("head = sh(f\"git rev-parse origin/{input['branch']}\").strip()\nreturn {\"commit\": head[:7], \"branch\": input[\"branch\"]}"),
                                 extra: ["permissions": ["repositories": [["id": "acme/app", "access": "read"]]]]),
                "build": ["kind": "pipeline", "pipeline": "build", "input": commit, "output": object(["upload": upload], required: []),
                          "permissions": ["pipelines": ["build"]]],
                "migrate": code(object(["commit": string()], required: ["commit"]), object(["applied": ["type": "integer"]], required: ["applied"]),
                                source: main("status(\"Connecting to the preview database\")\nreturn {\"applied\": migrate(sh, input[\"commit\"])}"),
                                extra: ["permissions": ["secrets": ["PREVIEW_DB"], "compute": ["pools": ["linux"]]],
                                        "compute": ["acquire": [["name": "box", "pool": "linux"]]], "timeoutSeconds": 1800]),
                "release": code(empty, object(["url": string()], required: ["url"]), source: main("return {\"url\": publish(input)}"),
                                extra: ["permissions": ["secrets": ["VERCEL_TOKEN"], "egress": ["hosts": ["api.vercel.com"]]], "join": "all"]),
                "notify": code(object(["node": string(), "code": string(), "message": string()], required: ["node", "code", "message"]), empty,
                               source: main("post(\"#eng-alerts\", input[\"message\"])\nreturn {}"),
                               extra: ["permissions": ["agents": ["cos-agent"]]]),
            ]
            var edges = ["checkout>build", "checkout>migrate", "build>release", "migrate>release", "build!notify"]
            if number >= 7 {
                nodes["review"] = ["kind": "agent", "model": "anthropic/claude-opus-5", "effort": "high",
                                   "instructions": "Read the diff between the last preview and this commit. Check every migration can be rolled back. Answer ship or hold, with a short reason.",
                                   "input": object(["commit": string()], required: ["commit"]),
                                   "output": object(["verdict": string(values: ["ship", "hold"]), "notes": string()], required: ["verdict"]),
                                   "permissions": ["tools": ["web_fetch"], "egress": ["hosts": ["ci.acme.dev"]]]]
                edges += ["checkout>review", "review>release"]
            }
            if number >= 8 {
                nodes["smoke"] = code(object(["url": string()], required: ["url"]), object(["passed": ["type": "boolean"]], required: ["passed"]),
                                      source: main("return {\"passed\": get(input[\"url\"]).ok}"), extra: ["permissions": ["egress": ["hosts": ["preview.acme.dev"]]]])
                edges += ["release>smoke"]
            }
            return document(
                input: object(["branch": string("The branch to deploy"), "preview": ["type": "boolean"],
                               "reviewers": ["type": "array", "items": string()],
                               "options": object(["migrate": ["type": "boolean"], "region": string(values: ["eu", "us"])], required: ["migrate"], nullable: true)],
                              required: ["branch"]),
                concurrency: ["mode": "supersede", "group": "{{input.branch}}"], triggers: ["t1-agent", "cos-agent"],
                permissions: ["vaults": [["id": "v-policy", "access": "read"]], "secrets": ["PREVIEW_DB", "VERCEL_TOKEN"],
                              "repositories": [["id": "acme/app", "access": "read"]], "agents": ["cos-agent"], "pipelines": ["build"], "tools": ["web_fetch"],
                              "egress": ["hosts": ["api.vercel.com", "ci.acme.dev", "preview.acme.dev"]], "compute": ["pools": ["linux"], "maxLeases": 2]],
                root: "checkout", nodes: nodes, edges: edges)
        case "build" where number <= 4:
            let mac: [String: Any] = ["pools": ["macos"]]
            return document(
                input: commit, concurrency: ["mode": "queue", "group": "{{input.target}}", "batch": true], triggers: [],
                permissions: ["repositories": [["id": "acme/app", "access": "read"]], "secrets": ["SIGNING_KEY"], "compute": mac.merging(["maxLeases": 1]) { _, new in new }],
                root: "fetch", nodes: [
                    "fetch": code(["type": "array", "items": commit], object(["path": string()], required: ["path"]), source: main("return {\"path\": clone(input[-1])}"),
                                  extra: ["compute": ["acquire": [["name": "mac", "pool": "macos"]], "pass": ["mac"]], "permissions": ["repositories": [["id": "acme/app", "access": "read"]]]]),
                    "compile": code(object(["path": string()], required: ["path"]), object(["warnings": ["type": "integer"]], required: ["warnings"]),
                                    source: main("return {\"warnings\": build(sh)}"), extra: ["compute": ["use": ["mac"], "pass": ["mac"]], "timeoutSeconds": 5400]),
                    "sign": code(empty, object(["signed": ["type": "boolean"]], required: ["signed"]), source: main("return {\"signed\": sign(sh)}"),
                                 extra: ["compute": ["use": ["mac"]], "permissions": ["secrets": ["SIGNING_KEY"]]]),
                    "upload": code(empty, upload, source: main("return upload()")),
                ], edges: ["fetch>compile", "compile>sign", "sign>upload"])
        case "sweep" where number <= 12:
            return document(
                input: object(["suite": string(values: ["nightly", "smoke"]), "shards": ["type": "integer"]], required: ["suite"]),
                concurrency: [:], triggers: ["cos-agent"],
                permissions: ["compute": ["pools": ["linux"]], "tools": ["web_fetch"]],
                root: "plan", nodes: [
                    "plan": ["kind": "agent", "model": "openai/gpt-6.1-sol", "instructions": "Split the suite into shards that finish together.",
                             "input": object(["suite": string()], required: ["suite"]), "output": object(["shards": ["type": "array", "items": string()]], required: ["shards"])],
                    "tests": code(object(["shards": ["type": "array", "items": string()]], required: ["shards"]), object(["passed": ["type": "integer"]], required: ["passed"]),
                                  source: main("for shard in input[\"shards\"]:\n    sh(f\"swift test --filter {shard}\")"),
                                  extra: ["compute": ["acquire": [["name": "runner", "pool": "linux"]]], "timeoutSeconds": 7200]),
                    "triage": ["kind": "agent", "model": "openai/gpt-6.1-sol", "instructions": "File an issue for every new failure.",
                               "input": object(["passed": ["type": "integer"]], required: []), "output": object(["issues": ["type": "integer"]], required: ["issues"]),
                               "permissions": ["tools": ["web_fetch"]]],
                    "report": code(object(["node": string(), "code": string(), "message": string()], required: ["node"]), object(["posted": string()], required: ["posted"]),
                                   source: main("return {\"posted\": \"#eng-alerts\"}")),
                ], edges: ["plan>tests", "tests>triage", "tests!report"])
        case "notes" where number <= 3:
            return document(
                input: object(["since": string("The last release's tag")], required: ["since"]), concurrency: ["mode": "queue"], triggers: ["cos-agent"],
                permissions: [:], root: "collect", nodes: [
                    "collect": code(object(["since": string()], required: ["since"]), object(["changes": ["type": "integer"]], required: ["changes"]),
                                    source: main("return {\"changes\": 14}")),
                    "write": ["kind": "agent", "model": "anthropic/claude-opus-5", "instructions": "Write the release notes in plain words.",
                              "input": object(["changes": ["type": "integer"]], required: ["changes"]), "output": object(["text": string()], required: ["text"])],
                    "publish": code(object(["text": string()], required: ["text"]), object(["url": string()], required: ["url"]), source: main("return {\"url\": \"https://acme.dev/notes\"}")),
                ], edges: ["collect>write", "write>publish"])
        case "triage" where number == 1:
            return document(
                input: string("The inbox to sort"), concurrency: ["mode": "supersede"], triggers: ["cos-agent"], permissions: ["vaults": [["id": "v-inbox", "access": "write"]]],
                root: "read", nodes: [
                    "read": code(string(), object(["messages": ["type": "integer"]], required: ["messages"]), source: main("return {\"messages\": 12}")),
                    "sort": ["kind": "agent", "model": "openai/gpt-6.1-terra", "instructions": "Sort the inbox by who needs an answer first.",
                             "input": object(["messages": ["type": "integer"]], required: ["messages"]), "output": empty],
                ], edges: ["read>sort"])
        case "importer":
            return document(input: empty, concurrency: [:], triggers: [], permissions: [:], root: "import",
                            nodes: ["import": code(empty, object(["rows": ["type": "integer"]], required: ["rows"]), source: main("return {\"rows\": 1280}"))], edges: [])
        default:
            return nil
        }
    }

    /// `a>b` runs b when a succeeds, `a!b` when it fails.
    private static func document(input: [String: Any], concurrency: [String: Any], triggers: [String], permissions: [String: Any], root: String,
                                 nodes: [String: [String: Any]], edges: [String]) -> [String: Any] {
        let edges = edges.map { edge -> [String: Any] in
            let failure = edge.contains("!")
            let ends = edge.split(whereSeparator: { $0 == ">" || $0 == "!" }).map(String.init)
            return ["from": ends[0], "to": ends[1], "on": failure ? "failure" : "success"]
        }
        return ["input": input, "concurrency": concurrency, "triggers": ["agents": triggers], "permissions": permissions, "root": root, "nodes": nodes, "edges": edges]
    }
}
#endif

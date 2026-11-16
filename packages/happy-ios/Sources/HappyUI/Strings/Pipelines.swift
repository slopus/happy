import Foundation
import HappyCore
import HappyWire

// A Happy Cloud server's pipelines, in desktop's words (HappyAgentPipelinesPage,
// PipelineRunsAcrossList, pipelinePresentation). happy-app has no pipelines,
// so en.ts has none of these; they stay English in every language, as the
// agent screens' others do.
extension Strings {
    enum Pipelines {
        static let title = "Pipelines"
        static let runs = "Runs"
        static let loading = "Loading pipelines…"
        static let empty = "No pipelines yet. Agents create pipelines and run them. Ask an agent to set one up and it appears here."
        static let unavailable = "Pipelines couldn’t be loaded."
        static let outOfDate = "Pipelines may be out of date."
        static let runsLoading = "Reading the runs…"
        static let runsEmpty = "No runs yet. Agents allowed to start a pipeline run it with run_pipeline."
        static let runsUnlisted = "This server lists runs on each pipeline’s own page."
        static let runsOutOfDate = "Runs may be out of date."
        static let runsLoadingMore = "Loading older runs…"
        static let neverRun = "Never run"
        static let disabled = "Disabled"
        static let archived = "Archived"

        nonisolated static func count(_ count: Int) -> String { count == 1 ? "1 pipeline" : "\(count) pipelines" }
        nonisolated static func version(_ number: Int) -> String { "v\(number)" }

        nonisolated static func state(_ state: PipelineRunState) -> String {
            switch state {
            case .queued: "Queued"
            case .running: "Running"
            case .succeeded: "Succeeded"
            case .failed: "Failed"
            case .aborted: "Aborted"
            case .superseded: "Superseded"
            }
        }

        /// How a pipeline's newest run stands, on its row.
        nonisolated static func lastRun(_ state: PipelineRunState) -> String {
            switch state {
            case .queued: "Run queued"
            case .running: "Running now"
            default: "Last run \(Self.state(state).lowercased())"
            }
        }

        /// Who started a run: an agent, or for a child the run and node it
        /// came from. `parent` names the parent's pipeline when that run is
        /// listed.
        nonisolated static func startedBy(_ run: PipelineRunListEntry, agent: (String) -> String?, parent: (String) -> String?) -> String {
            switch run.trigger {
            case .pipeline(let runId, let nodeId):
                if let name = parent(runId) { return "Child of \(name), node \(nodeId)" }
                return "Child run, from node \(nodeId)"
            case .agent(let agentId):
                if run.parentRunId != nil { return "Child run" }
                return "by \(agentId.flatMap(agent) ?? "an agent")"
            case nil:
                return run.parentRunId == nil ? "Started by someone unknown" : "Child run"
            }
        }

        /// How long something took, or has taken so far: `12s`, `4m 5s`,
        /// `2h 10m` (desktop's `elapsedTimeFormat`).
        nonisolated static func elapsed(_ milliseconds: Double) -> String {
            let seconds = Int(max(0, milliseconds) / 1000)
            if seconds < 60 { return "\(seconds)s" }
            let minutes = seconds / 60
            if minutes < 60 { return "\(minutes)m \(seconds % 60)s" }
            return "\(minutes / 60)h \(minutes % 60)m"
        }

        /// When, at a glance: `now`, `5m`, `3h`, a weekday within the week,
        /// then the day and month (desktop's `localAgoTime`).
        nonisolated static func ago(_ at: Date, now: Date, calendar: Calendar) -> String {
            let minutes = Int(max(0, now.timeIntervalSince(at)) / 60)
            if minutes < 1 { return "now" }
            if minutes < 60 { return "\(minutes)m" }
            if minutes < 24 * 60 { return "\(minutes / 60)h" }
            let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: at), to: calendar.startOfDay(for: now)).day ?? 0
            let formatter = DateFormatter()
            formatter.calendar = calendar
            formatter.timeZone = calendar.timeZone
            formatter.setLocalizedDateFormatFromTemplate(days < 7 ? "EEE" : "dM")
            return formatter.string(from: at)
        }

        // The run page.
        static let run = "Run"
        static let runLoading = "Loading run…"
        static let runMissing = "This server has no such run."
        static let runUnreadable = "This run couldn’t be read."
        static let runOutOfDate = "This run may be out of date."
        static let graphUnavailable = "The version this run pinned couldn’t be read, so its nodes are listed by name."
        static let aborting = "Aborting…"
        static let abortTitle = "Abort this run?"
        static let abortMessage = "Its waiting and working nodes stop, and child runs nothing else waits for are aborted with it. This can’t be undone."
        static let abortConfirm = "Abort Run"
        nonisolated static func abortFailed(_ message: String?) -> String { "The run wasn’t aborted. " + (message ?? "The server couldn’t be reached.") }
        static let startedByLabel = "Started by"
        static let group = "Group"
        static let queuedAt = "Queued"
        static let startedAt = "Started"
        static let endedAt = "Ended"
        static let nodes = "Nodes"
        static let node = "Node"
        static let nodeMissing = "This run has no such node."
        static let agent = "Agent"
        static let pipeline = "Pipeline"
        static let parentRun = "Parent run"
        static let childRuns = "Child runs"
        static let childRun = "Child run"
        static let input = "Input"
        static let output = "Output"
        static let result = "Result"
        static let failure = "Failure"
        static let noMessage = "No message."
        static let usage = "Usage"
        static let cached = "Cached"
        static let reasoning = "Reasoning"
        static let notPriced = "Not priced"
        static let noInference = "No inference yet."
        static let computers = "Computers"
        static let log = "Log"
        static let logLive = "Following as it runs"
        static let nodeSkipped = "This node was skipped; it did nothing."
        static let nodePending = "This node hasn’t started."
        static let logLoading = "Reading the log…"
        static let logEmpty = "Nothing logged yet."
        static let logOutOfDate = "The log may be out of date."
        static let showOutput = "Show output"
        static let hideOutput = "Hide output"
        static let outputCut = "Earlier output was cut; this is the last 64 KiB."
        nonisolated static func dropped(_ count: Int) -> String { count == 1 ? "1 earlier entry was let go." : "\(count) earlier entries were let go." }
        nonisolated static func runOf(version: Int) -> String { "Version \(version)" }

        nonisolated static func nodeState(_ state: PipelineNodeRunState) -> String {
            switch state {
            case .pending: "Waiting"
            case .running: "Running"
            case .succeeded: "Succeeded"
            case .failed: "Failed"
            case .skipped: "Skipped"
            case .aborted: "Aborted"
            }
        }

        /// What kind of step a node is: `Code`, `Agent · openai/gpt-6.1`, `Runs Build`.
        nonisolated static func kind(_ kind: String, model: String?, pipeline: String?) -> String {
            switch kind {
            case "agent": model.map { "Agent · \($0)" } ?? "Agent"
            case "pipeline": pipeline.map { "Runs \($0)" } ?? "Pipeline"
            default: "Code"
            }
        }

        /// What the cluster's failure codes mean, in a few words; a code an
        /// agent node made up reads as its words (`tests_failed` is "Tests failed").
        nonisolated static func failureTitle(_ code: String) -> String {
            let known = [
                "exception": "Raised an exception", "type_error": "Didn’t fit its type", "invalid_output": "Returned an invalid output",
                "output_too_large": "Output over 1 MiB", "timeout": "Ran out of time", "compute_unavailable": "Computer unavailable",
                "permission_denied": "Not permitted", "unsupported": "Not supported on this cluster", "internal_error": "The cluster failed",
                "no_output": "Ended without an output", "agent_error": "The agent’s turn failed", "model_unavailable": "Model unavailable",
                "child_failed": "Its child run failed", "child_aborted": "Its child run was aborted", "child_superseded": "Its child run was superseded",
                "child_unavailable": "Child run unavailable", "cycle": "Would run a pipeline already running above it", "too_deep": "Child runs nested too deep",
            ]
            if let title = known[code] { return title }
            let words = code.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
            return words.isEmpty ? "Failed" : words.prefix(1).uppercased() + words.dropFirst()
        }

        /// How a child run is tied to the run on screen: the nodes waiting on it.
        nonisolated static func childVia(_ nodeIds: [String]) -> String {
            switch nodeIds.count {
            case 0: "Started by this run"
            case 1: "From its node \(nodeIds[0])"
            default: "Shared by its nodes \(nodeIds.dropLast().joined(separator: ", ")) and \(nodeIds.last ?? "")"
            }
        }

        nonisolated static func parentVia(_ trigger: PipelineRunTrigger?) -> String {
            if case .pipeline(_, let nodeId) = trigger { return "Started this run from its node \(nodeId)" }
            return "Started this run"
        }

        /// Where a run beside this one stands: how far through its nodes,
        /// and its newest status line while it runs.
        nonisolated static func progress(_ relative: PipelineRunRelative) -> String {
            switch relative.state {
            case .queued: return "Queued behind its group"
            case .running:
                let count = relative.nodesTotal.map { "\(relative.nodesEnded) of \($0) nodes" }
                    ?? (relative.nodesEnded == 1 ? "1 node done" : "\(relative.nodesEnded) nodes done")
                return relative.status.map { "\(count) · \($0.text)" } ?? count
            default: return state(relative.state)
            }
        }

        /// A status line's progress, as a percentage.
        nonisolated static func percent(_ progress: Double) -> String { "\(Int((progress * 100).rounded()))%" }

        /// A token count at a glance: `840`, `12.4k`, `3.1M`.
        nonisolated static func tokens(_ count: Double) -> String {
            if count < 1_000 { return "\(Int(count.rounded()))" }
            if count < 1_000_000 { return String(format: count < 10_000 ? "%.1fk" : "%.0fk", count / 1_000) }
            return String(format: "%.1fM", count / 1_000_000)
        }

        nonisolated static func tokensInOut(input: Double, output: Double) -> String { "\(tokens(input)) in · \(tokens(output)) out" }

        /// US dollars to the cent, and a hint below a cent.
        nonisolated static func cost(_ usd: Double) -> String {
            if usd == 0 { return "$0.00" }
            if usd < 0.01 { return "< $0.01" }
            return String(format: "$%.2f", usd)
        }

        nonisolated static func costOf(_ usage: [PipelineModelUsage]) -> String {
            let priced = usage.compactMap(\.costUsd)
            if priced.isEmpty { return notPriced }
            return cost(priced.reduce(0, +)) + (priced.count < usage.count ? " (some unpriced)" : "")
        }

        nonisolated static func lease(_ lease: PipelineLease, now: Date, calendar: Calendar) -> String {
            if let released = lease.releasedAt {
                return "\(lease.computerId) · released \(ago(Date(timeIntervalSince1970: released / 1000), now: now, calendar: calendar))"
            }
            return "\(lease.computerId) · held by \(lease.holders.isEmpty ? "nobody" : lease.holders.joined(separator: ", "))"
        }

        /// A command's state, as its row ends: `Running`, `Aborted`, `Exit 1`.
        nonisolated static func commandState(_ command: PipelineLogCommand) -> String {
            switch command.state {
            case "running": "Running"
            case "aborted": "Aborted"
            default: "Exit \(command.exitCode.map(String.init) ?? "?")"
            }
        }

        nonisolated static func toolState(_ state: String) -> String {
            switch state {
            case "running": "Running"
            case "ok": "Done"
            default: "Failed"
            }
        }

        /// How long a command or call took: `350ms` under a second.
        nonisolated static func duration(_ milliseconds: Double?) -> String? {
            guard let milliseconds else { return nil }
            return milliseconds < 1000 ? "\(Int(milliseconds))ms" : elapsed(milliseconds)
        }

        /// When, exactly: the time today, else the day and time.
        nonisolated static func moment(_ at: Date, now: Date, calendar: Calendar) -> String {
            let formatter = DateFormatter()
            formatter.calendar = calendar
            formatter.timeZone = calendar.timeZone
            formatter.setLocalizedDateFormatFromTemplate(calendar.isDate(at, inSameDayAs: now) ? "jms" : "MMMdjm")
            return formatter.string(from: at)
        }

        /// A JSON value as it reads, indented; `null` for nothing.
        nonisolated static func value(_ value: JSONValue?) -> String {
            guard let value else { return "null" }
            if case .string(let text) = value { return text.contains("\n") ? text : (try? value.encodedString()) ?? text }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        }

        // The pipeline page, its versions' and its nodes' definitions.
        static let pipelineLoading = "Loading pipeline…"
        static let pipelineMissing = "This server has no such pipeline."
        static let archivedNote = "It no longer runs, and its definition and history can’t be read. Its runs are below."
        static let pipelineUnreadable = "This pipeline couldn’t be read."
        static let pipelineOutOfDate = "This pipeline may be out of date."
        static let definitionLoading = "Reading this version…"
        static let definitionUnreadable = "This version couldn’t be read, or is in a form this app doesn’t read yet."
        static let status = "Status"
        static let enabled = "Enabled"
        static let disabledNote = "Disabled: it refuses new runs"
        static let description = "Description"
        static let createdBy = "Created by"
        static let updated = "Updated"
        static let latest = "Latest"
        static let versions = "Versions"
        static let versionsLoading = "Reading the history…"
        static let versionNoMessage = "No message"
        static let digest = "Digest"
        static let concurrency = "Concurrency"
        static let startedByHeading = "Who may start it"
        static let noTrigger = "No agent may start it yet."
        static let rawSchema = "JSON Schema"
        static let graph = "Graph"
        static let root = "Root"
        static let endsRun = "Ends the run"
        static let permissions = "Permissions"
        static let ceiling = "The pipeline"
        static let nothingGranted = "Nothing granted"
        static let nothingGrantedNote = "Nothing is allowed unless granted: its nodes may compute and nothing else."
        static let nodeNothingGranted = "Nothing granted: it may compute and nothing else."
        static let compute = "Compute"
        static let source = "Source"
        static let instructions = "Instructions"
        static let lastRunLabel = "Last run"
        static let thisPipelineRunsEmpty = "No runs yet."

        /// How runs of it share the cluster, in plain words (desktop's `CONCURRENCY_TEXT`).
        nonisolated static func mode(_ mode: PipelineDefinition.Mode) -> (title: String, detail: String) {
            switch mode {
            case .independent: ("Independent", "Every run starts at once, alongside any already running")
            case .supersede: ("Supersede", "A new run aborts the one running and takes its place")
            case .queue: ("Queue", "Runs wait their turn, one at a time")
            }
        }

        nonisolated static func group(_ group: String?) -> (title: String, detail: String) {
            guard let group else { return ("One group", "Every run of it is in the same group") }
            return ("Grouped by \(group)", "Runs with the same value share a group; others don’t wait for them")
        }

        static let batching = ("Batching", "Waiting runs are merged into the next one, their inputs as a list")

        nonisolated static func versionTitle(_ number: Int, latest: Bool) -> String { latest ? "Version \(number), the latest" : "Version \(number)" }

        /// Who made the pipeline: `You`, a teammate's name, or `Someone`.
        nonisolated static func creator(_ id: String, people: [String: String], me: String?) -> String {
            id == me ? "You" : people[id] ?? "Someone"
        }

        /// Who published a version, by name where this app knows it: `By you`, `By Olga’s agent`.
        nonisolated static func author(_ author: PipelineAuthor?, agents: [String: String], people: [String: String], me: String?) -> String {
            func person(_ id: String?) -> String? {
                guard let id else { return nil }
                if id == me { return "you" }
                return people[id]
            }
            switch author {
            case .user(let id)?: return "By " + (person(id) ?? "someone")
            case .agent(let agentId, let user)?:
                if let name = agents[agentId], !name.isEmpty { return "By \(name)" }
                guard let name = person(user) else { return "By an agent" }
                return name == "you" ? "By your agent" : "By \(name)’s agent"
            case nil: return "Author unknown"
            }
        }

        /// A type in a few plain words: `text`, `list of whole number`, `one of "a", "b"`, `… or null`.
        nonisolated static func type(_ type: PipelineType) -> String {
            var text: String
            if let values = type.values, !values.isEmpty {
                text = "one of " + values.joined(separator: ", ")
            } else {
                switch type.kind {
                case .string: text = "text"
                case .number: text = "number"
                case .integer: text = "whole number"
                case .boolean: text = "true or false"
                case .null: text = "null"
                case .array: text = "list of " + (type.items.first.map { Self.type($0) } ?? "anything")
                case .object: text = type.fields.isEmpty ? "empty object" : "object"
                }
            }
            return type.nullable ? text + " or null" : text
        }

        nonisolated static func requirement(_ required: Bool) -> String { required ? "Required" : "Optional" }
        nonisolated static func outputPresence(_ required: Bool) -> String { required ? "Always there" : "There when the run reaches it" }
        nonisolated static func nodesCount(_ count: Int) -> String { count == 1 ? "1 node" : "\(count) nodes" }
        nonisolated static func versionsCount(_ count: Int) -> String { count == 1 ? "1 version" : "\(count) versions" }
        nonisolated static func wholeType(_ type: PipelineType) -> String { "The whole value is " + Self.type(type) }

        /// What a node does: `Code`, `Agent · openai/gpt-6.1 · high effort`, `Runs Build and sign`.
        nonisolated static func definitionKind(_ node: PipelineDefinitionNode, pipeline: String?) -> String {
            switch node.kind {
            case "agent": return ["Agent", node.model, node.effort.map { "\($0) effort" }].compactMap { $0 }.joined(separator: " · ")
            case "pipeline": return "Runs " + (pipeline ?? "a pipeline")
            default: return "Code"
            }
        }

        /// Where a node leads: `On success → b, c · On failure → d`, or that the run ends there.
        nonisolated static func leads(success: [String], failure: [String]) -> String {
            var parts: [String] = []
            if !success.isEmpty { parts.append("On success → " + success.joined(separator: ", ")) }
            if !failure.isEmpty { parts.append("On failure → " + failure.joined(separator: ", ")) }
            return parts.isEmpty ? endsRun : parts.joined(separator: " · ")
        }

        /// A permission set, one line per kind of grant it holds.
        nonisolated static func grants(_ permissions: PipelinePermissions, name: (String, String) -> String) -> [(title: String, detail: String)] {
            func list(_ kind: String, _ ids: [String]) -> String { ids.map { name(kind, $0) }.joined(separator: ", ") }
            func grants(_ kind: String, _ grants: [PipelinePermissions.Grant]) -> String {
                grants.map { "\(name(kind, $0.id)) (\($0.access == "write" ? "read and write" : "read only"))" }.joined(separator: ", ")
            }
            var lines: [(String, String)] = []
            if !permissions.vaults.isEmpty { lines.append(("Vaults", grants("vault", permissions.vaults))) }
            if !permissions.secrets.isEmpty { lines.append(("Secrets", list("secret", permissions.secrets))) }
            if !permissions.repositories.isEmpty { lines.append(("Repositories", grants("repository", permissions.repositories))) }
            if !permissions.agents.isEmpty { lines.append(("Messages agents", list("agent", permissions.agents))) }
            if !permissions.pipelines.isEmpty { lines.append(("Runs pipelines", list("pipeline", permissions.pipelines))) }
            if !permissions.tools.isEmpty { lines.append(("Tools", permissions.tools.joined(separator: ", "))) }
            if !permissions.egressHosts.isEmpty { lines.append(("Reaches hosts", permissions.egressHosts.joined(separator: ", "))) }
            if let compute = permissions.compute, !(compute.pools.isEmpty && compute.computers.isEmpty) {
                var parts: [String] = []
                if !compute.pools.isEmpty { parts.append("pools " + compute.pools.joined(separator: ", ")) }
                if !compute.computers.isEmpty { parts.append("computers " + compute.computers.joined(separator: ", ")) }
                if let most = compute.maxLeases { parts.append("at most \(most) at once") }
                lines.append(("Computers", parts.joined(separator: " · ")))
            }
            return lines
        }

        /// A node's leases: what it acquires, uses and hands on.
        nonisolated static func leases(_ node: PipelineDefinitionNode) -> [(title: String, detail: String)] {
            var lines: [(String, String)] = []
            if !node.acquire.isEmpty {
                lines.append(("Acquires", node.acquire.map { lease in
                    lease.pool.map { "\(lease.name) from pool \($0)" } ?? lease.computer.map { "\(lease.name) on \($0)" } ?? lease.name
                }.joined(separator: ", ")))
            }
            if !node.uses.isEmpty { lines.append(("Uses", node.uses.joined(separator: ", "))) }
            if !node.passes.isEmpty { lines.append(("Hands on", node.passes.joined(separator: ", "))) }
            return lines
        }

        /// Seconds as the largest whole unit that fits: `10 min`, `1 h`, `90 s`.
        nonisolated static func seconds(_ seconds: Int) -> String {
            if seconds % 3600 == 0 { return "\(seconds / 3600) h" }
            if seconds % 60 == 0 { return "\(seconds / 60) min" }
            return "\(seconds) s"
        }

        nonisolated static func join(_ join: String) -> String { join == "any" ? "Any edge into it fired" : "Every edge into it fired" }
        static let timesOut = "Times out after"
        static let runsWhen = "Runs when"
        static let childPipeline = "Child pipeline"
    }
}

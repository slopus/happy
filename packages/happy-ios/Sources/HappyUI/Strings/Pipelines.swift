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
    }
}

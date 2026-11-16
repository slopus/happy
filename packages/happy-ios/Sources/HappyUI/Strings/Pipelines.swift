import Foundation
import HappyCore

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
    }
}

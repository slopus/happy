#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation

/// Chief of Staff's conversation on `ClusterServer` (`-open chat`): the
/// messages it was given that no person wrote, between the person's own.
/// Pipeline results the cluster told it, with `metadata.pipelineRun` (a
/// sweep that passed, one that failed, a run the server no longer reads)
/// and without, as a cluster before that field sends them; a message it
/// scheduled for itself, a goal's continuation, and one to itself with no
/// line on what it is.
enum ClusterChat {
    static let agentId = "cos-agent"

    static func answer(_ method: String, _ path: String) -> String? {
        guard method == "GET" else { return nil }
        if path == "/v0/agents/\(agentId)/bootstrap" {
            return #"{"agent":{"id":"\#(agentId)","workspaceId":"cos-w","status":"idle"},"pending":[],"slashCommands":[]}"#
        }
        guard path.hasPrefix("/v0/agents/\(agentId)/messages?") else { return nil }
        // `-earlier`: its first turns alone, to see them without scrolling.
        let earlier = ProcessInfo.processInfo.arguments.contains("-earlier")
        return ClusterPipelines.encode(["hasMore": false, "runs": earlier ? Array(runs.prefix(4)) : runs])
    }

    private static var runs: [[String: Any]] {
        let now = (Date().timeIntervalSince1970 * 1000).rounded()
        var at = now - 3 * 3600 * 1000
        var index = 0
        var turns: [[String: Any]] = []
        /// One turn: what it was given, and what the agent said.
        func turn(_ given: [String: Any], _ reply: String) {
            index += 1
            let started = at
            at += 4 * 60 * 1000
            var message = given
            message["id"] = "m\(index)"
            message["role"] = "user"
            message["createdAt"] = started
            turns.append(["id": "a\(index)", "status": "completed", "startedAt": started, "endedAt": started + 9000, "reason": "completed", "messages": [
                message,
                ["id": "m\(index)-reply", "role": "agent", "createdAt": started + 8000, "metadata": [:] as [String: Any], "content": [text(reply)]],
            ]])
        }
        func text(_ text: String) -> [String: Any] { ["type": "text", "text": text] }
        func person(_ words: String) -> [String: Any] { ["metadata": [:] as [String: Any], "content": [text(words)]] }
        func own(_ words: String, explanation: String?, run: [String: Any]? = nil) -> [String: Any] {
            var metadata: [String: Any] = ["senderAgentId": agentId]
            if let explanation { metadata["senderAgentExplanation"] = explanation }
            if let run { metadata["pipelineRun"] = run }
            return ["metadata": metadata, "content": [text(words)]]
        }
        func notice(_ run: String, _ pipeline: String, version: Int, _ state: String, failed: String? = nil) -> String {
            "Pipeline result, sent by the cluster (not by a person, and not your own earlier words): run \(run) of pipeline \"\(pipeline)\" (version \(version)), which you started, \(state)."
                + (failed.map { "\nFailed nodes:\n- \($0)" } ?? "")
        }
        func pipelineRun(_ run: String, _ pipeline: String, _ name: String, version: Int, _ state: String, summary: String? = nil) -> [String: Any] {
            var value: [String: Any] = ["runId": run, "pipelineId": pipeline, "pipelineName": name, "version": version, "state": state]
            if let summary { value["summary"] = summary }
            return value
        }

        turn(person("Run the nightly sweep now and tell me how it goes."), "Started Nightly test sweep. I’ll read the result when it ends.")
        turn(own(notice("r10", "Nightly test sweep", version: 11, "succeeded") + "\nResult:\n```json\n{\n  \"outputs\": {\n    \"triage\": {\n      \"issues\": 0\n    }\n  }\n}\n```",
                 explanation: "Pipeline \"Nightly test sweep\" run succeeded", run: pipelineRun("r10", "sweep", "Nightly test sweep", version: 11, "succeeded")),
             "The sweep passed: no new failures, nothing to file.")
        turn(own("Check whether tonight’s sweep finished, and report any failures.", explanation: "Scheduled for 9:00: check tonight’s sweep"),
             "Started tonight’s sweep again; I’ll report when it ends.")
        let failure = "tests: exception — RuntimeError: 2 tests failed in shard sync"
        turn(own(notice("r4", "Nightly test sweep", version: 12, "failed", failed: failure),
                 explanation: "Pipeline \"Nightly test sweep\" run failed", run: pipelineRun("r4", "sweep", "Nightly test sweep", version: 12, "failed", summary: failure)),
             "Tonight’s sweep failed: two tests in the sync shard. I’ve sent them to triage.")
        turn(own(notice("r9", "Release notes", version: 2, "succeeded"), explanation: "Pipeline \"Release notes\" run succeeded"),
             "The release notes are published.")
        turn(own("Keep the nightly sweep green: look at what failed and file what’s new.", explanation: "Continuing the goal: keep the nightly sweep green"),
             "Filed CORE-118 and CORE-119 for the two sync failures.")
        turn(own(notice("r-gone", "Old importer", version: 2, "aborted"), explanation: "Pipeline \"Old importer\" run aborted",
                 run: pipelineRun("r-gone", "importer", "Old importer", version: 2, "aborted")),
             "The old import was stopped before it finished.")
        turn(own("Look at the inbox again.", explanation: nil), "Nothing new in the inbox.")
        return turns
    }
}
#endif

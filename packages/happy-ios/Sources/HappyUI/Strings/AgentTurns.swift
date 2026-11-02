import Foundation

// A turn's own rows, in desktop's words: a tool call's verb and subject
// (AgentActivityRow.tsx `toolVerb`, `humanizeToolName`, `diffVerb`), how
// the turn ended (TurnSummary.tsx), its fold control (agentTraceMeta.ts)
// and its questions (HappyAgentUserInputPrompt.tsx).

extension Strings {
    public enum Turns {
        // TurnSummary.tsx
        public static let completed = ("Completed", "in")
        public static let steered = ("Steered", "after")
        public static let stopped = ("Stopped", "after")
        public static let failed = ("Failed", "after")
        public static let worked = ("Worked", "for")
        public static let copyFinal = "Copy final message"
        public static let finalCopied = "Final message copied"

        // agentTraceMeta.ts
        public static let viewTraces = "View traces"
        public static let hideTraces = "Hide traces"
        public static func tools(_ count: Int) -> String { "\(count) \(count == 1 ? "tool" : "tools")" }

        // AgentActivityRow.tsx
        public static let spawning = "Spawning"
        public static let spawned = "Spawned"
        public static let failedToSpawn = "Failed to spawn"
        public static let subAgent = "sub-agent"
        public static func subAgent(_ model: String) -> String { "\(model) sub-agent" }
        public static let searching = "Searching"
        public static let searched = "Searched"
        public static let exploring = "Exploring"
        public static let explored = "Explored"
        public static let typing = "Typing"
        public static let typed = "Typed"
        public static let waiting = "Waiting"
        public static let waited = "Waited"
        public static let forSubagents = "for subagents"
        public static let bash = "Bash"
        public static let powerShell = "PowerShell"
        public static let shell = "Shell"
        public static let reading = "Reading"
        public static let read = "Read"
        public static let editing = "Editing"
        public static let edited = "Edited"
        public static let tool = "Tool"
        public static let used = "Used"
        public static let edit = "Edit"
        public static let added = "Added"
        public static let deleted = "Deleted"
        public static func list(_ target: String) -> String { "List \(target)" }
        public static func readFile(_ name: String) -> String { "Read \(name)" }
        public static func search(_ detail: String) -> String { "Search \(detail)" }
        public static func search(_ query: String, in path: String) -> String { "\(query) in \(path)" }
        /// `humanizeToolName`'s own names.
        public static let toolNames: [String: String] = [
            "Agent": "Subagent",
            "compact": "Context compaction",
            "TaskInput": "Terminal input",
            "TaskList": "Task list",
            "TaskOutput": "Background output",
            "spawn_agent": "Start subagent",
            "wait_agent": "Wait for subagents",
            "workflow": "Workflow",
            "write_stdin": "Terminal input",
        ]
        public static func isRunning(_ tool: String) -> String { "\(tool) is running" }
        public static let compacting = "Compacting"
        public static let compacted = "Compacted"
        /// `compactionSummary`: the context it started from, and what it
        /// came to once the next inference measured it.
        public static func compaction(before: Double?, after: Double?) -> String {
            switch (before, after) {
            case (nil, nil): "context"
            case (nil, let after?): "context to \(contextTokens(after)) tokens"
            case (let before?, nil): "context from \(contextTokens(before)) tokens"
            case (let before?, let after?): "context \(contextTokens(before)) → \(contextTokens(after)) tokens"
            }
        }

        /// `contextTokenCount`: 950, 43.2k, 201k.
        public static func contextTokens(_ tokens: Double) -> String {
            if tokens < 1_000 { return String(Int(max(0, tokens.rounded()))) }
            let thousands = tokens / 1_000
            guard thousands < 100 else { return "\(Int(thousands.rounded()))k" }
            let tenths = (thousands * 10).rounded() / 10
            return tenths == tenths.rounded() ? "\(Int(tenths))k" : "\(tenths)k"
        }
        public static let creating = "Creating"
        public static let created = "Created"
        public static let updating = "Updating"
        public static let updated = "Updated"
        public static let opening = "Opening"
        public static let opened = "Opened"
        public static let failedCall = "Failed"
        public static let artifact = "artifact"
        /// `mediaNoun`: what one call showed, by its items' kinds (an
        /// unknown kind is a file, as `mediaKindProject` reads it).
        public static func mediaNoun(_ kinds: [String]) -> String {
            let known = kinds.map { ["image", "video", "document"].contains($0) ? $0 : "file" }
            let plural = known.count > 1
            guard Set(known).count == 1 else { return "Files" }
            switch known[0] {
            case "image": return plural ? "Images" : "Image"
            case "video": return plural ? "Videos" : "Video"
            case "document": return plural ? "Documents" : "Document"
            default: return plural ? "Files" : "File"
            }
        }

        // HappyAgentUserInputPrompt.tsx
        public static let question = "Question"
        public static let chooseOne = "Choose one"
        public static let chooseAny = "Choose any"
        public static let answered = "Answered"
        public static let noAnswer = "No answer"
        public static let submit = "Submit"
        public static let answerNotSent = "Answer not sent"
    }
}

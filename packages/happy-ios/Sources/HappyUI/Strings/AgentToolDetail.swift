import Foundation
import HappyCore

// A Happy Agent tool call's own screen, in desktop's words where its
// ToolCallPreview has them ("Terminal", "File edit", "Tool call", the
// status), and this app's own for the rest. A workspace's changes reuse
// the Changes screen's words.

extension Strings {
    enum ToolDetail {
        // ToolCallPreview.tsx `presentationTitle`
        static let terminal = "Terminal"
        static let fileEdit = "File edit"
        static let toolCall = "Tool call"
        static let exploration = "Exploration"
        static let search = "Search"
        static let web = "Web page"
        static let subagent = "Subagent"
        static let plan = "Plan"
        static let message = "Message"
        static let question = "Question"
        static let compaction = "Context compaction"
        static let media = "Shown to you"

        // ToolCallPreview.tsx `statusLabel`
        static let running = "Running"
        static let completed = "Completed"
        static let failed = "Failed"

        static let command = "Command"
        static let input = "Input"
        static let output = "Output"
        static let result = "Result"
        static let error = "Error"
        static let arguments = "Arguments"
        static let prompt = "Prompt"
        static let content = "Content"
        static let explanation = "Explanation"
        static let sources = "Sources"
        static let operations = "Operations"
        static let questions = "Questions"
        static let patch = "Patch"
        static let files = "Files"
        static let review = "Review"
        static let noOutput = "(no output)"
        static let noAnswer = "No answer"
        static let loading = "Reading the whole call…"
        /// A plan's line in the chat.
        static func planProgress(done: Int, of total: Int) -> String { "plan · \(done) of \(total) done" }

        static let listed = "List"
        static let read = "Read"
        static let searched = "Search"

        static func omittedFiles(_ count: Int) -> String { "\(count) more \(count == 1 ? "file" : "files") not shown" }
        static func omittedLines(_ count: Int) -> String { "\(count) more \(count == 1 ? "line" : "lines") not shown" }

        // The automatic reviewer (API.md "review").
        static let allowed = "Allowed"
        static let denied = "Denied"
        static let unproven = "Not reviewed"
        static let decision = "Decision"
        static let risk = "Risk"
        static let authorization = "Asked for"
        static let access = "Access"
        static let fullAccess = "Ran with Full access"
        static let sandboxed = "Stayed in the sandbox"
        static let reason = "Reason"
        static let timedOut = "Timed out"
        static let unavailable = "Unavailable"

        static func kind(_ kind: HappyCore.ToolDetail.Kind) -> String {
            switch kind {
            case .terminal: terminal
            case .fileEdit: fileEdit
            case .exploration: exploration
            case .search: search
            case .web: web
            case .subagent: subagent
            case .plan: plan
            case .message: message
            case .question: question
            case .compaction: compaction
            case .media: media
            case .tool: toolCall
            }
        }

        static func status(_ status: HappyCore.ToolDetail.Status) -> String {
            switch status {
            case .running: running
            case .completed: completed
            case .failed: failed
            }
        }

        static func title(_ title: HappyCore.ToolDetail.Title) -> String {
            switch title {
            case .command: command
            case .input: input
            case .output: output
            case .result: result
            case .error: error
            case .arguments: arguments
            case .prompt: prompt
            case .message: message
            case .description: "Description"
            case .content: content
            case .plan: plan
            case .explanation: explanation
            case .sources: sources
            case .operations: operations
            case .questions: questions
            case .patch: patch
            case .files: files
            case .review: review
            }
        }

        /// "high" → "High".
        static func level(_ value: String) -> String {
            value.prefix(1).uppercased() + value.dropFirst()
        }
    }

    enum WorkspaceChanges {
        static let changes = "Changes"
        static func summary(files: Int, insertions: Int, deletions: Int) -> String {
            var parts = ["\(files) \(files == 1 ? "file" : "files")"]
            if insertions > 0 { parts.append("+\(insertions)") }
            if deletions > 0 { parts.append("\u{2212}\(deletions)") }
            return parts.joined(separator: " ")
        }
        static let noRepository = "This workspace is not a Git repository."
    }
}

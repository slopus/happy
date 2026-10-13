import Foundation
import HappyCore

// The tool views' copy, verbatim from happy-app's en.ts (`tools`,
// `toolView`, `claude.permissions`, `codex.permissions`).

extension Strings {
    public enum Tools {
        /// toolView.input
        public static let input = "Input"
        /// toolView.output
        public static let output = "Output"
        /// tools.taskView.moreTools
        public static func moreTools(_ count: Int) -> String { "+\(count) more \(count == 1 ? "tool" : "tools")" }
        /// tools.desc.readingFile
        public static func readingFile(_ file: String) -> String { "Reading \(file)" }
        /// tools.desc.writingFile
        public static func writingFile(_ file: String) -> String { "Writing \(file)" }
        /// tools.askUserQuestion.submit
        public static let submitAnswer = "Submit Answer"
        /// tools.taskView.initializing
        public static let initializing = "Initializing agent..."

        /// common.message: a message screen's title.
        public static let message = "Message"

        /// tools.fullView
        public enum FullView {
            public static let description = "Description"
            public static let inputParams = "Input Parameters"
            public static let output = "Output"
            public static let error = "Error"
            public static let completed = "Tool completed successfully"
            public static let noOutput = "No output was produced"
            public static let rawJsonDevMode = "Raw JSON (Dev Mode)"
        }

        /// tools.multiEdit
        public static func editNumber(_ index: Int, of total: Int) -> String { "Edit \(index) of \(total)" }
        public static let replaceAll = "Replace All"
        /// CommandView.tsx (not in en.ts)
        public static let commandNoOutput = "[Command completed with no output]"

        /// tools.names
        public static func name(_ name: ToolName) -> String {
            switch name {
            case .task: "Task"
            case .terminal: "Terminal"
            case .searchFiles: "Search Files"
            case .search: "Search"
            case .searchContent: "Search Content"
            case .listFiles: "List Files"
            case .planProposal: "Plan proposal"
            case .readFile: "Read File"
            case .editFile: "Edit File"
            case .writeFile: "Write File"
            case .fetchUrl: "Fetch URL"
            case .readNotebook: "Read Notebook"
            case .editNotebook: "Edit Notebook"
            case .todoList: "Todo List"
            case .webSearch: "Web Search"
            case .reasoning: "Reasoning"
            case .applyChanges: "Update file"
            case .viewDiff: "Current file changes"
            case .question: "Question"
            }
        }

        public static func text(_ text: ToolText) -> String {
            switch text {
            case .literal(let string): string
            case .name(let name): Self.name(name)
            case .multiEditEdits(let path, let count): "\(path) (\(count) edits)"
            case .modifyingMultipleFiles(let file, let count): "\(file) and \(count) more"
            case .multipleQuestions(let count): "\(count) questions"
            }
        }

        /// common.yes, claude.permissions, codex.permissions
        public static func permission(_ kind: PermissionButton.Kind) -> String {
            switch kind {
            case .allow, .codexAllow: "Yes"
            case .allowAllEdits: "Yes, allow all edits during this session"
            case .allowEverything: "Yes, allow everything during this session"
            case .allowForTool: "Yes, don't ask again for this tool"
            case .deny: "No, and provide feedback"
            case .codexAllowForSession: "Yes, and don't ask for a session"
            case .codexAbort: "Stop, and explain what to do"
            }
        }
    }
}

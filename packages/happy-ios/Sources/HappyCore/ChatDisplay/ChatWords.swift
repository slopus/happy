import Foundation

/// The chat's rows' words and the message screen's, in one language: what
/// happy-app reads there with `t('key')`, under that key. The rows are
/// planned off the main thread, where the screens' language
/// (`AppLocalization`) is never read, so a screen makes its words when it is
/// built and hands them to its derivation with its other inputs; a row says
/// its words in the language it was planned in.
///
/// English is written beside each key, as `localized` keeps it, so English
/// never decodes a catalog; `ChatWordsTests` holds it to _default.ts's. Text
/// happy-app writes out as a literal stays English where it is drawn, with
/// the file it comes from. Citations are to happy-app's `sources/`.
public struct ChatWords: Equatable, Sendable {
    /// The language the words are in.
    public let language: String
    /// Nil while that is English.
    private let catalog: TranslationCatalog?

    /// `language`'s words. Any language but English reads its catalog,
    /// which is decoded off the main thread (`TranslationCatalog.catalog`).
    public init(language: String) {
        self.init(catalog: language == "en" ? nil : TranslationCatalog.catalog(for: language))
    }

    /// A catalog already decoded, such as the screens' own
    /// (`AppLocalization.screens`), on any thread; nil or English's is
    /// English, as written here.
    public init(catalog: TranslationCatalog?) {
        self.init(reading: catalog?.language == "en" ? nil : catalog)
    }

    /// Reads `catalog` even when it is English's, so the tests can hold
    /// the English written here to it.
    init(reading catalog: TranslationCatalog?) {
        self.catalog = catalog
        language = catalog?.language ?? "en"
    }

    public static let english = ChatWords(catalog: nil)

    /// The catalogs are compiled in, so a language always has the same words.
    public static func == (lhs: ChatWords, rhs: ChatWords) -> Bool {
        lhs.language == rhs.language
    }

    private func word(_ key: String, _ english: @autoclosure () -> String) -> String {
        catalog.map { $0(key) } ?? english()
    }

    private func word(_ key: String, _ values: [String: TranslationValue], _ english: @autoclosure () -> String) -> String {
        catalog.map { $0(key, values) } ?? english()
    }

    // MARK: Messages (components/MessageView.tsx)

    /// message.switchedToMode (334)
    public func switchedToMode(_ mode: String) -> String {
        word("message.switchedToMode", ["mode": .text(mode)], "Switched to \(mode) mode")
    }
    /// message.unknownEvent (365)
    public var unknownEvent: String { word("message.unknownEvent", "Unknown event") }
    /// message.usageLimitUntil (358)
    public func usageLimitUntil(_ time: String) -> String {
        word("message.usageLimitUntil", ["time": .text(time)], "Usage limit reached until \(time)")
    }
    /// message.unknownTime (351)
    public var unknownTime: String { word("message.unknownTime", "unknown time") }
    /// message.sentAsGoal (222)
    public var sentAsGoal: String { word("message.sentAsGoal", "Sent as goal") }
    /// message.sendsAfterThisTurn (115)
    public var sendsAfterThisTurn: String { word("message.sendsAfterThisTurn", "Sends after this turn") }
    /// message.sending (115)
    public var sending: String { word("message.sending", "Sending\u{2026}") }
    /// message.sendFailed (113)
    public func sendFailed(_ reason: String) -> String {
        word("message.sendFailed", ["reason": .text(reason)], "Not sent: \(reason)")
    }

    // MARK: Work groups

    /// toolGroup.ran, .edited, .read, .searched, .fetched, .ranTask
    /// (utils/toolDisplay.ts 321-332): what an activity row starts with.
    public var toolActions: ToolActionWords {
        ToolActionWords(
            ran: word("toolGroup.ran", "Ran"),
            edited: word("toolGroup.edited", "Edited"),
            read: word("toolGroup.read", "Read"),
            searched: word("toolGroup.searched", "Searched"),
            fetched: word("toolGroup.fetched", "Fetched"),
            ranTask: word("toolGroup.ranTask", "Ran task")
        )
    }
    /// toolGroup.workedFor (components/AgentWorkGroupHeader.tsx 40)
    public func workedFor(_ duration: String) -> String {
        word("toolGroup.workedFor", ["duration": .text(duration)], "Worked \(duration)")
    }
    /// toolGroup.hide (components/AgentWorkGroupHeader.tsx 39)
    public var hide: String { word("toolGroup.hide", "Hide") }

    // MARK: Markdown

    /// markdown.codeCopied (components/markdown/MarkdownView.tsx 175)
    public var codeCopied: String { word("markdown.codeCopied", "Code copied") }
    /// markdown.copyFailed (components/markdown/MarkdownView.tsx 178)
    public var copyFailed: String { word("markdown.copyFailed", "Copy failed") }
    /// markdown.mermaidRenderFailed (components/markdown/MermaidRenderer.tsx 65)
    public var mermaidRenderFailed: String { word("markdown.mermaidRenderFailed", "Failed to render mermaid diagram") }

    // MARK: Tools (components/tools)

    /// toolView.input (ToolView.tsx 296, views/BashViewFull.tsx 36)
    public var input: String { word("toolView.input", "Input") }
    /// toolView.output (ToolView.tsx 302)
    public var output: String { word("toolView.output", "Output") }
    /// tools.taskView.moreTools (views/TaskView.tsx 112)
    public func moreTools(_ count: Int) -> String {
        word("tools.taskView.moreTools", ["count": .number(count)], "+\(count) more \(count == 1 ? "tool" : "tools")")
    }
    /// tools.desc.readingFile (views/CodexBashView.tsx 61)
    public func readingFile(_ file: String) -> String {
        word("tools.desc.readingFile", ["file": .text(file)], "Reading \(file)")
    }
    /// tools.desc.writingFile (views/CodexBashView.tsx 78)
    public func writingFile(_ file: String) -> String {
        word("tools.desc.writingFile", ["file": .text(file)], "Writing \(file)")
    }
    /// tools.askUserQuestion.submit (views/InlineQuestionForm.tsx 191)
    public var submitAnswer: String { word("tools.askUserQuestion.submit", "Submit Answer") }
    /// common.message: a message screen's title (ToolHeader.tsx 18).
    public var message: String { word("common.message", "Message") }

    /// tools.fullView.description (ToolFullView.tsx 49)
    public var fullDescription: String { word("tools.fullView.description", "Description") }
    /// tools.fullView.inputParams (ToolFullView.tsx 59)
    public var fullInputParams: String { word("tools.fullView.inputParams", "Input Parameters") }
    /// tools.fullView.output (ToolFullView.tsx 70, 111)
    public var fullOutput: String { word("tools.fullView.output", "Output") }
    /// tools.fullView.error (ToolFullView.tsx 83, 109; views/BashViewFull.tsx 29)
    public var fullError: String { word("tools.fullView.error", "Error") }
    /// tools.fullView.completed (ToolFullView.tsx 96)
    public var fullCompleted: String { word("tools.fullView.completed", "Tool completed successfully") }
    /// tools.fullView.noOutput (ToolFullView.tsx 97)
    public var fullNoOutput: String { word("tools.fullView.noOutput", "No output was produced") }
    /// tools.fullView.rawJsonDevMode (ToolFullView.tsx 122)
    public var fullRawJson: String { word("tools.fullView.rawJsonDevMode", "Raw JSON (Dev Mode)") }

    /// tools.multiEdit.editNumber (views/MultiEditViewFull.tsx 38)
    public func editNumber(_ index: Int, of total: Int) -> String {
        word("tools.multiEdit.editNumber", ["index": .number(index), "total": .number(total)], "Edit \(index) of \(total)")
    }
    /// tools.multiEdit.replaceAll (views/MultiEditViewFull.tsx 42)
    public var replaceAll: String { word("tools.multiEdit.replaceAll", "Replace All") }

    /// tools.names (knownTools.tsx).
    public func name(_ name: ToolName) -> String {
        switch name {
        case .task: word("tools.names.task", "Task") // 81
        case .terminal: word("tools.names.terminal", "Terminal") // 109
        case .searchFiles: word("tools.names.searchFiles", "Search Files") // 149
        case .search: word("tools.names.search", "Search") // 161
        // Spelled out, not read (169).
        case .searchContent: "Search Content"
        case .listFiles: word("tools.names.listFiles", "List Files") // 202
        case .planProposal: word("tools.names.planProposal", "Plan proposal") // 220
        case .readFile: word("tools.names.readFile", "Read File") // 244
        case .editFile: word("tools.names.editFile", "Edit File") // 294
        case .writeFile: word("tools.names.writeFile", "Write File") // 345
        case .fetchUrl: word("tools.names.fetchUrl", "Fetch URL") // 361
        case .readNotebook: word("tools.names.readNotebook", "Read Notebook") // 390
        case .editNotebook: word("tools.names.editNotebook", "Edit Notebook") // 405
        case .todoList: word("tools.names.todoList", "Todo List") // 426
        case .webSearch: word("tools.names.webSearch", "Web Search") // 462
        case .reasoning: word("tools.names.reasoning", "Reasoning") // 556
        case .applyChanges: word("tools.names.applyChanges", "Update file") // 73, 739
        case .viewDiff: word("tools.names.viewDiff", "Current file changes") // 851
        case .question: word("tools.names.question", "Question") // 926, 959
        }
    }

    /// A tool header's copy (knownTools.tsx).
    public func text(_ text: ToolText) -> String {
        switch text {
        case .literal(let string):
            string
        case .name(let name):
            self.name(name)
        case .multiEditEdits(let path, let count): // 311, 332
            word("tools.desc.multiEditEdits", ["path": .text(path), "count": .number(count)], "\(path) (\(count) edits)")
        case .modifyingMultipleFiles(let file, let count): // 52, 824
            word("tools.desc.modifyingMultipleFiles", ["file": .text(file), "count": .number(count)], "\(file) and \(count) more")
        case .multipleQuestions(let count): // 948
            word("tools.askUserQuestion.multipleQuestions", ["count": .number(count)], "\(count) questions")
        }
    }

    /// A permission button's label (PermissionFooter.tsx).
    public func permission(_ kind: PermissionButton.Kind) -> String {
        switch kind {
        case .allow, .codexAllow: word("common.yes", "Yes") // 439, 508
        case .allowAllEdits: word("claude.permissions.yesAllowAllEdits", "Yes, allow all edits during this session") // 528
        case .allowEverything: word("claude.permissions.yesAllowEverything", "Yes, allow everything during this session") // 550
        case .allowForTool: word("claude.permissions.yesForTool", "Yes, don't ask again for this tool") // 572
        case .deny: word("claude.permissions.noTellClaude", "No, and provide feedback") // 592
        case .codexAllowForSession: word("codex.permissions.yesForSession", "Yes, and don't ask for a session") // 457
        case .codexAbort: word("codex.permissions.stopAndExplain", "Stop, and explain what to do") // 476
        }
    }
}

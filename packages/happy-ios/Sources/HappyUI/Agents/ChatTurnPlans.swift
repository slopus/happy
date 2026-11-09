#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// A tool call's words and mark as desktop's single-line row reads them
/// (AgentActivityRow.tsx `AgentToolActivity`, `toolVerb`, `toolGlyph`).
struct ToolWords: Equatable {
    var verb: String
    var subject: String
    /// A command, terminal input or file: set in mono.
    var mono: Bool
    var glyph: Icon
    var added: Int?
    var deleted: Int?

    typealias W = Strings.Turns

    init(_ tool: ChatItem.Tool) {
        let presentation = tool.presentation
        let name = tool.name
        let lower = name.lowercased()
        let status = tool.status
        mono = false
        added = nil
        deleted = nil
        switch presentation?.type {
        case "agent_spawn":
            verb = status == "failed" ? W.failedToSpawn : tool.running ? W.spawning : W.spawned
            subject = presentation?.model.map { W.subAgent($0.name) } ?? W.subAgent
        case "compaction":
            verb = status == "failed" ? W.failedCall : tool.running ? W.compacting : W.compacted
            subject = W.compaction(before: presentation?.tokensBefore, after: presentation?.tokensAfter)
        case "search":
            verb = Self.verb(name, status: status, presentation: presentation)
            subject = presentation?.query ?? ""
        case "media":
            let items = presentation?.items ?? []
            // A read that turned out to be a picture still says it read it.
            verb = Self.matches("(read|view)", lower) ? W.read : W.mediaNoun(items.map(\.kind))
            subject = items.map(\.name).joined(separator: ", ")
        case "artifact":
            verb = Self.verb(name, status: status, presentation: presentation)
            subject = presentation?.shows == "latest" ? presentation?.title ?? W.artifact : W.artifact
        case "exploration":
            verb = Self.verb(name, status: status, presentation: presentation)
            subject = Self.exploration(presentation?.operations ?? [])
        case "file_diff":
            let files = presentation?.files ?? []
            if let first = files.first {
                verb = first.kind == "add" ? W.added : first.kind == "delete" ? W.deleted : W.edit
                subject = Self.fileName(first.path)
            } else {
                verb = Self.verb(name, status: status, presentation: presentation)
                subject = Self.humanize(name)
            }
            mono = true
            let added = files.reduce(0) { $0 + ($1.added ?? 0) }
            let deleted = files.reduce(0) { $0 + ($1.deleted ?? 0) }
            // A side that changed nothing is left unsaid.
            self.added = added > 0 ? added : nil
            self.deleted = deleted > 0 ? deleted : nil
        case "exec_command":
            verb = Self.verb(name, status: status, presentation: presentation)
            subject = presentation?.command ?? ""
            mono = true
        case "background_terminal_interaction":
            verb = Self.verb(name, status: status, presentation: presentation)
            subject = Self.terminalInput(presentation?.input ?? "").nonEmpty ?? presentation?.command ?? ""
            mono = true
        default:
            verb = Self.verb(name, status: status, presentation: presentation)
            if let plan = Self.plan(tool) {
                verb = status == "failed" ? W.failedCall : W.updated
                subject = plan
            } else if presentation == nil, ["webfetch", "web_fetch"].contains(lower), let url = tool.arguments?["url"]?.stringValue, !url.isEmpty {
                verb = status == "failed" ? W.failedCall : tool.running ? W.reading : W.read
                subject = url.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression)
            } else if name.hasPrefix("mcp__"), presentation == nil {
                let parts = name.components(separatedBy: "__")
                subject = parts.count >= 3 ? "\(parts[1]) · \(parts[2...].joined(separator: "__"))" : Self.humanize(name)
            } else {
                subject = lower == "wait_agent" ? W.forSubagents : Self.humanize(name)
            }
        }
        glyph = Self.glyph(name, presentation: presentation, failed: tool.failed)
        if !tool.failed, presentation == nil, ["update_plan", "todo_write", "todowrite"].contains(lower) { glyph = .ionicons("checkbox-outline") }
        if name.hasPrefix("mcp__") {
            subject = Self.humanize(name)
            mono = false
        } else if let summary = ToolSummary.text(name: name, arguments: tool.arguments) {
            verb = ""
            mono = false
            // A plan keeps its progress as well as why it changed.
            subject = Self.plan(tool).map { "\($0) · \(summary)" } ?? summary
        }
        if !name.hasPrefix("mcp__") { subject = ToolSummary.normalized(subject) ?? "" }
    }

    /// A plan's line says how far it has got (`ToolDetail`'s checklist).
    static func plan(_ tool: ChatItem.Tool) -> String? {
        guard tool.presentation == nil, tool.arguments != nil, ["update_plan", "todo_write", "todowrite"].contains(tool.name.lowercased()) else { return nil }
        for case .checklist(_, let todos) in ToolDetail(tool).sections where !todos.isEmpty {
            return Strings.ToolDetail.planProgress(done: todos.filter { $0.state == .done }.count, of: todos.count)
        }
        return nil
    }

    private static func matches(_ pattern: String, _ text: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    static func verb(_ name: String, status: String, presentation: AgentWire.Presentation?) -> String {
        let active = status == "running"
        let lower = name.lowercased()
        switch presentation?.type {
        case "search": return active ? W.searching : W.searched
        case "exploration": return active ? W.exploring : W.explored
        default: break
        }
        // An artifact's tools say what they did to it in their own words.
        if presentation?.type == "artifact" || matches("^(create_artifact|edit_artifact_files|update_artifact)$", lower) {
            if status == "failed" { return W.failedCall }
            if lower == "edit_artifact_files" { return active ? W.opening : W.opened }
            if lower == "create_artifact" { return active ? W.creating : W.created }
            return active ? W.updating : W.updated
        }
        if presentation?.type == "background_terminal_interaction" || matches("stdin|terminal_?input|taskinput", lower) { return active ? W.typing : W.typed }
        if lower == "wait_agent" { return active ? W.waiting : W.waited }
        if presentation?.type == "exec_command" || matches("(bash|exec|shell|command|run)", lower) {
            return lower == "powershell" ? W.powerShell : lower == "bash" ? W.bash : W.shell
        }
        if matches("(grep|find|glob|^ls$|list|search)", lower) { return active ? W.exploring : W.explored }
        if matches("(read|view|cat|open)", lower) { return active ? W.reading : W.read }
        if matches("(write|edit|patch|update|apply)", lower) { return active ? W.editing : W.edited }
        return active ? W.tool : W.used
    }

    /// `toolGlyph`, in the phone's glyphs: desktop's house icons are the
    /// Ionicons they draw (`Icon.tsx`).
    static func glyph(_ name: String, presentation: AgentWire.Presentation?, failed: Bool) -> Icon {
        if failed { return .octicons("alert") }
        switch presentation?.type {
        case "agent_spawn": return .ionicons("hardware-chip-outline")
        case "compaction": return .ionicons("funnel-outline")
        case "search": return .ionicons("globe-outline")
        case "exploration": return .ionicons("search-outline")
        case "file_diff": return .ionicons("document-outline")
        case "artifact": return .ionicons("cube-outline")
        case "media":
            let kinds = (presentation?.items ?? []).map(\.kind)
            return .ionicons(kinds.contains("image") ? "image-outline" : kinds.contains("video") ? "film-outline" : "document-outline")
        default: break
        }
        let lower = name.lowercased()
        if presentation?.type == "background_terminal_interaction" || matches("stdin|terminal_?input|taskinput", lower) { return .ionicons("terminal-outline") }
        if presentation?.type == "exec_command" || matches("(bash|exec|shell|command|run)", lower) { return .octicons("code") }
        if matches("(grep|find|glob|^ls$|list|search)", lower) { return .ionicons("search-outline") }
        if matches("(read|view|cat|open)", lower) { return .ionicons("document-text-outline") }
        if matches("(write|edit|patch|update|apply)", lower) { return .ionicons("document-outline") }
        if matches("(fetch|http|web|url|browser)", lower) { return .ionicons("globe-outline") }
        if matches("(task|todo|plan)", lower) { return .ionicons("checkbox-outline") }
        if matches("(agent|spawn|subagent|workflow)", lower) { return .ionicons("hardware-chip-outline") }
        return .ionicons("flash-outline")
    }

    /// `humanizeToolName`.
    static func humanize(_ name: String) -> String {
        if let known = W.toolNames[name] { return known }
        if name.hasPrefix("mcp__") {
            let parts = name.components(separatedBy: "__")
            if parts.count >= 3 { return "\(parts[1]) · \(parts[2...].joined(separator: "__"))" }
        }
        var text = name.replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    /// `explorationSummary`: the files read, or each step said.
    static func exploration(_ operations: [AgentWire.Presentation.Operation]) -> String {
        if operations.allSatisfy({ $0.kind == "read" }) {
            var seen: [String] = []
            for name in operations.compactMap(\.name) where !seen.contains(name) { seen.append(name) }
            return seen.joined(separator: ", ")
        }
        return operations.map { operation in
            switch operation.kind {
            case "list": return W.list(operation.target ?? "")
            case "read": return W.readFile(operation.name ?? "")
            default:
                if let query = operation.query, let path = operation.path { return W.search(W.search(query, in: path)) }
                return W.search(operation.query ?? operation.path ?? operation.command ?? "")
            }
        }.joined(separator: " · ")
    }

    static func fileName(_ path: String) -> String {
        let normalized = path.replacingOccurrences(of: "\\", with: "/")
        let name = normalized.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        return name.isEmpty ? path : name
    }

    /// `terminalInputSummary`: control codes as a terminal echoes them, a
    /// paste by its first line and how many more.
    static func terminalInput(_ input: String) -> String {
        var visible = ""
        for scalar in input.replacingOccurrences(of: "\r\n", with: "\n").unicodeScalars {
            if scalar == "\n" { visible.unicodeScalars.append(scalar) }
            else if scalar.value < 0x20 || scalar.value == 0x7F { visible += "^" + String(UnicodeScalar(UInt8(scalar.value ^ 0x40))).uppercased() }
            else { visible.unicodeScalars.append(scalar) }
        }
        while visible.hasSuffix("\n") { visible.removeLast() }
        guard !visible.isEmpty else { return "" }
        let lines = visible.components(separatedBy: "\n")
        return lines.count > 1 ? "\(lines[0]) … +\(lines.count - 1) lines" : lines[0]
    }

    /// countText.ts `compactCount`.
    static func compact(_ count: Int) -> String {
        if count < 1000 { return String(count) }
        if count < 5000 {
            let thousands = (Double(count) / 100).rounded() / 10
            return thousands == thousands.rounded() ? "\(Int(thousands))k" : "\(thousands)k"
        }
        return "\(Int((Double(count) / 1000).rounded()))k"
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// A tool call's line drawn: its words in their inks, measured.
struct ToolLine {
    var tool: ChatItem.Tool
    var words: ToolWords
    var ink: ColorToken
    var verb: NSAttributedString
    var subject: NSAttributedString
    var added: NSAttributedString?
    var deleted: NSAttributedString?

    init(_ tool: ChatItem.Tool, environment: TextEnvironment?) {
        self.tool = tool
        words = ToolWords(tool)
        ink = tool.failed ? Palette.activityFailedLine : Palette.textSecondary
        verb = ChatTextStyles.activityVerb.string(words.verb, color: ink, lineBreakMode: .byTruncatingTail, in: environment)
        let subjectStyle = words.mono ? ChatTextStyles.toolSubjectMono : ChatTextStyles.activityText
        subject = subjectStyle.string(words.subject, color: ink, lineBreakMode: .byTruncatingTail, in: environment)
        added = words.added.map { ChatTextStyles.toolCount.string("+\(ToolWords.compact($0))", color: Palette.gitAddedText, in: environment) }
        deleted = words.deleted.map { ChatTextStyles.toolCount.string("\u{2212}\(ToolWords.compact($0))", color: Palette.gitRemovedText, in: environment) }
    }

    func layout(_ key: ChatPlanner.Key) -> ToolRowLayout {
        ToolRowLayout(
            width: key.width, maxContentWidth: key.maxContentWidth,
            verbWidth: ChatTextLayout(unwrapped: verb).size.width, textWidth: ChatTextLayout(unwrapped: subject).size.width,
            addedWidth: added.map { ChatTextLayout(unwrapped: $0).size.width }, deletedWidth: deleted.map { ChatTextLayout(unwrapped: $0).size.width }
        )
    }

    func draw(_ layout: ToolRowLayout) -> [ChatDrawItem] {
        var items: [ChatDrawItem] = []
        if tool.running {
            // Desktop's 12 circle spinner in the glyph's lane.
            items.append(.spinner(layout.glyph, tint: Palette.textSecondary, scale: 0.6))
        } else {
            items.append(.icon(words.glyph, size: 12, frame: layout.glyph, tint: ink))
        }
        items.append(.text(ChatTextLayout(verb, width: layout.verb.width, maxLines: 1), layout.verb))
        items.append(.text(ChatTextLayout(subject, width: layout.text.width, maxLines: 1), layout.text))
        if let added, let frame = layout.added { items.append(.text(ChatTextLayout(added, width: frame.width, maxLines: 1), frame)) }
        if let deleted, let frame = layout.deleted { items.append(.text(ChatTextLayout(deleted, width: frame.width, maxLines: 1), frame)) }
        return items
    }

    /// A tap opens the call's own screen (`AgentToolViewController`); a
    /// long press copies what scrolled out of the line.
    func hits(_ layout: ToolRowLayout, id: String) -> [ChatHit] {
        let line = CGRect(origin: .zero, size: layout.size)
        var hits = [ChatHit(frame: line, action: .openMessage(id))]
        if !words.subject.isEmpty { hits.append(ChatHit(frame: line, action: .copyMenu(words.subject), hold: true)) }
        return hits
    }

    var spoken: String {
        tool.running ? Strings.Turns.isRunning(ToolWords.humanize(tool.name)) + ", " + words.subject : [words.verb, words.subject].filter { !$0.isEmpty }.joined(separator: " ")
    }
}

extension ChatPlanner {
    /// One tool call's line (`ToolRowLayout`): its mark, or a spinner while
    /// it runs, the verb, and its subject; a failed call says so in its ink.
    static func tool(_ tool: ChatItem.Tool, id: String, key: Key) -> ChatRowPlan {
        let line = ToolLine(tool, environment: key.environment)
        let layout = line.layout(key)
        return ChatRowPlan(id: id, size: layout.size, items: line.draw(layout), hits: line.hits(layout, id: id), accessibilityLabel: line.spoken)
    }

    /// A call that showed the person something (desktop's media and
    /// artifact rows, `ToolResultLayout`): its line, and under it the
    /// pictures, recordings, files or card it showed.
    static func toolResult(_ tool: ChatItem.Tool, item: ChatItem, key: Key, syntax: CodeSyntaxService, proposals: [String: ProposalShown]) -> ChatRowPlan {
        let line = ToolLine(tool, environment: key.environment)
        var row = line.layout(key)
        let body = Self.body(item, key: key, syntax: syntax, proposals: proposals) { parts in
            let result = ToolResultLayout(width: key.width, maxContentWidth: key.maxContentWidth, line: row, parts: parts)
            row = result.line
            return result.body
        }
        let spoken = [line.spoken, body.accessibilityLabel ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
        return ChatRowPlan(id: item.id, size: body.size, items: line.draw(row) + body.items, hits: body.hits + line.hits(row, id: item.id), accessibilityLabel: spoken, proposals: body.proposals)
    }

    /// The words desktop's `TurnSummary` ends a turn with, by its reason.
    static func turnWords(_ reason: String) -> (verb: String, joiner: String) {
        typealias W = Strings.Turns
        let pair = switch reason {
        case "steering": W.steered
        case "compaction": W.worked
        case "abort": W.stopped
        case "error": W.failed
        default: W.completed
        }
        return (pair.0, pair.1)
    }

    /// How the turn ended (`TurnStatusLayout`): "Completed in 12s", led by
    /// the copy button for its final answer, a check for a moment once copied.
    static func turnEnd(_ ended: ChatItem.TurnEnd, id: String, key: Key, copied: Bool) -> ChatRowPlan {
        let environment = key.environment
        let label = ChatTextStyles.text.string(ended.label(turnWords), color: Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: environment)
        let copyText = ended.complete ? ended.copyText : nil
        let layout = TurnStatusLayout(width: key.width, maxContentWidth: key.maxContentWidth, labelWidth: ChatTextLayout(unwrapped: label).size.width, copies: copyText != nil, afterStep: ended.afterStep)
        var items: [ChatDrawItem] = [.text(ChatTextLayout(label, width: layout.label.width, maxLines: 1), layout.label)]
        var hits: [ChatHit] = []
        if let copyText, let button = layout.copy, let glyph = layout.glyph {
            items.insert(.icon(.ionicons(copied ? "checkmark-outline" : "copy-outline"), size: TurnStatusLayout.Metrics.glyph, frame: glyph, tint: copied ? Palette.success : Palette.textSecondary), at: 0)
            // A finger's room around the 20 square.
            hits.append(ChatHit(frame: button.insetBy(dx: -12, dy: -6), action: .copyMessage(id: id, text: copyText)))
        }
        return ChatRowPlan(id: id, size: layout.size, items: items, hits: hits, accessibilityLabel: ended.label(turnWords))
    }

    /// A finished turn's fold control (`TraceLayout`).
    static func trace(_ trace: ChatItem.Trace, id: String, key: Key) -> ChatRowPlan {
        let environment = key.environment
        let titleText = trace.open ? Strings.Turns.hideTraces : Strings.Turns.viewTraces
        let title = ChatTextStyles.traceMeta.string(titleText, color: Palette.textSecondary, in: environment)
        let stats = trace.tools > 0 ? ChatTextStyles.traceMeta.string(Strings.Turns.tools(trace.tools), color: Palette.textSecondary, in: environment) : nil
        let layout = TraceLayout(width: key.width, maxContentWidth: key.maxContentWidth, titleWidth: ChatTextLayout(unwrapped: title).size.width, statsWidth: stats.map { ChatTextLayout(unwrapped: $0).size.width })
        var items: [ChatDrawItem] = [.text(ChatTextLayout(title, width: layout.title.width, maxLines: 1), layout.title)]
        if let dot = layout.dot { items.append(.box(ChatBox(frame: dot, fill: Palette.inputPlaceholder, radius: dot.width / 2))) }
        if let stats, let frame = layout.stats { items.append(.text(ChatTextLayout(stats, width: frame.width, maxLines: 1), frame)) }
        let spoken = [titleText, trace.tools > 0 ? Strings.Turns.tools(trace.tools) : nil].compactMap { $0 }.joined(separator: ", ")
        return ChatRowPlan(id: id, size: layout.size, items: items, hits: [ChatHit(frame: layout.hit, action: .toggleTurn(trace.turn))], accessibilityLabel: spoken, toggles: titleText)
    }

    /// A question the agent asked (`QuestionLayout`): pending, its options
    /// to tick and Submit, shimmering while the answer goes; answered, what
    /// was answered under each prompt.
    static func question(_ ask: ChatItem.Ask, id: String, key: Key) -> ChatRowPlan {
        typealias M = QuestionLayout.Metrics
        let environment = key.environment
        let answered = ask.phase == .answered
        let sending = ask.phase == .submitting
        func text(_ string: String, _ style: ChatTextStyle, _ color: ColorToken, lines: Int = 0) -> MeasuredText {
            MeasuredText(style.string(string, color: color, lineBreakMode: lines == 1 ? .byTruncatingTail : .byWordWrapping, in: environment), maxLines: lines)
        }
        struct Drafted {
            var header: MeasuredText
            var rule: MeasuredText
            var question: MeasuredText
            var choices: [(label: MeasuredText, description: MeasuredText?, picked: Bool, option: Int?)]
        }
        var drafted: [Drafted] = []
        var spoken: [String] = []
        for prompt in ask.question.questions {
            let options = prompt.options ?? []
            let header = text(prompt.header ?? "", ChatTextStyles.questionHeader, Palette.textSecondary, lines: 1)
            let values = answered ? (ask.question.answers?[prompt.id] ?? []) : (ask.picked[prompt.id] ?? [])
            let ruleText = answered ? (values.isEmpty ? Strings.Turns.noAnswer : Strings.Turns.answered)
                : (prompt.multiSelect ?? false ? Strings.Turns.chooseAny : Strings.Turns.chooseOne)
            let rule = text(ruleText, ChatTextStyles.questionRule, Palette.textSecondary, lines: 1)
            let question = text(prompt.question, ChatTextStyles.questionPrompt, Palette.text)
            var choices: [(label: MeasuredText, description: MeasuredText?, picked: Bool, option: Int?)] = []
            if answered {
                for value in values.isEmpty ? [Strings.Turns.noAnswer] : values {
                    let description = options.first { $0.label == value }?.description.flatMap { $0.isEmpty ? nil : $0 }
                    choices.append((text(value, ChatTextStyles.questionAnswer, Palette.text), description.map { text($0, ChatTextStyles.questionDescription, Palette.textSecondary) }, false, nil))
                }
            } else {
                for (index, option) in options.enumerated() {
                    let description = option.description.flatMap { $0.isEmpty ? nil : $0 }
                    choices.append((text(option.label, ChatTextStyles.questionOption, Palette.text), description.map { text($0, ChatTextStyles.questionDescription, Palette.textSecondary) }, values.contains(option.label), index))
                }
            }
            drafted.append(Drafted(header: header, rule: rule, question: question, choices: choices))
            spoken.append([prompt.header, ruleText, prompt.question].compactMap { $0 }.joined(separator: ", "))
            spoken += answered ? values : options.map(\.label)
        }
        let button = text(Strings.Turns.submit, ChatTextStyles.questionButton, Palette.text, lines: 1)
        var failure: MeasuredText?
        if case .failed(let reason) = ask.phase {
            failure = text("\(Strings.Turns.answerNotSent): \(reason)", ChatTextStyles.questionRule, Palette.statusError)
        }
        let layout = QuestionLayout(
            width: key.width, maxContentWidth: key.maxContentWidth,
            prompts: drafted.map { draft in
                QuestionLayout.Prompt(
                    header: draft.header.layout(width: 10_000).size, rule: draft.rule.layout(width: 10_000).size, question: draft.question.measurable,
                    choices: draft.choices.map { QuestionLayout.Choice(label: $0.label.measurable, description: $0.description?.measurable) }
                )
            },
            buttonLabel: answered ? nil : button.layout(width: 10_000).size.width,
            note: failure?.measurable
        )
        var items: [ChatDrawItem] = []
        var hits: [ChatHit] = []
        // The options stay readable while the answer goes, quieter.
        let optionAlpha: CGFloat = sending ? Palette.questionPendingAlpha : 1
        for (draft, placed) in zip(drafted, layout.prompts) {
            if placed.header.width > 0 { items.append(.text(draft.header.layout(for: placed.header), placed.header)) }
            items.append(.text(draft.rule.layout(for: placed.rule), placed.rule))
            items.append(.text(draft.question.layout(for: placed.question), placed.question))
            for (choice, frame) in zip(draft.choices, placed.choices) {
                if answered {
                    items.append(.box(ChatBox(frame: frame.frame, fill: Palette.questionSelected, radius: M.radius, alpha: Palette.questionAnsweredAlpha)))
                } else if choice.picked {
                    items.append(.box(ChatBox(frame: frame.frame, fill: Palette.questionSelected, radius: M.radius, alpha: Palette.questionPickedAlpha * optionAlpha)))
                }
                if let box = frame.box {
                    if choice.picked {
                        items.append(.box(ChatBox(frame: box, fill: Palette.radioActive, border: Palette.radioActive, borderWidth: 1, radius: M.radius, alpha: optionAlpha)))
                        items.append(.icon(.ionicons("checkmark-outline"), size: 14, frame: box, tint: Palette.questionCheck))
                    } else {
                        items.append(.box(ChatBox(frame: box, fill: Palette.questionBox, border: Palette.radioInactive, borderWidth: 1, radius: M.radius, alpha: optionAlpha)))
                    }
                }
                let label = choice.label.layout(for: frame.label)
                items.append(.text(optionAlpha < 1 ? label.dimmed(optionAlpha) : label, frame.label))
                if let description = choice.description, let placedDescription = frame.description {
                    let drawn = description.layout(for: placedDescription)
                    items.append(.text(optionAlpha < 1 ? drawn.dimmed(optionAlpha) : drawn, placedDescription))
                }
            }
        }
        // Each option answers a tap, by its prompt.
        for (prompt, placed) in zip(ask.question.questions, layout.prompts) where !answered && !sending {
            for (index, frame) in placed.choices.enumerated() {
                hits.append(ChatHit(frame: frame.frame, action: .questionOption(toolId: id, questionId: prompt.id, option: index)))
            }
        }
        if let failure, let frame = layout.note { items.append(.text(failure.layout(for: frame), frame)) }
        if let frame = layout.button {
            let ready = ask.complete && !sending
            let alpha = ready || sending ? 1 : Palette.questionDisabledAlpha
            items.append(.box(ChatBox(frame: frame, fill: Palette.questionButton, border: Palette.questionButtonBorder, borderWidth: 1, radius: frame.height / 2, alpha: alpha)))
            let label = button.layout(width: 10_000)
            let labelFrame = CGRect(x: frame.midX - label.size.width / 2, y: frame.midY - label.size.height / 2, width: label.size.width, height: label.size.height)
            if sending {
                // Desktop's pending Submit: the label stays, shimmering.
                func shimmered(_ color: ColorToken) -> ChatTextLayout {
                    text(Strings.Turns.submit, ChatTextStyles.questionButton, color, lines: 1).layout(width: 10_000)
                }
                let ground = Palette.questionButton
                items.append(.shimmer(ChatShimmerText(
                    ink: label,
                    rest: shimmered(Shimmer.rest(.lift, ink: Palette.text, ground: ground)),
                    band: shimmered(Shimmer.highlight(.lift, ink: Palette.text, ground: ground))
                ), frame: labelFrame))
            } else {
                items.append(.text(alpha < 1 ? label.dimmed(alpha) : label, labelFrame))
            }
            if ready { hits.insert(ChatHit(frame: frame.insetBy(dx: -8, dy: -8), action: .questionSubmit(toolId: id)), at: 0) }
            spoken.append(Strings.Turns.submit)
        }
        return ChatRowPlan(id: id, size: layout.size, items: items, hits: hits, accessibilityLabel: spoken.joined(separator: "\n"))
    }
}
#endif

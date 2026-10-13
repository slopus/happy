#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// Everything a message's screen is drawn from. Equal inputs at the same
/// width give the same plan.
struct MessageDetailInput: Equatable, Sendable {
    var message: ChatMessage
    /// metadata.path: tool paths under it are shown relative to it.
    var root: String?
    /// `settings.showLineNumbersInToolViews`, which WriteView follows.
    var showLineNumbers: Bool
    /// `devModeEnabled || __DEV__`: the raw JSON section.
    var devMode: Bool
    /// The files the reader opened past "Show N more lines", by diff.
    var diffExpanded: [Int: Set<Int>]
    var maxContentWidth: CGFloat
}

/// Measures a message's screen off the main thread, once per input and
/// width.
actor MessageDetailMeasurer {
    private var cache: (input: MessageDetailInput, width: CGFloat, plan: ChatRowPlan)?

    func plan(_ input: MessageDetailInput, width: CGFloat) -> ChatRowPlan {
        if let cache, cache.input == input, cache.width == width { return cache.plan }
        let plan = MessageDetailRenderer.plan(input, width: width)
        cache = (input, width, plan)
        return plan
    }
}

/// session/[id]/message/[messageId].tsx's content as one plan: a tool's
/// ToolFullView, or a text message's whole text. Long text comes in
/// pieces (`TextChunks`) so the screen draws only what is near the
/// visible part.
enum MessageDetailRenderer {
    static func plan(_ input: MessageDetailInput, width: CGFloat) -> ChatRowPlan {
        let content: ChatPiece
        let kind: MessageDetailLayout.Kind
        switch input.message {
        case .toolCall(let call):
            let presentation = ToolFullPresentation(call.tool, root: input.root, words: Strings.ToolGroup.words)
            content = tool(call, presentation, input: input)
            kind = presentation.wide ? .wideTool : .tool
        case .userText(let message):
            content = longText(message.text, style: ChatTextStyles.detailMessage, color: Palette.text)
            kind = .text
        case .agentText(let message):
            content = longText(message.text, style: ChatTextStyles.detailMessage, color: Palette.text)
            kind = .text
        case .agentEvent, .unsupported:
            return ChatRowPlan(id: input.message.id, size: CGSize(width: width, height: 0), items: [])
        }
        let layout = MessageDetailLayout(width: width, kind: kind, content: content.measurable, maxContentWidth: input.maxContentWidth)
        let drawn = content.draw(layout.content)
        return ChatRowPlan(id: input.message.id, size: layout.contentSize, items: drawn.items, hits: drawn.hits)
    }

    // MARK: ToolFullView

    /// The tool's specialized full view or the generic sections, then (for
    /// a specialized view that shows the inputs) how the run ended, then in
    /// dev mode the raw JSON.
    static func tool(_ call: ToolCallMessage, _ presentation: ToolFullPresentation, input: MessageDetailInput) -> ChatPiece {
        var entries: [ChatStackEntry] = []
        switch presentation.main {
        case .terminal(let terminal, let controlInput):
            // BashViewFull: the command and all it printed, then what a
            // shell control typed, 16 apart.
            var parts = [ChatStackEntry(piece: command(terminal))]
            if let controlInput {
                parts.append(ChatRowRenderer.section(Strings.Tools.input, code(controlInput)))
            }
            entries.append(ChatStackEntry(piece: .stack(parts, gap: 16)))
        case .task:
            if let view = ChatRowRenderer.taskView(call.children) { entries.append(view) }
        case .diff(let kind, let chunks, let replaceAll):
            if let view = diffs(kind, chunks: chunks, replaceAll: replaceAll, toolId: call.id, input: input) { entries.append(view) }
        case .generic(let generic):
            entries += sections(generic)
        }
        switch presentation.outcome {
        case .error(let error)?:
            entries.append(ChatRowRenderer.toolError(text(error)))
        case .output(let output)?:
            entries.append(ChatRowRenderer.section(Strings.Tools.FullView.output, code(output)))
        case nil:
            break
        }
        if input.devMode {
            let json = ChatToolPresentation.pretty(ToolFullPresentation.rawJSON(call))
            entries.append(section(.ionicons("code-slash"), tint: Palette.fullViewOrange, title: Strings.Tools.FullView.rawJsonDevMode, code(json)))
        }
        return .stack(entries)
    }

    static func text(_ error: ToolFullError) -> String {
        switch error {
        case .text(let text): text
        case .unspecified: Strings.Tools.FullView.error
        }
    }

    /// CommandView on the tool's screen: the command, then everything it
    /// printed, in pieces when it is long. The command and its output are
    /// selectable there (`syntaxHighlighting`); the error is not.
    static func command(_ terminal: ToolFullTerminal) -> ChatPiece {
        let line = ChatRowRenderer.commandLine(terminal.command, prompt: terminal.prompt)
        var entries = [ChatStackEntry(piece: selectable(line, terminal.command))]
        func output(_ text: String, _ style: ChatTextStyle, _ color: ColorToken, selectable copies: Bool) {
            let piece = longText(text, style: style, color: color, lineBreakMode: .byCharWrapping)
            entries.append(ChatStackEntry(piece: copies ? selectable(piece, text) : piece, marginTop: 8))
        }
        if let stdout = terminal.visibleStdout { output(stdout, ChatTextStyles.terminal, Palette.terminalStdout, selectable: true) }
        if let stderr = terminal.visibleStderr { output(stderr, ChatTextStyles.terminal, Palette.terminalStderr, selectable: true) }
        if let error = terminal.error { output(text(error), ChatTextStyles.terminal, Palette.terminalError, selectable: false) }
        if terminal.showsEmptyOutput {
            output(Strings.Tools.commandNoOutput, ChatTextStyles.terminalEmptyOutput, Palette.terminalEmptyOutput, selectable: false)
        }
        return ChatRowRenderer.terminalPanel(entries)
    }

    /// React Native's `selectable` Text: a long press anywhere on it copies
    /// all of `text`.
    static func selectable(_ piece: ChatPiece, _ text: String) -> ChatPiece {
        ChatPiece(measurable: piece.measurable) { frame in
            let drawn = piece.draw(frame)
            return (drawn.items, drawn.hits + [ChatHit(frame: frame, action: .selectable(text), hold: true)])
        }
    }

    /// EditViewFull and MultiEditViewFull draw their diffs with line
    /// numbers and leave 28 below; WriteView follows the setting and sits
    /// in ToolSectionView's full-width section, pulled 8 up, 12 below.
    static func diffs(_ kind: ToolViewKind, chunks: [ToolDiffChunk], replaceAll: [Bool], toolId: String, input: MessageDetailInput) -> ChatStackEntry? {
        func diff(_ index: Int, showLineNumbers: Bool) -> ChatPiece? {
            ChatRowRenderer.diffPiece(chunks[index], index: index, toolId: toolId, showLineNumbers: showLineNumbers, expanded: input.diffExpanded[index] ?? [])
        }
        switch kind {
        case .multiEdit:
            var entries: [ChatStackEntry] = []
            for index in chunks.indices {
                let all = replaceAll.indices.contains(index) && replaceAll[index]
                entries.append(ChatStackEntry(piece: multiEditHeader(index, of: chunks.count, replaceAll: all), marginBottom: 8))
                if let piece = diff(index, showLineNumbers: true) { entries.append(ChatStackEntry(piece: piece)) }
                if index < chunks.count - 1 {
                    let rule = ChatPiece(measurable: Measurable { CGSize(width: $0, height: 1) }) { frame in
                        ([.box(ChatBox(frame: frame, fill: Palette.multiEditSeparator))], [])
                    }
                    entries.append(ChatStackEntry(piece: rule, marginTop: 16, marginBottom: 16))
                }
            }
            guard !entries.isEmpty else { return nil }
            return ChatStackEntry(piece: .stack(entries), marginBottom: 28)
        case .write:
            // ToolSectionView's fullWidth also pulls 12 out at each side,
            // which on a phone (no padding here) would cut the gutter off.
            guard !chunks.isEmpty, let piece = diff(0, showLineNumbers: input.showLineNumbers) else { return nil }
            return ChatStackEntry(piece: piece, marginTop: -8, marginBottom: 12)
        default:
            guard !chunks.isEmpty, let piece = diff(0, showLineNumbers: true) else { return nil }
            return ChatStackEntry(piece: piece, marginBottom: 28)
        }
    }

    /// "Edit N of M", with the "Replace All" badge beside it.
    static func multiEditHeader(_ index: Int, of total: Int, replaceAll: Bool) -> ChatPiece {
        let number = MeasuredText(ChatTextStyles.multiEditNumber.string(Strings.Tools.editNumber(index + 1, of: total), color: Palette.fullViewPurple), maxLines: 1)
        let badge = replaceAll ? MeasuredText(ChatTextStyles.multiEditBadge.string(Strings.Tools.replaceAll, color: Palette.onAccent), maxLines: 1) : nil
        return ChatPiece(measurable: Measurable { MultiEditHeaderLayout(width: $0, number: number.measurable, badge: badge?.measurable).size }) { frame in
            let layout = MultiEditHeaderLayout(width: frame.width, number: number.measurable, badge: badge?.measurable)
            func place(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: frame.minX, dy: frame.minY) }
            var items: [ChatDrawItem] = [.text(number.layout(for: layout.number), place(layout.number))]
            if let badge, let pill = layout.badge, let text = layout.badgeText {
                items.append(.box(ChatBox(frame: place(pill), fill: Palette.fullViewPurple, radius: MultiEditHeaderLayout.Metrics.badgeRadius)))
                items.append(.text(badge.layout(for: text), place(text)))
            }
            return (items, [])
        }
    }

    /// ToolFullView's fallback: what the call was for, its input, and its
    /// output or error, or a tick when it finished without saying anything.
    static func sections(_ generic: ToolFullGeneric) -> [ChatStackEntry] {
        typealias FullView = Strings.Tools.FullView
        var entries: [ChatStackEntry] = []
        if let description = generic.description {
            let text = longText(description, style: ChatTextStyles.fullDescription, color: Palette.textSecondary)
            entries.append(section(.ionicons("information-circle"), tint: Palette.fullViewPurple, title: FullView.description, text))
        }
        if let input = generic.input {
            entries.append(section(.ionicons("log-in"), tint: Palette.fullViewPurple, title: FullView.inputParams, code(input)))
        }
        if let output = generic.output {
            entries.append(section(.ionicons("log-out"), tint: Palette.fullViewGreen, title: FullView.output, code(output)))
        }
        if let error = generic.error {
            let box = ChatStackEntry(
                piece: longText(error, style: ChatTextStyles.fullError, color: Palette.boxErrorText),
                padding: LayoutInsets(top: 16, left: 16, bottom: 16, right: 16),
                background: ChatBox(frame: .zero, fill: Palette.boxErrorBackground, border: Palette.boxErrorBorder, borderWidth: 1, radius: 8)
            )
            entries.append(section(.ionicons("close-circle"), tint: Palette.fullViewRed, title: FullView.error, .stack([box])))
        }
        if generic.completedWithoutOutput {
            let glyph = CGSize(width: 48, height: 48)
            let icon = ChatPiece(measurable: .fixed(glyph)) { frame in
                ([.icon(.ionicons("checkmark-circle-outline"), size: 48, frame: frame, tint: Palette.fullViewGreen)], [])
            }
            let title = MeasuredText(ChatTextStyles.fullEmptyTitle.string(FullView.completed, color: Palette.text, alignment: .center))
            let subtitle = MeasuredText(ChatTextStyles.fullEmptySubtitle.string(FullView.noOutput, color: Palette.textSecondary, alignment: .center))
            let column = ChatPiece.stack([
                ChatStackEntry(piece: icon, placement: .center),
                ChatStackEntry(piece: .text(title), placement: .center),
                ChatStackEntry(piece: .text(subtitle), placement: .center),
            ], gap: 12)
            entries.append(ChatStackEntry(piece: column, marginBottom: 28, padding: LayoutInsets(top: 48, left: 0, bottom: 48, right: 0)))
        }
        return entries
    }

    /// One of ToolFullView's sections: a 20-point glyph and its title 8
    /// apart, 12 above the content; 28 below the section.
    static func section(_ icon: Icon, tint: ColorToken, title: String, _ content: ChatPiece) -> ChatStackEntry {
        let text = MeasuredText(ChatTextStyles.fullSectionTitle.string(title, color: Palette.text))
        let glyph = CGSize(width: 20, height: 20)
        let header = ChatPiece(measurable: Measurable { ChatAccessoryRowLayout(width: $0, leading: glyph, text: text.measurable).size }) { frame in
            let layout = ChatAccessoryRowLayout(width: frame.width, leading: glyph, text: text.measurable)
            let textFrame = layout.text.offsetBy(dx: frame.minX, dy: frame.minY)
            return ([
                .icon(icon, size: 20, frame: layout.leading!.offsetBy(dx: frame.minX, dy: frame.minY), tint: tint),
                .text(text.layout(for: textFrame), textFrame),
            ], [])
        }
        return ChatStackEntry(piece: .stack([ChatStackEntry(piece: header, marginBottom: 12), ChatStackEntry(piece: content)]), marginBottom: 28)
    }

    /// CodeView: Menlo 12 / 18 on surfaceHigh, in pieces when long.
    static func code(_ code: String) -> ChatPiece {
        .stack([ChatStackEntry(
            piece: longText(code, style: ChatTextStyles.codeView, color: Palette.text, lineBreakMode: .byCharWrapping),
            padding: LayoutInsets(top: 12, left: 12, bottom: 12, right: 12),
            background: ChatBox(frame: .zero, fill: Palette.surfaceHigh, radius: 6)
        )])
    }

    /// Text that can run to thousands of lines, as pieces stacked with no
    /// gap; short text is one piece.
    static func longText(_ text: String, style: ChatTextStyle, color: ColorToken, lineBreakMode: NSLineBreakMode = .byWordWrapping) -> ChatPiece {
        let chunks = TextChunks.split(text)
        guard chunks.count > 1 else { return .text(MeasuredText(style.string(text, color: color, lineBreakMode: lineBreakMode))) }
        return .stack(chunks.enumerated().map { index, chunk in
            let drawn = index == chunks.count - 1 ? chunk : TextChunks.drawn(chunk)
            return ChatStackEntry(piece: .text(MeasuredText(style.string(drawn, color: color, lineBreakMode: lineBreakMode))))
        })
    }
}
#endif

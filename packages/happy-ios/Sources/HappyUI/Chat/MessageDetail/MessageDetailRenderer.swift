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
    /// Of a patch's files, the one the reader tapped in the chat.
    var focusFile: String?
    /// The screen's text size and words.
    var text: ChatRowText
    /// The account's diff documents and syntax colour.
    var render: RenderServices
}

/// Measures a message's screen off the main thread, once per input (its
/// text size included) and width.
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
            let presentation = ToolFullPresentation(call.tool, root: input.root, words: input.text.words.toolActions)
            content = tool(call, presentation, input: input)
            kind = presentation.wide ? .wideTool : .tool
        case .userText(let message):
            content = longText(message.text, style: ChatTextStyles.detailMessage, color: Palette.text, in: input.text.environment)
            kind = .text
        case .agentText(let message):
            content = longText(message.text, style: ChatTextStyles.detailMessage, color: Palette.text, in: input.text.environment)
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
        let text = input.text
        var entries: [ChatStackEntry] = []
        switch presentation.main {
        case .terminal(let terminal, let controlInput):
            // BashViewFull: the command and all it printed, then what a
            // shell control typed, 16 apart.
            var parts = [ChatStackEntry(piece: command(terminal, syntax: input.render.diffSyntax, text: text))]
            if let controlInput {
                parts.append(ChatRowRenderer.section(text.words.input, code(controlInput, text: text), text: text))
            }
            entries.append(ChatStackEntry(piece: .stack(parts, gap: 16)))
        case .task:
            if let view = ChatRowRenderer.taskView(call.children, text: text) { entries.append(view) }
        case .diff(let kind, let chunks, let replaceAll):
            if let view = diffs(kind, chunks: chunks, replaceAll: replaceAll, toolId: call.id, input: input) { entries.append(view) }
        case .patch(let files):
            entries.append(patch(files, tool: call.tool, toolId: call.id, input: input))
        case .unifiedDiff(let diff):
            if let diff, let card = diffCard(
                header: diff.fileName.flatMap { $0.isEmpty ? nil : ($0, .modified, DiffStats.countPatch(diff.patch), nil) },
                source: DiffChunkSource(patch: diff.patch, fileName: diff.fileName), index: 0, toolId: call.id, input: input
            ) {
                entries.append(ChatStackEntry(piece: card, marginBottom: 28, padding: LayoutInsets(top: 0, left: 12, bottom: 0, right: 12)))
            }
        case .generic(let generic):
            entries += sections(generic, text: text)
        }
        switch presentation.outcome {
        case .error(let error)?:
            entries.append(ChatRowRenderer.toolError(message(error, words: text.words), text: text))
        case .output(let output)?:
            entries.append(ChatRowRenderer.section(text.words.fullOutput, code(output, text: text), text: text))
        case nil:
            break
        }
        if input.devMode {
            let json = ChatToolPresentation.pretty(ToolFullPresentation.rawJSON(call))
            entries.append(section(.ionicons("code-slash"), tint: Palette.fullViewOrange, title: text.words.fullRawJson, code(json, text: text), text: text))
        }
        return .stack(entries)
    }

    static func message(_ error: ToolFullError, words: ChatWords) -> String {
        switch error {
        case .text(let text): text
        case .unspecified: words.fullError
        }
    }

    /// CommandView on the tool's screen: the command, then everything it
    /// printed, in pieces when it is long. The command and its output are
    /// selectable there and coloured (`syntaxHighlighting`), the command as
    /// bash and the output as a shell session, all tokenized by `deadline`
    /// or left plain; the error is neither.
    static func command(
        _ terminal: ToolFullTerminal, syntax: DiffSyntaxService, text rowText: ChatRowText,
        syntaxDeadline deadline: ContinuousClock.Instant = DiffFilePlan.syntaxDeadline()
    ) -> ChatPiece {
        let style = ChatTextStyles.terminalCommand
        let environment = rowText.environment
        let commandText = TerminalSyntax.spans(terminal.command, language: TerminalSyntax.commandLanguage(prompt: terminal.prompt), until: deadline, service: syntax)
            .map { terminalString($0, style: style, color: Palette.terminalCommand, lineBreakMode: .byCharWrapping, in: environment) }
            ?? style.string(terminal.command, color: Palette.terminalCommand, lineBreakMode: .byCharWrapping, in: environment)
        let line = ChatRowRenderer.commandLine(commandText, prompt: terminal.prompt, text: rowText)
        var entries = [ChatStackEntry(piece: selectable(line, terminal.command))]
        /// `terminalText` is CommandView's: selectable and coloured.
        func output(_ text: String, _ style: ChatTextStyle, _ color: ColorToken, terminalText: Bool) {
            let spans = terminalText ? TerminalSyntax.spans(text, language: TerminalSyntax.outputLanguage, until: deadline, service: syntax) : nil
            let piece = longText(text, style: style, color: color, lineBreakMode: .byCharWrapping, syntax: spans, in: environment)
            entries.append(ChatStackEntry(piece: terminalText ? selectable(piece, text) : piece, marginTop: 8))
        }
        if let stdout = terminal.visibleStdout { output(stdout, ChatTextStyles.terminal, Palette.terminalStdout, terminalText: true) }
        if let stderr = terminal.visibleStderr { output(stderr, ChatTextStyles.terminal, Palette.terminalStderr, terminalText: true) }
        if let error = terminal.error { output(message(error, words: rowText.words), ChatTextStyles.terminal, Palette.terminalError, terminalText: false) }
        if terminal.showsEmptyOutput {
            output(Strings.Tools.commandNoOutput, ChatTextStyles.terminalEmptyOutput, Palette.terminalEmptyOutput, terminalText: false)
        }
        return ChatRowRenderer.terminalPanel(entries)
    }

    /// SyntaxText's runs on CommandView's panel, which stays dark: tokens
    /// in the dark theme's diff colours whatever the appearance, plain runs
    /// in the text's own colour.
    static func terminalString(
        _ spans: [(text: String, kind: DiffSpanKind)], style: ChatTextStyle, color: ColorToken, lineBreakMode: NSLineBreakMode, in environment: TextEnvironment?
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        var attributes: [DiffSpanKind: [NSAttributedString.Key: Any]] = [:]
        for span in spans {
            let runAttributes = attributes[span.kind] ?? {
                let runColor = span.kind == .plain ? UIColor(color) : UIColor(DiffStyle.syntax(span.kind).dark)
                let made = style.attributes(color: runColor, lineBreakMode: lineBreakMode, in: environment)
                attributes[span.kind] = made
                return made
            }()
            result.append(NSAttributedString(string: span.text, attributes: runAttributes))
        }
        return result
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
            ChatRowRenderer.diffPiece(
                chunks[index], index: index, toolId: toolId, showLineNumbers: showLineNumbers, expanded: input.diffExpanded[index] ?? [],
                render: input.render, text: input.text
            )
        }
        switch kind {
        case .multiEdit:
            var entries: [ChatStackEntry] = []
            for index in chunks.indices {
                let all = replaceAll.indices.contains(index) && replaceAll[index]
                entries.append(ChatStackEntry(piece: multiEditHeader(index, of: chunks.count, replaceAll: all, text: input.text), marginBottom: 8))
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

    /// CodexPatchViewFull: the tapped file alone, or every file when none
    /// was tapped or it is no longer in the patch, each in its own card,
    /// 16 apart. PatchFallback without its error when the patch can't be
    /// read.
    static func patch(_ files: [ToolPatchFile]?, tool: ToolCall, toolId: String, input: MessageDetailInput) -> ChatStackEntry {
        guard let files else {
            let raw = ChatPatch.fallbackText(tool.input).flatMap { $0.isEmpty ? nil : $0 }
            let text = input.text
            return ChatRowRenderer.section(text.words.name(.applyChanges), .stack(raw.map { [ChatStackEntry(piece: ChatRowRenderer.codeView($0, text: text))] } ?? []), text: text)
        }
        let focused = files.indices.filter { files[$0].file == input.focusFile }
        let shown = focused.isEmpty ? Array(files.indices) : focused
        let cards = shown.map { index in
            let file = files[index]
            let source: DiffChunkSource? = switch file.diff {
            case .patch(let patch)?: DiffChunkSource(patch: patch, fileName: file.fileName)
            case .pair(let old, let new)?: DiffChunkSource(oldText: old, newText: new, fileName: file.fileName)
            case nil: nil
            }
            let card = diffCard(header: (file.path, file.kind, file.stats, file.movePath), source: source, index: index, toolId: toolId, input: input)
            return ChatStackEntry(piece: card ?? .stack([]))
        }
        return ChatStackEntry(piece: .stack(cards, gap: 16), marginBottom: 28, padding: LayoutInsets(top: 0, left: 12, bottom: 0, right: 12))
    }

    /// The full views' card: surface, a 1 pt divider rim, 8 round, the
    /// header and the diff inside the rim, which clips them to its inner
    /// corners (`overflow: hidden`): the header its top ones, the diff its
    /// bottom ones, or all four without a header. Nil with neither.
    static func diffCard(
        header: (path: String, kind: FileChangeKind, stats: DiffStats.Counts, movePath: String?)?,
        source: DiffChunkSource?, index: Int, toolId: String, input: MessageDetailInput
    ) -> ChatPiece? {
        let border: CGFloat = 1
        let radius: CGFloat = 8
        var parts: [ChatStackEntry] = []
        if let header {
            parts.append(ChatStackEntry(piece: ChatRowRenderer.patchHeader(
                path: header.path, kind: header.kind, stats: header.stats, movePath: header.movePath, opens: nil, topRadius: radius - border, text: input.text
            )))
        }
        if let source, let diff = ChatRowRenderer.diffPiece(
            source, index: index, toolId: toolId, showLineNumbers: input.showLineNumbers, expanded: input.diffExpanded[index] ?? [],
            render: input.render, radius: radius - border, corners: header == nil ? .all : .bottom, text: input.text
        ) {
            parts.append(ChatStackEntry(piece: diff))
        }
        guard !parts.isEmpty else { return nil }
        return .stack([ChatStackEntry(
            piece: .stack(parts),
            padding: LayoutInsets(top: border, left: border, bottom: border, right: border),
            background: ChatBox(frame: .zero, fill: Palette.surface, border: Palette.divider, borderWidth: border, radius: radius)
        )])
    }

    /// "Edit N of M", with the "Replace All" badge beside it.
    static func multiEditHeader(_ index: Int, of total: Int, replaceAll: Bool, text: ChatRowText) -> ChatPiece {
        let environment = text.environment
        let number = MeasuredText(ChatTextStyles.multiEditNumber.string(text.words.editNumber(index + 1, of: total), color: Palette.fullViewPurple, in: environment), maxLines: 1)
        let badge = replaceAll ? MeasuredText(ChatTextStyles.multiEditBadge.string(text.words.replaceAll, color: Palette.onAccent, in: environment), maxLines: 1) : nil
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
    static func sections(_ generic: ToolFullGeneric, text: ChatRowText) -> [ChatStackEntry] {
        let words = text.words
        let environment = text.environment
        var entries: [ChatStackEntry] = []
        if let description = generic.description {
            let piece = longText(description, style: ChatTextStyles.fullDescription, color: Palette.textSecondary, in: environment)
            entries.append(section(.ionicons("information-circle"), tint: Palette.fullViewPurple, title: words.fullDescription, piece, text: text))
        }
        if let input = generic.input {
            entries.append(section(.ionicons("log-in"), tint: Palette.fullViewPurple, title: words.fullInputParams, code(input, text: text), text: text))
        }
        if let output = generic.output {
            entries.append(section(.ionicons("log-out"), tint: Palette.fullViewGreen, title: words.fullOutput, code(output, text: text), text: text))
        }
        if let error = generic.error {
            let box = ChatStackEntry(
                piece: longText(error, style: ChatTextStyles.fullError, color: Palette.boxErrorText, in: environment),
                padding: LayoutInsets(top: 16, left: 16, bottom: 16, right: 16),
                background: ChatBox(frame: .zero, fill: Palette.boxErrorBackground, border: Palette.boxErrorBorder, borderWidth: 1, radius: 8)
            )
            entries.append(section(.ionicons("close-circle"), tint: Palette.fullViewRed, title: words.fullError, .stack([box]), text: text))
        }
        if generic.completedWithoutOutput {
            let glyph = CGSize(width: 48, height: 48)
            let icon = ChatPiece(measurable: .fixed(glyph)) { frame in
                ([.icon(.ionicons("checkmark-circle-outline"), size: 48, frame: frame, tint: Palette.fullViewGreen)], [])
            }
            let title = MeasuredText(ChatTextStyles.fullEmptyTitle.string(words.fullCompleted, color: Palette.text, alignment: .center, in: environment))
            let subtitle = MeasuredText(ChatTextStyles.fullEmptySubtitle.string(words.fullNoOutput, color: Palette.textSecondary, alignment: .center, in: environment))
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
    static func section(_ icon: Icon, tint: ColorToken, title: String, _ content: ChatPiece, text rowText: ChatRowText) -> ChatStackEntry {
        let text = MeasuredText(ChatTextStyles.fullSectionTitle.string(title, color: Palette.text, in: rowText.environment))
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
    static func code(_ code: String, text: ChatRowText) -> ChatPiece {
        .stack([ChatStackEntry(
            piece: longText(code, style: ChatTextStyles.codeView, color: Palette.text, lineBreakMode: .byCharWrapping, in: text.environment),
            padding: LayoutInsets(top: 12, left: 12, bottom: 12, right: 12),
            background: ChatBox(frame: .zero, fill: Palette.surfaceHigh, radius: 6)
        )])
    }

    /// Text that can run to thousands of lines, as pieces stacked with no
    /// gap; short text is one piece.
    /// With `syntax`, the text is drawn in those spans' colours
    /// (`terminalString`), each piece cut from the whole.
    static func longText(
        _ text: String, style: ChatTextStyle, color: ColorToken, lineBreakMode: NSLineBreakMode = .byWordWrapping,
        syntax: [(text: String, kind: DiffSpanKind)]? = nil, in environment: TextEnvironment?
    ) -> ChatPiece {
        let whole = syntax
            .map { terminalString($0, style: style, color: color, lineBreakMode: lineBreakMode, in: environment) }
            .flatMap { $0.length == text.utf16.count ? $0 : nil }
        let chunks = TextChunks.split(text)
        guard chunks.count > 1 else { return .text(MeasuredText(whole ?? style.string(text, color: color, lineBreakMode: lineBreakMode, in: environment))) }
        guard let whole else {
            return .stack(chunks.enumerated().map { index, chunk in
                let drawn = index == chunks.count - 1 ? chunk : TextChunks.drawn(chunk)
                return ChatStackEntry(piece: .text(MeasuredText(style.string(drawn, color: color, lineBreakMode: lineBreakMode, in: environment))))
            })
        }
        return .stack(TextChunks.cuts(chunks).map { cut in
            let piece = NSMutableAttributedString(attributedString: whole.attributedSubstring(from: NSRange(location: cut.location, length: cut.length)))
            if cut.space { piece.append(style.string(" ", color: color, lineBreakMode: lineBreakMode, in: environment)) }
            return ChatStackEntry(piece: .text(MeasuredText(piece)))
        })
    }
}
#endif

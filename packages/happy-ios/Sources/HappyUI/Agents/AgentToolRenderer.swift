#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// Everything a Happy Agent tool call's screen is drawn from. Equal inputs
/// at the same width give the same plan.
struct AgentToolInput: Equatable, Sendable {
    var callId: String
    var detail: ToolDetail
    /// The whole call is being read from the computer.
    var loading: Bool
    /// Of a diff's files, the one the reader opened alone.
    var focusFile: String?
    /// The files the reader opened past "Show N more lines", by diff.
    var diffExpanded: [Int: Set<Int>]
    var maxContentWidth: CGFloat
    var text: ChatRowText
    var render: RenderServices
}

/// Measures the screen off the main thread, once per input and width.
actor AgentToolMeasurer {
    private var cache: (input: AgentToolInput, width: CGFloat, plan: ChatRowPlan)?

    func plan(_ input: AgentToolInput, width: CGFloat) -> ChatRowPlan {
        if let cache, cache.input == input, cache.width == width { return cache.plan }
        let plan = AgentToolRenderer.plan(input, width: width)
        cache = (input, width, plan)
        return plan
    }
}

/// A tool call's screen as one plan (`MessageDetailLayout`'s readable
/// column): a header card saying what kind of call it was and how it
/// stands, then each of `ToolDetail`'s sections under its heading, the
/// terminal and diffs as the legacy tool screen draws them.
enum AgentToolRenderer {
    typealias W = Strings.ToolDetail
    typealias M = ToolDetailMetrics

    static func plan(_ input: AgentToolInput, width: CGFloat) -> ChatRowPlan {
        let detail = input.detail
        var entries = [ChatStackEntry(piece: header(detail, text: input.text), marginBottom: M.sectionGap)]
        for section in detail.sections {
            entries += self.section(section, input: input).map { entry in
                var entry = entry
                entry.marginBottom += M.sectionGap
                return entry
            }
        }
        if input.loading {
            entries.append(ChatStackEntry(piece: note(W.loading, text: input.text), padding: LayoutInsets(top: 0, left: M.headingInset, bottom: 0, right: M.headingInset)))
        }
        let content = ChatPiece.stack(entries)
        let layout = MessageDetailLayout(width: width, kind: .tool, content: content.measurable, maxContentWidth: input.maxContentWidth)
        let drawn = content.draw(layout.content)
        return ChatRowPlan(id: input.callId, size: layout.contentSize, items: drawn.items, hits: drawn.hits)
    }

    // MARK: Header

    static func glyph(_ kind: ToolDetail.Kind) -> Icon {
        switch kind {
        case .terminal: .ionicons("terminal-outline")
        case .fileEdit: .ionicons("document-outline")
        case .exploration: .ionicons("search-outline")
        case .search, .web: .ionicons("globe-outline")
        case .subagent: .ionicons("hardware-chip-outline")
        case .plan: .ionicons("checkbox-outline")
        case .message: .ionicons("chatbubbles-outline")
        case .question: .ionicons("help-circle-outline")
        case .compaction: .ionicons("funnel-outline")
        case .media: .ionicons("image-outline")
        case .tool: .ionicons("flash-outline")
        }
    }

    static func statusColors(_ status: ToolDetail.Status) -> (pill: ColorToken, ink: ColorToken) {
        switch status {
        case .running: (Palette.toolRunningPill, Palette.toolRunningInk)
        case .completed: (Palette.toolDonePill, Palette.toolDoneInk)
        case .failed: (Palette.toolFailedPill, Palette.toolFailedInk)
        }
    }

    static func header(_ detail: ToolDetail, text rowText: ChatRowText) -> ChatPiece {
        let environment = rowText.environment
        let kindWords = W.kind(detail.kind)
        let title = MeasuredText(ChatTextStyles.toolDetailKind.string(kindWords, color: Palette.text, in: environment), maxLines: 2)
        // A kind that names the tool already says it once.
        let subtitle = detail.toolName == kindWords ? nil : MeasuredText(ChatTextStyles.toolDetailName.string(detail.toolName, color: Palette.textSecondary, lineBreakMode: .byTruncatingMiddle, in: environment), maxLines: 2)
        let colors = statusColors(detail.status)
        let status = MeasuredText(ChatTextStyles.toolDetailStatus.string(W.status(detail.status), color: colors.ink, in: environment), maxLines: 1)
        let statusSize = status.layout(width: 10_000).size
        let lead: CGFloat = detail.status == .running ? 16 : 0
        func layout(_ width: CGFloat) -> ToolDetailHeaderLayout {
            ToolDetailHeaderLayout(width: width, title: title.measurable, subtitle: subtitle?.measurable, pillText: statusSize, pillLead: lead)
        }
        return ChatPiece(measurable: Measurable { layout($0).size }) { frame in
            let layout = layout(frame.width)
            func place(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: frame.minX, dy: frame.minY) }
            var items: [ChatDrawItem] = [
                .box(ChatBox(frame: place(CGRect(origin: .zero, size: layout.size)), fill: Palette.settingsCard, radius: ToolDetailHeaderLayout.Metrics.radius)),
                .box(ChatBox(frame: place(layout.tile), fill: Palette.toolTile, radius: ToolDetailHeaderLayout.Metrics.tileRadius)),
                .icon(glyph(detail.kind), size: ToolDetailHeaderLayout.Metrics.glyph, frame: place(layout.glyph), tint: Palette.text),
                .text(title.layout(for: layout.title), place(layout.title)),
            ]
            if let subtitle, let frame = layout.subtitle { items.append(.text(subtitle.layout(for: frame), place(frame))) }
            let pill = place(layout.pill)
            items.append(.box(ChatBox(frame: pill, fill: colors.pill, radius: pill.height / 2)))
            if detail.status == .running {
                let spinner = CGRect(x: pill.minX + ToolDetailHeaderLayout.Metrics.pillPaddingH - 2, y: pill.midY - 6, width: 12, height: 12)
                items.append(.spinner(spinner, tint: colors.ink, scale: 0.6))
            }
            items.append(.text(status.layout(width: 10_000), place(layout.pillText)))
            return (items, [])
        }
    }

    // MARK: Sections

    static func section(_ section: ToolDetail.Section, input: AgentToolInput) -> [ChatStackEntry] {
        let text = input.text
        switch section {
        case .terminal(let command, let output, let prompt):
            let terminal = ToolFullTerminal(
                command: command, prompt: prompt, stdout: output, stderr: nil, error: nil,
                hideEmptyOutput: input.detail.status == .running || output == nil && !prompt
            )
            return [titled(prompt ? W.command : W.input, MessageDetailRenderer.command(terminal, syntax: input.render.diffSyntax, text: text), text: text)]
        case .files(let files, let omittedFiles):
            return [titled(W.files, filesPiece(files, omittedFiles: omittedFiles, input: input), text: text)]
        case .operations(let operations):
            return [titled(W.operations, card(operations.map { operationRow($0, text: text) }), text: text)]
        case .fields(let title, let fields):
            guard !fields.isEmpty else { return [] }
            return [titled(title.map(W.title), card(fields.map { fieldRow($0, text: text) }), text: text)]
        case .text(let title, let body):
            let piece = MessageDetailRenderer.longText(body, style: ChatTextStyles.toolDetailBody, color: Palette.text, in: text.environment)
            return [titled(W.title(title), card([MessageDetailRenderer.selectable(piece, body)]), text: text)]
        case .code(let title, let code, let path):
            let heading = path.map { "\(W.title(title)) · \(ToolWords.fileName($0))" } ?? W.title(title)
            return [titled(heading, codeBlock(code, text: text), text: text)]
        case .checklist(let title, let todos):
            return [titled(W.title(title), card(todos.map { todoRow($0, text: text) }), text: text)]
        case .links(let links):
            return [titled(W.sources, card(links.map { linkRow($0, text: text) }), text: text)]
        case .questions(let questions):
            return [titled(W.questions, card(questions.map { questionRow($0, text: text) }), text: text)]
        case .error(let message):
            let piece = MessageDetailRenderer.longText(message, style: ChatTextStyles.toolDetailBody, color: Palette.boxErrorText, lineBreakMode: .byCharWrapping, in: text.environment)
            let box = ChatPiece.stack([ChatStackEntry(
                piece: MessageDetailRenderer.selectable(piece, message), padding: LayoutInsets(top: 12, left: 14, bottom: 12, right: 14),
                background: ChatBox(frame: .zero, fill: Palette.boxErrorBackground, border: Palette.boxErrorBorder, borderWidth: 1, radius: ToolFieldsCardLayout.Metrics.radius)
            )])
            return [titled(W.error, box, text: text)]
        case .review(let review):
            return [titled(W.review, card(reviewFields(review).map { fieldRow($0, text: text, ink: reviewInk(review, $0)) }), text: text)]
        }
    }

    /// A section's heading over its content, inset to the cards' text.
    static func titled(_ title: String?, _ content: ChatPiece, text: ChatRowText) -> ChatStackEntry {
        var entries: [ChatStackEntry] = []
        if let title {
            let label = MeasuredText(ChatTextStyles.toolDetailSection.string(title, color: Palette.textSecondary, in: text.environment))
            entries.append(ChatStackEntry(piece: .text(label), marginBottom: M.headingGap, padding: LayoutInsets(top: 0, left: M.headingInset, bottom: 0, right: M.headingInset)))
        }
        entries.append(ChatStackEntry(piece: content))
        return ChatStackEntry(piece: .stack(entries))
    }

    static func note(_ words: String, text: ChatRowText) -> ChatPiece {
        .text(MeasuredText(ChatTextStyles.toolDetailNote.string(words, color: Palette.textSecondary, in: text.environment)))
    }

    /// Rows in a grouped card (`ToolFieldsCardLayout`), hairlines between.
    static func card(_ rows: [ChatPiece], fill: ColorToken = Palette.settingsCard) -> ChatPiece {
        let measurables = rows.map(\.measurable)
        return ChatPiece(measurable: Measurable { ToolFieldsCardLayout(width: $0, rows: measurables).size }) { frame in
            let layout = ToolFieldsCardLayout(width: frame.width, rows: measurables)
            var items: [ChatDrawItem] = [.box(ChatBox(frame: CGRect(origin: frame.origin, size: layout.size), fill: fill, radius: ToolFieldsCardLayout.Metrics.radius))]
            var hits: [ChatHit] = []
            for line in layout.separators { items.append(.box(ChatBox(frame: line.offsetBy(dx: frame.minX, dy: frame.minY), fill: Palette.toolSeparator))) }
            for (row, placed) in zip(rows, layout.rows) {
                let drawn = row.draw(placed.offsetBy(dx: frame.minX, dy: frame.minY))
                items += drawn.items
                hits += drawn.hits
            }
            return (items, hits)
        }
    }

    /// Monospaced text on the code ground, in pieces when it is long; a
    /// long press copies all of it.
    static func codeBlock(_ code: String, text: ChatRowText) -> ChatPiece {
        let piece = MessageDetailRenderer.longText(code, style: ChatTextStyles.toolDetailMono, color: Palette.text, lineBreakMode: .byCharWrapping, in: text.environment)
        return .stack([ChatStackEntry(
            piece: MessageDetailRenderer.selectable(piece, code), padding: LayoutInsets(top: M.codePadding, left: M.codePadding, bottom: M.codePadding, right: M.codePadding),
            background: ChatBox(frame: .zero, fill: Palette.settingsCard, radius: ToolFieldsCardLayout.Metrics.radius)
        )])
    }

    // MARK: Rows

    /// A row of a glyph and its text (`ChatAccessoryRowLayout`).
    static func glyphRow(_ icon: Icon, tint: ColorToken, _ string: NSAttributedString, hit: ChatRowAction? = nil) -> ChatPiece {
        let label = MeasuredText(string)
        let glyph = CGSize(width: M.rowGlyph, height: M.rowGlyph)
        return ChatPiece(measurable: Measurable { ChatAccessoryRowLayout(width: $0, leading: glyph, text: label.measurable, gap: 10, alignment: .top).size }) { frame in
            let layout = ChatAccessoryRowLayout(width: frame.width, leading: glyph, text: label.measurable, gap: 10, alignment: .top)
            let textFrame = layout.text.offsetBy(dx: frame.minX, dy: frame.minY)
            // The glyph sits on the first line, the rows' style's 20.
            let firstLine = min(textFrame.height, ChatTextStyles.toolDetailValue.lineHeight ?? textFrame.height)
            let glyphFrame = CGRect(x: frame.minX, y: textFrame.minY + (firstLine - M.rowGlyph) / 2, width: M.rowGlyph, height: M.rowGlyph)
            let items: [ChatDrawItem] = [.icon(icon, size: M.rowGlyph, frame: glyphFrame, tint: tint), .text(label.layout(for: textFrame), textFrame)]
            return (items, hit.map { [ChatHit(frame: frame.insetBy(dx: 0, dy: -ToolFieldsCardLayout.Metrics.paddingV), action: $0)] } ?? [])
        }
    }

    static func operationRow(_ operation: ToolDetail.Operation, text: ChatRowText) -> ChatPiece {
        let environment = text.environment
        let (verb, icon): (String, Icon) = switch operation.kind {
        case "list": (W.listed, .ionicons("folder-outline"))
        case "read": (W.read, .ionicons("document-text-outline"))
        default: (W.searched, .ionicons("search-outline"))
        }
        let string = NSMutableAttributedString(attributedString: ChatTextStyles.toolDetailValue.string(verb + "  ", color: Palette.textSecondary, in: environment))
        string.append(ChatTextStyles.toolDetailMono.string(operation.subject, color: Palette.text, lineBreakMode: .byCharWrapping, in: environment))
        if let detail = operation.detail {
            string.append(ChatTextStyles.toolDetailValue.string("\n", color: Palette.text, in: environment))
            string.append(ChatTextStyles.toolDetailNote.string(detail, color: Palette.textSecondary, lineBreakMode: .byCharWrapping, in: environment))
        }
        return glyphRow(icon, tint: Palette.textSecondary, string)
    }

    static func todoRow(_ todo: ToolDetail.Todo, text: ChatRowText) -> ChatPiece {
        let (icon, tint): (Icon, ColorToken) = switch todo.state {
        case .done: (.ionicons("checkmark-circle"), Palette.toolDoneInk)
        case .active: (.ionicons("time-outline"), Palette.toolRunningInk)
        case .pending: (.ionicons("ellipse-outline"), Palette.textSecondary)
        case .cancelled: (.ionicons("remove-circle-outline"), Palette.textSecondary)
        }
        let settled = todo.state == .done || todo.state == .cancelled
        let string = NSMutableAttributedString(attributedString: ChatTextStyles.toolDetailValue.string(todo.text, color: settled ? Palette.textSecondary : Palette.text, in: text.environment))
        if settled { string.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: NSRange(location: 0, length: string.length)) }
        return glyphRow(icon, tint: tint, string)
    }

    static func linkRow(_ link: ToolDetail.Link, text: ChatRowText) -> ChatPiece {
        let string = NSMutableAttributedString(attributedString: ChatTextStyles.toolDetailValue.string(link.title.isEmpty ? link.url : link.title, color: Palette.textLink, in: text.environment))
        string.append(ChatTextStyles.toolDetailValue.string("\n", color: Palette.text, in: text.environment))
        string.append(ChatTextStyles.toolDetailNote.string(link.url, color: Palette.textSecondary, lineBreakMode: .byTruncatingMiddle, in: text.environment))
        return glyphRow(.ionicons("globe-outline"), tint: Palette.textSecondary, string, hit: .openURL(link.url))
    }

    static func questionRow(_ question: ToolDetail.Question, text: ChatRowText) -> ChatPiece {
        let environment = text.environment
        var entries: [ChatStackEntry] = []
        if let header = question.header, !header.isEmpty {
            entries.append(ChatStackEntry(piece: .text(MeasuredText(ChatTextStyles.toolDetailSection.string(header, color: Palette.textSecondary, in: environment))), marginBottom: 4))
        }
        entries.append(ChatStackEntry(piece: .text(MeasuredText(ChatTextStyles.questionPrompt.string(question.question, color: Palette.text, in: environment))), marginBottom: 6))
        let answers = question.answers.isEmpty ? [W.noAnswer] : question.answers
        for answer in answers {
            let ink: ColorToken = question.answers.isEmpty ? Palette.textSecondary : Palette.text
            entries.append(ChatStackEntry(piece: glyphRow(.ionicons(question.answers.isEmpty ? "remove-circle-outline" : "checkmark-circle"), tint: question.answers.isEmpty ? Palette.textSecondary : Palette.toolDoneInk,
                                                          ChatTextStyles.toolDetailValue.string(answer, color: ink, in: environment)), marginTop: 2))
        }
        return .stack(entries)
    }

    // MARK: Fields

    static func fieldRow(_ field: ToolDetail.Field, text: ChatRowText, ink: ColorToken? = nil) -> ChatPiece {
        let label = MeasuredText(ChatTextStyles.toolDetailLabel.string(field.label, color: Palette.textSecondary, in: text.environment), maxLines: 2)
        let (value, inline, oneLine) = valuePiece(field.value, text: text, ink: ink)
        func layout(_ width: CGFloat) -> ToolFieldLayout {
            ToolFieldLayout(width: width, label: label.measurable, value: value.measurable, inline: inline, oneLine: oneLine)
        }
        return ChatPiece(measurable: Measurable { layout($0).size }) { frame in
            let layout = layout(frame.width)
            let labelFrame = layout.label.offsetBy(dx: frame.minX, dy: frame.minY)
            let drawn = value.draw(layout.value.offsetBy(dx: frame.minX, dy: frame.minY))
            return ([.text(label.layout(for: labelFrame), labelFrame)] + drawn.items, drawn.hits)
        }
    }

    /// A value's piece, whether it may sit beside its label, and its width
    /// on one line.
    static func valuePiece(_ value: ToolDetail.Value, text: ChatRowText, ink: ColorToken? = nil) -> (ChatPiece, Bool, CGFloat) {
        let environment = text.environment
        func line(_ string: NSAttributedString, hit: ChatRowAction? = nil, copy: String) -> (ChatPiece, Bool, CGFloat) {
            let measured = MeasuredText(string)
            let width = ChatTextLayout(unwrapped: string).size.width
            let piece = ChatPiece(measurable: measured.measurable) { frame in
                var hits = [ChatHit(frame: frame, action: .selectable(copy), hold: true)]
                if let hit { hits.insert(ChatHit(frame: frame.insetBy(dx: -4, dy: -8), action: hit), at: 0) }
                return ([.text(measured.layout(for: frame), frame)], hits)
            }
            return (piece, true, width)
        }
        switch value {
        case .text(let words):
            return line(ChatTextStyles.toolDetailValue.string(words, color: ink ?? Palette.text, in: environment), copy: words)
        case .mono(let words):
            return line(ChatTextStyles.toolDetailMono.string(words, color: ink ?? Palette.text, lineBreakMode: .byCharWrapping, in: environment), copy: words)
        case .scalar(let words):
            return line(ChatTextStyles.toolDetailValue.string(words, color: ink ?? Palette.textSecondary, in: environment), copy: words)
        case .link(let url):
            return line(ChatTextStyles.toolDetailValue.string(url, color: Palette.textLink, lineBreakMode: .byCharWrapping, in: environment), hit: .openURL(url), copy: url)
        case .block(let words):
            let piece = MessageDetailRenderer.longText(words, style: ChatTextStyles.toolDetailBody, color: Palette.text, in: environment)
            return (MessageDetailRenderer.selectable(piece, words), false, .greatestFiniteMagnitude)
        case .json(let json):
            return (nestedCode(json, text: text), false, .greatestFiniteMagnitude)
        case .list(let items):
            let pieces = items.map { item -> ChatStackEntry in
                switch item {
                case .fields(let fields): return ChatStackEntry(piece: nestedCard(fields, text: text))
                default:
                    let (piece, _, _) = valuePiece(item, text: text)
                    let bullet = MeasuredText(ChatTextStyles.toolDetailValue.string("•", color: Palette.textSecondary, in: environment), maxLines: 1)
                    let bulletSize = bullet.layout(width: 100).size
                    let row = ChatPiece(measurable: Measurable { ChatAccessoryRowLayout(width: $0, leading: bulletSize, text: piece.measurable, gap: 8, alignment: .top).size }) { frame in
                        let layout = ChatAccessoryRowLayout(width: frame.width, leading: bulletSize, text: piece.measurable, gap: 8, alignment: .top)
                        let drawn = piece.draw(layout.text.offsetBy(dx: frame.minX, dy: frame.minY))
                        let bulletFrame = layout.leading!.offsetBy(dx: frame.minX, dy: frame.minY)
                        return ([.text(bullet.layout(width: 100), bulletFrame)] + drawn.items, drawn.hits)
                    }
                    return ChatStackEntry(piece: row)
                }
            }
            return (.stack(pieces, gap: 6), false, .greatestFiniteMagnitude)
        case .fields(let fields):
            return (nestedCard(fields, text: text), false, .greatestFiniteMagnitude)
        }
    }

    /// Fields inside a field: a quieter card of their own.
    static func nestedCard(_ fields: [ToolDetail.Field], text: ChatRowText) -> ChatPiece {
        card(fields.map { fieldRow($0, text: text) }, fill: Palette.toolCode)
    }

    static func nestedCode(_ code: String, text: ChatRowText) -> ChatPiece {
        let piece = MessageDetailRenderer.longText(code, style: ChatTextStyles.toolDetailMono, color: Palette.text, lineBreakMode: .byCharWrapping, in: text.environment)
        return .stack([ChatStackEntry(
            piece: MessageDetailRenderer.selectable(piece, code), padding: LayoutInsets(top: 10, left: 10, bottom: 10, right: 10),
            background: ChatBox(frame: .zero, fill: Palette.toolCode, radius: 8)
        )])
    }

    // MARK: Review

    static func reviewFields(_ review: AgentWire.ToolReview) -> [ToolDetail.Field] {
        let decision = switch review.outcome {
        case "allowed": W.allowed
        case "denied": W.denied
        default: W.unproven
        }
        var fields = [ToolDetail.Field(W.decision, .text(decision))]
        if let kind = review.kind { fields.append(.init(W.reason, .text(kind == "timed_out" ? W.timedOut : W.unavailable))) }
        if let risk = review.risk { fields.append(.init(W.risk, .text(W.level(risk)))) }
        if let authorization = review.userAuthorization { fields.append(.init(W.authorization, .text(W.level(authorization)))) }
        if let elevated = review.elevated { fields.append(.init(W.access, .text(elevated ? W.fullAccess : W.sandboxed))) }
        if let reason = review.reason, !reason.isEmpty { fields.append(.init(W.reason, .block(reason))) }
        return fields
    }

    static func reviewInk(_ review: AgentWire.ToolReview, _ field: ToolDetail.Field) -> ColorToken? {
        guard field.label == W.decision else {
            if field.label == W.risk, review.risk == "high" || review.risk == "critical" { return Palette.toolFailedInk }
            return nil
        }
        return switch review.outcome {
        case "allowed": Palette.toolDoneInk
        case "denied": Palette.toolFailedInk
        default: Palette.textSecondary
        }
    }

    // MARK: Files

    /// Each file under its header, its diff with line numbers, in a card;
    /// the file the reader opened alone, when it is still there. A header
    /// opens its file alone when there are others.
    static func filesPiece(_ files: [ToolDetail.FileChange], omittedFiles: Int, input: AgentToolInput) -> ChatPiece {
        let focused = files.indices.filter { files[$0].path == input.focusFile }
        let shown = focused.isEmpty ? Array(files.indices) : focused
        var entries: [ChatStackEntry] = []
        for index in shown {
            let file = files[index]
            let opens: ChatRowAction? = files.count > 1 && focused.isEmpty ? .openMessageFile(id: input.callId, file: file.path) : nil
            entries.append(ChatStackEntry(piece: fileCard(file, index: index, opens: opens, input: input)))
            if file.omittedLines > 0 {
                entries.append(ChatStackEntry(piece: note(W.omittedLines(file.omittedLines), text: input.text), marginTop: 6, padding: LayoutInsets(top: 0, left: M.headingInset, bottom: 0, right: M.headingInset)))
            }
        }
        if omittedFiles > 0, focused.isEmpty {
            entries.append(ChatStackEntry(piece: note(W.omittedFiles(omittedFiles), text: input.text), padding: LayoutInsets(top: 0, left: M.headingInset, bottom: 0, right: M.headingInset)))
        }
        return .stack(entries, gap: 12)
    }

    static func fileCard(_ file: ToolDetail.FileChange, index: Int, opens: ChatRowAction?, input: AgentToolInput) -> ChatPiece {
        let border: CGFloat = 1
        let radius = ToolFieldsCardLayout.Metrics.radius
        let kind: FileChangeKind = file.kind == "add" ? .added : file.kind == "delete" ? .deleted : .modified
        let source: DiffChunkSource? = switch file.source {
        case .patch(let patch)?: DiffChunkSource(patch: patch, fileName: file.path, newFile: kind == .added)
        case .pair(let old, let new)?: DiffChunkSource(oldText: old, newText: new, fileName: file.path, newFile: kind == .added)
        case nil: nil
        }
        var stats = source?.patch.map { DiffStats.countPatch($0) } ?? DiffStats.Counts(additions: file.added, deletions: file.deleted)
        if file.added > 0 || file.deleted > 0 { stats = DiffStats.Counts(additions: file.added, deletions: file.deleted) }
        var parts = [ChatStackEntry(piece: ChatRowRenderer.patchHeader(path: file.path, kind: kind, stats: stats, movePath: nil, opens: opens, topRadius: radius - border, text: input.text))]
        if let source, let diff = ChatRowRenderer.diffPiece(
            source, index: index, toolId: input.callId, showLineNumbers: true, expanded: input.diffExpanded[index] ?? [],
            render: input.render, radius: radius - border, corners: .bottom, text: input.text
        ) {
            parts.append(ChatStackEntry(piece: diff))
        }
        return .stack([ChatStackEntry(
            piece: .stack(parts),
            padding: LayoutInsets(top: border, left: border, bottom: border, right: border),
            background: ChatBox(frame: .zero, fill: Palette.surface, border: Palette.legacyDivider, borderWidth: border, radius: radius)
        )])
    }
}
#endif

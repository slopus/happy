#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// Part of a row: its size at a width, and once a layout has placed it,
/// what to draw there. Tool bodies are built from these.
struct ChatPiece {
    let measurable: Measurable
    let draw: (CGRect) -> (items: [ChatDrawItem], hits: [ChatHit])

    static func text(_ text: MeasuredText) -> ChatPiece {
        ChatPiece(measurable: text.measurable) { frame in ([.text(text.layout(for: frame), frame)], []) }
    }

    static func markdown(_ markdown: MarkdownPiece) -> ChatPiece {
        ChatPiece(measurable: Measurable { MarkdownLayout(width: $0, blocks: markdown.blocks).size }) { frame in
            markdown.draw(MarkdownLayout(width: frame.width, blocks: markdown.blocks), origin: frame.origin)
        }
    }

    /// Pieces one above the other (`ChatStackLayout`), each with its own
    /// margins, padding and background.
    static func stack(_ entries: [ChatStackEntry], gap: CGFloat = 0) -> ChatPiece {
        let items = entries.map(\.item)
        return ChatPiece(measurable: ChatStackLayout.measurable(items: { _ in items }, gap: gap)) { frame in
            let layout = ChatStackLayout(width: frame.width, items: items, gap: gap)
            var drawn: [ChatDrawItem] = []
            var hits: [ChatHit] = []
            for (index, entry) in entries.enumerated() {
                if var background = entry.background {
                    background.frame = layout.boxes[index].offsetBy(dx: frame.minX, dy: frame.minY)
                    drawn.append(.box(background))
                }
                let placed = entry.piece.draw(layout.contents[index].offsetBy(dx: frame.minX, dy: frame.minY))
                drawn += placed.items
                hits += placed.hits
            }
            return (drawn, hits)
        }
    }
}

struct ChatStackEntry {
    var piece: ChatPiece
    var marginTop: CGFloat = 0
    var marginBottom: CGFloat = 0
    var padding: LayoutInsets = .zero
    var placement: ChatStackLayout.Placement = .fill
    var maxHeight: CGFloat?
    /// Drawn behind the entry, its padding included; the frame is filled in.
    var background: ChatBox?

    var item: ChatStackLayout.Item {
        ChatStackLayout.Item(piece.measurable, marginTop: marginTop, marginBottom: marginBottom, padding: padding, placement: placement, maxHeight: maxHeight)
    }
}

/// What a tool's views need besides the tool: a question form's state,
/// the diffs the reader opened further, and whether the body runs to the
/// card's edges (a card) or sits inside a box (a compact row).
struct ChatToolViews {
    var question: ChatQuestionState?
    var diffExpanded: [Int: Set<Int>] = [:]
    var diagrams = ChatMermaidHeights()
    var flush = true
}

// MARK: Tool rows (ToolView.tsx)

extension ChatRowRenderer {
    /// A tool row: its header always, its body only once the reader opens
    /// it or while a decision needs it (`ChatToolPresentation`).
    static func toolCall(_ message: ToolCallMessage, expanded: Bool, busy: PermissionButton.Kind?, views: ChatToolViews, width: CGFloat, style: ChatRowStyle) -> ChatRowPlan {
        let tool = message.tool
        let text = style.text
        let environment = text.environment
        let context = ToolContext(root: style.root, flavor: style.flavor, compactMode: style.compactTools)
        guard let presentation = ChatToolPresentation.present(
            tool, children: message.children, context: context, state: ToolDisplayState(expanded: expanded), words: text.words.toolActions
        ) else {
            return ChatRowPlan(id: message.id, size: CGSize(width: width, height: 0), items: [])
        }
        var views = views
        views.flush = presentation.form != .compact
        let body = toolBody(presentation.body, message: message, views: views, style: style)
        // The header opens and closes the body. With nothing to open, or
        // while a decision holds it open, it opens the tool's own screen.
        let open: ChatRowAction = presentation.opensFile.map(ChatRowAction.openFile) ?? .openMessage(message.id)
        let expandable = !presentation.awaitingDecision && presentation.expandedBody != .none
            && (body != nil || toolBody(presentation.expandedBody, message: message, views: views, style: style) != nil)
        let tap: ChatRowAction = expandable ? .toggleTool(message.id) : open
        let footer = presentation.showsPermissionFooter ? tool.permission.map {
            permissionFooter($0, tool: tool, busy: busy, flavor: style.flavor, tablet: style.tablet, maxListHeight: style.permissionListMaxHeight, text: text)
        } : nil
        let elapsed = presentation.showsElapsed ? elapsedSize(in: environment) : nil
        let glyph = presentation.statusGlyph.map { _ in CGSize(width: ToolCardLayout.Metrics.statusIconSize, height: ToolCardLayout.Metrics.statusIconSize) }

        if presentation.form == .compact {
            let label = MeasuredText(ChatTextStyles.compactActivity.string(presentation.activityLabel, color: Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: environment), maxLines: 1)
            let layout = CompactToolRowLayout(
                width: width, maxContentWidth: style.maxContentWidth, label: label.measurable,
                elapsed: elapsed.map { Measurable.fixed($0) }, statusIcon: glyph, body: body?.measurable, footer: footer?.measurable
            )
            var items: [ChatDrawItem] = [
                headerIcon(presentation.icon, frame: layout.icon),
                .text(label.layout(for: layout.label), layout.label),
            ]
            if let frame = layout.elapsed { items.append(.elapsed(since: tool.createdAt, frame: frame, text: environment)) }
            if let frame = layout.statusIcon, let glyph = presentation.statusGlyph { items.append(statusGlyph(glyph, frame: frame)) }
            var hits: [ChatHit] = []
            if let body, let box = layout.bodyBox, let frame = layout.body {
                items.append(.box(ChatBox(frame: box, fill: Palette.surfaceHigh, radius: CompactToolRowLayout.Metrics.bodyRadius)))
                let drawn = body.draw(frame)
                items += drawn.items
                hits += drawn.hits
                hits.append(ChatHit(frame: box, action: open))
            }
            if let footer, let frame = layout.footer {
                let drawn = footer.draw(frame)
                items += drawn.items
                hits += drawn.hits
            }
            hits.append(ChatHit(frame: layout.header, action: tap))
            return ChatRowPlan(id: message.id, size: layout.size, items: items, hits: hits, accessibilityLabel: presentation.activityLabel)
        }

        let titleText = text.words.text(presentation.title)
        var header: ToolCardLayout.Header?
        var title: MeasuredText?
        var subtitle: MeasuredText?
        if presentation.showsHeader {
            let string = NSMutableAttributedString(attributedString: ChatTextStyles.toolName.string(titleText, color: Palette.text, lineBreakMode: .byTruncatingTail, in: environment))
            if let status = presentation.status {
                let dimmed = UIColor(Palette.text).withAlphaComponent(0.3)
                let attributes = ChatTextStyles.toolStatus.attributes(color: dimmed, lineBreakMode: .byTruncatingTail, in: environment)
                string.append(NSAttributedString(string: " \(text.words.text(status))", attributes: attributes))
            }
            title = MeasuredText(string, maxLines: 1)
            subtitle = presentation.subtitle.map {
                MeasuredText(ChatTextStyles.toolDescription.string(text.words.text($0), color: Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: environment), maxLines: 1)
            }
            header = ToolCardLayout.Header(title: title!.measurable, description: subtitle?.measurable, elapsed: elapsed.map { Measurable.fixed($0) }, statusIcon: glyph)
        }
        let layout = ToolCardLayout(.init(
            width: width, maxContentWidth: style.maxContentWidth, header: header,
            body: body?.measurable, footer: footer?.measurable, inline: presentation.form == .inline
        ))
        let card = layout.card
        func place(_ frame: CGRect) -> CGRect { frame.offsetBy(dx: card.minX, dy: card.minY) }

        var items: [ChatDrawItem] = []
        var hits: [ChatHit] = []
        if presentation.form == .card {
            items.append(.box(ChatBox(frame: card, fill: Palette.surfaceHigh, radius: ToolCardLayout.Metrics.radius)))
        }
        if let headerFrame = layout.header {
            // The card clips its header's top corners, and its bottom ones
            // when nothing follows.
            let alone = headerFrame.height >= card.height
            items.append(.box(ChatBox(frame: place(headerFrame), fill: Palette.surfaceHighest, radius: ToolCardLayout.Metrics.radius, corners: alone ? .all : .top)))
            hits.append(ChatHit(frame: place(headerFrame), action: tap))
        }
        if let frame = layout.icon { items.append(headerIcon(presentation.icon, frame: place(frame))) }
        if let frame = layout.title, let title { items.append(.text(title.layout(for: frame), place(frame))) }
        if let frame = layout.description, let subtitle { items.append(.text(subtitle.layout(for: frame), place(frame))) }
        if let frame = layout.elapsed { items.append(.elapsed(since: tool.createdAt, frame: place(frame), text: environment)) }
        if let frame = layout.statusIcon, let glyph = presentation.statusGlyph { items.append(statusGlyph(glyph, frame: place(frame))) }
        if let body, let frame = layout.body {
            let drawn = body.draw(place(frame))
            items += drawn.items
            // The opened body leads to the tool's screen; an attachment's
            // picture leads nowhere.
            hits = drawn.hits + hits + (presentation.form == .inline ? [] : [ChatHit(frame: place(frame), action: open)])
        }
        if let footer, let frame = layout.footer {
            let drawn = footer.draw(place(frame))
            items += drawn.items
            hits = drawn.hits + hits
        }
        let accessibility = [titleText, presentation.subtitle.map(text.words.text)].compactMap { $0 }.joined(separator: ", ")
        return ChatRowPlan(id: message.id, size: layout.size, items: items, hits: hits, accessibilityLabel: accessibility)
    }

    /// Room for the timer: right-aligned, as wide as "000.0s" at the size
    /// it is drawn at.
    static func elapsedSize(in environment: TextEnvironment?) -> CGSize {
        ChatTextLayout(ChatTextStyles.toolElapsed.string("000.0s", color: Palette.textSecondary, in: environment), width: 1000, maxLines: 1).size
    }

    static func headerIcon(_ icon: ToolIcon, frame: CGRect) -> ChatDrawItem {
        let glyph: Icon
        var tint = Palette.text
        switch icon {
        case .task: glyph = .octicons("rocket")
        case .terminal: glyph = .octicons("terminal")
        case .search: glyph = .octicons("search")
        case .read: glyph = .octicons("eye")
        case .edit: glyph = .octicons("file-diff")
        case .web: glyph = .ionicons("globe-outline")
        case .exit: glyph = .ionicons("exit-outline")
        case .todo: glyph = .ionicons("bulb-outline")
        case .reasoning: glyph = .octicons("light-bulb")
        case .question: glyph = .ionicons("help-circle-outline")
        case .mcp:
            glyph = .ionicons("extension-puzzle-outline")
            tint = Palette.textSecondary
        case .generic:
            glyph = .ionicons("construct-outline")
            tint = Palette.textSecondary
        }
        return .icon(glyph, size: 18, frame: frame, tint: tint)
    }

    static func statusGlyph(_ glyph: ToolPresentation.StatusGlyph, frame: CGRect) -> ChatDrawItem {
        switch glyph {
        case .spinner: .spinner(frame, tint: Palette.text, scale: 0.8)
        case .stopped: .icon(.ionicons("remove-circle-outline"), size: 20, frame: frame, tint: Palette.textSecondary)
        case .failed: .icon(.ionicons("alert-circle-outline"), size: 20, frame: frame, tint: Palette.warning)
        }
    }

    // MARK: Card bodies

    /// The body's pieces, or nil when they draw nothing.
    static func toolBody(_ body: ToolPresentation.Body, message: ToolCallMessage, views: ChatToolViews, style: ChatRowStyle) -> ChatPiece? {
        var entries: [ChatStackEntry] = []
        switch body {
        case .none:
            break
        case .error(let error):
            entries.append(toolError(error, text: style.text))
        case .raw(let input, let output):
            if let input { entries.append(section(style.text.words.input, codeView(input, text: style.text), text: style.text)) }
            if let output { entries.append(section(style.text.words.output, codeView(output, text: style.text), text: style.text)) }
        case .view(let kind, let error):
            if let view = toolView(kind, message: message, views: views, style: style) { entries.append(view) }
            if let error { entries.append(toolError(error, text: style.text)) }
        }
        return entries.isEmpty ? nil : .stack(entries)
    }

    /// The tool's own view.
    static func toolView(_ kind: ToolViewKind, message: ToolCallMessage, views: ChatToolViews, style: ChatRowStyle) -> ChatStackEntry? {
        let text = style.text
        return switch kind {
        case .askUserQuestion, .requestUserInput: views.question.map { questionForm($0, toolId: message.id, text: text) }
        case .edit, .write, .multiEdit, .geminiEdit: diffView(kind, message: message, views: views, style: style)
        case .codexPatch: codexPatchView(message, views: views, style: style)
        case .codexDiff: codexDiffView(message, views: views, style: style)
        case .todo: todoView(message.tool, text: text)
        case .exitPlan: exitPlanView(message.tool, diagrams: views.diagrams, syntax: style.render.codeSyntax, text: text)
        case .task: taskView(message.children, text: text)
        case .bash: bashView(message.tool, text: text)
        case .codexBash: codexBashView(message.tool, root: style.root, text: text)
        case .geminiExecute: geminiExecuteView(message.tool, text: text)
        case .file: fileView(message.tool, text: text)
        }
    }

    // MARK: Diff views

    /// EditView, WriteView, MultiEditView and GeminiEditView: DiffChunk
    /// under a full-width ToolSectionView (flush under the card's header,
    /// to its edges), MultiEdit's diffs 8 apart. Nil when no diff draws
    /// anything (DiffChunk renders null).
    static func diffView(_ kind: ToolViewKind, message: ToolCallMessage, views: ChatToolViews, style: ChatRowStyle) -> ChatStackEntry? {
        let chunks = ToolDiffInputs.chunks(kind, input: message.tool.input)
        // MultiEditView passes no line-number flag, so its diffs use the
        // same setting through ToolDiffView.
        let pieces = chunks.enumerated().compactMap { index, chunk in
            diffPiece(chunk, index: index, toolId: message.id, showLineNumbers: style.showLineNumbers, expanded: views.diffExpanded[index] ?? [], render: style.render, text: style.text)
        }
        guard !pieces.isEmpty else { return nil }
        let entries = pieces.map { ChatStackEntry(piece: $0) }
        return fullWidthSection(.stack(entries, gap: 8), flush: views.flush, text: style.text)
    }

    /// ToolSectionView fullWidth: flush under the card's header and out to
    /// its edges. In a compact row's box, a plain section.
    static func fullWidthSection(_ piece: ChatPiece, flush: Bool, text: ChatRowText) -> ChatStackEntry {
        guard flush else { return section(nil, piece, text: text) }
        typealias M = ToolCardLayout.Metrics
        return ChatStackEntry(
            piece: piece, marginTop: -M.contentPaddingTop, marginBottom: 12,
            padding: LayoutInsets(top: 0, left: -M.contentPaddingH, bottom: 0, right: -M.contentPaddingH)
        )
    }

    /// CodexPatchView: each file in its own full-width section on
    /// `surface`, its header opening that file on the message's screen,
    /// then its diff. PatchFallback, "Update file" over the raw text, when
    /// the patch can't be read.
    static func codexPatchView(_ message: ToolCallMessage, views: ChatToolViews, style: ChatRowStyle) -> ChatStackEntry? {
        let tool = message.tool
        // PatchError: ToolView hides the default error for patches.
        let text = style.text
        let error = tool.state == .error ? ToolFullPresentation.resultText(tool.result).map { toolError($0, text: text) } : nil
        guard let files = ChatPatch.viewFiles(tool.input, root: style.root) else {
            var entries = error.map { [$0] } ?? []
            if let raw = ChatPatch.fallbackText(tool.input), !raw.isEmpty { entries.append(ChatStackEntry(piece: codeView(raw, text: text))) }
            return section(text.words.name(.applyChanges), .stack(entries), text: text)
        }
        var entries = error.map { [$0] } ?? []
        for (index, file) in files.enumerated() {
            var parts = [ChatStackEntry(piece: patchHeader(
                path: file.path, kind: file.kind, stats: file.stats, movePath: file.movePath,
                opens: .openMessageFile(id: message.id, file: file.file), text: text
            ))]
            let source: DiffChunkSource? = switch file.diff {
            case .patch(let patch)?: DiffChunkSource(patch: patch, fileName: file.fileName)
            case .pair(let old, let new)?: DiffChunkSource(oldText: old, newText: new, fileName: file.fileName)
            case nil: nil
            }
            if let source, let diff = diffPiece(
                source, index: index, toolId: message.id, showLineNumbers: style.showLineNumbers, expanded: views.diffExpanded[index] ?? [],
                render: style.render, text: text
            ) {
                parts.append(ChatStackEntry(piece: diff))
            }
            let container = ChatStackEntry(piece: .stack(parts), background: ChatBox(frame: .zero, fill: Palette.surface))
            entries.append(fullWidthSection(.stack([container]), flush: views.flush, text: text))
        }
        return ChatStackEntry(piece: .stack(entries))
    }

    /// CodexDiffView: the turn's diff under a header naming its file, when
    /// it names one.
    static func codexDiffView(_ message: ToolCallMessage, views: ChatToolViews, style: ChatRowStyle) -> ChatStackEntry? {
        guard let diff = ToolUnifiedDiff(message.tool.input) else { return nil }
        var parts: [ChatStackEntry] = []
        if let name = diff.fileName, !name.isEmpty {
            parts.append(ChatStackEntry(piece: patchHeader(path: name, kind: .modified, stats: DiffStats.countPatch(diff.patch), movePath: nil, opens: nil, text: style.text)))
        }
        let source = DiffChunkSource(patch: diff.patch, fileName: diff.fileName)
        if let piece = diffPiece(
            source, index: 0, toolId: message.id, showLineNumbers: style.showLineNumbers, expanded: views.diffExpanded[0] ?? [], render: style.render, text: style.text
        ) {
            parts.append(ChatStackEntry(piece: piece))
        }
        guard !parts.isEmpty else { return nil }
        return fullWidthSection(.stack(parts), flush: views.flush, text: style.text)
    }

    /// CodexPatchView's PatchFileHeader: DiffFileHeader (no collapse
    /// chevron) on hunkBg, the move's destination under it, and, when it
    /// opens something, a chevron after the counts. `topRadius` rounds its
    /// top corners, as a card that clips it does. Its text is at the
    /// rows' size; the chevron, the icon and the paddings keep theirs.
    static func patchHeader(
        path: String, kind: FileChangeKind, stats: DiffStats.Counts, movePath: String?, opens: ChatRowAction?, topRadius: CGFloat = 0, text: ChatRowText
    ) -> ChatPiece {
        typealias M = DiffFileHeaderLayout.Metrics
        let chevronSize: CGFloat = 14
        // The `right` slot: 8 after the counts, inside the header's padding.
        let reserve = opens == nil ? 0 : M.gap + chevronSize
        let move = movePath.map {
            MeasuredText(ChatTextStyles.patchMovePath.string($0, color: DiffStyle.textSecondary, lineBreakMode: .byTruncatingHead, in: text.environment), maxLines: 1)
        }
        let moveInset = LayoutInsets(top: 0, left: M.paddingHorizontal, bottom: M.paddingVertical, right: M.paddingHorizontal)
        func plan(_ width: CGFloat) -> DiffHeaderPlan {
            DiffHeaderPlan(
                path: path, kind: kind, additions: stats.additions, deletions: stats.deletions,
                collapsed: false, width: max(0, width - reserve), scale: 1, toggles: false, text: text.environment
            )
        }
        func moveHeight(_ width: CGFloat) -> CGFloat {
            move.map { $0.measurable.height(fitting: max(0, width - moveInset.horizontal)) + moveInset.vertical } ?? 0
        }
        return ChatPiece(measurable: Measurable { width in
            CGSize(width: width, height: plan(width).layout.size.height + moveHeight(width))
        }) { frame in
            let header = plan(frame.width)
            let headerFrame = CGRect(x: frame.minX, y: frame.minY, width: header.layout.size.width, height: header.layout.size.height)
            let box = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: headerFrame.height + moveHeight(frame.width))
            var items: [ChatDrawItem] = [
                .box(ChatBox(frame: box, fill: DiffStyle.hunkBackground, radius: topRadius, corners: .top)),
                .diffHeader(header, path: path, frame: headerFrame),
            ]
            if opens != nil {
                let chevron = CGRect(
                    x: frame.maxX - M.paddingHorizontal - chevronSize, y: headerFrame.midY - chevronSize / 2,
                    width: chevronSize, height: chevronSize
                )
                items.append(.icon(.octicons("chevron-right"), size: chevronSize, frame: chevron, tint: DiffStyle.textSecondary))
            }
            if let move {
                let moveFrame = CGRect(
                    x: frame.minX + moveInset.left, y: headerFrame.maxY,
                    width: max(0, frame.width - moveInset.horizontal), height: box.height - headerFrame.height - moveInset.bottom
                )
                items.append(.text(move.layout(for: moveFrame), moveFrame))
            }
            return (items, opens.map { [ChatHit(frame: box, action: $0)] } ?? [])
        }
    }

    /// One DiffChunk: diff `index` of tool `toolId`, or nil when it draws
    /// nothing (DiffChunk renders null).
    static func diffPiece(
        _ chunk: ToolDiffChunk, index: Int, toolId: String, showLineNumbers: Bool, expanded: Set<Int>, render: RenderServices, text: ChatRowText
    ) -> ChatPiece? {
        diffPiece(
            DiffChunkSource(oldText: chunk.oldText, newText: chunk.newText, fileName: chunk.fileName),
            index: index, toolId: toolId, showLineNumbers: showLineNumbers, expanded: expanded, render: render, text: text
        )
    }

    /// `radius` and `corners` clip the diff where it ends a card. The diff
    /// is built through the account's documents (`render`); once they are
    /// closed it draws nothing. Its rows are at the rows' text size.
    static func diffPiece(
        _ source: DiffChunkSource, index: Int, toolId: String, showLineNumbers: Bool, expanded: Set<Int>,
        render: RenderServices, radius: CGFloat = 0, corners: CACornerMask = .all, text: ChatRowText
    ) -> ChatPiece? {
        guard !DiffFileItem.document(source.source, cache: render.diffDocuments).files.isEmpty else { return nil }
        let diff = ChatDiffPiece(source: source, showLineNumbers: showLineNumbers, expanded: expanded, render: render, text: text.environment)
        return ChatPiece(measurable: Measurable { diff.plan(width: $0).size }) { frame in
            ([.diff(diff.plan(width: frame.width), frame: frame, toolId: toolId, chunk: index, radius: radius, corners: corners)], [])
        }
    }

    // MARK: Terminal views

    /// BashView: the command in CommandView, with the error when it failed;
    /// never its output (BashViewFull, on the tool's screen, has that).
    static func bashView(_ tool: ToolCall, text: ChatRowText) -> ChatStackEntry? {
        guard let command = tool.input["command"]?.stringValue ?? ChatToolDisplay.stringifyCommand(tool.input["command"]) else { return nil }
        let error = tool.state == .error ? tool.result?.stringValue : nil
        return section(nil, commandView(command, error: error, text: text), text: text)
    }

    /// CodexBashView: a read or a write as what it does to which file;
    /// anything else as a command.
    static func codexBashView(_ tool: ToolCall, root: String?, text: ChatRowText) -> ChatStackEntry? {
        let first = tool.input["parsed_cmd"]?.arrayValue?.first
        let type = first?["type"]?.stringValue
        let command = first?["cmd"]?.stringValue
        if let type, type == "read" || type == "write", let name = first?["name"]?.stringValue, !name.isEmpty {
            let path = ChatToolPresentation.resolvePath(name, root: root)
            let operation = type == "read" ? text.words.readingFile(path) : text.words.writingFile(path)
            let label = MeasuredText(ChatTextStyles.toolOperation.string(operation, color: Palette.text, in: text.environment))
            let glyph = CGSize(width: 18, height: 18)
            let icon: Icon = type == "read" ? .octicons("eye") : .octicons("file-diff")
            let row = ChatPiece(measurable: Measurable { ChatAccessoryRowLayout(width: $0, leading: glyph, text: label.measurable).size }) { frame in
                let layout = ChatAccessoryRowLayout(width: frame.width, leading: glyph, text: label.measurable)
                let labelFrame = layout.text.offsetBy(dx: frame.minX, dy: frame.minY)
                return ([
                    .icon(icon, size: 18, frame: layout.leading!.offsetBy(dx: frame.minX, dy: frame.minY), tint: Palette.textSecondary),
                    .text(label.layout(for: labelFrame), labelFrame),
                ], [])
            }
            var entries = [ChatStackEntry(piece: row)]
            if let command {
                let line = MeasuredText(ChatTextStyles.toolOperationCommand.string(command, color: Palette.textSecondary, lineBreakMode: .byCharWrapping, in: text.environment))
                entries.append(ChatStackEntry(piece: .text(line), marginTop: 8))
            }
            let box = ChatStackEntry(
                piece: .stack(entries), padding: LayoutInsets(top: 12, left: 12, bottom: 12, right: 12),
                background: ChatBox(frame: .zero, fill: Palette.surfaceHigh, radius: 8)
            )
            return section(nil, .stack([box]), text: text)
        }
        let display = command ?? ChatToolDisplay.stringifyCommand(tool.input["command"]) ?? ""
        let error = tool.state == .error ? tool.result?.stringValue : nil
        return section(nil, commandView(display, error: error, text: text), text: text)
    }

    /// GeminiExecuteView: the command, then where it ran and why.
    static func geminiExecuteView(_ tool: ToolCall, text: ChatRowText) -> ChatStackEntry? {
        guard let title = tool.input["toolCall"]?["title"]?.stringValue, !title.isEmpty else { return nil }
        var command = title
        if let bracket = title.range(of: " ["), bracket.lowerBound > title.startIndex { command = String(title[..<bracket.lowerBound]) }
        var entries = [section(nil, codeView(command, text: text), text: text)]
        var info: [ChatStackEntry] = []
        if let open = title.range(of: "[current working directory "), let close = title[open.upperBound...].firstIndex(of: "]") {
            let cwd = String(title[open.upperBound..<close])
            info.append(ChatStackEntry(piece: .text(MeasuredText(ChatTextStyles.executeCwd.string("📁 \(cwd)", color: Palette.textSecondary, in: text.environment))), marginBottom: 4))
        }
        if let description = ChatToolPresentation.trailingParenthesis(title) {
            info.append(ChatStackEntry(piece: .text(MeasuredText(ChatTextStyles.executeDescription.string(description, color: Palette.textSecondary, in: text.environment)))))
        }
        if !info.isEmpty {
            entries.append(ChatStackEntry(piece: .stack(info), padding: LayoutInsets(top: 0, left: 12, bottom: 8, right: 12)))
        }
        return ChatStackEntry(piece: .stack(entries))
    }

    /// FileView: the picture a person attached, at its own shape, then its
    /// name on one line. Nothing when the input doesn't read as one.
    static func fileView(_ tool: ToolCall, text: ChatRowText) -> ChatStackEntry? {
        guard let file = ToolFileInput(tool.input) else { return nil }
        let name = MeasuredText(ChatTextStyles.attachmentName.string(file.name, color: Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: text.environment), maxLines: 1)
        let attachment = ChatAttachment(ref: file.ref, thumbhash: file.thumbhash)
        func layout(_ width: CGFloat) -> FileViewLayout {
            FileViewLayout(width: width, imageWidth: file.imageWidth, imageHeight: file.imageHeight, name: name.measurable)
        }
        return ChatStackEntry(piece: ChatPiece(measurable: Measurable { layout($0).size }) { frame in
            let layout = layout(frame.width)
            let image = layout.image.offsetBy(dx: frame.minX, dy: frame.minY)
            let nameFrame = layout.name.offsetBy(dx: frame.minX, dy: frame.minY)
            return ([.attachment(attachment, frame: image), .text(name.layout(for: nameFrame), nameFrame)], [])
        })
    }

    /// CommandView: a dark terminal panel, "$ " then the command, then the
    /// error in red. Empty output is not mentioned (hideEmptyOutput).
    static func commandView(_ command: String, error: String?, text: ChatRowText) -> ChatPiece {
        var entries = [ChatStackEntry(piece: commandLine(command, prompt: true, text: text))]
        if let error {
            let line = ChatTextStyles.terminal.string(error, color: Palette.terminalError, lineBreakMode: .byCharWrapping, in: text.environment)
            entries.append(ChatStackEntry(piece: .text(MeasuredText(line)), marginTop: 8))
        }
        return terminalPanel(entries)
    }

    /// CommandView's first line: "$ " (when it ran a command), then the
    /// command, wrapping under itself.
    static func commandLine(_ command: String, prompt: Bool, text: ChatRowText) -> ChatPiece {
        commandLine(ChatTextStyles.terminalCommand.string(command, color: Palette.terminalCommand, lineBreakMode: .byCharWrapping, in: text.environment), prompt: prompt, text: text)
    }

    /// The command already styled, as the tool's own screen colours it.
    static func commandLine(_ command: NSAttributedString, prompt: Bool, text rowText: ChatRowText) -> ChatPiece {
        let text = MeasuredText(command)
        guard prompt else { return .text(text) }
        let prompt = MeasuredText(ChatTextStyles.terminalPrompt.string("$ ", color: Palette.terminalPromptGreen, in: rowText.environment), maxLines: 1)
        return ChatPiece(measurable: Measurable { width in
            ChatAccessoryRowLayout(width: width, leading: prompt.layout(width: width).size, text: text.measurable, gap: 0, alignment: .top).size
        }) { frame in
            let layout = ChatAccessoryRowLayout(width: frame.width, leading: prompt.layout(width: frame.width).size, text: text.measurable, gap: 0, alignment: .top)
            let promptFrame = layout.leading!.offsetBy(dx: frame.minX, dy: frame.minY)
            let textFrame = layout.text.offsetBy(dx: frame.minX, dy: frame.minY)
            return ([.text(prompt.layout(width: frame.width), promptFrame), .text(text.layout(for: textFrame), textFrame)], [])
        }
    }

    /// CommandView's panel: dark in both themes, 16 in, rounded 8.
    static func terminalPanel(_ entries: [ChatStackEntry]) -> ChatPiece {
        .stack([ChatStackEntry(
            piece: .stack(entries), padding: LayoutInsets(top: 16, left: 16, bottom: 16, right: 16),
            background: ChatBox(frame: .zero, fill: Palette.terminalPanel, radius: 8)
        )])
    }

    /// ToolSectionView: an optional uppercase title, then the content, 12 below.
    static func section(_ title: String?, _ content: ChatPiece, text: ChatRowText) -> ChatStackEntry {
        var entries: [ChatStackEntry] = []
        if let title {
            let label = MeasuredText(ChatTextStyles.toolSectionTitle.string(title.uppercased(), color: Palette.textSecondary, in: text.environment))
            entries.append(ChatStackEntry(piece: .text(label), marginBottom: 6))
        }
        entries.append(ChatStackEntry(piece: content))
        return ChatStackEntry(piece: .stack(entries), marginBottom: 12)
    }

    /// CodeView: Menlo 12 / 18 on surfaceHigh, wrapped.
    static func codeView(_ code: String, text: ChatRowText) -> ChatPiece {
        let lines = MeasuredText(ChatTextStyles.codeView.string(code, color: Palette.text, lineBreakMode: .byCharWrapping, in: text.environment))
        return .stack([ChatStackEntry(
            piece: .text(lines), padding: LayoutInsets(top: 12, left: 12, bottom: 12, right: 12),
            background: ChatBox(frame: .zero, fill: Palette.surfaceHigh, radius: 6)
        )])
    }

    /// ToolError: the message in a red box, at most 115 tall; a refused
    /// call shows only its reason, after a warning sign. The 115 cap and
    /// the 16 glyph keep their size at every text size.
    static func toolError(_ message: String, text rowText: ChatRowText) -> ChatStackEntry {
        let reason = ChatToolPresentation.toolUseError(message)
        let shown = reason.flatMap { $0.isEmpty ? nil : $0 } ?? message
        let text = MeasuredText(ChatTextStyles.toolError.string(shown, color: Palette.boxErrorText, in: rowText.environment))
        let glyph: CGSize? = reason == nil ? nil : CGSize(width: 16, height: 16)
        let row = ChatPiece(measurable: Measurable { width in
            ChatAccessoryRowLayout(width: width, leading: glyph, text: text.measurable, alignment: .top).size
        }) { frame in
            let layout = ChatAccessoryRowLayout(width: frame.width, leading: glyph, text: text.measurable, alignment: .top)
            var items: [ChatDrawItem] = []
            if let leading = layout.leading {
                items.append(.icon(.ionicons("warning"), size: 16, frame: leading.offsetBy(dx: frame.minX, dy: frame.minY), tint: Palette.boxWarningText))
            }
            let textFrame = layout.text.offsetBy(dx: frame.minX, dy: frame.minY)
            // The box clips what runs past its height.
            let clipped = CGRect(x: textFrame.minX, y: textFrame.minY, width: textFrame.width, height: min(textFrame.height, frame.maxY - textFrame.minY))
            items.append(.text(text.layout(width: textFrame.width), clipped))
            return (items, [])
        }
        return ChatStackEntry(
            piece: row, marginBottom: 12, padding: LayoutInsets(top: 12, left: 12, bottom: 12, right: 12), maxHeight: 115,
            background: ChatBox(frame: .zero, fill: Palette.boxErrorBackground, border: Palette.boxErrorBorder, borderWidth: 1, radius: 6)
        )
    }

    /// TodoView: ☐ and ☑ lines, coloured by status, the latest list.
    static func todoView(_ tool: ToolCall, text: ChatRowText) -> ChatStackEntry? {
        var todos = tool.input["todos"]?.arrayValue ?? []
        if let newTodos = tool.result?["newTodos"]?.arrayValue { todos = newTodos }
        guard !todos.isEmpty else { return nil }
        let entries = todos.map { todo -> ChatStackEntry in
            let status = todo["status"]?.stringValue
            let content = todo["content"]?.stringValue ?? ""
            let color: ColorToken = switch status {
            case "completed": Palette.todoCompleted
            case "in_progress": Palette.todoInProgress
            case "pending": Palette.todoPending
            default: Palette.todoOther
            }
            let string = NSMutableAttributedString(attributedString: ChatTextStyles.todo.string("\(status == "completed" ? "☑" : "☐") \(content)", color: color, in: text.environment))
            if status == "completed" {
                string.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: NSRange(location: 0, length: string.length))
            }
            return ChatStackEntry(piece: .text(MeasuredText(string)), padding: LayoutInsets(top: 2, left: 0, bottom: 2, right: 0))
        }
        return section(nil, .stack(entries, gap: 4), text: text)
    }

    /// ExitPlanToolView: the plan as markdown, 8 in, pulled 10 up.
    static func exitPlanView(_ tool: ToolCall, diagrams: ChatMermaidHeights, syntax: CodeSyntaxService, text: ChatRowText) -> ChatStackEntry {
        let plan = tool.input["plan"]?.stringValue ?? "<empty>"
        let markdown = ChatPiece.markdown(MarkdownPiece(plan, color: Palette.text, diagrams: diagrams, syntax: syntax, in: text.environment))
        let inset = ChatStackEntry(piece: markdown, marginTop: -10, padding: LayoutInsets(top: 0, left: 8, bottom: 0, right: 8))
        return section(nil, .stack([inset]), text: text)
    }

    /// TaskView: the sub-agent's last three tool calls and how they went,
    /// then how many came before.
    static func taskView(_ children: [ChatMessage], text: ChatRowText) -> ChatStackEntry? {
        let calls = children.compactMap { child -> ToolCall? in
            guard case .toolCall(let call) = child, !ChatToolDisplay.isHidden(call.tool.name) else { return nil }
            return call.tool
        }
        guard !calls.isEmpty else { return nil }
        var entries = calls.suffix(3).map { call -> ChatStackEntry in
            let activity = ChatToolDisplay.activityLabel(call, words: text.words.toolActions)
            let label = MeasuredText(ChatTextStyles.taskItem.string(activity, color: Palette.textSecondary, in: text.environment))
            let status: CGSize = call.state == .running ? CGSize(width: 20, height: 20) : CGSize(width: 16, height: 16)
            let row = ChatPiece(measurable: Measurable { width in
                ChatAccessoryRowLayout(width: width, text: label.measurable, trailing: status).size
            }) { frame in
                let layout = ChatAccessoryRowLayout(width: frame.width, text: label.measurable, trailing: status)
                let labelFrame = layout.text.offsetBy(dx: frame.minX, dy: frame.minY)
                let glyph = layout.trailing!.offsetBy(dx: frame.minX, dy: frame.minY)
                let item: ChatDrawItem = switch call.state {
                case .running: .spinner(glyph, tint: Palette.warning, scale: 1)
                case .completed: .icon(.ionicons("checkmark-circle"), size: 16, frame: glyph, tint: Palette.success)
                case .error: .icon(.ionicons("close-circle"), size: 16, frame: glyph, tint: Palette.textDestructive)
                }
                return ([.text(label.layout(for: labelFrame), labelFrame), item], [])
            }
            return ChatStackEntry(piece: row, padding: LayoutInsets(top: 4, left: 4, bottom: 4, right: 2))
        }
        if calls.count > 3 {
            let dimmed = UIColor(Palette.textSecondary).withAlphaComponent(0.7)
            let more = NSAttributedString(string: text.words.moreTools(calls.count - 3), attributes: ChatTextStyles.taskMore.attributes(color: dimmed, in: text.environment))
            entries.append(ChatStackEntry(piece: .text(MeasuredText(more)), padding: LayoutInsets(top: 4, left: 4, bottom: 4, right: 4)))
        }
        return ChatStackEntry(piece: .stack(entries), padding: LayoutInsets(top: 4, left: 0, bottom: 12, right: 0))
    }

    // MARK: Permission buttons (PermissionFooter.tsx)

    /// A list taller than `maxListHeight` scrolls, its buttons and their
    /// taps inside the scroller.
    /// The buttons' 34 minimum and the list's cap keep their size at every
    /// text size; taller labels grow the buttons past it.
    static func permissionFooter(
        _ permission: ToolPermission, tool: ToolCall, busy: PermissionButton.Kind?, flavor: String?, tablet: Bool = false,
        maxListHeight: CGFloat = PermissionFooterLayout.Metrics.maxListHeight, text: ChatRowText
    ) -> ChatPiece {
        let buttons = ChatPermissionButtons.buttons(permission, toolName: tool.name, toolInput: tool.input, flavor: flavor)
        let pending = permission.status == .pending
        let labels = buttons.map { button in
            let style = pending || button.selected ? ChatTextStyles.permissionButton : ChatTextStyles.permissionButtonSettled
            let label = style.string(text.words.permission(button.kind), color: Palette.text, lineBreakMode: .byTruncatingTail, in: text.environment)
            return MeasuredText(label, maxLines: button.maxLines)
        }
        let measurables = labels.map(\.measurable)
        func layout(_ width: CGFloat) -> PermissionFooterLayout {
            tablet
                ? .tablet(width: width, labels: measurables, maxListHeight: maxListHeight)
                : PermissionFooterLayout(width: width, labels: measurables, maxListHeight: maxListHeight)
        }
        return ChatPiece(measurable: Measurable { layout($0).size }) { frame in
            typealias M = PermissionFooterLayout.Metrics
            let layout = layout(frame.width)
            // In the row, or in the scrolling list's own coordinates.
            let origin = layout.scrolls ? CGPoint(x: -layout.list.minX, y: -layout.list.minY) : frame.origin
            var items: [ChatDrawItem] = []
            var hits: [ChatHit] = []
            for (index, button) in buttons.enumerated() {
                let box = layout.buttons[index].offsetBy(dx: origin.x, dy: origin.y)
                let label = layout.labels[index].offsetBy(dx: origin.x, dy: origin.y)
                let alpha = button.inactive ? M.inactiveOpacity : 1
                items.append(.box(ChatBox(
                    frame: box, fill: button.selected ? Palette.surfaceHighest : Palette.surface,
                    border: Palette.divider, borderWidth: M.buttonBorder, radius: M.buttonRadius, alpha: alpha
                )))
                let text = labels[index].layout(for: layout.labels[index])
                items.append(.text(alpha < 1 ? text.dimmed(alpha) : text, label))
                if pending && busy == button.kind {
                    items.append(.pulse(ChatBox(frame: box.insetBy(dx: -1, dy: -1), border: Palette.text, borderWidth: 2, radius: M.buttonRadius + 1)))
                }
                if pending && busy == nil {
                    let reply = ChatPermissionButtons.reply(button.kind, toolName: tool.name, toolInput: tool.input)
                    hits.append(ChatHit(frame: box, action: .permission(ChatPermissionTap(permissionId: permission.id, kind: button.kind, reply: reply))))
                }
            }
            guard layout.scrolls else { return (items, hits) }
            let list = ChatRowPlan(id: "permissions", size: CGSize(width: layout.list.width, height: layout.listContentHeight), items: items, hits: hits)
            return ([.scroller(list, frame: layout.list.offsetBy(dx: frame.minX, dy: frame.minY), vertical: true)], [])
        }
    }
}

/// One DiffChunk in a row, planned once per width it is measured at, at
/// the row's text size: a row planned at another size makes a new piece.
/// Lives on the measuring actor with the rest of the row's pieces.
final class ChatDiffPiece {
    let source: DiffChunkSource
    let showLineNumbers: Bool
    let expanded: Set<Int>
    let render: RenderServices
    /// The text size the row is drawn at; nil is the designed size.
    let text: TextEnvironment?
    private var plans: [(width: CGFloat, plan: DiffChunkPlan)] = []

    init(source: DiffChunkSource, showLineNumbers: Bool, expanded: Set<Int>, render: RenderServices, text: TextEnvironment?) {
        self.source = source
        self.showLineNumbers = showLineNumbers
        self.expanded = expanded
        self.render = render
        self.text = text
    }

    func plan(width: CGFloat) -> DiffChunkPlan {
        if let cached = plans.first(where: { $0.width == width }) { return cached.plan }
        let plan = DiffChunkPlan(source: source, width: width, render: render, showLineNumbers: showLineNumbers, expanded: expanded, text: text)
        plans.append((width, plan))
        return plan
    }
}

extension ChatTextLayout {
    /// The same text at a lower opacity (an inactive permission button).
    func dimmed(_ alpha: CGFloat) -> ChatTextLayout {
        let copy = NSMutableAttributedString(attributedString: string)
        copy.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: copy.length)) { value, range, _ in
            guard let color = value as? UIColor else { return }
            copy.addAttribute(.foregroundColor, value: color.withAlphaComponent(alpha), range: range)
        }
        return ChatTextLayout(copy, width: width, maxLines: maxLines)
    }
}
#endif

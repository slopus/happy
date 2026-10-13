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

// MARK: Tool rows (ToolView.tsx)

extension ChatRowRenderer {
    static func toolCall(_ message: ToolCallMessage, busy: PermissionButton.Kind?, width: CGFloat, style: ChatRowStyle) -> ChatRowPlan {
        let tool = message.tool
        let context = ToolContext(root: style.root, flavor: style.flavor, compactMode: style.compactTools)
        guard let presentation = ChatToolPresentation.present(tool, children: message.children, context: context, words: Strings.ToolGroup.words) else {
            return ChatRowPlan(id: message.id, size: CGSize(width: width, height: 0), items: [])
        }
        let tap: ChatRowAction = presentation.opensFile.map(ChatRowAction.openFile) ?? .openMessage(message.id)
        let footer = presentation.showsPermissionFooter ? tool.permission.map { permissionFooter($0, tool: tool, busy: busy, flavor: style.flavor) } : nil
        let elapsed = presentation.showsElapsed ? elapsedSize : nil
        let glyph = presentation.statusGlyph.map { _ in CGSize(width: ToolCardLayout.Metrics.statusIconSize, height: ToolCardLayout.Metrics.statusIconSize) }

        if presentation.form == .compact {
            let label = MeasuredText(ChatTextStyles.compactActivity.string(presentation.activityLabel, color: Palette.textSecondary, lineBreakMode: .byTruncatingTail), maxLines: 1)
            let layout = CompactToolRowLayout(
                width: width, maxContentWidth: style.maxContentWidth, label: label.measurable,
                elapsed: elapsed.map { Measurable.fixed($0) }, statusIcon: glyph, footer: footer?.measurable
            )
            var items: [ChatDrawItem] = [
                headerIcon(presentation.icon, frame: layout.icon),
                .text(label.layout(for: layout.label), layout.label),
            ]
            if let frame = layout.elapsed { items.append(.elapsed(since: tool.createdAt, frame: frame)) }
            if let frame = layout.statusIcon, let glyph = presentation.statusGlyph { items.append(statusGlyph(glyph, frame: frame)) }
            var hits: [ChatHit] = []
            if let footer, let frame = layout.footer {
                let drawn = footer.draw(frame)
                items += drawn.items
                hits += drawn.hits
            }
            hits.append(ChatHit(frame: layout.header, action: tap))
            return ChatRowPlan(id: message.id, size: layout.size, items: items, hits: hits, accessibilityLabel: presentation.activityLabel)
        }

        let titleText = Strings.Tools.text(presentation.title)
        var header: ToolCardLayout.Header?
        var title: MeasuredText?
        var subtitle: MeasuredText?
        if presentation.showsHeader {
            let string = NSMutableAttributedString(attributedString: ChatTextStyles.toolName.string(titleText, color: Palette.text, lineBreakMode: .byTruncatingTail))
            if let status = presentation.status {
                let dimmed = UIColor(Palette.text).withAlphaComponent(0.3)
                string.append(NSAttributedString(string: " \(Strings.Tools.text(status))", attributes: ChatTextStyles.toolStatus.attributes(color: dimmed, lineBreakMode: .byTruncatingTail)))
            }
            title = MeasuredText(string, maxLines: 1)
            subtitle = presentation.subtitle.map {
                MeasuredText(ChatTextStyles.toolDescription.string(Strings.Tools.text($0), color: Palette.textSecondary, lineBreakMode: .byTruncatingTail), maxLines: 1)
            }
            header = ToolCardLayout.Header(title: title!.measurable, description: subtitle?.measurable, elapsed: elapsed.map { Measurable.fixed($0) }, statusIcon: glyph)
        }
        let body = toolBody(presentation.body, message: message, style: style)
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
        if let frame = layout.elapsed { items.append(.elapsed(since: tool.createdAt, frame: place(frame))) }
        if let frame = layout.statusIcon, let glyph = presentation.statusGlyph { items.append(statusGlyph(glyph, frame: place(frame))) }
        if let body, let frame = layout.body {
            let drawn = body.draw(place(frame))
            items += drawn.items
            hits = drawn.hits + hits
        }
        if let footer, let frame = layout.footer {
            let drawn = footer.draw(place(frame))
            items += drawn.items
            hits = drawn.hits + hits
        }
        let accessibility = [titleText, presentation.subtitle.map(Strings.Tools.text)].compactMap { $0 }.joined(separator: ", ")
        return ChatRowPlan(id: message.id, size: layout.size, items: items, hits: hits, accessibilityLabel: accessibility)
    }

    /// Room for the timer: right-aligned, as wide as "000.0s".
    static let elapsedSize: CGSize = {
        let size = ChatTextLayout(ChatTextStyles.toolElapsed.string("000.0s", color: Palette.textSecondary), width: 1000, maxLines: 1).size
        return CGSize(width: size.width, height: size.height)
    }()

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

    static func toolBody(_ body: ToolPresentation.Body, message: ToolCallMessage, style: ChatRowStyle) -> ChatPiece? {
        switch body {
        case .none:
            return nil
        case .error(let text):
            return .stack([toolError(text)])
        case .raw(let input, let output):
            var entries: [ChatStackEntry] = []
            if let input { entries.append(section(Strings.Tools.input, codeView(input))) }
            if let output { entries.append(section(Strings.Tools.output, codeView(output))) }
            return .stack(entries)
        case .view(let kind, let error):
            var entries: [ChatStackEntry] = []
            if let view = toolView(kind, message: message, style: style) { entries.append(view) }
            if let error { entries.append(toolError(error)) }
            return .stack(entries)
        }
    }

    /// The tool's own view. Diffs, questions and attachments are drawn by
    /// views still to come; until then their cards show the header alone.
    static func toolView(_ kind: ToolViewKind, message: ToolCallMessage, style: ChatRowStyle) -> ChatStackEntry? {
        switch kind {
        case .todo: todoView(message.tool)
        case .exitPlan: exitPlanView(message.tool)
        case .task: taskView(message.children)
        default: nil
        }
    }

    /// ToolSectionView: an optional uppercase title, then the content, 12 below.
    static func section(_ title: String?, _ content: ChatPiece) -> ChatStackEntry {
        var entries: [ChatStackEntry] = []
        if let title {
            let text = MeasuredText(ChatTextStyles.toolSectionTitle.string(title.uppercased(), color: Palette.textSecondary))
            entries.append(ChatStackEntry(piece: .text(text), marginBottom: 6))
        }
        entries.append(ChatStackEntry(piece: content))
        return ChatStackEntry(piece: .stack(entries), marginBottom: 12)
    }

    /// CodeView: Menlo 12 / 18 on surfaceHigh, wrapped.
    static func codeView(_ code: String) -> ChatPiece {
        let text = MeasuredText(ChatTextStyles.codeView.string(code, color: Palette.text, lineBreakMode: .byCharWrapping))
        return .stack([ChatStackEntry(
            piece: .text(text), padding: LayoutInsets(top: 12, left: 12, bottom: 12, right: 12),
            background: ChatBox(frame: .zero, fill: Palette.surfaceHigh, radius: 6)
        )])
    }

    /// ToolError: the message in a red box, at most 115 tall; a refused
    /// call shows only its reason, after a warning sign.
    static func toolError(_ message: String) -> ChatStackEntry {
        let reason = ChatToolPresentation.toolUseError(message)
        let text = MeasuredText(ChatTextStyles.toolError.string(reason.flatMap { $0.isEmpty ? nil : $0 } ?? message, color: Palette.boxErrorText))
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
    static func todoView(_ tool: ToolCall) -> ChatStackEntry? {
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
            let string = NSMutableAttributedString(attributedString: ChatTextStyles.todo.string("\(status == "completed" ? "☑" : "☐") \(content)", color: color))
            if status == "completed" {
                string.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: NSRange(location: 0, length: string.length))
            }
            return ChatStackEntry(piece: .text(MeasuredText(string)), padding: LayoutInsets(top: 2, left: 0, bottom: 2, right: 0))
        }
        return section(nil, .stack(entries, gap: 4))
    }

    /// ExitPlanToolView: the plan as markdown, 8 in, pulled 10 up.
    static func exitPlanView(_ tool: ToolCall) -> ChatStackEntry {
        let plan = tool.input["plan"]?.stringValue ?? "<empty>"
        let markdown = ChatPiece.markdown(MarkdownPiece(plan, color: Palette.text))
        let inset = ChatStackEntry(piece: markdown, marginTop: -10, padding: LayoutInsets(top: 0, left: 8, bottom: 0, right: 8))
        return section(nil, .stack([inset]))
    }

    /// TaskView: the sub-agent's last three tool calls and how they went,
    /// then how many came before.
    static func taskView(_ children: [ChatMessage]) -> ChatStackEntry? {
        let calls = children.compactMap { child -> ToolCall? in
            guard case .toolCall(let call) = child, !ChatToolDisplay.isHidden(call.tool.name) else { return nil }
            return call.tool
        }
        guard !calls.isEmpty else { return nil }
        var entries = calls.suffix(3).map { call -> ChatStackEntry in
            let label = MeasuredText(ChatTextStyles.taskItem.string(ChatToolDisplay.activityLabel(call, words: Strings.ToolGroup.words), color: Palette.textSecondary))
            let status: CGSize = call.state == .running ? CGSize(width: 20, height: 20) : CGSize(width: 16, height: 16)
            let row = ChatPiece(measurable: Measurable { width in
                ChatAccessoryRowLayout(width: width, text: label.measurable, trailing: status).size
            }) { frame in
                let layout = ChatAccessoryRowLayout(width: frame.width, text: label.measurable, trailing: status)
                let text = layout.text.offsetBy(dx: frame.minX, dy: frame.minY)
                let glyph = layout.trailing!.offsetBy(dx: frame.minX, dy: frame.minY)
                let item: ChatDrawItem = switch call.state {
                case .running: .spinner(glyph, tint: Palette.warning, scale: 1)
                case .completed: .icon(.ionicons("checkmark-circle"), size: 16, frame: glyph, tint: Palette.success)
                case .error: .icon(.ionicons("close-circle"), size: 16, frame: glyph, tint: Palette.textDestructive)
                }
                return ([.text(label.layout(for: text), text), item], [])
            }
            return ChatStackEntry(piece: row, padding: LayoutInsets(top: 4, left: 4, bottom: 4, right: 2))
        }
        if calls.count > 3 {
            let dimmed = UIColor(Palette.textSecondary).withAlphaComponent(0.7)
            let more = NSAttributedString(string: Strings.Tools.moreTools(calls.count - 3), attributes: ChatTextStyles.taskMore.attributes(color: dimmed))
            entries.append(ChatStackEntry(piece: .text(MeasuredText(more)), padding: LayoutInsets(top: 4, left: 4, bottom: 4, right: 4)))
        }
        return ChatStackEntry(piece: .stack(entries), padding: LayoutInsets(top: 4, left: 0, bottom: 12, right: 0))
    }

    // MARK: Permission buttons (PermissionFooter.tsx)

    static func permissionFooter(_ permission: ToolPermission, tool: ToolCall, busy: PermissionButton.Kind?, flavor: String?) -> ChatPiece {
        let buttons = ChatPermissionButtons.buttons(permission, toolName: tool.name, toolInput: tool.input, flavor: flavor)
        let pending = permission.status == .pending
        let labels = buttons.map { button in
            let style = pending || button.selected ? ChatTextStyles.permissionButton : ChatTextStyles.permissionButtonSettled
            return MeasuredText(style.string(Strings.Tools.permission(button.kind), color: Palette.text, lineBreakMode: .byTruncatingTail), maxLines: button.maxLines)
        }
        let measurables = labels.map(\.measurable)
        return ChatPiece(measurable: Measurable { PermissionFooterLayout(width: $0, labels: measurables).size }) { frame in
            typealias M = PermissionFooterLayout.Metrics
            let layout = PermissionFooterLayout(width: frame.width, labels: measurables)
            var items: [ChatDrawItem] = []
            var hits: [ChatHit] = []
            for (index, button) in buttons.enumerated() {
                let box = layout.buttons[index].offsetBy(dx: frame.minX, dy: frame.minY)
                let label = layout.labels[index].offsetBy(dx: frame.minX, dy: frame.minY)
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
            return (items, hits)
        }
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

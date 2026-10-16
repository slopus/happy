#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What every row's text is drawn in: the person's text size, read from
/// the list's traits on the main thread (nil: the designed size), and the
/// words of the language the screen was built in. Part of every row's
/// input, so a new size plans every row again, as a new width does.
struct ChatRowText: Equatable, Sendable {
    var environment: TextEnvironment?
    var words: ChatWords

    static let designed = ChatRowText(environment: nil, words: .english)
}

/// The settings and session facts that change how every row looks.
struct ChatRowStyle: Equatable, Sendable {
    var bubble: BubbleColor = .gray
    var compactTools = false
    /// Absent flavor is Claude: its SDK echoes slash commands as chips.
    var claudeFlavor = true
    var maxContentWidth: CGFloat = .greatestFiniteMagnitude
    /// metadata.path: tool paths under it are shown relative to it.
    var root: String?
    var flavor: String?
    /// `settings.showLineNumbersInToolViews`.
    var showLineNumbers = false
    /// `useIsTablet()`: permission buttons hug their labels at the
    /// trailing edge (`TabletBranches.permissionButtonsTrailing`).
    var tablet = false
    /// PermissionFooter's `optionsScroll` maxHeight, min(260, 35% of the
    /// window): a taller list of buttons scrolls.
    var permissionListMaxHeight = PermissionFooterLayout.Metrics.maxListHeight
    var text = ChatRowText.designed
    /// The account's diff documents and syntax colour.
    var render: RenderServices
}

/// Everything one row is drawn from. Equal inputs at the same width give
/// the same plan, which is what the measuring cache relies on.
struct ChatRowInput: Equatable, Sendable {
    var item: ChatListItem
    /// Outbox state, for a message this device hasn't delivered yet.
    var delivery: OutboxDelivery?
    /// For a work header, whether its group is open; for a tool, whether
    /// the reader opened its body.
    var expanded = false
    /// For a tool: the permission button whose reply is on its way.
    var permissionBusy: PermissionButton.Kind?
    /// For a question tool: its form and what has been picked.
    var question: ChatQuestionState?
    /// For a diff tool: the files the reader opened past "Show N more
    /// lines", by diff.
    var diffExpanded: [Int: Set<Int>] = [:]
    /// For a user's message: its status line and dimming, decided at the
    /// time the inputs were made (the pending grace runs on the clock).
    var userStatus: UserMessageStatus?
    /// For an agent's message: copied a moment ago, so its button shows a tick.
    var copied = false
    /// The heights the row's diagrams reported, by their place in the row.
    var mermaid: [Int: CGFloat] = [:]
    var style: ChatRowStyle

    var id: String { item.id }
}

/// Builds a row's plan from its input: measures the text with TextKit,
/// places it with the pure layouts in HappyLayout, and lists what to draw.
/// Runs on the measuring actor, never on the main thread.
enum ChatRowRenderer {
    /// Rows that render as nothing (MessageView returns null): the SDK's
    /// caveats and goal confirmations, and the echo of a slash command the
    /// SDK re-emits as a chip.
    static func isShown(_ item: ChatListItem, style: ChatRowStyle) -> Bool {
        if case .message(.toolCall(let call)) = item { return !ChatToolDisplay.isHidden(call.tool.name) }
        guard case .message(.userText(let message)) = item else { return true }
        if style.claudeFlavor && LocalCommandMessage.isSlashCommandEcho(message.text, hasLocalId: message.localId != nil) {
            return false
        }
        switch LocalCommandMessage(message.displayText ?? message.text) {
        case .caveat, .goalConfirmation: return false
        default: return true
        }
    }

    static func plan(_ input: ChatRowInput, width: CGFloat) -> ChatRowPlan {
        let diagrams = ChatMermaidHeights(row: input.id, heights: input.mermaid)
        switch input.item {
        case .workHeader(let group, let placement):
            return workHeader(input.id, group: group, placement: placement, expanded: input.expanded, width: width, style: input.style)
        case .message(let message):
            switch message {
            case .userText(let user):
                let status = input.userStatus ?? userStatus(user, delivery: input.delivery, now: Int64(Date().timeIntervalSince1970 * 1000))
                return userText(user, delivery: input.delivery, status: status, diagrams: diagrams, width: width, style: input.style)
            case .agentText(let agent): return agentText(agent, copied: input.copied, diagrams: diagrams, width: width, style: input.style)
            case .toolCall(let call):
                let views = ChatToolViews(question: input.question, diffExpanded: input.diffExpanded, diagrams: diagrams)
                return toolCall(call, expanded: input.expanded, busy: input.permissionBusy, views: views, width: width, style: input.style)
            case .agentEvent(let event): return agentEvent(event, width: width, style: input.style)
            case .unsupported(let unsupported): return unsupportedRow(unsupported, width: width, style: input.style)
            }
        }
    }

    /// ChatFooter, just past the newest message: padding only, or the
    /// "permissions shown in terminal only" box while the terminal has
    /// control.
    static func footer(controlledByUser: Bool, width: CGFloat, in environment: TextEnvironment?) -> ChatRowPlan {
        guard controlledByUser else {
            return ChatRowPlan(id: footerId, size: ChatFooterLayout(width: width, warning: nil).size, items: [])
        }
        let text = MeasuredText(ChatTextStyles.chatFooterWarning.string(Strings.Chat.controlledByTerminal, color: Palette.boxWarningText, in: environment))
        let layout = ChatFooterLayout(width: width, warning: text.measurable)
        var items: [ChatDrawItem] = []
        if let box = layout.warning, let icon = layout.icon, let label = layout.label {
            items.append(.box(ChatBox(frame: box, fill: Palette.boxWarningBackground, radius: ChatFooterLayout.Metrics.warningRadius)))
            items.append(.icon(.ionicons("information-circle"), size: ChatFooterLayout.Metrics.iconSize, frame: icon, tint: Palette.boxWarningText))
            items.append(.text(text.layout(for: label), label))
        }
        return ChatRowPlan(id: footerId, size: layout.size, items: items, accessibilityLabel: Strings.Chat.controlledByTerminal)
    }

    static let footerId = "chat-footer"

    // MARK: User messages

    /// The status of a user's message at `now` (ms): sent, waiting on the
    /// agent or the outbox, or refused.
    static func userStatus(_ message: UserTextMessage, delivery: OutboxDelivery?, now: Int64) -> UserMessageStatus {
        let failure = message.sendError ?? { if case .failed(let reason) = delivery { return reason } else { return nil } }()
        return UserMessageStatus(
            pending: message.pending, undelivered: delivery != nil, queuedWhileBusy: message.meta?.queuedWhileBusy == true,
            createdAt: message.createdAt, failure: failure, now: now
        )
    }

    static func userText(
        _ message: UserTextMessage, delivery: OutboxDelivery?, status messageStatus: UserMessageStatus, diagrams: ChatMermaidHeights,
        width: CGFloat, style: ChatRowStyle
    ) -> ChatRowPlan {
        let palette = bubblePalette(style.bubble)
        let text = style.text
        let environment = text.environment
        let author = message.author.flatMap { $0.owner == true ? nil : $0 }
        let authorText = author.map { MeasuredText(ChatTextStyles.userAuthor.string($0.name, color: Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: environment), maxLines: 1) }

        let parsed = LocalCommandMessage(message.displayText ?? message.text)
        var markdown: MarkdownPiece?
        var chipText: MeasuredText?
        var sentText: MeasuredText?
        let content: UserMessageLayout.Content
        let copyText: String
        switch parsed {
        case .goalRun(let goal):
            let piece = MarkdownPiece(goal, color: Palette.userMessageText, selectable: false, diagrams: diagrams, syntax: style.render.codeSyntax, in: environment)
            sentText = MeasuredText(ChatTextStyles.goalSent.string(text.words.sentAsGoal, color: Palette.textSecondary, in: environment))
            content = .goal(piece.blocks, sentLabel: sentText!.measurable)
            markdown = piece
            copyText = goal
        case .commandRun(let name, let arguments):
            chipText = MeasuredText(ChatTextStyles.commandChip.string("/\(name)", color: Palette.userMessageText, in: environment), maxLines: 1)
            let piece = arguments.map { MarkdownPiece($0, color: Palette.userMessageText, selectable: false, diagrams: diagrams, syntax: style.render.codeSyntax, in: environment) }
            content = .command(chip: chipText!.measurable, arguments: piece?.blocks)
            markdown = piece
            copyText = arguments.map { "/\(name) \($0)" } ?? "/\(name)"
        case .text(let markdownText):
            let piece = MarkdownPiece(markdownText, color: Palette.userMessageText, selectable: false, diagrams: diagrams, syntax: style.render.codeSyntax, in: environment)
            content = .text(piece.blocks)
            markdown = piece
            copyText = markdownText
        case .caveat, .goalConfirmation:
            return ChatRowPlan(id: message.id, size: CGSize(width: width, height: 0), items: [])
        }

        let layout = UserMessageLayout(.init(width: width, maxContentWidth: style.maxContentWidth, author: authorText?.measurable, content: content))
        var items: [ChatDrawItem] = []
        var hits: [ChatHit] = []
        if let frame = layout.author, let authorText { items.append(.text(authorText.layout(for: frame), frame)) }
        if let bubble = layout.bubble {
            items.append(.box(ChatBox(frame: bubble, fill: palette.background, border: palette.border, borderWidth: 1, radius: UserMessageLayout.Metrics.bubbleRadius)))
        }
        // LongPressCopyable wraps the bubble and whatever sits under it (a
        // command's chip, a goal's "Sent as goal").
        let copyTarget = [layout.bubble, layout.chip, layout.goalIcon, layout.goalLabel].compactMap { $0 }.reduce(CGRect.null) { $0.union($1) }
        if !copyTarget.isNull {
            hits.append(ChatHit(frame: copyTarget, action: .copyMenu(copyText), hold: true))
        }
        if let placed = layout.markdown, let markdown {
            let drawn = markdown.draw(placed, origin: layout.markdownOrigin)
            items += drawn.items
            hits = drawn.hits + hits
        }
        if let chip = layout.chip, let label = layout.chipLabel, let chipText {
            items.append(.box(ChatBox(frame: chip, fill: palette.background, border: palette.border, borderWidth: UserMessageLayout.Metrics.chipBorder, radius: UserMessageLayout.Metrics.chipRadius)))
            items.append(.text(chipText.layout(for: label), label))
        }
        if let icon = layout.goalIcon, let label = layout.goalLabel, let sentText {
            items.append(.icon(.ionicons("locate-outline"), size: UserMessageLayout.Metrics.goalIconSize, frame: icon, tint: Palette.textSecondary))
            items.append(.text(sentText.layout(for: label), label))
        }

        // The status line is always there at one line's height, so a row
        // never changes height when a message settles. Its height is RN's
        // fixed 14 at every text size (`pendingStatusText`), so a larger
        // size's text is cut at it.
        let status: String
        var failed = false
        switch messageStatus.line {
        case .none: status = ""
        case .sending: status = text.words.sending
        case .sendsAfterThisTurn: status = text.words.sendsAfterThisTurn
        case .failed(let reason):
            status = text.words.sendFailed(reason)
            failed = true
        }
        if !status.isEmpty {
            let color = failed ? Palette.statusError : Palette.textSecondary
            let line = ChatTextLayout(
                ChatTextStyles.pendingStatus.string(status, color: color, alignment: layout.alignsLeft ? .left : .right, lineBreakMode: .byTruncatingTail, in: environment),
                width: layout.status.width, maxLines: 1
            )
            items.append(.text(line, layout.status))
            if case .failed = delivery, let localId = message.localId {
                hits.insert(ChatHit(frame: layout.status, action: .retry(localId: localId)), at: 0)
            }
        }
        // A message the agent hasn't read yet is dimmed once its status
        // shows; a refused one is not.
        return ChatRowPlan(
            id: message.id, size: layout.size, items: items, hits: hits,
            alpha: messageStatus.dimmed ? UserMessageLayout.Metrics.pendingOpacity : 1,
            accessibilityLabel: [author?.name, copyText, status.isEmpty ? nil : status].compactMap { $0 }.joined(separator: ", ")
        )
    }

    static func bubblePalette(_ color: BubbleColor) -> BubblePalette {
        let index = BubbleColor.allCases.firstIndex(of: color) ?? 0
        return BubblePalette.all.indices.contains(index) ? BubblePalette.all[index] : .gray
    }

    // MARK: Agent rows

    /// MessageView's agent text: the markdown, then the copy button, which
    /// shows a tick for a moment after copying.
    static func agentText(_ message: AgentTextMessage, copied: Bool, diagrams: ChatMermaidHeights, width: CGFloat, style: ChatRowStyle) -> ChatRowPlan {
        let markdown = MarkdownPiece(message.text, color: Palette.text, diagrams: diagrams, syntax: style.render.codeSyntax, in: style.text.environment)
        let layout = AgentTextLayout(width: width, maxContentWidth: style.maxContentWidth, blocks: markdown.blocks)
        let drawn = markdown.draw(layout.markdown, origin: layout.markdownOrigin)
        let slop = AgentTextLayout.Metrics.copyHitSlop
        let copyTarget = CGRect(
            x: layout.copyButton.minX - slop.left, y: layout.copyButton.minY - slop.top,
            width: layout.copyButton.width + slop.left + slop.right, height: layout.copyButton.height + slop.top + slop.bottom
        )
        return ChatRowPlan(
            id: message.id, size: layout.size,
            items: drawn.items + [.icon(.ionicons(copied ? "checkmark" : "copy-outline"), size: AgentTextLayout.Metrics.copyIconSize, frame: layout.copyIcon, tint: Palette.text)],
            hits: [ChatHit(frame: copyTarget, action: .copyMessage(id: message.id, text: message.text))] + drawn.hits,
            accessibilityLabel: message.text
        )
    }

    static func agentEvent(_ message: AgentEventMessage, width: CGFloat, style: ChatRowStyle) -> ChatRowPlan {
        let words = style.text.words
        let label: String
        switch message.event {
        case .modeSwitch(let mode): label = words.switchedToMode(mode)
        case .message(let text): label = text
        case .limitReached(let endsAt):
            let formatter = DateFormatter()
            formatter.timeStyle = .short
            formatter.dateStyle = .none
            label = words.usageLimitUntil(formatter.string(from: Date(timeIntervalSince1970: TimeInterval(endsAt))))
        default: label = words.unknownEvent
        }
        return centredLine(message.id, label, style: ChatTextStyles.agentEvent, color: Palette.agentEventText, width: width, rowStyle: style)
    }

    static func unsupportedRow(_ message: UnsupportedMessage, width: CGFloat, style: ChatRowStyle) -> ChatRowPlan {
        centredLine(message.id, Strings.Chat.unsupported(message.kind), style: ChatTextStyles.unsupported, color: Palette.textSecondary, width: width, rowStyle: style)
    }

    static func centredLine(_ id: String, _ label: String, style textStyle: ChatTextStyle, color: ColorToken, width: CGFloat, rowStyle: ChatRowStyle) -> ChatRowPlan {
        let text = MeasuredText(textStyle.string(label, color: color, alignment: .center, in: rowStyle.text.environment))
        let layout = ChatEventLayout(width: width, maxContentWidth: rowStyle.maxContentWidth, label: text.measurable)
        return ChatRowPlan(id: id, size: layout.size, items: [.text(text.layout(for: layout.label), layout.label)], accessibilityLabel: label)
    }

    static func workHeader(_ id: String, group: ChatWorkGroup, placement: ChatListItem.Placement, expanded: Bool, width: CGFloat, style: ChatRowStyle) -> ChatRowPlan {
        let trailing = placement == .trailing
        let duration = (group.completedAt ?? group.startedAt) - group.startedAt
        let words = style.text.words
        let label = trailing ? words.hide : words.workedFor(ChatDisplay.formatWorkDuration(milliseconds: duration))
        let text = MeasuredText(ChatTextStyles.workGroup.string(label, color: Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: style.text.environment), maxLines: 1)
        let layout = WorkGroupHeaderLayout(width: width, maxContentWidth: style.maxContentWidth, label: text.measurable)
        let chevron: Icon = trailing || expanded ? .ionicons("chevron-up") : .ionicons("chevron-forward")
        return ChatRowPlan(
            id: id, size: layout.size,
            items: [
                .text(text.layout(for: layout.label), layout.label),
                .icon(chevron, size: WorkGroupHeaderLayout.Metrics.chevronSize, frame: layout.chevron, tint: Palette.textSecondary),
            ],
            hits: [ChatHit(frame: layout.header, action: .toggleGroup(group.id))],
            accessibilityLabel: label
        )
    }
}

// MARK: Markdown

/// A markdown text measured block by block: the blocks for a pure layout,
/// and once that layout has placed them, what to draw where.
struct MarkdownPiece {
    let blocks: [MarkdownLayout.Block]
    private let drawers: [(MarkdownLayout.Placed, CGPoint) -> ([ChatDrawItem], [ChatHit])]

    static let bullets = ["•", "◦", "▪"]

    /// `selectable`: each paragraph, list item, code block and table cell
    /// answers a long press (MarkdownView's `selectable` Text). Off where
    /// the message copies as a whole instead (`externalCopyHandler`).
    /// `diagrams`: the row the markdown is in, and the heights its
    /// diagrams' pages reported. `syntax` colours its code blocks. The text
    /// is at `environment`'s size; the block margins, the code's padding,
    /// the tables' estimated columns, the images' and the diagrams' boxes
    /// keep theirs, as RN's do.
    init(_ markdown: String, color: ColorToken, selectable: Bool = true, diagrams: ChatMermaidHeights, syntax: CodeSyntaxService, in environment: TextEnvironment?) {
        var blocks: [MarkdownLayout.Block] = []
        var drawers: [(MarkdownLayout.Placed, CGPoint) -> ([ChatDrawItem], [ChatHit])] = []

        func hold(_ frame: CGRect, _ paragraph: String) -> [ChatHit] {
            selectable ? [ChatHit(frame: frame, action: .markdownSelectable(paragraph: paragraph, markdown: markdown), hold: true)] : []
        }

        func text(_ measured: MeasuredText) -> (MarkdownLayout.Placed, CGPoint) -> ([ChatDrawItem], [ChatHit]) {
            { placed, origin in
                let frame = placed.frame.offsetBy(dx: origin.x, dy: origin.y)
                return ([.text(measured.layout(for: placed.frame), frame)], hold(frame, measured.string.string))
            }
        }

        var diagramIndex = 0
        for block in Markdown.parse(markdown) {
            switch block {
            case .text(let spans):
                let measured = MeasuredText(ChatSpans.string(spans, style: ChatTextStyles.markdownText, color: color, in: environment))
                blocks.append(.text(measured.measurable))
                drawers.append(text(measured))

            case .header(let level, let spans):
                let measured = MeasuredText(ChatSpans.string(spans, style: ChatTextStyles.markdownHeader(level), color: color, in: environment))
                blocks.append(.header(level: level, measured.measurable))
                drawers.append(text(measured))

            case .horizontalRule:
                blocks.append(.rule)
                drawers.append { placed, origin in
                    ([.box(ChatBox(frame: placed.frame.offsetBy(dx: origin.x, dy: origin.y), fill: Palette.divider))], [])
                }

            case .list(let items):
                let rows = items.map { item in
                    (MeasuredText(ChatTextStyles.markdownText.string(Self.bullets[min(item.depth, Self.bullets.count - 1)], color: color, in: environment)),
                     MeasuredText(ChatSpans.string(item.spans, style: ChatTextStyles.markdownText, color: color, in: environment)), item.depth)
                }
                blocks.append(.list(rows.map { .init(depth: $0.2, marker: $0.0.measurable, text: $0.1.measurable) }))
                drawers.append(Self.listDrawer(rows.map { ($0.0, $0.1) }, hold: hold))

            case .numberedList(let items):
                let rows = items.map { item in
                    (MeasuredText(ChatTextStyles.markdownText.string("\(item.number).", color: color, in: environment)),
                     MeasuredText(ChatSpans.string(item.spans, style: ChatTextStyles.markdownText, color: color, in: environment)), item.depth)
                }
                blocks.append(.list(rows.map { .init(depth: $0.2, marker: $0.0.measurable, text: $0.1.measurable) }))
                drawers.append(Self.listDrawer(rows.map { ($0.0, $0.1) }, hold: hold))

            case .codeBlock(let language, let content):
                Self.code(language: language, content: content, syntax: syntax, environment: environment, blocks: &blocks, drawers: &drawers, hold: hold)

            case .mermaid(let content):
                // MermaidRenderer: the diagram drawn by mermaid in a web page,
                // as tall as the page last said, from 200 up to 600.
                let diagram = ChatMermaid(row: diagrams.row, index: diagramIndex, content: content)
                blocks.append(.mermaid(reported: diagrams.heights[diagramIndex]))
                diagramIndex += 1
                drawers.append { placed, origin in
                    ([.mermaid(diagram, frame: placed.frame.offsetBy(dx: origin.x, dy: origin.y))], [])
                }

            case .options(let options):
                let labels = options.map { MeasuredText(ChatTextStyles.option.string($0, color: color, in: environment)) }
                blocks.append(.options(labels.map(\.measurable)))
                drawers.append { placed, origin in
                    guard case .options(_, let buttons, let frames) = placed else { return ([], []) }
                    var items: [ChatDrawItem] = []
                    var hits: [ChatHit] = []
                    for (index, button) in buttons.enumerated() where index < labels.count {
                        let frame = button.offsetBy(dx: origin.x, dy: origin.y)
                        items.append(.box(ChatBox(frame: frame, fill: Palette.surfaceHighest, radius: MarkdownLayout.Metrics.optionRadius)))
                        items.append(.text(labels[index].layout(for: frames[index]), frames[index].offsetBy(dx: origin.x, dy: origin.y)))
                        hits.append(ChatHit(frame: frame, action: .option(options[index])))
                    }
                    return (items, hits)
                }

            case .table(let headers, let rows):
                let all = [headers] + rows
                let measured = all.enumerated().map { rowIndex, row in
                    row.map { MeasuredText(ChatSpans.string($0, style: rowIndex == 0 ? ChatTextStyles.tableHeader : ChatTextStyles.tableCell, color: color, in: environment)) }
                }
                let lengths = all.map { row in row.map { $0.reduce(0) { $0 + $1.text.utf16.count } } }
                blocks.append(.table(.init(columnWidths: MarkdownLayout.columnWidths(lengths: lengths), rows: measured.map { $0.map(\.measurable) })))
                drawers.append { placed, origin in
                    guard case .table(let table) = placed else { return ([], []) }
                    let frame = table.frame.offsetBy(dx: origin.x, dy: origin.y)
                    // The border stays put; the grid inside scrolls sideways,
                    // clipped to the border's rounded inside (overflow: hidden).
                    var grid: [ChatDrawItem] = []
                    if let header = table.rows.first {
                        grid.append(.box(ChatBox(frame: header, fill: Palette.surfaceHigh)))
                    }
                    for separator in table.separators {
                        grid.append(.box(ChatBox(frame: separator, fill: Palette.divider)))
                    }
                    var hits: [ChatHit] = []
                    for (rowIndex, cells) in table.cells.enumerated() where rowIndex < measured.count {
                        for (column, cell) in cells.enumerated() where column < measured[rowIndex].count {
                            grid.append(.text(measured[rowIndex][column].layout(for: cell), cell))
                            hits += hold(cell, measured[rowIndex][column].string.string)
                        }
                    }
                    let content = ChatRowPlan(id: "table", size: table.contentSize, items: grid, hits: hits)
                    return ([
                        .box(ChatBox(frame: frame, border: Palette.divider, borderWidth: MarkdownLayout.Metrics.tableBorder, radius: MarkdownLayout.Metrics.tableRadius)),
                        .scroller(
                            content, frame: table.scroll.offsetBy(dx: frame.minX, dy: frame.minY),
                            radius: MarkdownLayout.Metrics.tableRadius - MarkdownLayout.Metrics.tableBorder
                        ),
                    ], [])
                }

            case .image(let alt, let url):
                let caption = alt.isEmpty ? nil : MeasuredText(ChatTextStyles.imageCaption.string(alt, color: Palette.textSecondary, in: environment))
                let source = URL(string: url)
                blocks.append(.image(caption: caption?.measurable))
                drawers.append { placed, origin in
                    guard case .image(let frame, let picture, let captionFrame) = placed else { return ([], []) }
                    let shifted = frame.offsetBy(dx: origin.x, dy: origin.y)
                    let pictureFrame = picture.offsetBy(dx: shifted.minX, dy: shifted.minY)
                    var items: [ChatDrawItem] = [.box(ChatBox(frame: pictureFrame, fill: Palette.surfaceHighest, radius: MarkdownLayout.Metrics.imageRadius))]
                    // `accessibilityLabel={alt || 'Markdown image'}`.
                    if let source { items.append(.webImage(source, frame: pictureFrame, label: alt.isEmpty ? "Markdown image" : alt)) }
                    if let caption, let captionFrame {
                        items.append(.text(caption.layout(for: captionFrame), captionFrame.offsetBy(dx: shifted.minX, dy: shifted.minY)))
                    }
                    return (items, [])
                }
            }
        }
        self.blocks = blocks
        self.drawers = drawers
    }

    func draw(_ layout: MarkdownLayout, origin: CGPoint) -> (items: [ChatDrawItem], hits: [ChatHit]) {
        var items: [ChatDrawItem] = []
        var hits: [ChatHit] = []
        for (placed, drawer) in zip(layout.blocks, drawers) {
            let drawn = drawer(placed, origin)
            items += drawn.0
            hits += drawn.1
        }
        return (items, hits)
    }

    /// A list: the marker isn't selectable, the item's text is.
    private static func listDrawer(
        _ rows: [(marker: MeasuredText, text: MeasuredText)], hold: @escaping (CGRect, String) -> [ChatHit]
    ) -> (MarkdownLayout.Placed, CGPoint) -> ([ChatDrawItem], [ChatHit]) {
        { placed, origin in
            guard case .list(_, let items) = placed else { return ([], []) }
            var drawn: [ChatDrawItem] = []
            var hits: [ChatHit] = []
            for (index, item) in items.enumerated() where index < rows.count {
                let text = item.text.offsetBy(dx: origin.x, dy: origin.y)
                drawn.append(.text(rows[index].marker.layout(for: item.marker), item.marker.offsetBy(dx: origin.x, dy: origin.y)))
                drawn.append(.text(rows[index].text.layout(for: item.text), text))
                hits += hold(text, rows[index].text.string.string)
            }
            return (drawn, hits)
        }
    }

    /// A code block, unwrapped like happy-app's: the language on top, the
    /// code scrolling sideways under it.
    private static func code(
        language: String?, content: String, syntax: CodeSyntaxService, environment: TextEnvironment?, blocks: inout [MarkdownLayout.Block],
        drawers: inout [(MarkdownLayout.Placed, CGPoint) -> ([ChatDrawItem], [ChatHit])], hold: @escaping (CGRect, String) -> [ChatHit]
    ) {
        let label = language.map { MeasuredText(ChatTextStyles.codeLanguage.string($0, color: Palette.textSecondary, in: environment), maxLines: 1) }
        let code = ChatTextLayout(unwrapped: ChatSyntax.string(content, language: language, service: syntax, in: environment))
        blocks.append(.code(language: label?.measurable, code: code.size))
        drawers.append { placed, origin in
            guard case .code(let placedCode) = placed else { return ([], []) }
            let frame = placedCode.frame.offsetBy(dx: origin.x, dy: origin.y)
            var items: [ChatDrawItem] = [.box(ChatBox(frame: frame, fill: Palette.surfaceHighest, radius: MarkdownLayout.Metrics.codeRadius))]
            if let label, let languageFrame = placedCode.language {
                items.append(.text(label.layout(for: languageFrame), languageFrame.offsetBy(dx: frame.minX, dy: frame.minY)))
            }
            let strip = ChatRowPlan(id: "code", size: placedCode.contentSize, items: [.text(code, placedCode.text)])
            items.append(.scroller(strip, frame: placedCode.scroll.offsetBy(dx: frame.minX, dy: frame.minY)))
            return (items, hold(frame, content))
        }
    }
}

/// SimpleSyntaxHighlighter over the shared tokenizer, in the file viewer's
/// colours (`FileSyntax`, its `getColors`), so the two cannot drift apart.
enum ChatSyntax {
    /// The block coloured from the account's `service`, or plain when it
    /// has no language, is past the limits, or isn't coloured yet (the row
    /// is drawn again once it is). Every weight of the mono face has the
    /// same advance, so plain and coloured take the same size. In an
    /// `environment`, at its text size.
    static func string(_ code: String, language: String?, service: CodeSyntaxService, in environment: TextEnvironment?) -> NSAttributedString {
        let style = ChatTextStyles.codeBlock
        let result = NSMutableAttributedString()
        let regular = style.font(in: environment)
        let bold = style.with(.plex(.monoSemiBold)).font(in: environment)
        let tokens: [SyntaxToken]
        if case .highlighted(let coloured) = service.tokens(code, language: language) {
            tokens = coloured
        } else {
            tokens = [SyntaxToken(code, .plain)]
        }
        for token in tokens {
            let attributes = style.attributes(color: UIColor(FileSyntax.color(token)), font: token.isBold ? bold : regular, in: environment)
            result.append(NSAttributedString(string: token.text, attributes: attributes))
        }
        return result
    }
}
#endif

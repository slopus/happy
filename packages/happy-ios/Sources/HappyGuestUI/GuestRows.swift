#if canImport(UIKit)
import HappyChatKit
import HappyGuest
import HappyIcons
import HappyLayout
import HappyMarkdown
import UIKit

/// One transcript row, measured and placed off the main thread: boxes,
/// texts and icons at fixed frames. A `GuestRowView` only draws it.
///
/// The rows are the session screen's, drawn from the same pure layouts
/// (`UserMessageLayout`, `AgentTextLayout`, `MarkdownLayout`), text styles
/// (`ChatTextStyles`) and palette, so a guest's chat reads as the app's.
/// Immutable once built, so it crosses to the main thread as is.
final class GuestRowPlan: @unchecked Sendable {
    let id: String
    let size: CGSize
    let items: [GuestDrawItem]
    let hits: [GuestHit]
    let alpha: CGFloat
    let accessibilityLabel: String?

    init(id: String, size: CGSize, items: [GuestDrawItem], hits: [GuestHit] = [], alpha: CGFloat = 1, accessibilityLabel: String? = nil) {
        self.id = id
        self.size = size
        self.items = items
        self.hits = hits
        self.alpha = alpha
        self.accessibilityLabel = accessibilityLabel
    }
}

struct GuestBox {
    var frame: CGRect
    var fill: ColorToken?
    var border: ColorToken?
    var borderWidth: CGFloat = 0
    var radius: CGFloat = 0
}

enum GuestDrawItem {
    case box(GuestBox)
    case text(ChatTextLayout, CGRect)
    case icon(Icon, size: CGFloat, frame: CGRect, tint: ColorToken)
    /// A strip that scrolls sideways (a code block, a table): `content` in
    /// its own coordinates, through `frame`.
    case scroller(GuestRowPlan, frame: CGRect, radius: CGFloat)
}

enum GuestRowAction: Equatable, Sendable {
    case copy(id: String, text: String)
    /// A markdown option button: sent as the guest's message.
    case option(String)
}

struct GuestHit {
    var frame: CGRect
    var action: GuestRowAction
}

/// What a row is drawn from. Equal inputs at one width give one plan.
struct GuestRowInput: Equatable, Sendable {
    var message: GuestMessage
    var botName: String
    var copied = false
}

enum GuestRowRenderer {
    static func plan(_ input: GuestRowInput, width: CGFloat, in environment: TextEnvironment?) -> GuestRowPlan {
        switch input.message.role {
        case .user: user(input.message, width: width, in: environment)
        case .assistant: agent(input, width: width, in: environment)
        }
    }

    /// MessageView's user bubble in the default gray. Another member's
    /// message carries their name above it, as a shared session's do.
    static func user(_ message: GuestMessage, width: CGFloat, in environment: TextEnvironment?) -> GuestRowPlan {
        let palette = BubblePalette.gray
        let name = message.isMine == false ? GuestTranscript.sender(message, botName: "") : nil
        let author = name.map {
            MeasuredText(ChatTextStyles.userAuthor.string($0, color: Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: environment), maxLines: 1)
        }
        let markdown = GuestMarkdown(message.text, color: Palette.userMessageText, in: environment)
        let layout = UserMessageLayout(.init(width: width, author: author?.measurable, content: .text(markdown.blocks)))
        var items: [GuestDrawItem] = []
        if let frame = layout.author, let author { items.append(.text(author.layout(for: frame), frame)) }
        if let bubble = layout.bubble {
            items.append(.box(GuestBox(frame: bubble, fill: palette.background, border: palette.border, borderWidth: 1, radius: UserMessageLayout.Metrics.bubbleRadius)))
        }
        var hits: [GuestHit] = []
        if let placed = layout.markdown {
            let drawn = markdown.draw(placed, origin: layout.markdownOrigin)
            items += drawn.items
            hits += drawn.hits
        }
        let label = [GuestTranscript.sender(message, botName: ""), message.text].joined(separator: ", ")
        return GuestRowPlan(id: message.id, size: layout.size, items: items, hits: hits, accessibilityLabel: label)
    }

    /// MessageView's agent text: the markdown, then the copy button.
    static func agent(_ input: GuestRowInput, width: CGFloat, in environment: TextEnvironment?) -> GuestRowPlan {
        let message = input.message
        let markdown = GuestMarkdown(message.text, color: Palette.text, in: environment)
        let layout = AgentTextLayout(width: width, blocks: markdown.blocks)
        let drawn = markdown.draw(layout.markdown, origin: layout.markdownOrigin)
        let slop = AgentTextLayout.Metrics.copyHitSlop
        let copyTarget = CGRect(
            x: layout.copyButton.minX - slop.left, y: layout.copyButton.minY - slop.top,
            width: layout.copyButton.width + slop.left + slop.right, height: layout.copyButton.height + slop.top + slop.bottom
        )
        let icon: Icon = .ionicons(input.copied ? "checkmark" : "copy-outline")
        return GuestRowPlan(
            id: message.id, size: layout.size,
            items: drawn.items + [.icon(icon, size: AgentTextLayout.Metrics.copyIconSize, frame: layout.copyIcon, tint: Palette.text)],
            hits: [GuestHit(frame: copyTarget, action: .copy(id: message.id, text: message.text))] + drawn.hits,
            accessibilityLabel: input.botName + ", " + message.text
        )
    }
}

/// A markdown text measured block by block, as the session screen measures
/// it (`MarkdownPiece`): the blocks for `MarkdownLayout`, then what to draw
/// where it placed them. Code is drawn plain in the code face; a diagram
/// shows its source as code, and an image its caption, so a guest screen
/// never fetches anything a message names.
struct GuestMarkdown {
    let blocks: [MarkdownLayout.Block]
    private let drawers: [(MarkdownLayout.Placed, CGPoint) -> ([GuestDrawItem], [GuestHit])]

    static let bullets = ["•", "◦", "▪"]

    init(_ markdown: String, color: ColorToken, in environment: TextEnvironment?) {
        var blocks: [MarkdownLayout.Block] = []
        var drawers: [(MarkdownLayout.Placed, CGPoint) -> ([GuestDrawItem], [GuestHit])] = []

        func text(_ measured: MeasuredText) -> (MarkdownLayout.Placed, CGPoint) -> ([GuestDrawItem], [GuestHit]) {
            { placed, origin in ([.text(measured.layout(for: placed.frame), placed.frame.offsetBy(dx: origin.x, dy: origin.y))], []) }
        }

        func list(_ rows: [(MeasuredText, MeasuredText, Int)]) {
            blocks.append(.list(rows.map { .init(depth: $0.2, marker: $0.0.measurable, text: $0.1.measurable) }))
            drawers.append { placed, origin in
                guard case .list(_, let items) = placed else { return ([], []) }
                var drawn: [GuestDrawItem] = []
                for (index, item) in items.enumerated() where index < rows.count {
                    drawn.append(.text(rows[index].0.layout(for: item.marker), item.marker.offsetBy(dx: origin.x, dy: origin.y)))
                    drawn.append(.text(rows[index].1.layout(for: item.text), item.text.offsetBy(dx: origin.x, dy: origin.y)))
                }
                return (drawn, [])
            }
        }

        func code(language: String?, content: String) {
            let label = language.map { MeasuredText(ChatTextStyles.codeLanguage.string($0, color: Palette.textSecondary, in: environment), maxLines: 1) }
            let code = ChatTextLayout(unwrapped: ChatTextStyles.codeBlock.string(content, color: Palette.text, in: environment))
            blocks.append(.code(language: label?.measurable, code: code.size))
            drawers.append { placed, origin in
                guard case .code(let placedCode) = placed else { return ([], []) }
                let frame = placedCode.frame.offsetBy(dx: origin.x, dy: origin.y)
                var items: [GuestDrawItem] = [.box(GuestBox(frame: frame, fill: Palette.surfaceHighest, radius: MarkdownLayout.Metrics.codeRadius))]
                if let label, let languageFrame = placedCode.language {
                    items.append(.text(label.layout(for: languageFrame), languageFrame.offsetBy(dx: frame.minX, dy: frame.minY)))
                }
                let strip = GuestRowPlan(id: "code", size: placedCode.contentSize, items: [.text(code, placedCode.text)])
                items.append(.scroller(strip, frame: placedCode.scroll.offsetBy(dx: frame.minX, dy: frame.minY), radius: 0))
                return (items, [])
            }
        }

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
                drawers.append { placed, origin in ([.box(GuestBox(frame: placed.frame.offsetBy(dx: origin.x, dy: origin.y), fill: Palette.divider))], []) }

            case .list(let items):
                list(items.map {
                    (MeasuredText(ChatTextStyles.markdownText.string(Self.bullets[min($0.depth, Self.bullets.count - 1)], color: color, in: environment)),
                     MeasuredText(ChatSpans.string($0.spans, style: ChatTextStyles.markdownText, color: color, in: environment)), $0.depth)
                })

            case .numberedList(let items):
                list(items.map {
                    (MeasuredText(ChatTextStyles.markdownText.string("\($0.number).", color: color, in: environment)),
                     MeasuredText(ChatSpans.string($0.spans, style: ChatTextStyles.markdownText, color: color, in: environment)), $0.depth)
                })

            case .codeBlock(let language, let content):
                code(language: language, content: content)

            case .mermaid(let content):
                code(language: "mermaid", content: content)

            case .options(let options):
                let labels = options.map { MeasuredText(ChatTextStyles.option.string($0, color: color, in: environment)) }
                blocks.append(.options(labels.map(\.measurable)))
                drawers.append { placed, origin in
                    guard case .options(_, let buttons, let frames) = placed else { return ([], []) }
                    var items: [GuestDrawItem] = []
                    var hits: [GuestHit] = []
                    for (index, button) in buttons.enumerated() where index < labels.count {
                        let frame = button.offsetBy(dx: origin.x, dy: origin.y)
                        items.append(.box(GuestBox(frame: frame, fill: Palette.surfaceHighest, radius: MarkdownLayout.Metrics.optionRadius)))
                        items.append(.text(labels[index].layout(for: frames[index]), frames[index].offsetBy(dx: origin.x, dy: origin.y)))
                        hits.append(GuestHit(frame: frame, action: .option(options[index])))
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
                    var grid: [GuestDrawItem] = []
                    if let header = table.rows.first { grid.append(.box(GuestBox(frame: header, fill: Palette.surfaceHigh))) }
                    for separator in table.separators { grid.append(.box(GuestBox(frame: separator, fill: Palette.divider))) }
                    for (rowIndex, cells) in table.cells.enumerated() where rowIndex < measured.count {
                        for (column, cell) in cells.enumerated() where column < measured[rowIndex].count {
                            grid.append(.text(measured[rowIndex][column].layout(for: cell), cell))
                        }
                    }
                    let content = GuestRowPlan(id: "table", size: table.contentSize, items: grid)
                    return ([
                        .box(GuestBox(frame: frame, border: Palette.divider, borderWidth: MarkdownLayout.Metrics.tableBorder, radius: MarkdownLayout.Metrics.tableRadius)),
                        .scroller(content, frame: table.scroll.offsetBy(dx: frame.minX, dy: frame.minY),
                                  radius: MarkdownLayout.Metrics.tableRadius - MarkdownLayout.Metrics.tableBorder),
                    ], [])
                }

            case .image(let alt, _):
                let caption = MeasuredText(ChatTextStyles.imageCaption.string(alt.isEmpty ? "Image" : alt, color: Palette.textSecondary, in: environment))
                blocks.append(.text(caption.measurable))
                drawers.append(text(caption))
            }
        }
        self.blocks = blocks
        self.drawers = drawers
    }

    func draw(_ layout: MarkdownLayout, origin: CGPoint) -> (items: [GuestDrawItem], hits: [GuestHit]) {
        var items: [GuestDrawItem] = []
        var hits: [GuestHit] = []
        for (placed, drawer) in zip(layout.blocks, drawers) {
            let drawn = drawer(placed, origin)
            items += drawn.0
            hits += drawn.1
        }
        return (items, hits)
    }
}
#endif

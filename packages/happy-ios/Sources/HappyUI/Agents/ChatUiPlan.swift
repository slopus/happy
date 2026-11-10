#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// A press on a chat UI component, or on a quick reply.
struct ChatUiTap: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// A live component's control.
        case card(UiShown, UiCard.Tap)
        /// A quick reply, by its option's index.
        case reply(QuickReplies, Int)
    }

    var kind: Kind
}

/// A chat UI component's or quick replies' part of an agent's row
/// (`ChatUiLayout`): drafted with its texts measured, then drawn where the
/// row placed it. Controls the person can't use are drawn faded and
/// answer nothing.
enum ChatUiPlan {
    static let label = ChatTextStyle(.figtree(.medium), size: 15, lineHeight: 20)
    static let detail = ChatTextStyle(.figtree(.regular), size: 13, lineHeight: 18)
    static let line = ChatTextStyles.text
    static let path = ChatTextStyles.terminal

    enum Shown {
        case component(UiShown)
        case replies(QuickReplies)
    }

    struct Draft {
        var shown: Shown
        var input: ChatUiLayout.Input
        /// A card's buttons' labels or the pills', its rows' labels, its
        /// title or the line, and its lines, in the order the layout places them.
        var buttons: [MeasuredText] = []
        var rows: [MeasuredText] = []
        var text: MeasuredText?
        var lines: [MeasuredText] = []
        /// Each pill's note, when it has one.
        var notes: [MeasuredText?] = []
        /// A live component's card.
        var card: UiCard?
        var spoken: String
    }

    static func draft(_ shown: UiShown, granted: Set<String>?, environment: TextEnvironment?) -> Draft {
        func measured(_ text: String, _ style: ChatTextStyle, _ color: ColorToken, alignment: NSTextAlignment = .natural, lines: Int = 0) -> MeasuredText {
            MeasuredText(style.string(text, color: color, alignment: alignment, in: environment), maxLines: lines)
        }
        switch shown.kind {
        case .fileTree(let entries):
            let rows = entries.map { measured($0.name, path, Palette.text, lines: 1) }
            let input = ChatUiLayout.Input.tree(zip(entries, rows).map { entry, row -> (depth: Int, name: Measurable) in (entry.depth, row.measurable) })
            return Draft(shown: .component(shown), input: input, rows: rows, spoken: entries.map(\.name).joined(separator: ", "))
        case .line(let words):
            let text = measured(words, line, Palette.textSecondary)
            return Draft(shown: .component(shown), input: .line(text.measurable), text: text, spoken: words)
        case .live:
            let card = UiCard.make(shown, granted: granted)
            if let row = card.row {
                // One line each, so the row is one height whatever it says.
                let name = measured(card.title, label, Palette.text, lines: 1)
                let words = card.lines.first ?? UiCard.Line("")
                let line = MeasuredText(detail.string(words.text, color: words.style == .error ? Palette.textDestructive : Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: environment), maxLines: 1)
                let buttons = card.buttons.map { one in
                    MeasuredText(label.string(one.label, color: !one.enabled ? Palette.textSecondary : (one.primary ? Palette.roundButtonText : Palette.text), lineBreakMode: .byTruncatingTail, in: environment), maxLines: 1)
                }
                let controls = zip(card.buttons, buttons).map { one, text in ChatUiLayout.RowControl(one.glyph == nil ? text.measurable : nil, rank: one.rank) }
                let input = ChatUiLayout.Input.row(name: name.measurable, line: line.measurable, lineMark: row.tone != .quiet, controls: controls)
                return Draft(shown: .component(shown), input: input, buttons: buttons, text: name, lines: [line], card: card, spoken: [card.title, words.text].joined(separator: ", "))
            }
            let title = measured(card.title, label, Palette.text)
            let lines = card.lines.map { one -> MeasuredText in
                switch one.style {
                case .plain: measured(one.text, line, Palette.text)
                case .muted: measured(one.text, detail, Palette.textSecondary)
                case .code: measured(one.text, path, Palette.text)
                case .error: measured(one.text, detail, Palette.textDestructive)
                }
            }
            let buttons = card.buttons.map { one in
                measured(one.label, label, !one.enabled ? Palette.textSecondary : (one.primary ? Palette.roundButtonText : Palette.text), alignment: .center, lines: 2)
            }
            let input = ChatUiLayout.Input.card(title: title.measurable, lines: lines.map(\.measurable), buttons: buttons.map(\.measurable))
            return Draft(shown: .component(shown), input: input, buttons: buttons, text: title, lines: lines, card: card,
                         spoken: ([card.title] + card.lines.filter { $0.style != .code }.map(\.text)).joined(separator: ", "))
        }
    }

    /// Quick replies in a person's words' type, one line each; once one
    /// is sent, the others' words go quiet, so the sent one stands out. A
    /// provider's option keeps room for the widest note it may show.
    static func draft(_ replies: QuickReplies, environment: TextEnvironment?) -> Draft {
        func quiet(_ index: Int) -> Bool { replies.chosen.map { $0 != index } ?? false }
        let labels = replies.options.enumerated().map { index, option in
            MeasuredText(ChatTextStyles.text.string(option, color: quiet(index) ? Palette.textSecondary : Palette.userMessageText, lineBreakMode: .byTruncatingTail, in: environment), maxLines: 1)
        }
        func note(_ text: String) -> MeasuredText {
            MeasuredText(detail.string(text, color: Palette.textSecondary, alignment: .right, lineBreakMode: .byTruncatingTail, in: environment), maxLines: 1)
        }
        let hasNotes = replies.providers.contains { $0 != nil }
        let noteWidth = hasNotes ? QuickReplies.noteCandidates.map { note($0).measurable.size(fitting: .greatestFiniteMagnitude).width.rounded(.up) }.max() ?? 0 : 0
        let notes = replies.notes.map { $0.map(note) }
        let input = ChatUiLayout.Input.replies(zip(labels, replies.providers).map { label, provider in
            ChatUiLayout.Reply(label.measurable, mark: provider != nil, note: provider != nil)
        }, noteWidth: noteWidth)
        return Draft(shown: .replies(replies), input: input, buttons: labels, notes: notes, spoken: "")
    }

    /// A provider CLI's mark (new/index.tsx's `agentIcons`), drawn in the
    /// words' colour; one this build has no picture of gets a sparkle.
    static func mark(_ provider: String) -> String? {
        switch provider {
        case "claude": "icon-claude"
        case "codex": "icon-gpt"
        case "antigravity": "icon-agy"
        default: nil
        }
    }

    static func draw(_ draft: Draft, _ layout: ChatUiLayout, origin: CGPoint) -> (items: [ChatDrawItem], hits: [ChatHit], controls: [ChatControl]) {
        typealias M = ChatUiLayout.Metrics
        var items: [ChatDrawItem] = []
        var hits: [ChatHit] = []
        var controls: [ChatControl] = []
        func at(_ frame: CGRect) -> CGRect { frame.offsetBy(dx: origin.x, dy: origin.y) }
        func text(_ text: MeasuredText, _ frame: CGRect) { items.append(.text(text.layout(for: frame), at(frame))) }
        switch draft.shown {
        case .replies(let replies):
            // Sent, it is the person's bubble with a tick; the rest keep
            // their look, and nothing moves.
            for (index, (placed, label)) in zip(layout.buttons, draft.buttons).enumerated() {
                let sent = replies.chosen == index
                items.append(.box(ChatBox(frame: at(placed.frame), fill: sent ? Palette.userBubble : Palette.quickReplyBubble, radius: MessageLayout.Metrics.bubbleRadius)))
                let words = replies.chosen.map { $0 != index } ?? false ? Palette.textSecondary : Palette.userMessageText
                if let provider = replies.providers[index], let frame = placed.mark {
                    if let name = mark(provider) { items.append(.image(name, frame: at(frame), tint: words)) }
                    else { items.append(.icon(.ionicons("sparkles-outline"), size: M.replyMark, frame: at(frame), tint: words)) }
                }
                text(label, placed.label)
                if index < draft.notes.count, let note = draft.notes[index], let frame = placed.note { text(note, frame) }
                if sent, let tick = placed.tick { items.append(.icon(.ionicons("checkmark"), size: M.tick, frame: at(tick), tint: Palette.userMessageText)) }
                let tap = ChatRowAction.ui(ChatUiTap(kind: .reply(replies, index)))
                if replies.live { hits.insert(ChatHit(frame: at(placed.frame), action: tap), at: 0) }
                controls.append(ChatControl(frame: at(placed.frame), label: replies.options[index], selected: sent, action: replies.live ? tap : nil))
            }
        case .component(let shown):
            switch shown.kind {
            case .fileTree(let entries):
                for ((entry, row), label) in zip(zip(entries, layout.rows), draft.rows) {
                    items.append(.icon(.ionicons(entry.folder ? "folder-outline" : "document-outline"), size: M.treeGlyph, frame: at(row.mark), tint: Palette.textSecondary))
                    text(label, row.label)
                }
            case .line:
                if let line = draft.text, let frame = layout.label { text(line, frame) }
            case .live where draft.card?.row != nil:
                guard let card = draft.card, let row = card.row else { break }
                if let frame = layout.card {
                    items.append(.box(ChatBox(frame: at(frame), fill: Palette.surfaceHigh, border: Palette.legacyDivider, borderWidth: M.border, radius: M.radius)))
                }
                if let frame = layout.mark {
                    if let name = mark(row.provider) { items.append(.image(name, frame: at(frame), tint: Palette.text)) }
                    else { items.append(.icon(.ionicons("sparkles-outline"), size: M.rowMark, frame: at(frame), tint: Palette.text)) }
                }
                if let name = draft.text, let frame = layout.label { text(name, frame) }
                for (one, frame) in zip(draft.lines, layout.lines) { text(one, frame) }
                if let frame = layout.lineMark {
                    switch row.tone {
                    case .busy: items.append(.spinner(at(frame), tint: Palette.textSecondary, scale: M.lineMark / 20))
                    case .done: items.append(.icon(.ionicons("checkmark-circle"), size: M.lineMark, frame: at(frame), tint: Palette.textSecondary))
                    case .error: items.append(.icon(.ionicons("alert-circle"), size: M.lineMark, frame: at(frame), tint: Palette.textDestructive))
                    case .quiet: break
                    }
                }
                for (placed, index) in zip(layout.buttons, layout.shown) {
                    let one = card.buttons[index]
                    let filled = one.primary && one.enabled
                    items.append(.box(ChatBox(frame: at(placed.frame), fill: filled ? Palette.roundButtonFill : nil, border: filled || one.glyph != nil ? nil : Palette.legacyDivider,
                                              borderWidth: filled || one.glyph != nil ? 0 : M.border, radius: M.rowControl / 2, alpha: one.enabled ? 1 : M.disabledAlpha)))
                    if let glyph = one.glyph {
                        items.append(.icon(.ionicons(glyph), size: M.tick, frame: at(placed.label), tint: Palette.textSecondary))
                    } else {
                        text(draft.buttons[index], placed.label)
                    }
                    let tap = ChatRowAction.ui(ChatUiTap(kind: .card(shown, one.tap)))
                    if one.enabled { hits.insert(ChatHit(frame: at(placed.frame), action: tap), at: 0) }
                    controls.append(ChatControl(frame: at(placed.frame), label: one.label, action: one.enabled ? tap : nil))
                }
            case .live:
                guard let card = draft.card else { break }
                if let frame = layout.card {
                    items.append(.box(ChatBox(frame: at(frame), fill: Palette.surfaceHigh, border: Palette.legacyDivider, borderWidth: M.border, radius: M.radius)))
                }
                if let title = draft.text, let frame = layout.label { text(title, frame) }
                for (one, frame) in zip(draft.lines, layout.lines) { text(one, frame) }
                for ((one, placed), label) in zip(zip(card.buttons, layout.buttons), draft.buttons) {
                    let filled = one.primary && one.enabled
                    items.append(.box(ChatBox(frame: at(placed.frame), fill: filled ? Palette.roundButtonFill : Palette.surface, border: filled ? nil : Palette.legacyDivider,
                                              borderWidth: filled ? 0 : M.border, radius: M.radius, alpha: one.enabled ? 1 : M.disabledAlpha)))
                    text(label, placed.label)
                    let tap = ChatRowAction.ui(ChatUiTap(kind: .card(shown, one.tap)))
                    if one.enabled { hits.insert(ChatHit(frame: at(placed.frame), action: tap), at: 0) }
                    controls.append(ChatControl(frame: at(placed.frame), label: one.label, action: one.enabled ? tap : nil))
                }
            }
        }
        return (items, hits, controls)
    }
}
#endif

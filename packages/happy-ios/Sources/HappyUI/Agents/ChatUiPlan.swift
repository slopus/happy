#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// A press on a chat UI component.
struct ChatUiTap: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// Sent through `/actions`.
        case act(UiAction)
        /// A checklist option ticked or unticked, here only.
        case tick(String)
        /// A text field asks for its text.
        case prompt
    }

    var shown: UiShown
    var kind: Kind
}

/// A chat UI component's part of an agent's row (`ChatUiLayout`): drafted
/// with its texts measured, then drawn where the row placed it. Controls
/// the person can't use, or no longer, are drawn faded and answer nothing.
enum ChatUiPlan {
    static let label = ChatTextStyle(.figtree(.medium), size: 15, lineHeight: 20)
    static let detail = ChatTextStyle(.figtree(.regular), size: 13, lineHeight: 18)
    static let line = ChatTextStyles.text
    static let path = ChatTextStyles.terminal

    struct Draft {
        var shown: UiShown
        /// The person may send its action, and it still takes one.
        var enabled: Bool
        var input: ChatUiLayout.Input
        /// Its buttons' labels, its rows' labels and details, then a field's
        /// label and value, or the line, in the order the layout places them.
        var buttons: [MeasuredText] = []
        var rows: [(label: MeasuredText, detail: MeasuredText?)] = []
        var text: MeasuredText?
        var value: MeasuredText?
        var spoken: String
    }

    /// The action a component's control sends.
    static func actionType(_ kind: UiShown.Kind) -> String? {
        switch kind {
        case .choice: "choice.choose"
        case .checklist: "checklist.submit"
        case .textField: "text_field.submit"
        case .fileTree, .line: nil
        }
    }

    static func draft(_ shown: UiShown, granted: Set<String>?, environment: TextEnvironment?) -> Draft {
        let allowed = actionType(shown.kind).map { UiCatalog.allowed($0, props: shown.props, granted: granted) } ?? false
        let enabled = allowed && !shown.state.settled
        func measured(_ text: String, _ style: ChatTextStyle, _ color: ColorToken, alignment: NSTextAlignment = .natural, lines: Int = 0) -> MeasuredText {
            MeasuredText(style.string(text, color: color, alignment: alignment, in: environment), maxLines: lines)
        }
        func button(_ text: String, primary: Bool, chosen: Bool) -> (MeasuredText, ChatUiLayout.ButtonInput) {
            let color = chosen ? Palette.text : (!enabled ? Palette.textSecondary : (primary ? Palette.roundButtonText : Palette.text))
            let text = measured(text, label, color, alignment: .center, lines: 3)
            return (text, ChatUiLayout.ButtonInput(label: text.measurable, glyph: chosen))
        }
        switch shown.kind {
        case .choice(let options):
            let chosen = (shown.state.answer ?? shown.state.pending)?["optionId"]?.stringValue
            let made = options.map { button($0.label, primary: $0.primary, chosen: $0.id == chosen) }
            return Draft(shown: shown, enabled: enabled, input: .buttons(made.map(\.1)), buttons: made.map(\.0), spoken: options.map(\.label).joined(separator: ", "))
        case .checklist(let options, let submitLabel, let emptyLabel):
            let ticked = shown.ticked
            let rows = options.map { option -> (label: MeasuredText, detail: MeasuredText?) in
                (measured(option.label, label, enabled ? Palette.text : Palette.textSecondary),
                 option.detail.map { measured($0, detail, Palette.textSecondary) })
            }
            let submitText = ticked.isEmpty ? emptyLabel ?? submitLabel : submitLabel
            let submit = button(submitText, primary: true, chosen: shown.state.answer != nil || shown.state.pending != nil)
            let input = ChatUiLayout.Input.checklist(rows.map { ChatUiLayout.RowInput(label: $0.label.measurable, detail: $0.detail?.measurable) }, submit: submit.1)
            return Draft(shown: shown, enabled: enabled, input: input, buttons: [submit.0], rows: rows, spoken: (options.map(\.label) + [submitText]).joined(separator: ", "))
        case .textField(let fieldLabel, let placeholder, let submitLabel):
            let answered = (shown.state.answer ?? shown.state.pending)?["text"]?.stringValue
            let text = measured(fieldLabel, detail, Palette.textSecondary)
            let value = measured(answered ?? placeholder ?? " ", line, answered == nil ? Palette.inputPlaceholder : Palette.text, lines: 1)
            let submit = button(submitLabel, primary: true, chosen: answered != nil)
            return Draft(shown: shown, enabled: enabled, input: .field(label: text.measurable, value: value.measurable, submit: submit.1), buttons: [submit.0], text: text, value: value,
                         spoken: [fieldLabel, answered ?? placeholder].compactMap { $0 }.joined(separator: ", "))
        case .fileTree(let entries):
            let rows = entries.map { entry -> (label: MeasuredText, detail: MeasuredText?) in (measured(entry.name, path, Palette.text, lines: 1), nil) }
            let input = ChatUiLayout.Input.tree(zip(entries, rows).map { entry, row -> (depth: Int, name: Measurable) in (entry.depth, row.label.measurable) })
            return Draft(shown: shown, enabled: false, input: input, rows: rows, spoken: entries.map(\.name).joined(separator: ", "))
        case .line(let words):
            let text = measured(words, line, Palette.textSecondary)
            return Draft(shown: shown, enabled: false, input: .line(text.measurable), text: text, spoken: words)
        }
    }

    static func draw(_ draft: Draft, _ layout: ChatUiLayout, origin: CGPoint) -> (items: [ChatDrawItem], hits: [ChatHit]) {
        typealias M = ChatUiLayout.Metrics
        let shown = draft.shown
        var items: [ChatDrawItem] = []
        var hits: [ChatHit] = []
        func at(_ frame: CGRect) -> CGRect { frame.offsetBy(dx: origin.x, dy: origin.y) }
        func text(_ text: MeasuredText, _ frame: CGRect) { items.append(.text(text.layout(for: frame), at(frame))) }
        /// A button: `chosen` is the answer given, `primary` the one offered first.
        func button(_ button: ChatUiLayout.Button, label: MeasuredText, primary: Bool, chosen: Bool, tap: ChatUiTap.Kind?) {
            let fill = chosen ? Palette.userBubble : (primary && draft.enabled ? Palette.roundButtonFill : Palette.surfaceHigh)
            let faded = !draft.enabled && !chosen
            items.append(.box(ChatBox(frame: at(button.frame), fill: fill, border: primary || chosen ? nil : Palette.legacyDivider, borderWidth: primary || chosen ? 0 : M.border,
                                      radius: M.radius, alpha: faded ? M.disabledAlpha : 1)))
            text(label, button.label)
            if let glyph = button.glyph {
                if shown.state.pending != nil && shown.state.answer == nil {
                    items.append(.spinner(at(glyph), tint: Palette.textSecondary, scale: 0.8))
                } else {
                    items.append(.icon(.ionicons("checkmark"), size: M.glyph, frame: at(glyph), tint: Palette.text))
                }
            }
            if let tap, draft.enabled { hits.insert(ChatHit(frame: at(button.frame), action: .ui(ChatUiTap(shown: shown, kind: tap))), at: 0) }
        }
        switch shown.kind {
        case .choice(let options):
            let chosen = (shown.state.answer ?? shown.state.pending)?["optionId"]?.stringValue
            for ((option, placed), label) in zip(zip(options, layout.buttons), draft.buttons) {
                button(placed, label: label, primary: option.primary, chosen: option.id == chosen,
                       tap: .act(UiAction(type: "choice.choose", payload: .object(["optionId": .string(option.id)]))))
            }
        case .checklist(let options, _, _):
            let ticked = shown.ticked
            for ((option, row), texts) in zip(zip(options, layout.rows), draft.rows) {
                let on = ticked.contains(option.id)
                items.append(.box(ChatBox(frame: at(row.mark), fill: on ? Palette.roundButtonFill : nil, border: on ? nil : Palette.textSecondary, borderWidth: on ? 0 : 1.5,
                                          radius: M.boxRadius, alpha: draft.enabled ? 1 : M.disabledAlpha)))
                if on { items.append(.icon(.ionicons("checkmark"), size: 14, frame: at(row.mark.insetBy(dx: 3, dy: 3)), tint: Palette.roundButtonText)) }
                text(texts.label, row.label)
                if let detail = texts.detail, let frame = row.detail { text(detail, frame) }
                if draft.enabled { hits.insert(ChatHit(frame: at(row.frame), action: .ui(ChatUiTap(shown: shown, kind: .tick(option.id)))), at: 0) }
            }
            if let submit = layout.buttons.first, let label = draft.buttons.first {
                let selected = options.map(\.id).filter(ticked.contains).map(JSONValue.string)
                button(submit, label: label, primary: true, chosen: shown.state.answer != nil || shown.state.pending != nil,
                       tap: .act(UiAction(type: "checklist.submit", payload: .object(["selected": .array(selected)]))))
            }
        case .textField:
            if let label = draft.text, let frame = layout.label { text(label, frame) }
            if let field = layout.field {
                items.append(.box(ChatBox(frame: at(field), fill: Palette.inputBackground, radius: M.radius, alpha: draft.enabled || shown.state.settled ? 1 : M.disabledAlpha)))
                if draft.enabled { hits.insert(ChatHit(frame: at(field), action: .ui(ChatUiTap(shown: shown, kind: .prompt))), at: 0) }
            }
            if let value = draft.value, let frame = layout.value { text(value, frame) }
            if let submit = layout.buttons.first, let label = draft.buttons.first {
                button(submit, label: label, primary: true, chosen: (shown.state.answer ?? shown.state.pending) != nil, tap: .prompt)
            }
        case .fileTree(let entries):
            for ((entry, row), texts) in zip(zip(entries, layout.rows), draft.rows) {
                items.append(.icon(.ionicons(entry.folder ? "folder-outline" : "document-outline"), size: M.treeGlyph, frame: at(row.mark), tint: Palette.textSecondary))
                text(texts.label, row.label)
            }
        case .line:
            if let line = draft.text, let frame = layout.label { text(line, frame) }
        }
        return (items, hits)
    }
}
#endif

#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// A question tool's form, with what the reader has done to it.
struct ChatQuestionState: Equatable, Sendable {
    var form: InlineQuestionForm
    var selections = InlineQuestionSelections()
    /// The answers sent from here, before the agent's own record of them.
    var sent: [String: [String]]?
    var submitting = false

    /// What the summary shows once answered.
    var submitted: [String: [String]]? { form.submitted ?? sent }
    var canInteract: Bool { form.canInteract && submitted == nil }
}

// MARK: InlineQuestionForm.tsx

extension ChatRowRenderer {
    /// Its text at the rows' size; the marks, the 44 minimum and the
    /// paddings keep theirs.
    static func questionForm(_ state: ChatQuestionState, toolId: String, text: ChatRowText) -> ChatStackEntry {
        if let submitted = state.submitted {
            return section(nil, .stack(state.form.questions.map { question in
                submittedLine(question, answer: submitted[question.id], text: text)
            }, gap: 8), text: text)
        }
        var sections = state.form.questions.map { question in
            questionSection(question, state: state, toolId: toolId, text: text)
        }
        if state.canInteract {
            sections.append(submitButton(state, toolId: toolId, text: text))
        }
        return section(nil, .stack(sections, gap: 16), text: text)
    }

    /// "Header: answer", the header in secondary semibold.
    static func submittedLine(_ question: InlineQuestion, answer: [String]?, text: ChatRowText) -> ChatStackEntry {
        let environment = text.environment
        let header = MeasuredText(ChatTextStyles.inlineSubmittedHeader.string("\(question.header):", color: Palette.textSecondary, in: environment), maxLines: 1)
        let joined = answer?.joined(separator: ", ") ?? ""
        let value = MeasuredText(ChatTextStyles.inlineSubmittedValue.string(joined.isEmpty ? "—" : joined, color: Palette.text, in: environment))
        let row = ChatPiece(measurable: Measurable { width in
            ChatAccessoryRowLayout(width: width, leading: header.layout(width: width / 2).size, text: value.measurable, alignment: .top).size
        }) { frame in
            let layout = ChatAccessoryRowLayout(width: frame.width, leading: header.layout(width: frame.width / 2).size, text: value.measurable, alignment: .top)
            let headerFrame = layout.leading!.offsetBy(dx: frame.minX, dy: frame.minY)
            let valueFrame = layout.text.offsetBy(dx: frame.minX, dy: frame.minY)
            return ([.text(header.layout(width: frame.width / 2), headerFrame), .text(value.layout(for: valueFrame), valueFrame)], [])
        }
        return ChatStackEntry(piece: row)
    }

    /// The header chip, the question, then its options 4 apart.
    static func questionSection(_ question: InlineQuestion, state: ChatQuestionState, toolId: String, text rowText: ChatRowText) -> ChatStackEntry {
        let environment = rowText.environment
        let chip = MeasuredText(ChatTextStyles.inlineQuestionHeader.string(question.header.uppercased(), color: Palette.textSecondary, in: environment), maxLines: 1)
        let text = MeasuredText(ChatTextStyles.inlineQuestionText.string(question.question, color: Palette.text, in: environment))
        var entries = [
            ChatStackEntry(
                piece: .text(chip), marginBottom: 4, padding: LayoutInsets(top: 4, left: 8, bottom: 4, right: 8), placement: .leading,
                background: ChatBox(frame: .zero, fill: Palette.surfaceHighest, radius: 4)
            ),
            ChatStackEntry(piece: .text(text), marginBottom: 8),
        ]
        let options = question.options.enumerated().map { index, option in
            optionButton(option, selected: state.selections.isSelected(question, option: index), multiSelect: question.multiSelect,
                         enabled: state.canInteract, action: .questionOption(toolId: toolId, questionId: question.id, option: index), text: rowText)
        }
        entries.append(ChatStackEntry(piece: .stack(options, gap: 4)))
        return ChatStackEntry(piece: .stack(entries, gap: 8))
    }

    /// An outlined option: a radio or a checkbox, then the label and its
    /// description. 12 in, 10 between, at least 44 tall.
    static func optionButton(
        _ option: AgentQuestionOption, selected: Bool, multiSelect: Bool, enabled: Bool, action: ChatRowAction, text: ChatRowText
    ) -> ChatStackEntry {
        let environment = text.environment
        let label = MeasuredText(ChatTextStyles.inlineOptionLabel.string(option.label, color: Palette.text, in: environment))
        let description = option.description.flatMap {
            $0.isEmpty ? nil : MeasuredText(ChatTextStyles.inlineOptionDescription.string($0, color: Palette.textSecondary, in: environment))
        }
        let column = ChatPiece.stack([ChatStackEntry(piece: .text(label))] + (description.map { [ChatStackEntry(piece: .text($0), marginTop: 2)] } ?? []))
        let mark = CGSize(width: 20, height: 22)
        let alpha: CGFloat = enabled ? 1 : 0.6
        let row = ChatPiece(measurable: Measurable { width in
            ChatAccessoryRowLayout(width: width, leading: mark, text: column.measurable, gap: 10, alignment: .top).size
        }) { frame in
            let layout = ChatAccessoryRowLayout(width: frame.width, leading: mark, text: column.measurable, gap: 10, alignment: .top)
            // The mark sits 2 down (marginTop: 2).
            let markFrame = CGRect(x: frame.minX, y: frame.minY + 2, width: 20, height: 20)
            var items: [ChatDrawItem] = []
            if multiSelect {
                items.append(.box(ChatBox(frame: markFrame, fill: selected ? Palette.radioActive : nil, border: selected ? Palette.radioActive : Palette.textSecondary, borderWidth: 2, radius: 4, alpha: alpha)))
                if selected { items.append(.icon(.ionicons("checkmark"), size: 14, frame: markFrame, tint: Palette.onAccent)) }
            } else {
                items.append(.box(ChatBox(frame: markFrame, border: selected ? Palette.radioActive : Palette.textSecondary, borderWidth: 2, radius: 10, alpha: alpha)))
                if selected { items.append(.box(ChatBox(frame: markFrame.insetBy(dx: 5, dy: 5), fill: Palette.radioActive, radius: 5, alpha: alpha))) }
            }
            let drawn = column.draw(layout.text.offsetBy(dx: frame.minX, dy: frame.minY))
            items += enabled ? drawn.items : drawn.items.map { $0.dimmed(alpha) }
            return (items, [])
        }
        let background = ChatBox(
            frame: .zero, fill: selected ? Palette.surfaceHighest : Palette.surface, border: selected ? Palette.radioActive : Palette.divider,
            borderWidth: 1, radius: 8, alpha: alpha
        )
        return ChatStackEntry(
            piece: ChatPiece(measurable: Measurable { width in
                let size = row.measurable.size(fitting: width)
                // minHeight 44 with 12 above and below: 20 inside.
                return CGSize(width: size.width, height: max(size.height, 44 - 24))
            }) { frame in
                let drawn = row.draw(frame)
                let box = frame.insetBy(dx: -12, dy: -12)
                return (drawn.items, enabled ? [ChatHit(frame: box, action: action)] : [])
            },
            padding: LayoutInsets(top: 12, left: 12, bottom: 12, right: 12), background: background
        )
    }

    /// "Submit Answer", right-aligned; outlined in blue once every required
    /// question has an answer, a spinner while it goes.
    static func submitButton(_ state: ChatQuestionState, toolId: String, text rowText: ChatRowText) -> ChatStackEntry {
        let ready = state.selections.allAnswered(state.form.questions) && !state.submitting
        let title = MeasuredText(ChatTextStyles.inlineSubmit.string(rowText.words.submitAnswer, color: Palette.text, in: rowText.environment), maxLines: 1)
        let alpha: CGFloat = ready ? 1 : 0.5
        let button = ChatPiece(measurable: Measurable { width in
            let size = title.layout(width: width).size
            return CGSize(width: size.width, height: max(size.height, 44 - 24))
        }) { frame in
            let box = frame.insetBy(dx: -20, dy: -12)
            var items: [ChatDrawItem] = []
            if state.submitting {
                let spinner = CGRect(x: frame.midX - 10, y: frame.midY - 10, width: 20, height: 20)
                items.append(.spinner(spinner, tint: Palette.text, scale: 1))
            } else {
                let text = title.layout(width: frame.width)
                let textFrame = CGRect(x: frame.minX, y: frame.midY - text.size.height / 2, width: frame.width, height: text.size.height)
                items.append(.text(alpha < 1 ? text.dimmed(alpha) : text, textFrame))
            }
            return (items, ready ? [ChatHit(frame: box, action: .questionSubmit(toolId: toolId))] : [])
        }
        let background = ChatBox(frame: .zero, fill: Palette.surfaceHighest, border: ready ? Palette.radioActive : Palette.divider, borderWidth: 1, radius: 8, alpha: alpha)
        let row = ChatPiece(measurable: Measurable { width in
            let layout = ChatStackLayout(width: width, items: [ChatStackEntry(piece: button, padding: LayoutInsets(top: 12, left: 20, bottom: 12, right: 20), placement: .leading).item])
            return layout.size
        }) { frame in
            // Right-aligned (justifyContent: 'flex-end').
            let entry = ChatStackEntry(piece: button, padding: LayoutInsets(top: 12, left: 20, bottom: 12, right: 20), placement: .leading, background: background)
            let width = ChatStackLayout(width: frame.width, items: [entry.item]).boxes[0].width
            return ChatPiece.stack([entry]).draw(CGRect(x: frame.maxX - width, y: frame.minY, width: width, height: frame.height))
        }
        return ChatStackEntry(piece: row, marginTop: 8)
    }
}

extension ChatDrawItem {
    /// The item at a lower opacity (a form that can no longer be answered).
    func dimmed(_ alpha: CGFloat) -> ChatDrawItem {
        switch self {
        case .text(let layout, let frame):
            return .text(layout.dimmed(alpha), frame)
        case .box(var box):
            box.alpha *= alpha
            return .box(box)
        default:
            return self
        }
    }
}
#endif

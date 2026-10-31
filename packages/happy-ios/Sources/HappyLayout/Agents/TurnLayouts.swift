import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// One tool call while its turn shows its work, as desktop's single-line
/// `AgentToolActivity` sets it (`agent-activity-row.css`): the row of a
/// message from another agent (`AgentMessageLayout`), 6 above and below and
/// 20 tall, a 14 glyph lane, then 6 apart the verb at its width and the
/// subject in what is left. A file edit's subject takes only its width,
/// its counts 6 after it and 6 apart.
public struct ToolRowLayout: Equatable, Sendable {
    public typealias Metrics = AgentMessageLayout.Metrics

    public var size: CGSize
    public var glyph: CGRect
    public var verb: CGRect
    public var text: CGRect
    public var added: CGRect?
    public var deleted: CGRect?

    /// `addedWidth` and `deletedWidth` are a file edit's counts, nil where
    /// there are none; with either, the subject is only as wide as it is.
    public init(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, verbWidth: CGFloat, textWidth: CGFloat, addedWidth: CGFloat? = nil, deletedWidth: CGFloat? = nil) {
        typealias M = Metrics
        let column = ChatColumn(rowWidth: width, maxContentWidth: maxContentWidth)
        let left = column.x + MessageLayout.Metrics.marginH
        let right = column.x + column.width - MessageLayout.Metrics.marginH
        let top = M.paddingV
        glyph = CGRect(x: left, y: top + (M.lineHeight - M.glyph) / 2, width: M.glyph, height: M.glyph)
        let verbX = glyph.maxX + M.gap
        verb = CGRect(x: verbX, y: top, width: min(ceil(verbWidth), max(0, right - verbX)), height: M.lineHeight)
        let x = verb.maxX + M.gap
        let counts = [addedWidth, deletedWidth].compactMap { $0.map { ceil($0) } }
        let countsWidth = counts.reduce(0, +) + CGFloat(counts.count) * M.gap
        let room = max(0, right - x - countsWidth)
        text = CGRect(x: x, y: top, width: counts.isEmpty ? room : min(ceil(textWidth), room), height: M.lineHeight)
        var countX = text.maxX + M.gap
        if let addedWidth {
            added = CGRect(x: countX, y: top, width: ceil(addedWidth), height: M.lineHeight)
            countX += ceil(addedWidth) + M.gap
        }
        if let deletedWidth {
            deleted = CGRect(x: countX, y: top, width: ceil(deletedWidth), height: M.lineHeight)
        }
        size = CGSize(width: max(0, width), height: top + M.lineHeight + M.paddingV)
    }
}

/// A call whose result is something to look at, desktop's media and
/// artifact rows (`agent-activity-row.css`, `toolResultHeight`): its line,
/// then what it showed 8 under it in the row's own flow, laid out as an
/// agent message's parts are, and the line's padding under the last.
public struct ToolResultLayout: Equatable, Sendable {
    public enum Metrics {
        /// Between the line and what it showed (`TOOL_MEDIA_GAP`).
        public static let gap: CGFloat = 8
    }

    public var size: CGSize
    public var line: ToolRowLayout
    public var body: MessageLayout

    public init(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, line: ToolRowLayout, parts: [MessageLayout.Part]) {
        let padding = ToolRowLayout.Metrics.paddingV
        self.line = line
        body = MessageLayout.agent(width: width, maxContentWidth: maxContentWidth, parts: parts, top: line.size.height - padding + Metrics.gap, bottom: padding)
        size = body.size
    }
}

/// How a finished turn ended, desktop's `TurnSummary` (`turn-summary.css`):
/// one 24 line of 16 type in a row 32 tall, 36 with 4 above it when it
/// follows a step of the turn. The copy button leads it, a 20 square 2 out
/// from the text column so its 16 glyph sits on it, 8 before the words.
public struct TurnStatusLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 32
        /// Above it, after a step (`--after-trace`).
        public static let afterStep: CGFloat = 4
        public static let lineHeight: CGFloat = 24
        public static let button: CGFloat = 20
        public static let buttonOutset: CGFloat = 2
        public static let glyph: CGFloat = 16
        public static let gap: CGFloat = 8
    }

    public var size: CGSize
    public var copy: CGRect?
    public var glyph: CGRect?
    public var label: CGRect

    public init(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, labelWidth: CGFloat, copies: Bool, afterStep: Bool) {
        typealias M = Metrics
        let column = ChatColumn(rowWidth: width, maxContentWidth: maxContentWidth)
        let left = column.x + MessageLayout.Metrics.marginH
        let right = column.x + column.width - MessageLayout.Metrics.marginH
        let top = afterStep ? M.afterStep : 0
        let middle = top + M.height / 2
        var x = left
        if copies {
            let button = CGRect(x: left - M.buttonOutset, y: middle - M.button / 2, width: M.button, height: M.button)
            copy = button
            glyph = CGRect(x: button.midX - M.glyph / 2, y: button.midY - M.glyph / 2, width: M.glyph, height: M.glyph)
            x = button.maxX + M.gap
        }
        label = CGRect(x: x, y: middle - M.lineHeight / 2, width: min(ceil(labelWidth), max(0, right - x)), height: M.lineHeight)
        size = CGSize(width: max(0, width), height: top + M.height)
    }
}

/// A finished turn's "View traces" / "Hide traces" control, the meta line
/// desktop hangs over the row it rides (`agent-trace-row.css`, `meta`):
/// 11 mono on a 16 line, then a 2 dot and the tool count 6 apart. On a
/// phone it is always shown, 8 under what is above it; the row it rides
/// keeps its own room under it.
public struct TraceLayout: Equatable, Sendable {
    public enum Metrics {
        public static let top: CGFloat = 8
        public static let lineHeight: CGFloat = 16
        public static let gap: CGFloat = 6
        public static let dot: CGFloat = 2
        /// How far past the line a finger still opens it.
        public static let reach: CGFloat = 10
    }

    public var size: CGSize
    public var title: CGRect
    public var dot: CGRect?
    public var stats: CGRect?
    /// What a tap answers to.
    public var hit: CGRect

    public init(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, titleWidth: CGFloat, statsWidth: CGFloat?) {
        typealias M = Metrics
        let column = ChatColumn(rowWidth: width, maxContentWidth: maxContentWidth)
        let left = column.x + MessageLayout.Metrics.marginH
        let right = column.x + column.width - MessageLayout.Metrics.marginH
        title = CGRect(x: left, y: M.top, width: min(ceil(titleWidth), max(0, right - left)), height: M.lineHeight)
        var end = title.maxX
        if let statsWidth {
            let dot = CGRect(x: title.maxX + M.gap, y: M.top + (M.lineHeight - M.dot) / 2, width: M.dot, height: M.dot)
            self.dot = dot
            let x = dot.maxX + M.gap
            let stats = CGRect(x: x, y: M.top, width: min(ceil(statsWidth), max(0, right - x)), height: M.lineHeight)
            self.stats = stats
            end = stats.maxX
        }
        hit = CGRect(x: left, y: M.top - M.reach, width: end - left, height: M.lineHeight + 2 * M.reach)
        size = CGSize(width: max(0, width), height: M.top + M.lineHeight)
    }
}

/// A question the agent asked, desktop's `HappyAgentUserInputPrompt` in its
/// `card` variant (`happy-agent-chat.css`). Its block sits 12 out from the
/// text column on each side, so the words inside line up with the
/// transcript's. Each prompt: the legend 6 above and 5 under, 12 in, its
/// eyebrow (header, 8, the selection rule, on a 16 line) 3 over the
/// question. Then the options 2 apart, each at least 32, 4 above and below
/// and 12 in, an 18 box 9 before its label and description. Answered, each
/// answer instead, 5 above and below. Prompts 8 apart; while pending, the
/// Submit button closes it at the right, 4 above and below and 8 in.
public struct QuestionLayout: Equatable, Sendable {
    public enum Metrics {
        public static let outset: CGFloat = 12
        public static let legendTop: CGFloat = 6
        public static let legendBottom: CGFloat = 5
        public static let legendGap: CGFloat = 3
        public static let eyebrowGap: CGFloat = 8
        public static let eyebrowHeight: CGFloat = 16
        public static let optionGap: CGFloat = 2
        public static let optionMinHeight: CGFloat = 32
        public static let optionPaddingV: CGFloat = 4
        public static let box: CGFloat = 18
        public static let boxGap: CGFloat = 9
        public static let answerPaddingV: CGFloat = 5
        public static let promptGap: CGFloat = 8
        public static let footerPaddingV: CGFloat = 4
        public static let footerPaddingH: CGFloat = 8
        public static let button: CGFloat = 28
        public static let buttonPaddingH: CGFloat = 10
        public static let radius: CGFloat = 6
        /// Above and below the whole block, as a message has.
        public static let marginV: CGFloat = 8
    }

    /// One option or answer: its label over its description.
    public struct Choice {
        public var label: Measurable
        public var description: Measurable?

        public init(label: Measurable, description: Measurable? = nil) {
            self.label = label
            self.description = description
        }
    }

    public struct Prompt {
        public var header: CGSize
        public var rule: CGSize
        public var question: Measurable
        /// The options while pending, the answers once answered.
        public var choices: [Choice]

        public init(header: CGSize, rule: CGSize, question: Measurable, choices: [Choice]) {
            self.header = header
            self.rule = rule
            self.question = question
            self.choices = choices
        }
    }

    public struct PlacedChoice: Equatable, Sendable {
        /// Its whole highlight, which a tap answers to.
        public var frame: CGRect
        /// The checkbox; nil for an answer.
        public var box: CGRect?
        public var label: CGRect
        public var description: CGRect?
    }

    public struct PlacedPrompt: Equatable, Sendable {
        public var header: CGRect
        public var rule: CGRect
        public var question: CGRect
        public var choices: [PlacedChoice]
    }

    public var size: CGSize
    public var prompts: [PlacedPrompt]
    /// Why the answer didn't go, over the button (desktop's banner).
    public var note: CGRect?
    public var button: CGRect?

    /// `buttonLabel` is Submit's width while the question waits; nil once
    /// it is answered. `note` says why an answer didn't go.
    public init(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, prompts: [Prompt], buttonLabel: CGFloat?, note: Measurable? = nil) {
        typealias M = Metrics
        let column = ChatColumn(rowWidth: width, maxContentWidth: maxContentWidth)
        let left = column.x + MessageLayout.Metrics.marginH - M.outset
        let right = column.x + column.width - MessageLayout.Metrics.marginH + M.outset
        let inner = max(0, right - left - 2 * M.outset)
        var y = M.marginV
        var placed: [PlacedPrompt] = []
        for (index, prompt) in prompts.enumerated() {
            if index > 0 { y += M.promptGap }
            y += M.legendTop
            let textX = left + M.outset
            let header = CGRect(x: textX, y: y, width: min(ceil(prompt.header.width), inner), height: M.eyebrowHeight)
            let ruleX = prompt.header.width > 0 ? header.maxX + M.eyebrowGap : textX
            let rule = CGRect(x: ruleX, y: y, width: min(ceil(prompt.rule.width), max(0, textX + inner - ruleX)), height: M.eyebrowHeight)
            y += M.eyebrowHeight + M.legendGap
            let questionSize = prompt.question.size(fitting: inner)
            let question = CGRect(x: textX, y: y, width: inner, height: ceil(questionSize.height))
            y = question.maxY + M.legendBottom
            var choices: [PlacedChoice] = []
            let answered = buttonLabel == nil
            for (offset, choice) in prompt.choices.enumerated() {
                if offset > 0 { y += M.optionGap }
                let padding = answered ? M.answerPaddingV : M.optionPaddingV
                let bodyX = answered ? textX : textX + M.box + M.boxGap
                let bodyWidth = max(0, left + M.outset + inner - bodyX)
                let labelHeight = ceil(choice.label.size(fitting: bodyWidth).height)
                let descriptionHeight = choice.description.map { ceil($0.size(fitting: bodyWidth).height) }
                let bodyHeight = labelHeight + (descriptionHeight ?? 0)
                let height = answered ? bodyHeight + 2 * padding : max(M.optionMinHeight, bodyHeight + 2 * padding)
                let frame = CGRect(x: left, y: y, width: right - left, height: height)
                let bodyTop = y + (height - bodyHeight) / 2
                let label = CGRect(x: bodyX, y: bodyTop, width: bodyWidth, height: labelHeight)
                let description = descriptionHeight.map { CGRect(x: bodyX, y: label.maxY, width: bodyWidth, height: $0) }
                let box = answered ? nil : CGRect(x: textX, y: y + (height - M.box) / 2, width: M.box, height: M.box)
                choices.append(PlacedChoice(frame: frame, box: box, label: label, description: description))
                y += height
            }
            placed.append(PlacedPrompt(header: header, rule: rule, question: question, choices: choices))
        }
        self.prompts = placed
        if let note, buttonLabel != nil {
            y += M.footerPaddingV
            let height = ceil(note.size(fitting: inner).height)
            self.note = CGRect(x: left + M.outset, y: y, width: inner, height: height)
            y += height
        }
        if let buttonLabel {
            y += M.footerPaddingV
            let buttonWidth = ceil(buttonLabel) + 2 * M.buttonPaddingH
            button = CGRect(x: right - M.footerPaddingH - buttonWidth, y: y, width: buttonWidth, height: M.button)
            y += M.button + M.footerPaddingV
        }
        size = CGSize(width: max(0, width), height: y + M.marginV)
    }
}

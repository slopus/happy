import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// AgentQuestionModal: the full-screen answer sheet for a question the
/// chat can't show inline (a written answer, or more than options).
///
///     safe top
///     16 [Cancel] ──── title, centred ──── [60] 16      14 above and below
///     ─ hairline ─────────────────────────────────────
///     scroll, 16 in, 28 between questions:
///       [HEADER chip] 8 [•]                              8 between rows
///       Question text (17 semibold)
///       Choose as many as apply
///       ┌ 14 [☐ 22] 12 label / description ┐ radius 12
///       Your own answer (4 above, 6 below)
///       ┌ text input, min 48 ┐ radius 12
///     ─ hairline ─────────────────────────────────────
///     16 ┌ Send answer, 50 tall, radius 14 ┐ 16          12 above, 12 + safe bottom below
///
/// The footer rides on the keyboard while it is up, so the button is never
/// under it.
public struct QuestionSheetLayout: Equatable, Sendable {
    public enum Metrics {
        public static let headerPaddingH: CGFloat = 16
        public static let headerPaddingV: CGFloat = 14
        public static let headerSpacer: CGFloat = 60
        public static let contentPadding: CGFloat = 16
        public static let questionGap: CGFloat = 28
        public static let rowGap: CGFloat = 8
        public static let chipPaddingH: CGFloat = 8
        public static let chipPaddingV: CGFloat = 4
        public static let chipRadius: CGFloat = 4
        public static let dotSize: CGFloat = 6
        public static let optionPadding: CGFloat = 14
        public static let optionRadius: CGFloat = 12
        public static let optionGap: CGFloat = 12
        public static let checkboxSize: CGFloat = 22
        public static let checkboxTop: CGFloat = 1
        public static let checkboxRadius: CGFloat = 6
        public static let descriptionGap: CGFloat = 2
        public static let customMarginTop: CGFloat = 4
        public static let customGap: CGFloat = 6
        public static let inputMinHeight: CGFloat = 48
        public static let inputPaddingH: CGFloat = 14
        public static let inputPaddingV: CGFloat = 12
        public static let inputRadius: CGFloat = 12
        public static let footerPaddingH: CGFloat = 16
        public static let footerPaddingTop: CGFloat = 12
        public static let footerPaddingBottom: CGFloat = 12
        public static let submitHeight: CGFloat = 50
        public static let submitRadius: CGFloat = 14
        /// The scroll content ends this far past the safe area (96).
        public static let contentBottomExtra: CGFloat = 96
    }

    public struct Option {
        public var label: Measurable
        public var description: Measurable?

        public init(label: Measurable, description: Measurable? = nil) {
            self.label = label
            self.description = description
        }
    }

    public struct Question {
        public var chip: Measurable
        public var showsDot: Bool
        public var text: Measurable
        public var hint: Measurable?
        public var options: [Option]
        /// "Your own answer" and the text the person has typed (the
        /// input's text, measured inside its padding).
        public var custom: (label: Measurable, text: Measurable)?

        public init(chip: Measurable, showsDot: Bool, text: Measurable, hint: Measurable? = nil, options: [Option], custom: (label: Measurable, text: Measurable)? = nil) {
            self.chip = chip
            self.showsDot = showsDot
            self.text = text
            self.hint = hint
            self.options = options
            self.custom = custom
        }
    }

    public struct Input {
        public var size: CGSize
        public var safeArea: LayoutInsets
        /// The keyboard's top in the sheet, nil while it is down.
        public var keyboardTop: CGFloat?
        public var hairline: CGFloat
        public var cancel: Measurable
        public var title: Measurable
        public var submit: Measurable
        public var questions: [Question]
        public var error: Measurable?

        public init(size: CGSize, safeArea: LayoutInsets, keyboardTop: CGFloat? = nil, hairline: CGFloat, cancel: Measurable, title: Measurable, submit: Measurable, questions: [Question], error: Measurable? = nil) {
            self.size = size
            self.safeArea = safeArea
            self.keyboardTop = keyboardTop
            self.hairline = hairline
            self.cancel = cancel
            self.title = title
            self.submit = submit
            self.questions = questions
            self.error = error
        }
    }

    public struct PlacedOption: Equatable, Sendable {
        public var box: CGRect
        public var checkbox: CGRect
        public var label: CGRect
        public var description: CGRect?
    }

    /// One question's frames, in the scroll content.
    public struct PlacedQuestion: Equatable, Sendable {
        public var chip: CGRect
        public var chipText: CGRect
        public var dot: CGRect?
        public var text: CGRect
        public var hint: CGRect?
        public var options: [PlacedOption]
        public var customLabel: CGRect?
        public var input: CGRect?
    }

    public var header: CGRect
    public var cancel: CGRect
    public var title: CGRect
    public var headerDivider: CGRect
    public var scroll: CGRect
    public var contentSize: CGSize
    public var questions: [PlacedQuestion]
    public var error: CGRect?
    public var footer: CGRect
    public var footerDivider: CGRect
    public var submit: CGRect
    public var submitLabel: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.size.width)
        let height = max(0, input.size.height)

        // Header
        let top = input.safeArea.top
        let cancelSize = input.cancel.size(fitting: width / 2)
        let titleX = M.headerPaddingH + cancelSize.width
        let titleWidth = max(0, width - 2 * M.headerPaddingH - cancelSize.width - M.headerSpacer)
        let titleSize = input.title.size(fitting: titleWidth)
        let rowHeight = max(cancelSize.height, titleSize.height)
        let rowTop = top + M.headerPaddingV
        cancel = CGRect(x: M.headerPaddingH, y: rowTop + (rowHeight - cancelSize.height) / 2, width: cancelSize.width, height: cancelSize.height)
        title = CGRect(x: titleX + (titleWidth - titleSize.width) / 2, y: rowTop + (rowHeight - titleSize.height) / 2, width: titleSize.width, height: titleSize.height)
        let headerHeight = rowHeight + 2 * M.headerPaddingV + input.hairline
        header = CGRect(x: 0, y: top, width: width, height: headerHeight)
        headerDivider = CGRect(x: 0, y: header.maxY - input.hairline, width: width, height: input.hairline)

        // Footer, on the keyboard or the safe area.
        let keyboardUp = input.keyboardTop.map { $0 < height - 0.5 } ?? false
        let bottomPadding = M.footerPaddingBottom + (keyboardUp ? 0 : input.safeArea.bottom)
        let footerHeight = input.hairline + M.footerPaddingTop + M.submitHeight + bottomPadding
        let footerBottom = keyboardUp ? min(height, input.keyboardTop!) : height
        footer = CGRect(x: 0, y: footerBottom - footerHeight, width: width, height: footerHeight)
        footerDivider = CGRect(x: 0, y: footer.minY, width: width, height: input.hairline)
        submit = CGRect(x: M.footerPaddingH, y: footer.minY + input.hairline + M.footerPaddingTop, width: max(0, width - 2 * M.footerPaddingH), height: M.submitHeight)
        let labelSize = input.submit.size(fitting: submit.width)
        submitLabel = CGRect(x: submit.minX + (submit.width - labelSize.width) / 2, y: submit.minY + (submit.height - labelSize.height) / 2, width: labelSize.width, height: labelSize.height)

        // The questions, in the scroll content between the two bars. It
        // ends 96 past the safe area, as happy-app's does.
        scroll = CGRect(x: 0, y: header.maxY, width: width, height: max(0, footer.minY - header.maxY))
        let contentWidth = max(0, width - 2 * M.contentPadding)
        var y = M.contentPadding
        var placed: [PlacedQuestion] = []
        for (index, question) in input.questions.enumerated() {
            if index > 0 { y += M.questionGap }
            let x = M.contentPadding
            let chipText = question.chip.size(fitting: max(0, contentWidth - 2 * M.chipPaddingH - (question.showsDot ? M.rowGap + M.dotSize : 0)))
            let chip = CGRect(x: x, y: y, width: chipText.width + 2 * M.chipPaddingH, height: chipText.height + 2 * M.chipPaddingV)
            let dot = question.showsDot ? CGRect(x: chip.maxX + M.rowGap, y: chip.midY - M.dotSize / 2, width: M.dotSize, height: M.dotSize) : nil
            y = chip.maxY + M.rowGap
            let textHeight = question.text.height(fitting: contentWidth)
            let text = CGRect(x: x, y: y, width: contentWidth, height: textHeight)
            y = text.maxY
            var hint: CGRect?
            if let hintContent = question.hint {
                y += M.rowGap
                hint = CGRect(x: x, y: y, width: contentWidth, height: hintContent.height(fitting: contentWidth))
                y = hint!.maxY
            }
            var options: [PlacedOption] = []
            for option in question.options {
                y += M.rowGap
                let columnX = x + M.optionPadding + M.checkboxSize + M.optionGap
                let columnWidth = max(0, x + contentWidth - M.optionPadding - columnX)
                let labelHeight = option.label.height(fitting: columnWidth)
                let descriptionHeight = option.description?.height(fitting: columnWidth)
                let columnHeight = labelHeight + (descriptionHeight.map { M.descriptionGap + $0 } ?? 0)
                let inner = max(columnHeight, M.checkboxTop + M.checkboxSize)
                let box = CGRect(x: x, y: y, width: contentWidth, height: inner + 2 * M.optionPadding)
                options.append(PlacedOption(
                    box: box,
                    checkbox: CGRect(x: x + M.optionPadding, y: y + M.optionPadding + M.checkboxTop, width: M.checkboxSize, height: M.checkboxSize),
                    label: CGRect(x: columnX, y: y + M.optionPadding, width: columnWidth, height: labelHeight),
                    description: descriptionHeight.map { CGRect(x: columnX, y: y + M.optionPadding + labelHeight + M.descriptionGap, width: columnWidth, height: $0) }
                ))
                y = box.maxY
            }
            var customLabel: CGRect?
            var inputFrame: CGRect?
            if let custom = question.custom {
                y += M.rowGap + M.customMarginTop
                customLabel = CGRect(x: x, y: y, width: contentWidth, height: custom.label.height(fitting: contentWidth))
                y = customLabel!.maxY + M.customGap
                let textHeight = custom.text.height(fitting: max(0, contentWidth - 2 * M.inputPaddingH))
                inputFrame = CGRect(x: x, y: y, width: contentWidth, height: max(M.inputMinHeight, textHeight + 2 * M.inputPaddingV))
                y = inputFrame!.maxY
            }
            placed.append(PlacedQuestion(
                chip: chip, chipText: CGRect(x: chip.minX + M.chipPaddingH, y: chip.minY + M.chipPaddingV, width: chipText.width, height: chipText.height),
                dot: dot, text: text, hint: hint, options: options, customLabel: customLabel, input: inputFrame
            ))
        }
        questions = placed
        if let errorContent = input.error {
            y += M.questionGap
            error = CGRect(x: M.contentPadding, y: y, width: contentWidth, height: errorContent.height(fitting: contentWidth))
            y = error!.maxY
        } else {
            error = nil
        }
        contentSize = CGSize(width: width, height: y + input.safeArea.bottom + M.contentBottomExtra)
    }
}

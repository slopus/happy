import Foundation

/// One set of choices in a conversation, the `ChoiceList`: an inline
/// `<menu>`'s buttons or one prompt of an agent's question, on the reply's
/// column. Options stack 8 apart across the column, at least 44 tall: a
/// button's label centred, a checkbox's beside its box; a submit sits 12
/// under the checkboxes. Nothing changes size when one is chosen.
public struct ChoiceListLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 44, gap: CGFloat = 8, paddingH: CGFloat = 16, paddingV: CGFloat = 10, radius: CGFloat = 12
        public static let box: CGFloat = 20, boxGap: CGFloat = 10, submitGap: CGFloat = 12
    }

    /// `checks`: checkboxes rather than buttons.
    public struct Input {
        public var prompt: Measurable?, options: [Measurable], checks: Bool, submit: Measurable?

        public init(prompt: Measurable?, options: [Measurable], checks: Bool, submit: Measurable?) {
            (self.prompt, self.options, self.checks, self.submit) = (prompt, options, checks, submit)
        }
    }

    public struct Control: Equatable, Sendable { public var frame: CGRect, label: CGRect, box: CGRect? }

    public var size: CGSize, prompt: CGRect?, options: [Control] = [], submit: Control?

    public init(width: CGFloat, input: Input) {
        typealias M = Metrics
        var y: CGFloat = 0
        func control(_ label: Measurable, box: Bool) -> Control {
            let lead = box ? M.box + M.boxGap : M.paddingH
            let text = label.size(fitting: max(0, width - lead - M.paddingH))
            let frame = CGRect(x: 0, y: y, width: width, height: max(M.height, text.height + 2 * M.paddingV))
            let x = box ? lead : ((width - text.width) / 2).rounded()
            let label = CGRect(x: x, y: y + ((frame.height - text.height) / 2).rounded(), width: text.width, height: text.height)
            y = frame.maxY + M.gap
            return Control(frame: frame, label: label, box: box ? CGRect(x: 0, y: label.minY + 2, width: M.box, height: M.box) : nil)
        }
        if let measurable = input.prompt {
            let text = measurable.size(fitting: width)
            prompt = CGRect(origin: .zero, size: text)
            y = text.height + M.gap
        }
        options = input.options.map { control($0, box: input.checks) }
        if let label = input.submit {
            y += M.submitGap - M.gap
            submit = control(label, box: false)
        }
        size = CGSize(width: width, height: max(0, y - M.gap))
    }
}

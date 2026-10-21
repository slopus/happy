#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// The steps at the top of app/(app)/troubleshoot.tsx, in the order of
/// likelihood: asleep, Happy Desktop closed, terminal daemon stopped.
public final class TroubleshootGuideView: UIView {
    @MainActor
    struct Step {
        /// troubleshoot.tsx: a 22pt Ionicon centred in a 26 x 22 box.
        let icon = IconView(size: 22)
        let title = StyledLabel(style: TextStyles.checklistTitle, color: Palette.text)
        let body = StyledLabel(style: TextStyles.checklistBody, color: Palette.textSecondary)
        let terminal: TerminalBlockView?
    }

    public var onOpenWebsite: (() -> Void)?

    let heading = StyledLabel(style: TextStyles.emptyStateTitle, color: Palette.text)
    let intro = StyledLabel(style: TextStyles.checklistBody, color: Palette.textSecondary)
    let steps: [Step]

    public override init(frame: CGRect) {
        steps = [
            Step(terminal: nil),
            Step(terminal: nil),
            Step(terminal: TerminalBlockView(lines: [
                .comment(Strings.Troubleshoot.terminalComment),
                .command(Strings.Onboarding.terminalInstall),
                .command(Strings.Onboarding.terminalRun),
            ])),
        ]
        super.init(frame: frame)
        heading.string = Strings.Troubleshoot.heading
        heading.accessibilityTraits = .header
        intro.string = Strings.Troubleshoot.intro
        addSubview(heading)
        addSubview(intro)
        let content: [(icon: Icon, title: String, body: String)] = [
            (.ionicons("moon-outline"), Strings.Troubleshoot.awakeStep, Strings.Troubleshoot.awakeBody),
            (.ionicons("desktop-outline"), Strings.Troubleshoot.desktopStep,
             Strings.Troubleshoot.desktopBodyPrefix + Strings.Troubleshoot.desktopBodyLink + Strings.Troubleshoot.desktopBodySuffix),
            (.ionicons("terminal-outline"), Strings.Troubleshoot.terminalStep, Strings.Troubleshoot.terminalBody),
        ]
        for (step, content) in zip(steps, content) {
            step.icon.icon = content.icon
            step.icon.tintColor = UIColor(Palette.textSecondary)
            step.title.string = content.title
            step.body.string = content.body
            addSubview(step.icon)
            addSubview(step.title)
            addSubview(step.body)
            if let terminal = step.terminal { addSubview(terminal) }
        }
        steps[1].body.decoration = { text in
            let range = (text.string as NSString).range(of: Strings.Troubleshoot.desktopBodyLink)
            guard range.location != NSNotFound else { return }
            text.addAttributes([
                .underlineStyle: NSUnderlineStyle.single.rawValue,
                .foregroundColor: UIColor(Palette.text),
            ], range: range)
        }
        steps[1].body.isUserInteractionEnabled = true
        steps[1].body.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(openWebsite)))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> TroubleshootGuideLayout {
        TroubleshootGuideLayout(
            width: width,
            heading: heading.measurable,
            intro: intro.measurable,
            steps: steps.map { .init(title: $0.title.measurable, body: $0.body.measurable, terminal: $0.terminal?.measurable) }
        )
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        heading.setLayoutFrame(layout.heading)
        intro.setLayoutFrame(layout.intro)
        for (step, frames) in zip(steps, layout.steps) {
            step.icon.setLayoutFrame(frames.icon)
            step.title.setLayoutFrame(frames.title)
            step.body.setLayoutFrame(frames.body)
            if let frame = frames.terminal { step.terminal?.setLayoutFrame(frame) }
        }
    }

    @objc private func openWebsite() {
        onOpenWebsite?()
    }
}

/// Copy AI prompt and its hint, at the bottom of the troubleshoot screen.
public final class CopyPromptView: UIView {
    public let button = RoundButton(title: Strings.Troubleshoot.copyAiPrompt, size: .normal, display: .inverted)
    let hint = StyledLabel(style: TextStyles.promptHint, color: Palette.textSecondary, alignment: .center)

    public override init(frame: CGRect) {
        super.init(frame: frame)
        hint.string = Strings.Troubleshoot.copyAiPromptHint
        addSubview(button)
        addSubview(hint)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> CopyPromptLayout {
        CopyPromptLayout(width: width, button: button.measurable, hint: hint.measurable)
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        button.setLayoutFrame(layout.button)
        hint.setLayoutFrame(layout.hint)
    }
}
#endif

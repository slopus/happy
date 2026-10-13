#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

// The bars between the conversation and the composer that aren't the
// question banner: InactiveArchivedHint and AgentGoalBar above it,
// RigActivityBar below.

/// The dock: the bars above the composer, then the composer. Anything in
/// it that reaches past its bounds, as the composer's suggestion list
/// rising above it does, still takes its own touches; everywhere else
/// above the dock the conversation does.
final class ChatDockView: UIView {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        if super.point(inside: point, with: event) { return true }
        return subviews.contains { view in
            !view.isHidden && view.alpha > 0.01 && view.isUserInteractionEnabled
                && view.point(inside: convert(point, to: view), with: event)
        }
    }
}

/// InactiveArchivedHint: "This session is inactive.", then Resume (a
/// spinner while it runs), or "To resume it from the terminal:" and the
/// commands, which a tap copies; their glyph ticks for two seconds.
final class ChatInactiveHintView: UIView {
    var onResume: (() -> Void)?

    private(set) var hint: InactiveSessionHint?
    private var resuming = false
    private var copied = false
    private var copiedReset: Task<Void, Never>?
    private let notice = ChatLabel(MeasuredText(ChatTextStyles.inactiveHint.string(Strings.Chat.inactiveArchived, color: Palette.agentEventText)))
    private let terminalNotice = ChatLabel(MeasuredText(ChatTextStyles.inactiveHint.string(Strings.Chat.resumeFromTerminal, color: Palette.agentEventText)))
    private let button = ChatHintCard(fill: Palette.surfaceHigh)
    private let buttonLabel = ChatLabel(MeasuredText(
        ChatTextStyles.resumeButton.string(Strings.SessionDetail.resumeSession, color: Palette.text, lineBreakMode: .byTruncatingTail),
        maxLines: 1
    ))
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let command = ChatHintCard(fill: Palette.surface)
    private let commandText = ChatLabel(MeasuredText(NSAttributedString()))
    private let commandIcon = UIImageView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        for label in [notice, terminalNotice] {
            label.view.isAccessibilityElement = true
            label.view.accessibilityTraits = .staticText
            label.view.accessibilityLabel = label.text.string.string
            addSubview(label.view)
        }
        spinner.color = UIColor(Palette.text)
        spinner.hidesWhenStopped = true
        for view in [buttonLabel.view, spinner] {
            view.isUserInteractionEnabled = false
            button.addSubview(view)
        }
        button.accessibilityLabel = Strings.SessionDetail.resumeSession
        button.addAction(UIAction { [weak self] _ in self?.onResume?() }, for: .touchUpInside)
        addSubview(button)
        commandIcon.contentMode = .center
        for view in [commandText.view, commandIcon] {
            view.isUserInteractionEnabled = false
            command.addSubview(view)
        }
        command.addAction(UIAction { [weak self] _ in self?.copyCommand() }, for: .touchUpInside)
        addSubview(command)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func show(_ hint: InactiveSessionHint, resuming: Bool) {
        guard hint != self.hint || resuming != self.resuming else { return }
        if hint != self.hint {
            copied = false
            copiedReset?.cancel()
            if case .command(let lines) = hint.action {
                commandText.update(MeasuredText(ChatTextStyles.resumeCommand.string(lines.joined(separator: "\n"), color: Palette.text)))
                command.accessibilityLabel = lines.joined(separator: ", ")
            }
        }
        self.hint = hint
        self.resuming = resuming
        let isCommand = hint.copyText != nil
        terminalNotice.view.isHidden = !isCommand
        command.isHidden = !isCommand
        button.isHidden = hint.action != .resume
        button.isEnabled = !resuming
        button.alpha = resuming ? InactiveHintLayout.Metrics.resumingOpacity : 1
        buttonLabel.view.isHidden = resuming
        if resuming { spinner.startAnimating() } else { spinner.stopAnimating() }
        updateIcon()
        accessibilityElements = [notice.view] + (isCommand ? [terminalNotice.view, command] : []) + (button.isHidden ? [] : [button])
        setNeedsLayout()
    }

    var barMeasurable: Measurable {
        Measurable { [self] width in layout(width).size }
    }

    private func layout(_ width: CGFloat) -> InactiveHintLayout {
        let action: InactiveHintLayout.Action = switch hint?.action {
        case .resume?: .resume(label: buttonLabel.measurable)
        case .command?: .command(commandText.measurable)
        default: .none
        }
        return InactiveHintLayout(
            width: width,
            notice: notice.measurable,
            terminalNotice: terminalNotice.view.isHidden ? nil : terminalNotice.measurable,
            action: action
        )
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(bounds.width)
        notice.place(layout.notice)
        if let frame = layout.terminalNotice { terminalNotice.place(frame) }
        if let frame = layout.button {
            button.setLayoutFrame(frame)
            if let label = layout.buttonLabel { buttonLabel.place(label.offsetBy(dx: -frame.minX, dy: -frame.minY)) }
            spinner.center = CGPoint(x: frame.width / 2, y: frame.height / 2)
        }
        if let frame = layout.command {
            command.setLayoutFrame(frame)
            if let text = layout.commandText { commandText.place(text.offsetBy(dx: -frame.minX, dy: -frame.minY)) }
            if let icon = layout.commandIcon { commandIcon.setLayoutFrame(icon.offsetBy(dx: -frame.minX, dy: -frame.minY)) }
        }
    }

    private func copyCommand() {
        guard let text = hint?.copyText else { return }
        UIPasteboard.general.string = text
        copied = true
        updateIcon()
        copiedReset?.cancel()
        copiedReset = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self else { return }
            self.copied = false
            self.updateIcon()
        }
    }

    private func updateIcon() {
        commandIcon.image = .icon(.ionicons(copied ? "checkmark" : "copy-outline"), size: InactiveHintLayout.Metrics.iconSize)
        commandIcon.tintColor = UIColor(copied ? SecondaryPalette.copied : Palette.textSecondary)
    }
}

/// The hint's Resume button and command block: `fill`, surfacePressed
/// while held, a hairline divider rim, 18 round.
private final class ChatHintCard: UIControl {
    private let fill: ColorToken

    init(fill: ColorToken) {
        self.fill = fill
        super.init(frame: .zero)
        layer.cornerRadius = InactiveHintLayout.Metrics.radius
        layer.cornerCurve = .continuous
        isAccessibilityElement = true
        accessibilityTraits = .button
        updateColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.updateColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var isHighlighted: Bool {
        didSet { updateColors() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.borderWidth = hairline
    }

    private func updateColors() {
        backgroundColor = UIColor(isHighlighted ? Palette.surfacePressed : fill)
        layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
    }
}

/// AgentGoalBar.tsx: the goal the agent is working towards, with the
/// actions the agent allows. A button whose action is on its way shows a
/// spinner and can't be pressed again.
final class ChatGoalBarView: UIView {
    var onAction: ((SessionGoalAction) -> Void)?

    private(set) var goal: VisibleAgentGoal?
    private var inFlight: SessionGoalAction?
    private let card = UIView()
    private let icon = UIImageView(image: .icon(.ionicons("locate-outline"), size: GoalBarLayout.Metrics.iconSize))
    private let label = ChatLabel(MeasuredText(ChatTextStyles.goalLabel.string(Strings.AgentGoal.currentGoal, color: Palette.textSecondary, lineBreakMode: .byTruncatingTail), maxLines: 1))
    private let text = ChatLabel(MeasuredText(NSAttributedString()))
    private var buttons: [ChatGoalActionButton] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        card.backgroundColor = UIColor(Palette.surfaceHigh)
        card.layer.cornerRadius = GoalBarLayout.Metrics.radius
        card.layer.cornerCurve = .continuous
        card.layer.borderWidth = GoalBarLayout.Metrics.border
        addSubview(card)
        icon.contentMode = .center
        icon.tintColor = UIColor(Palette.textSecondary)
        for view in [icon, label.view, text.view] { addSubview(view) }
        updateBorder()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.updateBorder()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func show(_ goal: VisibleAgentGoal, inFlight: SessionGoalAction?) {
        guard goal != self.goal || inFlight != self.inFlight else { return }
        if goal.text != self.goal?.text {
            text.update(MeasuredText(ChatTextStyles.goalText.string(goal.text, color: Palette.text, lineBreakMode: .byTruncatingTail), maxLines: 1))
        }
        if goal.actions != self.goal?.actions {
            for button in buttons { button.removeFromSuperview() }
            buttons = goal.actions.map { action in
                let button = ChatGoalActionButton(action)
                button.addAction(UIAction { [weak self] _ in self?.onAction?(action) }, for: .touchUpInside)
                addSubview(button)
                return button
            }
        }
        self.goal = goal
        self.inFlight = inFlight
        for button in buttons { button.busy = button.action == inFlight }
        isAccessibilityElement = false
        card.isAccessibilityElement = true
        card.accessibilityLabel = Strings.AgentGoal.accessibilityLabel(goal.text)
        accessibilityElements = [card] + buttons
        setNeedsLayout()
    }

    /// The bar's height at a width, for the dock.
    var barMeasurable: Measurable {
        Measurable { [self] width in
            GoalBarLayout(width: width, label: label.measurable, text: text.measurable, actionCount: buttons.count).size
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = GoalBarLayout(width: bounds.width, label: label.measurable, text: text.measurable, actionCount: buttons.count)
        card.setLayoutFrame(layout.card)
        icon.setLayoutFrame(layout.icon)
        label.place(layout.label)
        text.place(layout.text)
        for (button, frame) in zip(buttons, layout.actions) { button.setLayoutFrame(frame) }
    }

    private func updateBorder() {
        card.layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
    }
}

/// One of the goal bar's 30 pt round buttons (hitSlop 8).
final class ChatGoalActionButton: UIControl {
    let action: SessionGoalAction
    private let icon = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .medium)

    var busy = false {
        didSet {
            guard busy != oldValue else { return }
            isEnabled = !busy
            alpha = busy ? 0.6 : 1
            icon.isHidden = busy
            if busy { spinner.startAnimating() } else { spinner.stopAnimating() }
        }
    }

    init(_ action: SessionGoalAction) {
        self.action = action
        super.init(frame: .zero)
        let name = switch action {
        case .edit: "create-outline"
        case .stop: "pause-outline"
        case .clear: "trash-outline"
        }
        icon.image = .icon(.ionicons(name), size: GoalBarLayout.Metrics.actionIconSize)
        icon.tintColor = UIColor(Palette.buttonSecondaryTint)
        icon.contentMode = .center
        spinner.color = UIColor(Palette.textSecondary)
        spinner.hidesWhenStopped = true
        addSubview(icon)
        addSubview(spinner)
        layer.cornerRadius = GoalBarLayout.Metrics.actionSize / 2
        accessibilityLabel = Strings.AgentGoal.action(action)
        accessibilityTraits = .button
        isAccessibilityElement = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        icon.frame = bounds
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -8, dy: -8).contains(point)
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(Palette.surfacePressed) : .clear }
    }
}

/// RigActivityBar.tsx: "2 agents · 1 processes", each with its glyph,
/// wrapping onto more lines when it must. Full width, under the other bars.
final class ChatRigActivityView: UIView {
    private(set) var indicators: [RigActivityIndicator] = []
    private var icons: [UIImageView] = []
    private var labels: [ChatLabel] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = true
        accessibilityTraits = .staticText
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func show(_ indicators: [RigActivityIndicator]) {
        guard indicators != self.indicators else { return }
        self.indicators = indicators
        for view in icons { view.removeFromSuperview() }
        for label in labels { label.view.removeFromSuperview() }
        icons = indicators.map { indicator in
            let name = switch indicator.kind {
            case .subagents: "people-outline"
            case .workflows: "git-network-outline"
            case .processes: "terminal-outline"
            case .tasks: "checkbox-outline"
            }
            let view = UIImageView(image: .icon(.ionicons(name), size: RigActivityLayout.Metrics.iconSize))
            view.contentMode = .center
            view.tintColor = UIColor(Palette.textSecondary)
            addSubview(view)
            return view
        }
        labels = indicators.map { indicator in
            let label = ChatLabel(MeasuredText(ChatTextStyles.rigActivity.string(Strings.Chat.rigActivity(indicator), color: Palette.textSecondary), maxLines: 1))
            addSubview(label.view)
            return label
        }
        accessibilityLabel = indicators.map(Strings.Chat.rigActivity).joined(separator: ", ")
        setNeedsLayout()
    }

    var barMeasurable: Measurable {
        Measurable { [self] width in RigActivityLayout(width: width, labels: labels.map(\.measurable)).size }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = RigActivityLayout(width: bounds.width, labels: labels.map(\.measurable))
        for (view, frame) in zip(icons, layout.icons) { view.setLayoutFrame(frame) }
        for (label, frame) in zip(labels, layout.labels) { label.place(frame) }
    }
}
#endif

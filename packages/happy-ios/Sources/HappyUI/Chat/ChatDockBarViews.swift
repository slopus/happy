#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

// The bars between the conversation and the composer that aren't the
// question banner: AgentGoalBar above it, RigActivityBar below.

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

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
/// commands, which a tap copies; their glyph ticks for two seconds. Its
/// text follows the text size, laid out off the main thread
/// (`ChatDockBarMeasure.inactiveHint`) at the width the dock offers; until
/// its plan is in it has no height. Resume keeps RN's 44, which taller
/// text spills out of, and the commands their 48 at least.
final class ChatInactiveHintView: UIView {
    var onResume: (() -> Void)?
    /// Its plan came in: the dock is laid out again with its height.
    var onNeedsLayout: (() -> Void)?

    private(set) var hint: InactiveSessionHint?
    private var resuming = false
    private var copied = false
    private var copiedReset: Task<Void, Never>?
    private var model: ChatInactiveHintModel?
    let measure = OffMainPlan<ChatDockBarInput<ChatInactiveHintModel>, ChatInactiveHintPlan> { ChatDockBarMeasure.inactiveHint($0) }
    private let notice = ChatTextView()
    private let terminalNotice = ChatTextView()
    private let button = ChatHintCard(fill: Palette.surfaceHigh)
    private let buttonLabel = ChatTextView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let command = ChatHintCard(fill: Palette.surface)
    private let commandText = ChatTextView()
    private let commandIcon = UIImageView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        for label in [notice, terminalNotice] { addSubview(label) }
        spinner.color = UIColor(Palette.text)
        spinner.hidesWhenStopped = true
        buttonLabel.isAccessibilityElement = false
        for view in [buttonLabel, spinner] {
            view.isUserInteractionEnabled = false
            button.addSubview(view)
        }
        button.accessibilityLabel = Strings.SessionDetail.resumeSession
        button.addAction(UIAction { [weak self] _ in self?.onResume?() }, for: .touchUpInside)
        addSubview(button)
        commandIcon.contentMode = .center
        commandText.isAccessibilityElement = false
        for view in [commandText, commandIcon] {
            view.isUserInteractionEnabled = false
            command.addSubview(view)
        }
        command.addAction(UIAction { [weak self] _ in self?.copyCommand() }, for: .touchUpInside)
        addSubview(command)
        measure.onApply = { [weak self] in
            self?.setNeedsLayout()
            self?.onNeedsLayout?()
        }
        // A new size is measured when the dock next asks for its height.
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.setNeedsLayoutUpTheTree()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Gone, it forgets its plan, so it comes back with nothing old in it.
    override var isHidden: Bool {
        didSet { if isHidden { measure.reset() } }
    }

    func show(_ hint: InactiveSessionHint, resuming: Bool) {
        guard hint != self.hint || resuming != self.resuming else { return }
        if hint != self.hint {
            copied = false
            copiedReset?.cancel()
            if case .command(let lines) = hint.action {
                command.accessibilityLabel = lines.joined(separator: ", ")
            }
        }
        self.hint = hint
        self.resuming = resuming
        let isCommand = hint.copyText != nil
        let action: ChatInactiveHintModel.Action = switch hint.action {
        case .resume: .resume(Strings.SessionDetail.resumeSession)
        case .command(let lines): .command(lines.joined(separator: "\n"))
        case .noticeOnly: .none
        }
        model = ChatInactiveHintModel(notice: Strings.Chat.inactiveArchived, terminalNotice: isCommand ? Strings.Chat.resumeFromTerminal : nil, action: action)
        button.isEnabled = !resuming
        button.alpha = resuming ? InactiveHintLayout.Metrics.resumingOpacity : 1
        buttonLabel.isHidden = resuming
        if resuming { spinner.startAnimating() } else { spinner.stopAnimating() }
        updateIcon()
        setNeedsLayout()
    }

    /// The hint's height at a width, for the dock: its plan's, asked for
    /// at that width; the last one's until that is in, or none.
    var barMeasurable: Measurable {
        Measurable { [self] width in
            guard let model else { return .zero }
            measure.request(ChatDockBarInput(model: model, width: width, text: traitCollection.measuredTextEnvironment))
            return measure.plan?.layout.size ?? .zero
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let plan = measure.plan
        let layout = plan?.layout
        notice.isHidden = plan == nil
        if let plan, let layout {
            notice.setLayoutFrame(layout.notice)
            notice.layout = plan.notice
        }
        terminalNotice.isHidden = plan?.terminalNotice == nil
        if let frame = layout?.terminalNotice, let text = plan?.terminalNotice {
            terminalNotice.setLayoutFrame(frame)
            terminalNotice.layout = text
        }
        button.isHidden = layout?.button == nil
        if let frame = layout?.button {
            button.setLayoutFrame(frame)
            if let label = layout?.buttonLabel, let text = plan?.buttonLabel {
                buttonLabel.setLayoutFrame(label.offsetBy(dx: -frame.minX, dy: -frame.minY))
                buttonLabel.layout = text
            }
            spinner.center = CGPoint(x: frame.width / 2, y: frame.height / 2)
        }
        command.isHidden = layout?.command == nil
        if let frame = layout?.command {
            command.setLayoutFrame(frame)
            if let rect = layout?.commandText, let text = plan?.command {
                commandText.setLayoutFrame(rect.offsetBy(dx: -frame.minX, dy: -frame.minY))
                commandText.layout = text
            }
            if let icon = layout?.commandIcon { commandIcon.setLayoutFrame(icon.offsetBy(dx: -frame.minX, dy: -frame.minY)) }
        }
        accessibilityElements = [notice, terminalNotice, command, button].filter { !$0.isHidden }
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
/// spinner and can't be pressed again. Its text follows the text size,
/// laid out off the main thread (`ChatDockBarMeasure.goalBar`) at the width
/// the dock offers; until its plan is in it has no height. The glyph and
/// the 30 pt buttons keep their size.
final class ChatGoalBarView: UIView {
    var onAction: ((SessionGoalAction) -> Void)?
    /// Its plan came in: the dock is laid out again with its height.
    var onNeedsLayout: (() -> Void)?

    private(set) var goal: VisibleAgentGoal?
    private var inFlight: SessionGoalAction?
    private var model: ChatGoalBarModel?
    let measure = OffMainPlan<ChatDockBarInput<ChatGoalBarModel>, ChatGoalBarPlan> { ChatDockBarMeasure.goalBar($0) }
    private let card = UIView()
    private let icon = UIImageView(image: .icon(.ionicons("locate-outline"), size: GoalBarLayout.Metrics.iconSize))
    private let label = ChatTextView()
    private let text = ChatTextView()
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
        for view in [label, text] { view.isAccessibilityElement = false }
        for view in [icon, label, text] { addSubview(view) }
        updateBorder()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.updateBorder()
        }
        measure.onApply = { [weak self] in
            self?.setNeedsLayout()
            self?.onNeedsLayout?()
        }
        // A new size is measured when the dock next asks for its height.
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.setNeedsLayoutUpTheTree()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Gone, it forgets its plan, so it comes back with nothing old in it.
    override var isHidden: Bool {
        didSet { if isHidden { measure.reset() } }
    }

    func show(_ goal: VisibleAgentGoal, inFlight: SessionGoalAction?) {
        guard goal != self.goal || inFlight != self.inFlight else { return }
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
        model = ChatGoalBarModel(label: Strings.AgentGoal.currentGoal, text: goal.text, actionCount: buttons.count)
        for button in buttons { button.busy = button.action == inFlight }
        isAccessibilityElement = false
        card.isAccessibilityElement = true
        card.accessibilityLabel = Strings.AgentGoal.accessibilityLabel(goal.text)
        accessibilityElements = [card] + buttons
        setNeedsLayout()
    }

    /// The bar's height at a width, for the dock: its plan's, asked for at
    /// that width; the last one's until that is in, or none.
    var barMeasurable: Measurable {
        Measurable { [self] width in
            guard let model else { return .zero }
            measure.request(ChatDockBarInput(model: model, width: width, text: traitCollection.measuredTextEnvironment))
            return measure.plan?.layout.size ?? .zero
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let plan = measure.plan
        for view in [card, icon, label, text] { view.isHidden = plan == nil }
        guard let plan else { return }
        let layout = plan.layout
        card.setLayoutFrame(layout.card)
        icon.setLayoutFrame(layout.icon)
        label.setLayoutFrame(layout.label)
        label.layout = plan.label
        text.setLayoutFrame(layout.text)
        text.layout = plan.text
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
/// Its counts follow the text size, laid out off the main thread
/// (`ChatDockBarMeasure.rigActivity`) at the width the dock offers; until
/// its plan is in it has no height. The 12 pt glyphs keep their size.
final class ChatRigActivityView: UIView {
    /// Its plan came in: the dock is laid out again with its height.
    var onNeedsLayout: (() -> Void)?

    private(set) var indicators: [RigActivityIndicator] = []
    private var model: ChatRigActivityModel?
    let measure = OffMainPlan<ChatDockBarInput<ChatRigActivityModel>, ChatRigActivityPlan> { ChatDockBarMeasure.rigActivity($0) }
    private var icons: [UIImageView] = []
    private var labels: [ChatTextView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = true
        accessibilityTraits = .staticText
        measure.onApply = { [weak self] in
            self?.setNeedsLayout()
            self?.onNeedsLayout?()
        }
        // A new size is measured when the dock next asks for its height.
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.setNeedsLayoutUpTheTree()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Gone, it forgets its plan, so it comes back with nothing old in it.
    override var isHidden: Bool {
        didSet { if isHidden { measure.reset() } }
    }

    func show(_ indicators: [RigActivityIndicator]) {
        guard indicators != self.indicators else { return }
        self.indicators = indicators
        for view in icons { view.removeFromSuperview() }
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
        let words = indicators.map(Strings.Chat.rigActivity)
        model = ChatRigActivityModel(labels: words)
        accessibilityLabel = words.joined(separator: ", ")
        setNeedsLayout()
    }

    var barMeasurable: Measurable {
        Measurable { [self] width in
            guard let model else { return .zero }
            measure.request(ChatDockBarInput(model: model, width: width, text: traitCollection.measuredTextEnvironment))
            return measure.plan?.layout.size ?? .zero
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let plan = measure.plan
        while labels.count < plan?.labels.count ?? 0 {
            let label = ChatTextView()
            label.isAccessibilityElement = false
            addSubview(label)
            labels.append(label)
        }
        let placed = plan?.layout.icons ?? []
        for (index, view) in icons.enumerated() {
            view.isHidden = index >= placed.count
            if index < placed.count { view.setLayoutFrame(placed[index]) }
        }
        for (index, label) in labels.enumerated() {
            guard let plan, index < plan.labels.count, index < plan.layout.labels.count else {
                label.isHidden = true
                continue
            }
            label.isHidden = false
            label.setLayoutFrame(plan.layout.labels[index])
            label.layout = plan.labels[index]
        }
    }
}
#endif

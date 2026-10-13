#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import HappyStore
import UIKit

/// Home's dock (HomeDock.tsx with MainView.tsx's `handleHomePromptSubmit`):
/// the resting capsule, the composer it opens, and the start they share.
///
/// The prompt is home's own and lives while home does; the pickers write
/// the account's new-session draft, which outlives it. A start runs
/// through `SessionStarter`; the composer stays open, reporting each step,
/// until the session is open, and Stop gives it back at once.
@MainActor
final class HomeDockController: NSObject {
    let restingView: HomeDockView
    let composer: NewSessionComposer
    let starter: SessionStarter
    private(set) var prompt = ""
    private weak var host: UIViewController?
    private let context: AppContext
    private weak var focus: HomeDockFocusViewController?

    init(restingView: HomeDockView, host: UIViewController, context: AppContext, session: AccountSession, snapshot: HomeSnapshot) {
        self.restingView = restingView
        self.host = host
        self.context = context
        composer = NewSessionComposer(
            drafts: NewSessionDraftStore.shared(for: context.account.localSettings),
            snapshot: snapshot,
            ops: session.homeOps
        )
        let sync = session.sync
        starter = SessionStarter(environment: .init(
            ops: session.homeOps,
            sessionOps: session.homeSessionOps,
            sender: session.sender,
            metadataTransport: session.realtime,
            refreshSessions: { await sync.run(.sessions) }
        ))
        super.init()
        starter.presenter = self
        starter.onPhaseChange = { [weak self] _ in self?.render() }
        composer.onChange = { [weak self] in self?.render() }
        restingView.entryButton.addAction(UIAction { [weak self] _ in self?.openFocus() }, for: .touchUpInside)
        restingView.sendButton.addAction(UIAction { [weak self] _ in
            Task { await self?.submit() }
        }, for: .touchUpInside)
        render()
    }

    func update(_ snapshot: HomeSnapshot) {
        composer.update(snapshot: snapshot)
    }

    /// Home shows the dock: false on Link Your Computer.
    var isAvailable = false {
        didSet {
            guard isAvailable != oldValue else { return }
            if !isAvailable { focus?.close() }
            updateVisibility()
        }
    }

    private func updateVisibility() {
        // The capsule is replaced rather than covered while the composer is
        // open: the composer sits higher, and the capsule's button showed
        // below it.
        restingView.isHidden = !isAvailable || focus != nil
    }

    var canSubmit: Bool {
        !starter.isStarting && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func setPrompt(_ prompt: String) {
        guard prompt != self.prompt else { return }
        self.prompt = prompt
        render()
    }

    private func render() {
        restingView.prompt = prompt
        restingView.sendButton.appearance = starter.isStarting ? .busy : canSubmit ? .send : .idle
        focus?.render()
    }

    // MARK: Focus

    /// Opens the composer; false when it can't be (`requestHomeDockFocus`).
    @discardableResult
    func openFocus() -> Bool {
        guard let host, host.view.window != nil else { return false }
        if focus != nil { return true }
        guard isAvailable, host.presentedViewController == nil else { return false }
        let focus = HomeDockFocusViewController(dock: self)
        self.focus = focus
        updateVisibility()
        host.present(focus, animated: false)
        return true
    }

    func focusDidClose() {
        focus = nil
        updateVisibility()
        render()
    }

    /// ProjectRow's `+` (ProjectHomeList.tsx `createWorkspace`): the draft
    /// moves to the project, asking for a new workspace, and the composer
    /// opens on it.
    func createWorkspace(_ origin: WorkspaceOrigin) -> Bool {
        let drafts = composer.drafts
        drafts.setMachineId(origin.machineId)
        if let projectId = origin.projectId {
            // A catalog project is an identity: a worktree's directory
            // says nothing about where it lives.
            drafts.pickAgentType(.rig)
            drafts.setProjectId(projectId)
        } else {
            drafts.setPath(origin.path)
        }
        drafts.setSessionType(.worktree)
        drafts.setWorktreeKey(nil)
        return openFocus()
    }

    // MARK: Start

    /// `handleHomePromptSubmit`: the prompt trimmed into the draft, then
    /// the start. The prompt is cleared once the session is open.
    @discardableResult
    func submit() async -> Bool {
        guard canSubmit else { return false }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let drafts = composer.drafts
        drafts.setInput(text)
        let started = drafts.draft
        let launch: NewSessionLaunch
        switch composer.launch(prompt: text, attachments: []) {
        case .success(let resolved):
            launch = resolved
        case .failure(let refusal):
            showStartError(refusal.errorDescription ?? SessionStarter.Message.startFailed)
            return false
        }
        render()
        let composer = composer
        guard let sessionId = await starter.start(launch, isCurrentTarget: { composer.isCurrentTarget(started) }) else {
            render()
            return false
        }
        // Only what was sent is cleared: edits made while it ran stay.
        if drafts.draft.input == started.input { drafts.setInput("") }
        prompt = ""
        render()
        host?.push(.session(id: sessionId), context: context)
        return true
    }

    /// Stop: the composer back now, the session put down unwatched.
    func cancelStart() {
        starter.cancel()
        render()
    }

    private var presenterController: UIViewController? {
        focus ?? host
    }
}

extension HomeDockController: SessionStarterPresenter {
    func showStartError(_ message: String) {
        guard let controller = presenterController else { return }
        Alerts.show(Strings.Common.error, message, on: controller)
    }

    func confirmDirectoryCreation(_ directory: String) async -> Bool {
        guard let controller = presenterController else { return false }
        return await Alerts.confirm(
            Strings.Home.createDirectoryTitle,
            Strings.Home.createDirectoryMessage(directory),
            confirmTitle: Strings.Home.create,
            on: controller
        )
    }
}

/// The open composer (HomeDock.tsx's focus mode): a modal over home that
/// blurs and dims the list, stacks the machine, project, worktree and
/// harness pickers over the composer card, and rides on the keyboard.
///
/// Every frame comes from `HomeDockFocusLayout`, every opening and closing
/// value from `HomeDockFocusMotion`, driven frame by frame. The pickers
/// and the composer sit in `dock`, a screen-sized box moved onto the
/// keyboard inside the keyboard's own animation, so the motion and the
/// keyboard never fight over a frame.
final class HomeDockFocusViewController: UIViewController {
    private enum Row: Int, CaseIterable {
        case machine
        case project
        case worktree
        case harness
    }

    private weak var controller: HomeDockController?
    private let backdrop = HomeDockBackdropView()
    private let dock = PassthroughView()
    private let rows = Row.allCases.map { _ in HomeDockRowView() }
    private let progressDot = StatusDotView()
    private let progressLabel = StyledLabel(style: TextStyles.homeDockProgress, color: Palette.textSecondary, lines: 1)
    private let progressHint = StyledLabel(style: TextStyles.homeDockProgress, color: Palette.textSecondary, lines: 1)
    private let composerShell = UIView()
    private let composerClip = UIView()
    private let card: AgentInputCardView
    // STOPGAP (card `refusesControls`): until the card refuses its own
    // controls, these cover the text and the controls beside the button.
    private let textBlocker = UIControl()
    private let controlsBlocker = UIControl()
    private let keyboardTracker = UIView()

    private var progress: CGFloat = 0
    private var motion: Motion?
    private var flashStart: CFTimeInterval?
    private var displayLink: CADisplayLink?
    private var closing = false
    private var revertingText = false

    /// One run of the presentation value.
    private struct Motion {
        var from: CGFloat
        var to: CGFloat
        var start: CFTimeInterval
        var duration: Double
        var easing: (Double) -> Double
        var completion: (() -> Void)?
    }

    init(dock controller: HomeDockController) {
        self.controller = controller
        card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: ""))
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        backdrop.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(backdropTapped)))
        view.addSubview(backdrop)
        view.addSubview(dock)

        for (index, row) in rows.enumerated() {
            row.blocker.addAction(UIAction { [weak self, weak row] _ in
                guard let row else { return }
                self?.refuse(shaking: row, keyframes: HomeDockRefusal.shake, step: HomeDockRefusal.shakeStep)
            }, for: .touchUpInside)
            if Row(rawValue: index) == .harness {
                row.trigger.addAction(UIAction { [weak self] _ in self?.openHarnessHelp() }, for: .touchUpInside)
            }
            dock.addSubview(row)
        }

        progressDot.backgroundColor = UIColor(Palette.statusConnecting)
        progressDot.isPulsing = true
        progressHint.string = Strings.Home.interruptHint
        for view in [progressDot, progressLabel, progressHint] {
            view.isHidden = true
            dock.addSubview(view)
        }

        composerShell.layer.shadowColor = UIColor(Palette.shadow).cgColor
        dock.addSubview(composerShell)
        composerClip.clipsToBounds = true
        composerClip.layer.cornerCurve = .continuous
        composerShell.addSubview(composerClip)
        card.delegate = self
        // The clip takes the card's own shadow; the shell carries one
        // around however much of it is open.
        composerClip.addSubview(card)
        for blocker in [textBlocker, controlsBlocker] {
            blocker.isHidden = true
            blocker.addAction(UIAction { [weak self] _ in self?.refuseComposer() }, for: .touchUpInside)
            composerClip.addSubview(blocker)
        }

        keyboardTracker.isHidden = true
        keyboardTracker.isUserInteractionEnabled = false
        keyboardTracker.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(keyboardTracker)
        view.keyboardLayoutGuide.followsUndockedKeyboard = false
        NSLayoutConstraint.activate([
            keyboardTracker.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            keyboardTracker.widthAnchor.constraint(equalToConstant: 1),
            keyboardTracker.topAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            keyboardTracker.heightAnchor.constraint(equalToConstant: 1),
        ])

        applyShadow()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyShadow()
            self.applyFlash()
        }
        card.setText(controller?.prompt ?? "", selection: NSRange(location: ((controller?.prompt ?? "") as NSString).length, length: 0))
        render()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard motion == nil, progress == 0, !closing else { return }
        // A frame for the modal to land, then 340ms ease-out.
        animate(to: 1, delay: HomeDockFocusMotion.openDelay, duration: HomeDockFocusMotion.openDuration, easing: HomeDockFocusMotion.easeOut)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(50))
            guard let self, !self.closing else { return }
            self.card.focus()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        displayLink?.invalidate()
        displayLink = nil
    }

    private func applyShadow() {
        let dark = traitCollection.userInterfaceStyle == .dark
        composerShell.layer.shadowOffset = CGSize(width: 0, height: dark ? ComposerShadow.darkOffsetY : ComposerShadow.lightOffsetY)
        composerShell.layer.shadowRadius = dark ? ComposerShadow.darkRadius : ComposerShadow.lightRadius
        composerShell.layer.shadowOpacity = dark ? ComposerShadow.darkOpacity : ComposerShadow.lightOpacity
    }

    // MARK: State

    private var isStarting: Bool {
        controller?.starter.isStarting ?? false
    }

    /// Everything that follows the draft, the store and the start.
    func render() {
        guard isViewLoaded, let controller else { return }
        let choices = controller.composer.choices
        let phase = controller.starter.phase
        let starting = phase != nil

        let values: [Row: String] = [
            .machine: choices.currentMachine?.name ?? Strings.Home.selectMachine,
            .project: choices.currentProject?.name ?? Strings.Home.noProject,
            .worktree: choices.currentWorktree?.name ?? (choices.picksWorkspaces ? Strings.Home.mainWorkspace : Strings.Home.noWorktree),
            .harness: choices.hasAvailableHarness ? choices.currentAgent.name : Strings.Home.harnessHelp,
        ]
        let icons: [Row: String] = [
            .machine: "desktop-outline",
            .project: "folder-outline",
            .worktree: "git-branch-outline",
            .harness: choices.hasAvailableHarness ? "hardware-chip-outline" : "help-circle-outline",
        ]
        for row in Row.allCases {
            let view = rows[row.rawValue]
            view.value = values[row] ?? ""
            view.iconView.icon = .ionicons(icons[row] ?? "")
            view.refusing = starting
            let isHelp = row == .harness && !choices.hasAvailableHarness
            view.isLink = isHelp
            if isHelp {
                view.trigger.menu = nil
                view.trigger.showsMenuAsPrimaryAction = false
                view.trigger.accessibilityLabel = Strings.Home.harnessHelpLabel
                view.trigger.accessibilityTraits = .link
            } else {
                if view.trigger.menu == nil { view.trigger.menu = menu(for: row) }
                view.trigger.showsMenuAsPrimaryAction = true
                view.trigger.accessibilityLabel = "\(title(for: row, choices)): \(view.value)"
                view.trigger.accessibilityTraits = .button
            }
        }

        let label = NewSessionProgress.label(phase: phase, agentName: choices.currentAgent.name, picksWorkspaces: choices.picksWorkspaces)
        let primary = NewSessionProgress.primaryAction(canSubmit: controller.canSubmit, phase: phase, canCancel: true)
        progressLabel.string = label ?? ""
        progressDot.isHidden = label == nil
        progressLabel.isHidden = label == nil
        progressHint.isHidden = label == nil || primary != .stop

        card.configuration = cardConfiguration(choices, primary: primary)
        textBlocker.isHidden = !starting
        controlsBlocker.isHidden = !starting
        view.setNeedsLayout()
    }

    private func title(for row: Row, _ choices: NewSessionChoices) -> String {
        switch row {
        case .machine: Strings.Home.machineTitle
        case .project: Strings.Home.projectTitle
        case .worktree: choices.picksWorkspaces ? Strings.Home.workspaceTitle : Strings.Home.worktreeTitle
        case .harness: Strings.Home.harnessTitle
        }
    }

    /// The card for the draft (`renderFocusedComposer`). The add button
    /// is left out until there is an image picker to open.
    private func cardConfiguration(_ choices: NewSessionChoices, primary: NewSessionPrimaryAction) -> AgentInputCardConfiguration {
        let hasHarness = choices.hasAvailableHarness
        let permission: AgentInputChipConfiguration? = hasHarness && choices.currentPermission != nil
            ? choices.permissionLabel.map { label in
                AgentInputChipConfiguration(
                    content: .label(label),
                    accessibilityLabel: Strings.Composer.permissionModeTitle,
                    menu: AgentInputMenu(
                        sections: [.init(options: choices.permissionOptions.map { .init(key: $0.key, label: $0.name, isDisabled: $0.isDisabled) })],
                        selectedKey: choices.currentPermission?.key
                    )
                )
            }
            : nil
        let modelMenu: AgentInputMenu? = hasHarness && choices.currentModel != nil && !choices.modelOptions.isEmpty
            ? AgentInputMenu(
                sections: choices.modelSections.map { section in
                    .init(
                        title: section.title ?? Strings.Composer.modelTitle,
                        options: section.options.map { .init(key: $0.key, label: $0.name, isDisabled: $0.isDisabled) }
                    )
                },
                selectedKey: choices.currentModel?.key
            )
            : nil
        let model = AgentInputChipConfiguration(content: .label(choices.modelChipLabel), accessibilityLabel: Strings.Composer.modelTitle, menu: modelMenu)
        let effort: AgentInputChipConfiguration? = hasHarness ? choices.currentEffort.map { current in
            AgentInputChipConfiguration(
                content: .label(current.name),
                accessibilityLabel: Strings.Composer.effortTitle,
                menu: AgentInputMenu(
                    sections: [.init(options: choices.effortOptions.map { .init(key: $0.key, label: $0.name, isDisabled: $0.isDisabled) })],
                    selectedKey: current.key
                )
            )
        } : nil
        let action: AgentInputPrimaryAction = switch primary {
        case .send: .send
        case .stop: .stop
        case .busy: .send
        case .idle: .idle
        }
        return AgentInputCardConfiguration(
            placeholder: choices.promptPlaceholder,
            permission: permission,
            model: model,
            effort: effort,
            primaryAction: action,
            isPrimaryBusy: primary == .busy,
            primaryAccessibilityLabel: primary == .stop ? Strings.Composer.stop : Strings.Composer.send
        )
    }

    /// A picker row's native menu, built when it opens so it shows the
    /// draft as it is then. The worktree menu lists git again first.
    private func menu(for row: Row) -> UIMenu {
        UIMenu(children: [
            UIDeferredMenuElement.uncached { [weak self] completion in
                guard let self, let controller = self.controller else { return completion([]) }
                if row == .worktree { controller.composer.refreshWorktrees() }
                completion(self.menuElements(for: row, controller))
            },
        ])
    }

    private func menuElements(for row: Row, _ controller: HomeDockController) -> [UIMenuElement] {
        let composer = controller.composer
        let choices = composer.choices
        let draft = composer.drafts.draft
        func section(_ title: String?, _ options: [NewSessionChoices.Option], selected: String?, select: @escaping (String) -> Void) -> UIMenu {
            UIMenu(title: title ?? "", options: .displayInline, children: options.map { option in
                UIAction(
                    title: option.name,
                    attributes: option.isDisabled ? .disabled : [],
                    state: !option.isAction && option.key == selected ? .on : .off
                ) { _ in select(option.key) }
            })
        }
        switch row {
        case .machine:
            return [section(Strings.Home.machineTitle, choices.machineOptions, selected: draft.selectedMachineId) { composer.selectMachine($0) }]
        case .project:
            let custom = NewSessionChoices.Option(key: NewSessionChoices.customPathKey, name: Strings.Home.enterCustomPath, isAction: true)
            return [
                section(Strings.Home.projectsSection, choices.projectOptions, selected: choices.currentProject?.key) { composer.selectProject($0) },
                section(nil, [custom], selected: nil) { [weak self] _ in self?.askForCustomPath() },
            ]
        case .worktree:
            let title = choices.picksWorkspaces ? Strings.Home.workspaceTitle : Strings.Home.worktreeTitle
            return [section(title, choices.worktreeOptions, selected: choices.worktreeSelection) { composer.selectWorktree($0) }]
        case .harness:
            return [section(Strings.Home.harnessTitle, choices.agentOptions, selected: draft.agentType.rawValue) { composer.selectAgent($0) }]
        }
    }

    /// "Enter custom path", starting from the draft's directory.
    private func askForCustomPath() {
        guard let controller else { return }
        let current = controller.composer.drafts.draft.selectedPath ?? "~"
        let alert = UIAlertController(title: Strings.Home.enterCustomPath, message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = Strings.Home.customPathPlaceholder
            field.text = current
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default) { [weak self, weak alert] _ in
            self?.controller?.composer.selectCustomPath(alert?.textFields?.first?.text)
        })
        present(alert, animated: true)
    }

    /// The harness row with nothing to run: setup help, not a menu.
    private func openHarnessHelp() {
        guard controller?.composer.choices.hasAvailableHarness == false else { return }
        card.blur()
        UIApplication.shared.open(Strings.Home.harnessHelpURL)
    }

    // MARK: Closing and refusing

    /// `resolveHomeDockBackdropPressAction`: a tap outside closes, except
    /// while a session is starting, when Stop is the way out.
    @objc private func backdropTapped() {
        if isStarting {
            refuse()
            return
        }
        close()
    }

    /// The modal's own close (`closeFocusMode`): the keyboard goes, the
    /// presentation runs back in 180ms ease-in, then the modal leaves.
    func close() {
        guard !closing else { return }
        closing = true
        card.blur()
        animate(to: 0, delay: 0, duration: HomeDockFocusMotion.closeDuration, easing: HomeDockFocusMotion.easeIn) { [weak self] in
            guard let self else { return }
            let controller = self.controller
            self.presentingViewController?.dismiss(animated: false) {
                controller?.focusDidClose()
            }
        }
    }

    /// Two beats on the hint and on Stop, and an error tap.
    private func refuse() {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        flashStart = CACurrentMediaTime()
        startDisplayLink()
    }

    private func refuse(shaking view: UIView, keyframes: [CGFloat], step: Double) {
        refuse()
        let animation = CAKeyframeAnimation(keyPath: "transform.translation.x")
        animation.values = [0] + keyframes
        animation.keyTimes = (0...keyframes.count).map { NSNumber(value: Double($0) / Double(keyframes.count)) }
        animation.duration = step * Double(keyframes.count)
        animation.timingFunctions = Array(repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: keyframes.count)
        animation.isAdditive = true
        view.layer.add(animation, forKey: "shake")
    }

    /// STOPGAP (card `refusesControls`): the whole composer shakes, as
    /// Shaker does, rather than only the control pressed.
    private func refuseComposer() {
        refuse()
        AgentInputCardView.shake(composerShell)
    }

    private func applyFlash() {
        let amount = flashStart.map { HomeDockRefusal.flash(at: CACurrentMediaTime() - $0) } ?? 0
        let from = UIColor(Palette.textSecondary).resolvedColor(with: traitCollection)
        let to = UIColor(Palette.text).resolvedColor(with: traitCollection)
        progressHint.textColor = Self.blend(from, to, amount)
        // STOPGAP (card `setPrimaryFlash`): Stop's own swell and wash wait
        // for the card to offer them.
    }

    private static func blend(_ from: UIColor, _ to: UIColor, _ amount: CGFloat) -> UIColor {
        var a = (r: CGFloat(0), g: CGFloat(0), b: CGFloat(0), a: CGFloat(0))
        var b = a
        from.getRed(&a.r, green: &a.g, blue: &a.b, alpha: &a.a)
        to.getRed(&b.r, green: &b.g, blue: &b.b, alpha: &b.a)
        return UIColor(
            red: a.r + (b.r - a.r) * amount,
            green: a.g + (b.g - a.g) * amount,
            blue: a.b + (b.b - a.b) * amount,
            alpha: a.a + (b.a - a.a) * amount
        )
    }

    // MARK: Motion

    private func animate(to target: CGFloat, delay: Double, duration: Double, easing: @escaping (Double) -> Double, completion: (() -> Void)? = nil) {
        motion = Motion(from: progress, to: target, start: CACurrentMediaTime() + delay, duration: duration, easing: easing, completion: completion)
        startDisplayLink()
    }

    private func startDisplayLink() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    @objc private func tick() {
        let now = CACurrentMediaTime()
        var finished: (() -> Void)?
        if let motion {
            let t = max(0, now - motion.start) / motion.duration
            progress = motion.from + (motion.to - motion.from) * CGFloat(motion.easing(t))
            if t >= 1 {
                progress = motion.to
                self.motion = nil
                finished = motion.completion
            }
        }
        if let start = flashStart, now - start >= HomeDockRefusal.flashDuration {
            flashStart = nil
        }
        layoutContent()
        applyFlash()
        if motion == nil && flashStart == nil {
            displayLink?.invalidate()
            displayLink = nil
        }
        finished?()
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = view.bounds.size
        backdrop.frame = view.bounds
        let shift = HomeDockFocusLayout.keyboardShift(keyboardTop: keyboardTracker.frame.minY, size: size, safeBottom: view.safeAreaInsets.bottom)
        dock.frame = CGRect(x: 0, y: shift, width: size.width, height: size.height)
        layoutContent()
    }

    /// The dock's contents at the present progress.
    private func layoutContent() {
        let size = view.bounds.size
        guard size.width > 0 else { return }
        let motion = HomeDockFocusMotion(progress: progress)
        backdrop.alpha = motion.backdropAlpha

        let composerWidth = max(0, size.width - 2 * HomeDockFocusLayout.Metrics.composerPaddingHorizontal)
        let cardLayout = card.layout(width: composerWidth)
        let cardHeight = cardLayout.size.height
        let showsProgress = !progressLabel.isHidden
        let layout = HomeDockFocusLayout(.init(
            size: size,
            safeBottom: view.safeAreaInsets.bottom,
            composerHeight: motion.composerHeight(full: cardHeight),
            rows: rows.map(\.valueLabel.measurable),
            progress: showsProgress ? progressLabel.measurable : nil,
            hint: showsProgress && !progressHint.isHidden ? progressHint.measurable : nil
        ))

        for (index, row) in rows.enumerated() {
            let frame = layout.rows[index]
            let reveal = motion.row(index)
            place(row, frame.frame, CGAffineTransform(translationX: 0, y: reveal.offsetY))
            row.alpha = reveal.alpha
            row.apply(frame)
        }

        if let frame = layout.progressDot { progressDot.setLayoutFrame(frame) }
        if let frame = layout.progressLabel { progressLabel.setLayoutFrame(frame) }
        if let frame = layout.progressHint { progressHint.setLayoutFrame(frame) }

        // The shell grows from the capsule, its card anchored to its foot.
        place(composerShell, layout.composer, CGAffineTransform(scaleX: motion.composerScaleX, y: 1))
        composerShell.alpha = motion.composerAlpha
        let shellBounds = CGRect(origin: .zero, size: layout.composer.size)
        let radius = min(MobileComposerMetrics.mobile.shellRadius, shellBounds.height / 2)
        composerShell.layer.shadowPath = UIBezierPath(roundedRect: shellBounds, cornerRadius: radius).cgPath
        composerClip.frame = shellBounds
        composerClip.layer.cornerRadius = radius
        let cardFrame = CGRect(x: 0, y: shellBounds.height - cardHeight, width: shellBounds.width, height: cardHeight)
        card.setLayoutFrame(cardFrame)
        // STOPGAP (card `setReveal`): the text and the action row rise in
        // with the rest of the card rather than in their own beats.

        textBlocker.frame = CGRect(x: 0, y: cardFrame.minY, width: cardFrame.width, height: cardLayout.actionRow.minY)
        controlsBlocker.frame = CGRect(
            x: 0,
            y: cardFrame.minY + cardLayout.actionRow.minY,
            width: max(0, cardLayout.primary.minX - MobileComposerMetrics.mobile.primaryActionMarginLeft),
            height: cardLayout.actionRow.height
        )
    }

    private func place(_ view: UIView, _ frame: CGRect, _ transform: CGAffineTransform) {
        view.transform = .identity
        view.setLayoutFrame(frame)
        view.transform = transform
    }
}

extension HomeDockFocusViewController: AgentInputCardDelegate {
    func agentInputCardDidChangeText(_ card: AgentInputCardView) {
        guard !revertingText, let controller else { return }
        // The keyboard stays up while a session starts, so the text is
        // locked by refusing each change rather than by disabling it.
        if controller.starter.isStarting {
            revertingText = true
            let prompt = controller.prompt
            card.setText(prompt, selection: NSRange(location: (prompt as NSString).length, length: 0))
            revertingText = false
            refuseComposer()
            return
        }
        controller.setPrompt(card.text)
    }

    func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) {
        layoutContent()
    }

    func agentInputCardDidPressPrimary(_ card: AgentInputCardView) {
        guard let controller else { return }
        if controller.starter.isStarting {
            // Stop is about this screen: the composer comes back now.
            controller.cancelStart()
            close()
            return
        }
        controller.setPrompt(card.text)
        guard controller.canSubmit else { return }
        // The composer stays up until the session exists, so a failure
        // lands where it was asked for.
        Task { @MainActor [weak self] in
            if await controller.submit() { self?.close() }
        }
    }

    func agentInputCard(_ card: AgentInputCardView, didSelect key: String, in chip: AgentInputChip) {
        guard let controller, !controller.starter.isStarting else { return }
        switch chip {
        case .permission: controller.composer.selectPermission(key)
        case .model: controller.composer.selectModel(key)
        case .effort: controller.composer.selectEffort(key)
        }
    }
}
#endif

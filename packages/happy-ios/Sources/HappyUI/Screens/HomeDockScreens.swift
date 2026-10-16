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
///
/// Where the computer's Happy Agent can make bots, the composer makes one
/// instead: the text is the bot's name, and the face it wears is picked
/// above.
@MainActor
final class HomeDockController: NSObject {
    let restingView: HomeDockView
    let composer: NewSessionComposer
    let starter: SessionStarter
    /// Pictures for the first message (`useImagePicker`): home's own, kept
    /// while home is, as the prompt is. A bot takes none.
    let images: ComposerImagePicker
    private let staging: ComposerAttachmentStaging
    private(set) var prompt = ""
    /// Send was tapped and the start is being resolved, before it runs.
    private(set) var launching = false
    private weak var host: UIViewController?
    private let context: AppContext
    private weak var focus: HomeDockFocusViewController?
    /// The dock's own text heights at the text size, made off the main
    /// thread (`HomeDockText`).
    let text = HomeDockTextStore()
    /// "Picture not set" offers waiting for the composer to go.
    private var faceOffers: [(message: String, answer: CheckedContinuation<Bool, Never>)] = []

    init(restingView: HomeDockView, host: UIViewController, context: AppContext, session: AccountSession, snapshot: HomeSnapshot) {
        self.restingView = restingView
        self.host = host
        self.context = context
        composer = NewSessionComposer(
            drafts: NewSessionDraftStore.shared(for: context.account.localSettings),
            snapshot: snapshot,
            ops: session.homeOps
        )
        starter = SessionStarter.make(for: session)
        staging = ComposerAttachmentStaging(filesDirectory: session.filesDirectory)
        images = ComposerImagePicker(staging: staging)
        super.init()
        starter.presenter = self
        images.host = { [weak self] in self?.presenterController }
        images.onChange = { [weak self] in self?.render() }
        starter.onPhaseChange = { [weak self] _ in self?.render() }
        composer.onChange = { [weak self] in self?.render() }
        restingView.entryButton.addAction(UIAction { [weak self] _ in self?.openFocus() }, for: .touchUpInside)
        restingView.sendButton.addAction(UIAction { [weak self] _ in
            Task { await self?.submit() }
        }, for: .touchUpInside)
        text.onChange = { [weak self] in
            guard let self else { return }
            self.restingView.text = self.text.current
            self.focus?.view.setNeedsLayout()
        }
        render()
    }

    /// What the dock's text heights are for on a screen `width` wide drawn
    /// at `text`.
    static func textKey(width: CGFloat, text: TextEnvironment) -> HomeDockText.Key {
        HomeDockText.Key(text: text, ledeWidth: HomeDockHeaderLayout.ledeWidth(width: width), lede: Strings.Home.botLede)
    }

    /// Makes the dock's text heights for home's width and text size, ahead
    /// of the composer opening.
    func prepareText(width: CGFloat, text environment: TextEnvironment) {
        guard width > 0 else { return }
        text.prepare(Self.textKey(width: width, text: environment))
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

    /// `origin` is what a dock that comes into view comes back from.
    private func updateVisibility(from origin: HomeDockFade.Origin = .appearing) {
        // The capsule is replaced rather than covered while the composer is
        // open: the composer sits higher, and the capsule's button showed
        // below it.
        let hidden = !isAvailable || focus != nil
        let appears = restingView.isHidden && !hidden
        restingView.isHidden = hidden
        if hidden {
            restingView.finishFade()
        } else if appears {
            // It fades in where it is seen; off a window (home under a
            // pushed screen) or with Reduce Motion it is there at once.
            restingView.fadeIn(HomeDockFade.shown(
                from: origin,
                onWindow: restingView.window != nil,
                reduceMotion: UIAccessibility.isReduceMotionEnabled
            ))
        }
    }

    /// A bot needs a name the daemon takes; a session, a prompt or a
    /// picture.
    var canSubmit: Bool {
        guard !starter.isStarting, !launching else { return false }
        let drafts = composer.drafts
        return drafts.createsBot
            ? BotName.isValid(drafts.botName)
            : !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.images.isEmpty
    }

    func setPrompt(_ prompt: String) {
        guard prompt != self.prompt else { return }
        self.prompt = prompt
        render()
    }

    private func render() {
        restingView.prompt = prompt
        restingView.sendButton.appearance = starter.isStarting || launching ? .busy : canSubmit ? .send : .idle
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
        updateVisibility(from: .focus)
        render()
        showFaceOffers()
    }

    /// ProjectRow's `+` (ProjectHomeList.tsx `createWorkspace`): the draft
    /// moves to the project, asking for a new workspace, and the composer
    /// opens on it.
    func createWorkspace(_ origin: WorkspaceOrigin) -> Bool {
        composer.drafts.prepareWorkspace(origin)
        return openFocus()
    }

    // MARK: Start

    /// `handleHomePromptSubmit`: the prompt trimmed into the draft, then
    /// the start. The prompt is cleared once the session is open.
    @discardableResult
    func submit() async -> Bool {
        guard canSubmit else { return false }
        let drafts = composer.drafts
        // A bot is made from its name, not from a prompt: the composer's
        // text is the name, and the prompt typed for a session stays.
        if drafts.createsBot {
            guard !drafts.botName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
            let bot = drafts.bot
            let composer = composer
            guard let sessionId = await start({ await composer.launchBotPrepared() }) else { return false }
            // The next bot starts from a clean name and fresh faces; the
            // composer goes back to offering a session, the ordinary case.
            if drafts.botName == bot.botName { drafts.setBotName("") }
            drafts.rollBotFaces()
            drafts.setCreatesBot(false)
            open(sessionId)
            return true
        }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let picked = images.images
        guard !text.isEmpty || !picked.isEmpty else { return false }
        drafts.setInput(text)
        let started = drafts.draft
        let composer = composer
        let attachments = picked.map(\.attachment)
        guard let sessionId = await start({ await composer.launchPrepared(prompt: text, attachments: attachments) }) else { return false }
        // Only what was sent is cleared: edits made while it ran stay. The
        // outbox holds its own copies of the pictures by now.
        if drafts.draft.input == started.input { drafts.setInput("") }
        prompt = ""
        images.clear()
        open(sessionId)
        return true
    }

    /// Resolves a start off the main thread (`resolve`, the composer's
    /// prepared launch), then runs it; the session's id once it is open.
    /// One at a time: Send is busy while it resolves. If the target moved
    /// meanwhile (another computer, path or harness), nothing starts.
    private func start(_ resolve: () async -> Result<NewSessionLaunch, NewSessionLaunch.Refusal>) async -> String? {
        guard !launching else { return nil }
        let composer = composer
        let started = composer.drafts.draft
        let bot = composer.drafts.bot
        launching = true
        render()
        let resolved = await resolve()
        launching = false
        guard composer.isCurrentTarget(started, bot: bot) else {
            render()
            return nil
        }
        let launch: NewSessionLaunch
        switch resolved {
        case .success(let value):
            launch = value
        case .failure(let refusal):
            render()
            showStartError(refusal.errorDescription ?? SessionStarter.Message.startFailed)
            return nil
        }
        render()
        guard let sessionId = await starter.start(launch, isCurrentTarget: { composer.isCurrentTarget(started, bot: bot) }) else {
            render()
            return nil
        }
        return sessionId
    }

    private func open(_ sessionId: String) {
        render()
        host?.push(.session(id: sessionId), context: context)
    }

    // MARK: Bots

    /// Session | Bot.
    func setCreatesBot(_ value: Bool) {
        guard !starter.isStarting else { return }
        composer.drafts.setCreatesBot(value)
    }

    /// The name field, as typed: a pasted line break becomes a space and
    /// the daemon's ceiling is kept. Returns what the field should hold.
    @discardableResult
    func setBotName(_ name: String) -> String {
        let sanitized = BotName.sanitize(name)
        composer.drafts.setBotName(sanitized)
        return sanitized
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

    func showAttachmentsNotSupported() {
        guard let controller = presenterController else { return }
        Alerts.show(Strings.ImageUpload.notSupportedTitle, Strings.ImageUpload.notSupportedMessage, on: controller)
    }

    /// Asked once the composer has gone: the bot's session opens beneath,
    /// and the question must outlive the composer it was made from.
    func offerBotFaceRetry(_ message: String) async -> Bool {
        await withCheckedContinuation { continuation in
            faceOffers.append((message, continuation))
            showFaceOffers()
        }
    }

    private func showFaceOffers() {
        guard focus == nil, !faceOffers.isEmpty else { return }
        let anchor = host?.navigationController ?? host
        guard var top = anchor?.view.window?.rootViewController ?? anchor else {
            for offer in faceOffers { offer.answer.resume(returning: false) }
            faceOffers = []
            return
        }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        let offers = faceOffers
        faceOffers = []
        for offer in offers {
            let controller = top
            Task { @MainActor in
                offer.answer.resume(returning: await Alerts.confirm(
                    Strings.Home.botFaceNotSet,
                    offer.message,
                    confirmTitle: Strings.Home.botFaceTryAgain,
                    cancelTitle: Strings.Home.botFaceNotNow,
                    on: controller
                ))
            }
        }
    }
}

/// The open composer (HomeDock.tsx's focus mode): a modal over home that
/// blurs and dims the list, stacks the machine, project, worktree and
/// harness pickers over the composer card, and rides on the keyboard.
/// Where bots can be made, Session | Bot heads the screen; a bot keeps the
/// machine row and offers faces in place of the rest.
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
    /// Session | Bot, at the top over the backdrop, with the bot's lede.
    private let header = HomeDockRevealLineView(passesThrough: true)
    private let kindControl = UISegmentedControl(items: [Strings.Home.composerSession, Strings.Home.composerBot])
    private let lede = StyledLabel(style: TextStyles.homeDockLede, color: Palette.textSecondary, lines: 0, alignment: .center)
    private let facesLine = HomeDockRevealLineView(passesThrough: false)
    private let facePicker = BotFacePickerView()
    /// Which text the card holds: the prompt, or the bot's name.
    private var cardHoldsBotName: Bool?
    /// The other one, measured for a switch.
    private let kindText: HomeDockKindText
    private let progressDot = StatusDotView()
    private let progressLabel = StyledLabel(style: TextStyles.homeDockProgress, color: Palette.textSecondary, lines: 1)
    private let progressHint = StyledLabel(style: TextStyles.homeDockProgress, color: Palette.textSecondary, lines: 1)
    private let composerShell = UIView()
    private let composerClip = UIView()
    private let card: AgentInputCardView
    /// Over the text while a session starts (`composerPressBlocker`): a
    /// press shakes the whole composer. The card refuses its own controls.
    private let textBlocker = UIControl()
    private let keyboardTracker = UIView()

    private var progress: CGFloat = 0
    private var motion: Motion?
    private var flashStart: CFTimeInterval?
    private var displayLink: CADisplayLink?
    private var closing = false
    /// The open was asked for: it runs once the card's height is in.
    private var opening = false
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
        kindText = HomeDockKindText(card: card)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The pickers, the lede, the faces' words, the status line and the
        // card follow the person's text size; every height is measured at
        // it off the main thread (`HomeDockText`, the card's own).
        followsTextSize()
        view.backgroundColor = .clear
        backdrop.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(backdropTapped)))
        view.addSubview(backdrop)
        view.addSubview(dock)

        for (index, row) in rows.enumerated() {
            row.blocker.addAction(UIAction { [weak self, weak row] _ in
                guard let row else { return }
                AgentInputCardView.shake(row, .refusal)
                self?.refuse()
            }, for: .touchUpInside)
            if Row(rawValue: index) == .harness {
                row.trigger.addAction(UIAction { [weak self] _ in self?.openHarnessHelp() }, for: .touchUpInside)
            }
            dock.addSubview(row)
        }

        kindControl.accessibilityLabel = Strings.Home.composerKindLabel
        kindControl.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.controller?.setCreatesBot(self.kindControl.selectedSegmentIndex == 1)
        }, for: .valueChanged)
        lede.string = Strings.Home.botLede
        header.addSubview(kindControl)
        header.addSubview(lede)
        header.blocker.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            AgentInputCardView.shake(self.header, .refusal)
            self.refuse()
        }, for: .touchUpInside)
        view.addSubview(header)

        facePicker.onPick = { [weak self] slot in self?.controller?.composer.drafts.setBotFaceSlot(slot) }
        facePicker.onRoll = { [weak self] in self?.controller?.composer.drafts.rollBotFaces() }
        facesLine.addSubview(facePicker)
        facesLine.blocker.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            AgentInputCardView.shake(self.facesLine, .refusal)
            self.refuse()
        }, for: .touchUpInside)
        dock.addSubview(facesLine)
        if controller?.composer.choices.supportsBots == true {
            // The faces' outlines are parsed once, off the main thread,
            // before anyone asks for a bot.
            Task.detached(priority: .utility) { _ = BotFaceStyle.adventurerNeutral.canvas }
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
        textBlocker.isHidden = true
        textBlocker.addAction(UIAction { [weak self] _ in self?.refuseComposer() }, for: .touchUpInside)
        composerClip.addSubview(textBlocker)

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
        render()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !opening, motion == nil, progress == 0, !closing else { return }
        opening = true
        // The shell grows from the capsule to the card's height: a draft's
        // height, measured off the main thread, is waited for, for two
        // frames at most, so the open doesn't retarget on the way. Then
        // what is left of a frame for the modal to land, and 340ms
        // ease-out. The card shows throughout, as the capsule.
        // The dock's own text heights at the text size are waited for
        // alongside, within the same two frames; home makes them ahead, so
        // they are usually in already.
        let asked = CACurrentMediaTime()
        let pending = HomeDockOpenWait(count: 2)
        let arrived: @MainActor () -> Void = { [weak self] in
            guard pending.arrive(), let self, self.motion == nil, self.progress == 0, !self.closing else { return }
            self.layoutContent()
            let delay = HomeDockFocusMotion.openDelay(afterWaiting: CACurrentMediaTime() - asked)
            self.animate(to: 1, delay: delay, duration: HomeDockFocusMotion.openDuration, easing: HomeDockFocusMotion.easeOut)
        }
        card.whenTextMeasured(fitting: composerWidth, timeout: .seconds(HomeDockFocusMotion.heightWait)) { _ in arrived() }
        if let controller {
            controller.text.whenReady(textKey, timeout: .seconds(HomeDockFocusMotion.heightWait)) { _ in arrived() }
        } else {
            arrived()
        }
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

    /// Measures, off the main thread, what Session | Bot would put in the
    /// card while it holds the other: the prompt kept while a bot is
    /// named, or the bot's name.
    private func prepareKindSwitch() {
        guard let controller, controller.composer.choices.supportsBots, let holdsBotName = cardHoldsBotName else { return }
        kindText.prepare(
            createsBot: !holdsBotName,
            text: holdsBotName ? controller.prompt : controller.composer.drafts.botName,
            width: composerWidth
        )
    }

    /// Everything that follows the draft, the store and the start.
    func render() {
        guard isViewLoaded, let controller else { return }
        let choices = controller.composer.choices
        let drafts = controller.composer.drafts
        let createsBot = drafts.createsBot
        let phase = controller.starter.phase
        let starting = phase != nil

        header.isHidden = !choices.supportsBots
        header.refusing = starting
        kindControl.selectedSegmentIndex = createsBot ? 1 : 0
        lede.isHidden = !createsBot
        facesLine.isHidden = !createsBot
        facesLine.refusing = starting
        facePicker.seeds = drafts.botFaceSeeds
        facePicker.slot = drafts.botFaceSlot
        // One field for both: switching keeps the keyboard up.
        let text = createsBot ? drafts.botName : controller.prompt
        if cardHoldsBotName != createsBot || (createsBot && card.text != text) {
            cardHoldsBotName = createsBot
            let selection = NSRange(location: (text as NSString).length, length: 0)
            // A text from elsewhere settles at its height rather than
            // growing into it. The other kind's comes measured for a card
            // as wide as this one; otherwise it is measured now and the
            // card moves once, unanimated, when it lands.
            revertingText = true
            if let measured = kindText.measured(createsBot: createsBot, text: text, width: composerWidth) {
                card.setText(measured, selection: selection, animatesHeight: false)
            } else {
                card.setText(text, selection: selection, animatesHeight: false)
            }
            revertingText = false
        }
        prepareKindSwitch()

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
            // A bot lives on a computer and nowhere else.
            view.isHidden = createsBot && row != .machine
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

        let label = NewSessionProgress.label(
            phase: phase,
            agentName: choices.currentAgent.name,
            picksWorkspaces: choices.picksWorkspaces,
            createsBot: createsBot
        )
        let primary = NewSessionProgress.primaryAction(canSubmit: controller.canSubmit, phase: phase, canCancel: true)
        progressLabel.string = label ?? ""
        progressDot.isHidden = label == nil
        progressLabel.isHidden = label == nil
        progressHint.isHidden = label == nil || primary != .stop

        card.configuration = createsBot
            ? botCardConfiguration(choices, primary: primary, starting: starting)
            : cardConfiguration(choices, primary: primary, starting: starting)
        textBlocker.isHidden = !starting
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

    /// The card for the draft (`renderFocusedComposer`), with the pictures
    /// picked for the first message.
    private func cardConfiguration(_ choices: NewSessionChoices, primary: NewSessionPrimaryAction, starting: Bool) -> AgentInputCardConfiguration {
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
        let attachments = controller?.images.images.map { AgentInputAttachmentPreview(id: $0.id, fileURL: $0.attachment.fileURL) } ?? []
        return AgentInputCardConfiguration(
            placeholder: choices.promptPlaceholder,
            showsAdd: true,
            addAccessibilityLabel: Strings.Home.addImage,
            attachments: attachments,
            permission: permission,
            model: model,
            effort: effort,
            primaryAction: Self.action(primary),
            isPrimaryBusy: primary == .busy,
            primaryAccessibilityLabel: primary == .stop ? Strings.Composer.stop : Strings.Composer.send,
            primaryStyle: .newSession,
            refusesControls: starting
        )
    }

    /// The card for a bot: its name and the button that makes it. A bot
    /// takes no pictures and no modes.
    private func botCardConfiguration(_ choices: NewSessionChoices, primary: NewSessionPrimaryAction, starting: Bool) -> AgentInputCardConfiguration {
        AgentInputCardConfiguration(
            placeholder: choices.promptPlaceholder,
            primaryAction: Self.action(primary),
            isPrimaryBusy: primary == .busy,
            primaryAccessibilityLabel: primary == .stop ? Strings.Composer.stop : Strings.Home.createBot,
            autocapitalization: .words,
            returnKey: .done,
            primaryStyle: .newSession,
            refusesControls: starting
        )
    }

    private static func action(_ primary: NewSessionPrimaryAction) -> AgentInputPrimaryAction {
        switch primary {
        case .send: .send
        case .stop: .stop
        case .busy: .send
        case .idle: .idle
        }
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

    /// A refused edit of the text: the whole composer shakes (Shaker).
    private func refuseComposer() {
        refuse()
        AgentInputCardView.shake(composerShell)
    }

    private func applyFlash() {
        let amount = flashStart.map { HomeDockRefusal.flash(at: CACurrentMediaTime() - $0) } ?? 0
        let from = UIColor(Palette.textSecondary).resolvedColor(with: traitCollection)
        let to = UIColor(Palette.text).resolvedColor(with: traitCollection)
        progressHint.textColor = Self.blend(from, to, amount)
        card.setPrimaryFlash(amount)
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
        // The width is known, or has moved.
        prepareKindSwitch()
    }

    /// What this screen's text heights are for now.
    private var textKey: HomeDockText.Key {
        HomeDockController.textKey(width: view.bounds.width, text: TextEnvironment(traitCollection))
    }

    /// The card's width.
    private var composerWidth: CGFloat {
        max(0, view.bounds.width - 2 * HomeDockFocusLayout.Metrics.composerPaddingHorizontal)
    }

    /// The dock's contents at the present progress.
    private func layoutContent() {
        let size = view.bounds.size
        guard size.width > 0 else { return }
        let motion = HomeDockFocusMotion(progress: progress)
        backdrop.alpha = motion.backdropAlpha

        let cardLayout = card.layout(width: composerWidth)
        let cardHeight = cardLayout.size.height
        let showsProgress = !progressLabel.isHidden
        let shownRows = rows.filter { !$0.isHidden }
        // The heights made off the main thread for this width and text
        // size; until they land (the first open after a new text size, for
        // a frame at most past the open's wait) the lines are the styles'
        // own and the lede and faces measure their labels.
        let key = textKey
        let text = controller?.text.text(for: key)
        if text == nil { controller?.text.prepare(key) }
        let environment = key.text
        let layout = HomeDockFocusLayout(.init(
            size: size,
            safeBottom: view.safeAreaInsets.bottom,
            composerHeight: motion.composerHeight(full: cardHeight),
            rows: shownRows.map(\.valueLabel.measurable),
            triggerLine: text?.triggerLine ?? TextStyles.homeDockRowValue.oneLine(in: environment),
            progress: showsProgress ? text.map { HomeDockText.line(progressLabel, $0.progressLine) } ?? progressLabel.measurable : nil,
            hint: showsProgress && !progressHint.isHidden ? text.map { HomeDockText.line(progressHint, $0.progressLine) } ?? progressHint.measurable : nil,
            faces: facesLine.isHidden ? nil : text.map { facePicker.text(headingLine: $0.faceHeadingLine, creditLine: $0.creditLine) } ?? facePicker.text
        ))

        // Each line reveals in turn from the top.
        for (index, row) in shownRows.enumerated() {
            let frame = layout.rows[index]
            let reveal = motion.row(index)
            place(row, frame.frame, CGAffineTransform(translationX: 0, y: reveal.offsetY))
            row.alpha = reveal.alpha
            row.apply(frame)
        }
        if let line = layout.faces, let picker = layout.facePicker, let pickerLayout = layout.facePickerLayout {
            let reveal = motion.row(shownRows.count)
            place(facesLine, line, CGAffineTransform(translationX: 0, y: reveal.offsetY))
            facesLine.alpha = reveal.alpha
            facePicker.setLayoutFrame(picker.offsetBy(dx: -line.minX, dy: -line.minY))
            facePicker.apply(pickerLayout)
        }

        // Session | Bot holds the top of the screen, off the keyboard, and
        // reveals with the first row.
        if !header.isHidden {
            let headerLayout = HomeDockHeaderLayout(.init(
                width: size.width,
                safeTop: view.safeAreaInsets.top,
                lede: lede.isHidden ? nil : text.map { measured in
                    Measurable { [lede] width in width == measured.key.ledeWidth ? measured.lede : lede.measurable.size(fitting: width) }
                } ?? lede.measurable
            ))
            let content = headerLayout.content
            let reveal = motion.row(0)
            place(header, content, CGAffineTransform(translationX: 0, y: reveal.offsetY))
            header.alpha = reveal.alpha
            kindControl.setLayoutFrame(headerLayout.segment.offsetBy(dx: -content.minX, dy: -content.minY))
            if let frame = headerLayout.lede { lede.setLayoutFrame(frame.offsetBy(dx: -content.minX, dy: -content.minY)) }
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
        card.setReveal(input: AgentInputCardReveal.input(progress: progress), actions: AgentInputCardReveal.actions(progress: progress))
        textBlocker.frame = CGRect(x: 0, y: cardFrame.minY, width: cardFrame.width, height: cardLayout.actionRow.minY)
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
        let createsBot = controller.composer.drafts.createsBot
        // The keyboard stays up while a session starts, so the text is
        // locked by refusing each change rather than by disabling it.
        if controller.starter.isStarting {
            revertingText = true
            let text = createsBot ? controller.composer.drafts.botName : controller.prompt
            card.setText(text, selection: NSRange(location: (text as NSString).length, length: 0))
            revertingText = false
            refuseComposer()
            return
        }
        if createsBot {
            let typed = card.text
            let kept = controller.setBotName(typed)
            if kept != typed {
                revertingText = true
                let caret = min(card.selectedRange.location, (kept as NSString).length)
                card.setText(kept, selection: NSRange(location: caret, length: 0))
                revertingText = false
            }
            return
        }
        controller.setPrompt(card.text)
    }

    /// Return makes the bot (`submitBehavior="submit"`); a session's
    /// prompt takes the newline.
    func agentInputCardShouldInsertNewline(_ card: AgentInputCardView) -> Bool {
        guard let controller, controller.composer.drafts.createsBot else { return true }
        submitFromFocus()
        return false
    }

    func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) {
        layoutContent()
        // The card says so when its text size moved too: what was measured
        // for the switch is for the size before.
        prepareKindSwitch()
    }

    func agentInputCardDidPressPrimary(_ card: AgentInputCardView) {
        guard let controller else { return }
        if controller.starter.isStarting {
            // Stop is about this screen: the composer comes back now.
            controller.cancelStart()
            close()
            return
        }
        if !controller.composer.drafts.createsBot { controller.setPrompt(card.text) }
        submitFromFocus()
    }

    /// The composer stays up until the session exists, so a failure lands
    /// where it was asked for.
    private func submitFromFocus() {
        guard let controller, controller.canSubmit else { return }
        Task { @MainActor [weak self] in
            if await controller.submit() { self?.close() }
        }
    }

    func agentInputCardDidRefuse(_ card: AgentInputCardView, control: AgentInputControl) {
        refuse()
    }

    func agentInputCardDidPressAdd(_ card: AgentInputCardView) {
        guard let controller, !controller.starter.isStarting else { return }
        controller.images.attach()
    }

    func agentInputCard(_ card: AgentInputCardView, didRemoveAttachment id: String) {
        guard let controller, !controller.starter.isStarting else { return }
        controller.images.remove(id: id)
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
/// The open's waits: it runs when the last one answers.
@MainActor
private final class HomeDockOpenWait {
    private var count: Int
    init(count: Int) { self.count = count }
    /// True for the last answer.
    func arrive() -> Bool {
        count -= 1
        return count == 0
    }
}
#endif

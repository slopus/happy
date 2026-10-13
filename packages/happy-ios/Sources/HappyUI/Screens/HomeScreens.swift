#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

/// Signed in: app/(app)/index.tsx and SessionsListWrapper.tsx. Home stays
/// the navigation root for the whole session and swaps its content as the
/// store changes (`HomeState`):
///   - a spinner until the machines are known;
///   - Link Your Computer while none is linked;
///   - the offline checklist while none is reachable and nothing is listed;
///   - "No sessions yet" on a reachable computer with nothing on it;
///   - the session list otherwise.
///
/// Screens pushed over it (settings, server, troubleshoot) stay where they
/// are when a computer arrives, as they do in happy-app.
public final class HomeViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let titleView = NavigationTitleView()
    private var observation: StoreObservation?
    private var state: HomeState?
    private var content: UIViewController?

    public init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        navigationItem.titleView = titleView
        showsBackTitle()
        observation = session.observeHome { [weak self] state in
            self?.show(state)
        }
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The server may have changed on a screen pushed from here.
        updateNavigation()
    }

    private func show(_ state: HomeState) {
        guard state != self.state else { return }
        let previous = self.state
        self.state = state
        switch (previous, state) {
        case (.offline?, .offline(let choices, let hasArchived)):
            let checklist = content as? OfflineChecklistViewController
            checklist?.choices = choices
            checklist?.hasArchived = hasArchived
        case (.list?, .list(let list, let offline)):
            (content as? SessionListViewController)?.update(list, offline: offline)
        default:
            embed(makeContent(for: state), animated: previous != nil)
        }
        updateNavigation()
    }

    private func makeContent(for state: HomeState) -> UIViewController {
        switch state {
        case .loading:
            LoadingViewController()
        case .link:
            LinkComputerViewController(context: context, session: session)
        case .offline(let choices, let hasArchived):
            OfflineChecklistViewController(session: session, choices: choices, hasArchived: hasArchived)
        case .noSessions:
            NoSessionsViewController(session: session)
        case .list(let list, let offline):
            SessionListViewController(session: session, list: list, offline: offline)
        }
    }

    private func embed(_ next: UIViewController, animated: Bool) {
        let previous = content
        content = next
        previous?.willMove(toParent: nil)
        addChild(next)
        next.view.frame = view.bounds
        next.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        let swap = {
            previous?.view.removeFromSuperview()
            self.view.addSubview(next.view)
        }
        if animated {
            UIView.transition(with: view, duration: 0.25, options: .transitionCrossDissolve, animations: swap)
        } else {
            swap()
        }
        previous?.removeFromParent()
        next.didMove(toParent: self)
    }

    /// The link screen has happy-app's onboarding header: no title, the
    /// custom server under it, and a gear to the onboarding settings. Every
    /// other state has the home header and the full settings.
    private func updateNavigation() {
        guard let state else { return }
        if state == .link {
            titleView.title = nil
            titleView.subtitle = context.customServerHost
            navigationItem.rightBarButtonItem = settingsBarButton(action: #selector(openOnboardingSettings))
        } else {
            titleView.title = Strings.Sidebar.sessionsTitle
            titleView.subtitle = nil
            navigationItem.rightBarButtonItem = settingsBarButton(action: #selector(openSettings))
        }
        titleView.sizeToFit()
    }

    @objc private func openOnboardingSettings() {
        navigationController?.pushViewController(OnboardingSettingsViewController(context: context), animated: true)
    }

    @objc private func openSettings() {
        navigationController?.pushViewController(SettingsViewController(context: context), animated: true)
    }
}

final class LoadingViewController: UIViewController {
    override func loadView() {
        view = LoadingView()
    }
}

/// OnboardingLinkComputer from components/onboarding/LinkComputer.tsx.
/// Scanning opens once both boxes are ticked, and the ticks are kept until
/// logout. A link that went through keeps the button busy until the
/// computer arrives and home swaps this screen out, or for ten seconds if
/// it never does. A failed one says so on the line above the button. The
/// only way back is the gear's "Log out and start over".
final class LinkComputerViewController: UIViewController {
    static let machineArrivalTimeout: Duration = .seconds(10)

    private let context: AppContext
    private let session: AccountSession
    private let content = LinkComputerContentView()
    private lazy var screen = OnboardingScreenView(
        content: content,
        primary: RoundButton(title: Strings.Onboarding.scanButton),
        secondary: RoundButton(title: Strings.Onboarding.pasteLink, size: .normal, display: .inverted)
    )
    /// The approval request is in flight.
    private var linking = false
    /// Approved; waiting for the computer to sync in.
    private var approved = false
    private var approvalTimeout: Task<Void, Never>?

    init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        view = screen
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        screen.primary.loadingTitle = Strings.Onboarding.linking
        screen.primary.onTap = { [weak self] in self?.scan() }
        screen.secondary.onTap = { [weak self] in self?.paste() }
        screen.help.onTap = { [weak self] in
            guard let self else { return }
            Alerts.help(on: self)
        }
        content.onOpenWebsite = {
            UIApplication.shared.open(Strings.Onboarding.desktopURL)
        }
        let saved = context.account.localSettings.linkComputerChecklist
        content.ticked = Set(LinkComputerContentView.Step.allCases.filter {
            $0 == .install ? saved.install : saved.open
        })
        content.onToggle = { [weak self] ticked in
            self?.context.account.localSettings.linkComputerChecklist = LinkChecklist(
                install: ticked.contains(.install),
                open: ticked.contains(.open)
            )
            self?.update()
        }
        update()
    }

    private var busy: Bool {
        linking || approved
    }

    private func update() {
        let ready = content.ticked == Set(LinkComputerContentView.Step.allCases)
        screen.primary.isLoading = busy
        screen.primary.isEnabled = !busy && ready
        screen.secondary.isEnabled = !busy
        content.isEnabled = !busy
    }

    private func scan() {
        content.error = nil
        Task { @MainActor in
            guard let text = await PairingFlow.scan(.terminal, from: self) else { return }
            await link(text)
        }
    }

    private func paste() {
        content.error = nil
        Task { @MainActor in
            let text = await Alerts.prompt(
                Strings.Onboarding.pasteLinkTitle,
                Strings.Onboarding.pasteLinkMessage,
                placeholder: "happy://terminal?...",
                confirmTitle: Strings.Onboarding.pasteLinkConfirm,
                on: self
            )
            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
            await link(text)
        }
    }

    private func link(_ text: String) async {
        guard !busy else { return }
        linking = true
        update()
        let outcome = await PairingFlow.approve(text, expecting: .terminal, session: session)
        linking = false
        switch outcome {
        case .approved:
            PairingFlow.report(outcome, kind: .terminal, on: self)
            approved = true
            approvalTimeout?.cancel()
            approvalTimeout = Task { @MainActor [weak self] in
                try? await Task.sleep(for: Self.machineArrivalTimeout)
                guard !Task.isCancelled, let self else { return }
                approved = false
                update()
            }
        case .failed:
            content.error = Strings.Onboarding.linkFailed
            UIAccessibility.post(notification: .announcement, argument: Strings.Onboarding.linkFailed)
        case .invalidLink, .terminalNeedsUpdate:
            // These need more than one line, and scanning again won't help.
            PairingFlow.report(outcome, kind: .terminal, on: self)
        }
        update()
    }
}

/// LinkComputerChecklist from components/onboarding/LinkComputer.tsx:
/// computers are linked but none is reachable. The install box is already
/// ticked; the job now is to get Happy running again.
final class OfflineChecklistViewController: UIViewController {
    var choices: [MachineChoice] {
        didSet { applyChoices() }
    }

    /// Offers "Show archived", which turns the archive on and so lists it.
    var hasArchived: Bool {
        didSet { applyChoices() }
    }

    private let session: AccountSession
    private let checklist = OfflineChecklistView()
    private var linking = false
    private var approved = false
    private var approvalTimeout: Task<Void, Never>?

    init(session: AccountSession, choices: [MachineChoice], hasArchived: Bool = false) {
        self.session = session
        self.choices = choices
        self.hasArchived = hasArchived
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        view = checklist
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        checklist.troubleshoot.onTap = { [weak self] in
            guard let self else { return }
            navigationController?.pushViewController(TroubleshootViewController(session: session), animated: true)
        }
        checklist.linkAnother.onTap = { [weak self] in self?.scan() }
        checklist.showArchived.onTap = { [weak self] in
            self?.session.updateSettings(["hideInactiveSessions": .bool(false)])
        }
        applyChoices()
        update()
    }

    private func applyChoices() {
        guard isViewLoaded else { return }
        checklist.showsArchivedButton = hasArchived
        if choices.count == 1 {
            checklist.title = Strings.Onboarding.offlineTitleOne(name: choices[0].name)
            checklist.linkedTitle = Strings.Onboarding.offlineLinkedStep(name: choices[0].name)
        } else {
            checklist.title = Strings.Onboarding.offlineTitleMany
            checklist.linkedTitle = Strings.Onboarding.offlineLinkedStepMany(count: choices.count)
        }
    }

    private func update() {
        checklist.linkAnother.isLoading = linking || approved
        checklist.linkAnother.title = approved ? Strings.Onboarding.linking : Strings.Onboarding.linkAnother
    }

    private func scan() {
        Task { @MainActor in
            guard let text = await PairingFlow.scan(.terminal, from: self), !linking, !approved else { return }
            linking = true
            update()
            let outcome = await PairingFlow.approve(text, expecting: .terminal, session: session)
            linking = false
            // No inline error line here: failures are alerts, as in happy-app.
            PairingFlow.report(outcome, kind: .terminal, on: self)
            if outcome == .approved { startWaitingForComputer() }
            update()
        }
    }

    private func startWaitingForComputer() {
        approved = true
        approvalTimeout?.cancel()
        approvalTimeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: LinkComputerViewController.machineArrivalTimeout)
            guard !Task.isCancelled, let self else { return }
            approved = false
            update()
        }
    }
}

@MainActor
enum ComputerRow {
    /// A computer as troubleshoot.tsx lists it. happy-app opens the machine
    /// screen on tap; that screen isn't ported yet, so the row is inert.
    static func make(_ choice: MachineChoice) -> ItemRowView {
        ItemRowView(
            title: choice.name,
            subtitle: choice.online ? nil : Strings.Troubleshoot.machineOffline,
            icon: ItemIcon("desktopcomputer", tint: Palette.textSecondary)
        )
    }
}

/// app/(app)/troubleshoot.tsx: what to check when every linked computer is
/// offline, the computers, and an AI prompt pointed at the local logs.
final class TroubleshootViewController: UIViewController {
    private let session: AccountSession
    private let list = GroupedListView()
    private let guide = TroubleshootGuideView()
    private let prompt = CopyPromptView()
    private var observation: StoreObservation?
    private var aiPrompt = ""
    private var copiedReset: Task<Void, Never>?

    init(session: AccountSession) {
        self.session = session
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        view = list
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Troubleshoot.title
        guide.onOpenWebsite = {
            UIApplication.shared.open(Strings.Onboarding.desktopURL)
        }
        prompt.button.onTap = { [weak self] in self?.copyPrompt() }
        observation = session.store.observeMachines { [weak self] snapshot in
            self?.update(snapshot)
        }
    }

    private func update(_ snapshot: MachinesSnapshot) {
        let choices = MachineChoice.collect(snapshot.machines)
        let sessions = (try? session.store.sessions()) ?? []
        aiPrompt = OfflineTroubleshooting(choices: choices, sessions: sessions).aiPrompt
        var sections: [UIView] = [guide]
        if !choices.isEmpty {
            sections.append(ItemGroupView(title: Strings.Troubleshoot.machines, rows: choices.map(ComputerRow.make)))
        }
        sections.append(prompt)
        list.sections = sections
    }

    private func copyPrompt() {
        UIPasteboard.general.string = aiPrompt
        prompt.button.title = Strings.Troubleshoot.copied
        copiedReset?.cancel()
        copiedReset = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            self?.prompt.button.title = Strings.Troubleshoot.copyAiPrompt
        }
    }
}
#endif

#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

// An empty chat opened by compose, before it has a session. The screen is
// the chat screen itself, on a `compose-chat:` id: its composer writes the
// account's new-session draft (the text the home dock used to keep), and
// its first send starts the session on the draft's machine, folder and
// harness, the last ones picked, with that text as the first message. The
// machine and folder are picked in the middle of the empty chat, as Happy
// Agent's new work picks Task or Bot (`NewWorkPanel`'s `.session`); the
// machine only on an account with more than one. Where the computer's
// Happy Agent makes them, a task or a bot is picked there too, as home's
// dock offered: Happy Agent makes it on that computer, with the first send
// as its first message. The screen then becomes the session's chat in
// place (`becomeChat`): the same screen and the same composer, retargeted.
//
// Pictures, videos and files picked with "+" before there is a session go
// with that first message: once the session is made, the start hands them
// to its outbox ahead of the text, which uploads them to it and keeps them
// across a relaunch until they are sent (`takesAttachments`).
//
// A start that fails or is refused says why, and the text and the picked
// files stay in the composer (the text in the draft too) for another send.
// Leaving before it has answered stops it; the draft stays for the next
// compose.

enum ComposeChat {
    static let prefix = "compose-chat:"

    static func makeId() -> String { prefix + UUID().uuidString.lowercased() }

    static func isComposeId(_ id: String) -> Bool { id.hasPrefix(prefix) }
}

/// The start behind a `compose-chat:` screen: the account's new-session
/// draft read against its machines, and one `SessionStarter`.
@MainActor
final class LegacyComposeStart: NSObject {
    /// How the start is made: the account's own, or a test's.
    static var makeStarter: (AccountSession) -> SessionStarter = { SessionStarter.make(for: $0) }

    let composer: NewSessionComposer
    let starter: SessionStarter
    /// The session the first send started; nil until it is open.
    private(set) var sessionId: String?
    /// What the screen says while the start runs or the target changes.
    var onChange: (() -> Void)?
    /// What alerts and questions show over.
    weak var host: UIViewController?
    private var feed: Task<Void, Never>?

    struct Refused: LocalizedError {
        var message: String
        var errorDescription: String? { message }
    }

    init(context: AppContext, account: AccountSession) {
        let snapshot = account.homeFeed.latest ?? LegacyHomeSnapshot(machines: MachinesSnapshot(synced: false, machines: []), sessions: [])
        let drafts = NewSessionDraftStore.shared(for: context.account.localSettings)
        // A computer picked on an earlier compose holds a kept bot or task
        // no longer: this one routes it again.
        drafts.pickedMachineId = nil
        composer = NewSessionComposer(
            drafts: drafts,
            snapshot: snapshot,
            ops: account.homeOps
        )
        starter = Self.makeStarter(account)
        // Hears the keyboard from now, before this screen's comes up with it.
        _ = KeyboardReserve.shared
        super.init()
        starter.presenter = self
        starter.onPhaseChange = { [weak self] _ in self?.onChange?() }
        composer.onChange = { [weak self] in
            guard let self else { return }
            if settleKind() || followMachine() { return }
            onChange?()
        }
        _ = settleKind()
        let snapshots = account.homeFeed.snapshots()
        feed = Task { [weak self] in
            for await snapshot in snapshots {
                guard let self, !Task.isCancelled else { return }
                self.composer.update(snapshot: snapshot)
            }
        }
    }

    deinit { feed?.cancel() }

    var drafts: NewSessionDraftStore { composer.drafts }

    var isStarting: Bool { starter.isStarting }

    /// "Starting Claude…", "Creating task…" and the rest while the start runs.
    var progress: String? {
        let choices = composer.choices
        return NewSessionProgress.label(
            phase: starter.phase, agentName: choices.currentAgent.name, picksWorkspaces: choices.picksWorkspaces,
            createsBot: drafts.createsBot, createsTask: drafts.createsTask
        )
    }

    // MARK: Kind

    /// Session, and Bot and Task where some computer's Happy Agent on the
    /// account makes them (picking one goes there); an account of Happy
    /// CLI computers alone offers Session only.
    var kinds: [HomeDockKind] {
        HomeDockKind.offered(supportsBots: composer.choices.offersBots, supportsTasks: composer.choices.offersTasks)
    }

    var kind: HomeDockKind {
        HomeDockKind.current(createsBot: drafts.createsBot, createsTask: drafts.createsTask)
    }

    static let allKinds: [HomeDockKind] = [.session, .bot, .task]

    /// This account's computers have been fetched, now or on an earlier
    /// launch (its store keeps them).
    var knowsComputers: Bool { composer.choices.machinesSynced }

    /// The kinds the panel shows: every one once this account's computers
    /// have been fetched (ever: the store keeps them, so from the first
    /// frame after that) and one of them is a Happy Agent that makes a bot
    /// or a task; else a session alone, which hides the control (Kirill).
    /// So an account of Happy CLI computers only never sees it, and it
    /// never shows while the computers are not known yet, only to go.
    var shownKinds: [HomeDockKind] {
        knowsComputers && kinds.count > 1 ? Self.allKinds : [.session]
    }

    /// A bot or a task kept in the draft from before, on an account whose
    /// computers make neither now, is a session again: nothing on screen
    /// could pick it back. True when it moved the draft.
    private func settleKind() -> Bool {
        guard composer.choices.machinesSynced, kinds.count == 1, kind != .session, sessionId == nil, !isStarting else { return false }
        composer.selectKind(.session)
        return true
    }

    /// The kinds that can be picked: those some computer makes, the one
    /// already picked, and while the computers are still arriving, all
    /// (where it goes is settled when they are in).
    var enabledKinds: Set<HomeDockKind> {
        var enabled = Set(kinds).union([kind])
        if !composer.choices.machinesSynced { enabled.formUnion(Self.allKinds) }
        return enabled
    }

    func setKind(_ kind: HomeDockKind) {
        guard !isStarting, sessionId == nil else { return }
        composer.selectKind(kind)
    }

    /// The name field, as typed: a pasted line break becomes a space and
    /// the daemon's ceiling is kept. Returns what the field should hold.
    func setBotName(_ name: String) -> String {
        let sanitized = BotName.sanitize(name)
        drafts.setBotName(sanitized)
        return sanitized
    }

    /// What the composer asks for: the first message of a task, or of the
    /// session or bot the harness runs.
    var placeholder: String {
        let choices = composer.choices
        switch kind {
        case .task: return Strings.Tasks.placeholder
        case .bot: return NewSessionChoices.promptPlaceholder(agentKey: choices.currentAgent.key, agentName: choices.currentAgent.name)
        case .session: return choices.promptPlaceholder
        }
    }

    /// Pictures and files picked before the session exists go with the
    /// first send, as home's dock took them: a bot or a task is Happy
    /// Agent's, a session the harness picked.
    var takesAttachments: Bool {
        SessionComposerRules.canUseAttachments(starting: kind == .session ? composer.choices.resolvedAgent : .rig)
    }

    /// The machine the first send goes to, as its picker names it; while
    /// the computers are still arriving, that they are.
    var machineName: String {
        let choices = composer.choices
        if choices.awaitsComputers { return Strings.ComposeTarget.loading }
        return choices.currentMachine?.name ?? Strings.Home.selectMachine
    }

    /// The computer row's chip: online in green, what doesn't answer in
    /// the warning colour, grey while the computers are still arriving.
    var machineStatus: (text: String, color: UIColor)? {
        if composer.choices.awaitsComputers { return (Strings.ComposeTarget.loadingStatus, UIColor(Palette.textSecondary)) }
        guard let target = composer.choices.currentTarget else { return nil }
        let offline = composer.choices.offline
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return (Strings.ComposeTarget.label(target, offline: offline, now: now),
                UIColor(offline == nil ? Palette.sessionStatusOnline : Palette.warningText))
    }

    /// Why the first send can't reach the computer now, in full; nil while
    /// it can.
    var machineWarning: String? {
        if composer.choices.awaitsComputers { return Strings.ComposeTarget.stillLoading }
        return composer.choices.offline.map(Strings.ComposeTarget.offline)
    }

    /// The status dot a computer wears in the menu, as the session list's.
    static func dot(_ color: UIColor) -> UIImage {
        let side: CGFloat = 8
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            color.setFill()
            UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: side, height: side)).fill()
        }.withRenderingMode(.alwaysOriginal)
    }

    private static func status(_ target: MachineTarget, for kind: HomeDockKind) -> (text: String, color: UIColor) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let online = target.isOnline(for: kind)
        return (Strings.ComposeTarget.status(target, for: kind, now: now),
                UIColor(online ? Palette.sessionStatusOnline : Palette.sessionStatusDisconnected))
    }

    /// A bot's name refused before anything starts: true when the screen
    /// asked for it in place; false leaves it to an alert.
    var askName: ((String) -> Bool)?

    /// The folder on it, as its picker names it.
    var folderName: String { composer.choices.currentProject?.name ?? Strings.Home.noProject }

    /// A machine with no folder picked yet (another one was just chosen,
    /// or nothing was ever picked) starts in its most recent folder, or
    /// home: the folders follow the machine. True when it moved the draft,
    /// whose change comes back here.
    private func followMachine() -> Bool {
        let choices = composer.choices
        let draft = composer.drafts.draft
        guard choices.currentMachine != nil, draft.selectedPath == nil, draft.selectedProjectId == nil, sessionId == nil else { return false }
        let recent = choices.sessionPlaces.first { $0.projectId == nil && $0.path != nil }
        composer.drafts.setPath(recent?.key ?? "~")
        return true
    }

    /// The first message: the session started with it, its id once the
    /// session is open and the message is in its outbox. Throws when it
    /// didn't start, having said why.
    func start(_ message: OutgoingMessage) async throws -> String {
        if let sessionId { return sessionId }
        let drafts = composer.drafts
        let composer = composer
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        drafts.setInput(text)
        let started = drafts.draft
        let bot = drafts.bot
        let createsTask = drafts.createsTask
        let attachments = message.attachments
        // Nothing is asked before the computers are known: the panel
        // isn't up yet to ask it.
        if !knowsComputers, let warning = machineWarning {
            showStartError(warning)
            throw Refused(message: warning)
        }
        // A bot's name is asked for where it is typed, before anything
        // starts; the text stays in the composer.
        if bot.createsBot, let problem = BotName.problem(bot.botName) {
            if askName?(problem) != true { showStartError(problem) }
            throw Refused(message: problem)
        }
        // A computer that doesn't answer is said so in full before anything
        // is asked of it; the text stays.
        if let warning = machineWarning {
            showStartError(warning)
            throw Refused(message: warning)
        }
        onChange?()
        // A bot or a task is Happy Agent's on the chosen computer; the
        // text is its first message either way.
        let resolved = bot.createsBot
            ? await composer.launchBotPrepared(prompt: text, attachments: attachments)
            : createsTask
            ? await composer.launchTaskPrepared(prompt: text, attachments: attachments)
            : await composer.launchPrepared(prompt: text, attachments: attachments)
        // If the target moved meanwhile (another computer, path, harness,
        // kind or bot name), nothing starts.
        let isCurrentTarget = { composer.isCurrentTarget(started, bot: bot, createsTask: createsTask) }
        guard isCurrentTarget() else { throw Refused(message: SessionStarter.Message.startFailed) }
        let launch: NewSessionLaunch
        switch resolved {
        case .success(let value):
            launch = value
        case .failure(let refusal):
            let message = refusal.errorDescription ?? SessionStarter.Message.startFailed
            showStartError(message)
            onChange?()
            throw Refused(message: message)
        }
        guard let sessionId = await starter.start(launch, isCurrentTarget: isCurrentTarget) else {
            onChange?()
            throw Refused(message: SessionStarter.Message.startFailed)
        }
        self.sessionId = sessionId
        // Only what was sent is cleared: edits made while it ran stay. The
        // next compose offers a session again, and a next bot a clean name,
        // as home's dock did.
        if drafts.draft.input == text { drafts.setInput("") }
        if bot.createsBot {
            if drafts.botName == bot.botName { drafts.setBotName("") }
            drafts.setCreatesBot(false)
        }
        if createsTask { drafts.setCreatesTask(false) }
        onChange?()
        return sessionId
    }

    /// The screen went before the machine answered.
    func cancel() {
        feed?.cancel()
        guard sessionId == nil else { return }
        starter.cancel()
    }

    // MARK: Target

    /// The machines, built as it opens. Another one starts in its own most
    /// recent folder (`followMachine`).
    func machineMenu() -> UIMenu {
        UIMenu(children: [
            UIDeferredMenuElement.uncached { [weak self] completion in
                completion(self?.machineMenuElements() ?? [])
            },
        ])
    }

    /// The chosen machine's folders, most recent first, and a custom path.
    func folderMenu() -> UIMenu {
        UIMenu(children: [
            UIDeferredMenuElement.uncached { [weak self] completion in
                completion(self?.folderMenuElements() ?? [])
            },
        ])
    }

    func harnessMenu() -> UIMenu {
        UIMenu(children: [
            UIDeferredMenuElement.uncached { [weak self] completion in
                completion(self?.harnessMenuElements() ?? [])
            },
        ])
    }

    /// The harness row with nothing to run: setup help, not a menu.
    /// Nothing to run on the computer: the row is setup help. Not while the
    /// computers are still arriving, when nothing is known yet.
    var offersHarnessHelp: Bool { !composer.choices.hasAvailableHarness && !composer.choices.awaitsComputers }

    func openHarnessHelp() {
        guard offersHarnessHelp else { return }
        host?.openBrowser(Strings.Home.harnessHelpURL)
    }

    func harnessMenuElements() -> [UIMenuElement] {
        let composer = composer
        return [Self.section(Strings.Home.harnessTitle, composer.choices.agentOptions, selected: composer.choices.currentAgent.key) {
            composer.selectAgent($0)
        }]
    }

    /// Online first, each with whether it answers; for a bot or a task only
    /// the computers whose Happy Agent makes it.
    func machineMenuElements() -> [UIMenuElement] {
        let composer = composer
        let kind = kind
        let selected = composer.choices.currentTarget?.id
        let actions = composer.choices.machines(for: kind).map { target in
            let status = Self.status(target, for: kind)
            return UIAction(
                title: target.name,
                subtitle: status.text,
                image: Self.dot(status.color),
                state: target.id == selected ? .on : .off
            ) { _ in composer.selectMachine(target.id) }
        }
        if actions.isEmpty, composer.choices.awaitsComputers {
            let loading = UIAction(title: Strings.ComposeTarget.loading, attributes: .disabled) { _ in }
            return [UIMenu(title: Strings.ComposeTarget.machinesTitle(kind), options: .displayInline, children: [loading])]
        }
        // Tapping the row while the computer is offline says why at the head.
        let title = machineWarning ?? Strings.ComposeTarget.machinesTitle(kind)
        return [UIMenu(title: title, options: .displayInline, children: actions)]
    }

    func folderMenuElements() -> [UIMenuElement] {
        let composer = composer
        let choices = composer.choices
        let custom = NewSessionChoices.Option(key: NewSessionChoices.customPathKey, name: Strings.Home.enterCustomPath, isAction: true)
        return [
            Self.section(Strings.Home.projectsSection, choices.projectOptions, selected: choices.currentProject?.key) { composer.selectProject($0) },
            Self.section(nil, [custom], selected: nil) { [weak self] _ in self?.askForCustomPath() },
        ]
    }

    private static func section(_ title: String?, _ options: [NewSessionChoices.Option], selected: String?, select: @escaping (String) -> Void) -> UIMenu {
        UIMenu(title: title ?? "", options: .displayInline, children: options.map { option in
            UIAction(
                title: option.name,
                subtitle: option.description,
                attributes: option.isDisabled ? .disabled : [],
                state: !option.isAction && option.key == selected ? .on : .off
            ) { _ in select(option.key) }
        })
    }

    private func askForCustomPath() {
        guard let host else { return }
        let alert = UIAlertController(title: Strings.Home.enterCustomPath, message: nil, preferredStyle: .alert)
        alert.addTextField { [composer] field in
            field.placeholder = Strings.Home.customPathPlaceholder
            field.text = composer.drafts.draft.selectedPath ?? "~"
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default) { [weak self, weak alert] _ in
            self?.composer.selectCustomPath(alert?.textFields?.first?.text)
        })
        host.present(alert, animated: true)
    }
}

extension LegacyComposeStart: SessionStarterPresenter {
    func showStartError(_ message: String) {
        guard let host else { return }
        Alerts.show(Strings.Common.error, message, on: host)
    }

    func confirmDirectoryCreation(_ directory: String) async -> Bool {
        guard let host else { return false }
        return await Alerts.confirm(
            Strings.Home.createDirectoryTitle,
            Strings.Home.createDirectoryMessage(directory),
            confirmTitle: Strings.Home.create,
            on: host
        )
    }

    func showAttachmentsNotSupported() {
        guard let host else { return }
        Alerts.show(Strings.ImageUpload.notSupportedTitle, Strings.ImageUpload.notSupportedMessage, on: host)
    }
}

/// A `compose-chat:` composer's sends: the first starts the session.
struct ComposeChatSender: ChatSending {
    let start: @MainActor @Sendable (OutgoingMessage) async throws -> String

    func send(_ message: OutgoingMessage, sessionId: String) async throws -> String {
        _ = try await start(message)
        // The message is in the new session's outbox under its own id; the
        // screen reads it from there once it is the session's.
        return "compose:\(UUID().uuidString.lowercased())"
    }

    func retry(localId: String) async throws {}
    func discard(localId: String) async throws {}
}

/// A `compose-chat:` composer's draft: the account's new-session draft,
/// which outlives the screen, so leaving and composing again finds it.
struct ComposeDraftStorage: ComposerStorage {
    let drafts: NewSessionDraftStore

    func composerValue(sessionId: String) async throws -> ComposerStoreValue {
        let drafts = drafts
        return ComposerStoreValue(draft: await MainActor.run { drafts.draft.input })
    }

    func saveDraft(sessionId: String, text: String) async throws {
        let drafts = drafts
        await MainActor.run { if drafts.draft.input != text { drafts.setInput(text) } }
    }

    /// Only this screen writes it while it is open: the first value is all.
    func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> {
        let drafts = drafts
        return AsyncThrowingStream { continuation in
            let task = Task { @MainActor in
                continuation.yield(ComposerStoreValue(draft: drafts.draft.input))
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
#endif

#if canImport(UIKit)
import HappyCore
import HappyStore
import UIKit

// An empty chat opened by compose, before it has a session. The screen is
// the chat screen itself, on a `compose-chat:` id: its composer writes the
// account's new-session draft (the text the home dock used to keep), and
// its first send starts the session on the draft's machine, folder and
// harness, the last ones picked, with that text as the first message. The
// screen then becomes the session's chat in place (`becomeChat`): the same
// screen and the same composer, retargeted.
//
// A start that fails or is refused says why, and the text stays in the
// composer and the draft for another send. Leaving before it has answered
// stops it; the draft stays for the next compose.

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
        composer = NewSessionComposer(
            drafts: NewSessionDraftStore.shared(for: context.account.localSettings),
            snapshot: snapshot,
            ops: account.homeOps
        )
        starter = Self.makeStarter(account)
        super.init()
        starter.presenter = self
        starter.onPhaseChange = { [weak self] _ in self?.onChange?() }
        composer.onChange = { [weak self] in self?.onChange?() }
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

    /// "Starting Claude…" and the rest while the start runs.
    var progress: String? {
        let choices = composer.choices
        return NewSessionProgress.label(phase: starter.phase, agentName: choices.currentAgent.name, picksWorkspaces: choices.picksWorkspaces)
    }

    /// Where the first send goes: the machine and the folder, as the
    /// pickers name them.
    var target: String {
        let choices = composer.choices
        let machine = choices.currentMachine?.name ?? Strings.Home.selectMachine
        let project = choices.currentProject?.name ?? Strings.Home.noProject
        return "\(machine) · \(project)"
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
        onChange?()
        let resolved = await composer.launchPrepared(prompt: text, attachments: message.attachments)
        guard composer.isCurrentTarget(started, bot: bot) else { throw Refused(message: SessionStarter.Message.startFailed) }
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
        guard let sessionId = await starter.start(launch, isCurrentTarget: { composer.isCurrentTarget(started, bot: bot) }) else {
            onChange?()
            throw Refused(message: SessionStarter.Message.startFailed)
        }
        self.sessionId = sessionId
        // Only what was sent is cleared: edits made while it ran stay.
        if drafts.draft.input == text { drafts.setInput("") }
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

    /// The machine, folder and harness the first send goes to, each a
    /// section, built as it opens.
    func targetMenu() -> UIMenu {
        UIMenu(children: [
            UIDeferredMenuElement.uncached { [weak self] completion in
                completion(self?.targetMenuElements() ?? [])
            },
        ])
    }

    private func targetMenuElements() -> [UIMenuElement] {
        let composer = composer
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
        let custom = NewSessionChoices.Option(key: NewSessionChoices.customPathKey, name: Strings.Home.enterCustomPath, isAction: true)
        var elements: [UIMenuElement] = [
            section(Strings.Home.machineTitle, choices.machineOptions, selected: draft.selectedMachineId) { composer.selectMachine($0) },
            section(Strings.Home.projectsSection, choices.projectOptions, selected: choices.currentProject?.key) { composer.selectProject($0) },
            section(nil, [custom], selected: nil) { [weak self] _ in self?.askForCustomPath() },
        ]
        if choices.agentOptions.count > 1 {
            elements.append(section(Strings.Home.harnessTitle, choices.agentOptions, selected: draft.agentType.rawValue) { composer.selectAgent($0) })
        }
        return elements
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

    /// Compose makes sessions, never bots.
    func offerBotFaceRetry(_ message: String) async -> Bool { false }
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

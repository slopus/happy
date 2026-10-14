#if canImport(UIKit)
import HappyCore
import HappyStore
import HappyWire
import UIKit

/// The "Session" alert a long press on a home row opens, and what each item
/// does (hooks/useSessionQuickActions.ts). happy-app's popover is web-only;
/// on a phone it is this alert.
@MainActor
final class HomeSessionActions {
    private let context: AppContext
    private let session: AccountSession
    private weak var host: UIViewController?
    /// useHappyAction: one run at a time per action.
    private var running: Set<String> = []
    /// The session whose alert is being read from the store.
    private var opening: String?
    /// useSessionQuickActions' `onBeforeArchive`: on the press, before the
    /// machine is asked anything, so a screen showing the chat can leave it
    /// while it is still whole (the worktree tab strip).
    var onBeforeArchive: ((String) -> Void)?

    init(context: AppContext, session: AccountSession, host: UIViewController) {
        self.context = context
        self.session = session
        self.host = host
    }

    /// The record, its computer and the settings are read off the main
    /// thread; the alert opens once they are in, if the account and the
    /// screen are still there.
    func present(sessionId: String) {
        guard host != nil, opening == nil else { return }
        opening = sessionId
        let account = session
        let store = account.store
        Task { @MainActor [weak self] in
            let read = await Task.detached(priority: .userInitiated) { () -> (SessionRecord, MachineRecord?, AccountSettings)? in
                guard let record = try? store.session(id: sessionId) else { return nil }
                let machine = record.metadata?["machineId"]?.stringValue.flatMap { try? store.machine(id: $0) }
                let settings = (try? store.settingsSnapshot()).map(AccountSettings.init) ?? AccountSettings()
                return (record, machine ?? nil, settings)
            }.value
            guard let self else { return }
            self.opening = nil
            guard let (record, machine, settings) = read, self.context.account.session === account else { return }
            self.present(record, machine: machine, settings: settings)
        }
    }

    private func present(_ record: SessionRecord, machine: MachineRecord?, settings: AccountSettings) {
        guard let host, host.view.window != nil, host.presentedViewController == nil else { return }
        let actions = SessionQuickActions(
            session: record,
            machine: machine,
            settings: settings,
            devModeEnabled: context.account.localSettings.devModeEnabled
        )
        let alert = UIAlertController(title: Strings.Session.actionsTitle, message: nil, preferredStyle: .alert)
        for item in actions.items {
            let style: UIAlertAction.Style = item == .archive ? .destructive : .default
            alert.addAction(UIAlertAction(title: Self.title(item), style: style) { [weak self] _ in
                self?.run(item, record: record, actions: actions, settings: settings)
            })
        }
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        host.present(alert, animated: true)
    }

    static func title(_ item: SessionQuickActions.Item) -> String {
        switch item {
        case .details: Strings.Home.details
        case .resume: Strings.Home.resumeSession
        case .fork: Strings.Home.forkAction
        case .duplicate: Strings.Home.duplicateAction
        case .copyMetadata: Strings.Home.copyMetadata
        case .copyMetadataAndLogs: Strings.Home.copyMetadataAndLogs
        case .archive: Strings.Session.archiveAction
        }
    }

    private func run(_ item: SessionQuickActions.Item, record: SessionRecord, actions: SessionQuickActions, settings: AccountSettings) {
        switch item {
        case .details:
            host?.push(.sessionInfo(id: record.id), context: context)
        case .resume:
            perform("resume:\(record.id)") { [weak self] in
                try await self?.resume(record, availability: actions.resume, settings: settings)
            }
        case .fork:
            perform("fork:\(record.id)") { [weak self] in
                try await self?.fork(actions)
            }
        case .duplicate:
            guard actions.canFork else { return }
            host?.presentDuplicateSheet(sessionId: record.id, context: context)
        case .copyMetadata:
            copy(SessionQuickActions.metadataText(record))
        case .copyMetadataAndLogs:
            copy(SessionQuickActions.metadataAndLogsText(record))
        case .archive:
            // Taken before the hook, which may swap this screen out.
            let window = host?.view.window
            onBeforeArchive?(record.id)
            archive(record.id, in: window)
        }
    }

    /// useHappyAction: a `HomeActionError` shows its message; anything else
    /// is "Unknown error".
    private func perform(_ key: String, _ action: @escaping @MainActor () async throws -> Void) {
        guard !running.contains(key) else { return }
        running.insert(key)
        Task { @MainActor [weak self] in
            do {
                try await action()
            } catch let error as HomeActionError {
                self?.alert(Strings.Home.actionError, error.message)
            } catch {
                self?.alert(Strings.Home.actionError, Strings.Home.actionUnknownError)
            }
            self?.running.remove(key)
        }
    }

    private func resume(_ record: SessionRecord, availability: SessionQuickActions.Resume, settings: AccountSettings) async throws {
        guard availability.canResume, let machineId = record.metadata?["machineId"]?.stringValue else {
            throw HomeActionError(Self.message(availability.blocker ?? .missingMachine))
        }
        let store = session.store
        let sessionId = record.id
        let composer = await Task.detached(priority: .userInitiated) {
            (try? store.composerState(sessionId: sessionId).values) ?? .object([:])
        }.value
        let modes: (model: String?, permissionMode: String?)
        do {
            modes = try SessionQuickActions.resumeModes(session: record, composer: composer, settings: settings)
        } catch let error as UnsupportedPermissionModeError {
            // Refused loudly rather than swapped for a default.
            throw HomeActionError(error.errorDescription ?? Strings.Home.actionUnknownError)
        }
        let result = await session.homeOps.machineResumeSession(
            machineId: machineId,
            sessionId: record.id,
            model: modes.model,
            permissionMode: modes.permissionMode
        )
        switch result {
        case .success(let sessionId):
            // The session reconnects under the same id; refresh to see it.
            await session.sync.invalidate(.sessions)
            if let permission = composer["permissionMode"] {
                try? await session.actions.sessionSetAgentModes(
                    sessionId: sessionId,
                    patch: SessionAgentModesPatch(permissionMode: permission),
                    transport: session.realtime
                )
            }
            open(sessionId)
        case .requestToApproveDirectoryCreation:
            throw HomeActionError(Strings.Home.resumeSessionUnexpectedDirectoryPrompt)
        case .error(let message):
            throw HomeActionError(message)
        case .pending:
            throw HomeActionError(Strings.Home.actionUnknownError)
        }
    }

    private func fork(_ actions: SessionQuickActions) async throws {
        guard actions.canFork, let source = actions.forkSource else {
            throw HomeActionError(Strings.Home.forkErrorMissingMetadata)
        }
        switch await session.homeOps.forkAndSpawn(source: source, options: ForkOptions()) {
        case .success(let sessionId):
            open(sessionId)
        case .error(let message):
            throw HomeActionError(message)
        default:
            throw HomeActionError(Strings.Home.forkErrorGeneric)
        }
    }

    private func copy(_ text: String?) {
        guard let text else {
            alert(Strings.Common.error, Strings.Home.failedToCopyMetadata)
            return
        }
        UIPasteboard.general.string = text
        alert(Strings.Common.success, Strings.Home.metadataCopied)
    }

    /// A failure is shown in front of the window the press came from, not on
    /// the screen that asked: archiving the open tab moves the chat to its
    /// neighbour, and that screen and these actions are gone by the time
    /// the machine answers. Nothing is shown once another account is open.
    func archive(_ sessionId: String, in window: UIWindow? = nil) {
        let actions = session.actions
        let context = context
        let window = window ?? host?.view.window
        Task { @MainActor [weak window, weak account = self.session] in
            do {
                try await actions.archive(sessionId: sessionId)
            } catch {
                guard let account, context.account.session === account, let front = Self.front(of: window) else { return }
                let message = (error as? SessionActionError) == .botNeedsMachine
                    ? Strings.SessionInfo.botNeedsMachine
                    : Strings.SessionInfo.failedToArchiveSession
                Alerts.show(Strings.Common.error, message, on: front)
            }
        }
    }

    /// The screen in front of `window`: the last one its root presented.
    static func front(of window: UIWindow?) -> UIViewController? {
        guard var front = window?.rootViewController else { return nil }
        while let presented = front.presentedViewController, !presented.isBeingDismissed { front = presented }
        return front
    }

    private func open(_ sessionId: String) {
        host?.push(.session(id: sessionId), context: context)
    }

    private func alert(_ title: String, _ message: String) {
        guard let host else { return }
        Alerts.show(title, message, on: host.presentedViewController ?? host)
    }

    static func message(_ blocker: SessionQuickActions.Resume.Blocker) -> String {
        switch blocker {
        case .missingMachine: Strings.Home.resumeSessionMissingMachine
        case .missingBackendId: Strings.Home.resumeSessionMissingBackendId
        case .sameMachineOnly: Strings.Home.resumeSessionSameMachineOnly
        case .machineOffline: Strings.Home.resumeSessionMachineOffline
        }
    }
}

/// A HappyError: its message is what the person reads.
struct HomeActionError: Error {
    let message: String

    init(_ message: String) {
        self.message = message
    }
}
#endif

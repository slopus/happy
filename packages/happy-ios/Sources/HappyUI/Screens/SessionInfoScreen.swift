#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import HappyStore
import HappyWire
import UIKit

/// app/(app)/session/[id]/info.tsx: quick actions, the session's ids and
/// state, its metadata, agent state and activity. Reads only the local
/// store; git status comes from `GitStatusSync`.
final class SessionInfoViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let sessionId: String
    private let list = GroupedListView()
    private var observation: StoreObservation?
    private var gitTask: Task<Void, Never>?
    private var snapshot: HomeSnapshot?
    private var gitStatus: GitStatus?
    private var forking = false
    private var busy = Set<Action>()
    private var copiedResumeCommand = false
    private var copiedReset: Task<Void, Never>?
    private var stateView: UIView?

    private enum Action: Hashable { case archive, delete, resume, fork }

    init(context: AppContext, session: AccountSession, sessionId: String) {
        self.context = context
        self.session = session
        self.sessionId = sessionId
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        gitTask?.cancel()
        copiedReset?.cancel()
    }

    override func loadView() {
        view = UIView()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        view.addSubview(list)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        showsBackTitle()
        dropsBackButtonOnTablet() // Tablet (HappyUI/Tablet): navigation/Header.tsx
        observation = session.store.observeHome { [weak self] snapshot in
            self?.snapshot = snapshot
            self?.rebuild()
        }
        let git = session.detailGitStatus
        let id = sessionId
        gitTask = Task { [weak self] in
            for await status in await git.observe(sessionId: id) {
                guard let self, !Task.isCancelled else { return }
                self.gitStatus = status
                self.rebuild()
            }
        }
        Task { await git.refresh(sessionId: id) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.frame = view.bounds
        stateView?.frame = view.bounds
    }

    // MARK: Model

    private var record: SessionRecord? {
        snapshot?.sessions.first { $0.id == sessionId }
    }

    private func machine(for record: SessionRecord) -> MachineRecord? {
        guard let id = record.metadata?["machineId"]?.stringValue else { return nil }
        return snapshot?.machines.machines.first { $0.id == id }
    }

    private var settings: AccountSettings {
        AccountSettings(snapshot?.settings ?? SettingsSnapshot())
    }

    private var composer: JSONValue {
        (try? session.store.composerState(sessionId: sessionId))?.values ?? .object([:])
    }

    /// happy-app's `isDataReady`: sessions have been fetched at least once.
    private var isDataReady: Bool {
        ((try? session.store.cursor(.sessionsChangedSince)) ?? nil) != nil || snapshot?.sessions.isEmpty == false
    }

    // MARK: Building

    private func rebuild() {
        guard snapshot != nil else { return }
        guard let record else {
            showState(isDataReady ? deletedView() : loadingView(), title: isDataReady ? Strings.SessionDetail.sessionDeleted : "")
            return
        }
        stateView?.removeFromSuperview()
        stateView = nil
        list.isHidden = false
        let model = SessionInfoModel(
            session: record,
            machine: machine(for: record),
            settings: settings,
            gitStatus: gitStatus,
            permissionMode: composer["permissionMode"]?.stringValue ?? record.metadata?["permissionMode"]?.stringValue
        )
        title = model.title ?? Strings.Session.newChat
        var sections: [UIView] = [quickActions(model, record: record)]
        if model.cliOutdated { sections.append(cliWarning()) }
        sections.append(details(model))
        if let metadata = model.metadata { sections.append(metadataGroup(metadata, model: model, record: record)) }
        if let state = model.agentState { sections.append(agentStateGroup(state)) }
        sections.append(activityGroup(model))
        #if DEBUG
        sections.append(rawJSON(record))
        #endif
        list.sections = sections
    }

    private func showState(_ view: UIView, title: String) {
        self.title = title
        list.isHidden = true
        stateView?.removeFromSuperview()
        stateView = view
        self.view.addSubview(view)
        view.frame = self.view.bounds
    }

    private func loadingView() -> UIView {
        DetailMessageView(lead: IconView(.ionicons("hourglass-outline"), size: 48, tint: Palette.textSecondary), lines: [
            .init(text: Strings.SessionDetail.loading, style: SecondaryTextStyles.infoLoading, color: Palette.textSecondary, spacingBefore: 16),
        ])
    }

    private func deletedView() -> UIView {
        DetailMessageView(lead: IconView(.ionicons("trash-outline"), size: 48, tint: Palette.textSecondary), lines: [
            .init(text: Strings.SessionDetail.sessionDeleted, style: SecondaryTextStyles.infoDeletedTitle, color: Palette.text, spacingBefore: 16),
            .init(text: Strings.SessionDetail.sessionDeletedDescription, style: SecondaryTextStyles.infoDeletedBody, color: Palette.textSecondary,
                  spacingBefore: 8, horizontalPadding: 32, centered: true),
        ])
    }

    private func icon(_ name: String, _ tint: ColorToken, size: CGFloat = 29) -> ItemIcon {
        ItemIcon(.ionicons(name), tint: tint, size: size)
    }

    private func info(_ title: String, subtitle: String? = nil, detail: String? = nil, icon: ItemIcon) -> ItemRowView {
        let row = ItemRowView(title: title, subtitle: subtitle, detail: detail, icon: icon)
        row.showsChevron = false
        return row
    }

    private func quickActions(_ model: SessionInfoModel, record: SessionRecord) -> ItemGroupView {
        typealias S = Strings.SessionDetail
        var rows: [ItemRowView] = []
        let changes = ItemRowView(
            title: Strings.FilesDetail.changes,
            icon: ItemIcon(.octicons("file-diff"), tint: SecondaryPalette.blue, size: 26)
        ) { [weak self] in
            guard let self else { return }
            push(.sessionChanges(id: sessionId), context: context)
        }
        if model.git.hasAccessory { changes.trailingView = DetailChangesAccessoryView(model.git) }
        rows.append(changes)

        if let machineId = model.machineId {
            rows.append(ItemRowView(title: S.viewMachine, subtitle: S.viewMachineSubtitle, icon: icon("server-outline", SecondaryPalette.blue)) { [weak self] in
                guard let self else { return }
                push(.machine(id: machineId), context: context)
            })
        }
        if model.resume.showsRow {
            let row = ItemRowView(title: S.resumeSession, subtitle: model.resume.canResume ? S.resumeSessionSubtitle : resumeMessages.message(for: model.resume),
                                  icon: icon("play-circle-outline", SecondaryPalette.blue)) { [weak self] in
                self?.resume()
            }
            rows.append(row)
        }
        if model.canFork {
            let fork = ItemRowView(title: S.forkAction, subtitle: S.forkSubtitle, icon: icon("git-branch-outline", SecondaryPalette.blue)) { [weak self] in
                self?.fork(canFork: model.canFork)
            }
            fork.isLoading = forking
            rows.append(fork)
            rows.append(ItemRowView(title: S.duplicateAction, subtitle: S.duplicateSubtitle, icon: icon("time-outline", SecondaryPalette.blue)) { [weak self] in
                self?.openDuplicateSheet()
            })
        }
        if let parent = model.parentSessionId {
            rows.append(ItemRowView(title: S.forkedFromLabel, subtitle: S.forkedFromSubtitle, icon: icon("return-up-back-outline", SecondaryPalette.purple)) { [weak self] in
                guard let self else { return }
                push(.session(id: parent), context: context)
            })
        }
        rows.append(ItemRowView(title: S.archiveSession, subtitle: S.archiveSessionSubtitle, icon: icon("archive-outline", SecondaryPalette.red)) { [weak self] in
            self?.archive()
        })
        if !model.isBot {
            rows.append(ItemRowView(title: S.deleteSession, subtitle: S.deleteSessionSubtitle, icon: icon("trash-outline", SecondaryPalette.red)) { [weak self] in
                self?.confirmDelete()
            })
        }
        let group = ItemGroupView(title: S.quickActions, rows: rows)
        group.keepsLastDivider(model.isBot)
        return group
    }

    private func cliWarning() -> ItemGroupView {
        typealias S = Strings.SessionDetail
        let row = ItemRowView(title: S.cliVersionOutdated, subtitle: S.updateCliInstructions, icon: icon("warning-outline", SecondaryPalette.orange)) { [weak self] in
            guard let self else { return }
            UIPasteboard.general.string = S.updateCommand
            Alerts.show(Strings.Common.success, S.updateCommand, on: self)
        }
        row.showsChevron = false
        return ItemGroupView(rows: [row])
    }

    private func details(_ model: SessionInfoModel) -> ItemGroupView {
        typealias S = Strings.SessionDetail
        var rows: [ItemRowView] = []
        rows.append(ItemRowView(title: S.happySessionId, subtitle: model.sessionIdShort, icon: icon("finger-print-outline", SecondaryPalette.blue)) { [weak self] in
            self?.copy(model.sessionId, success: S.happySessionIdCopied)
        })
        if let claude = model.claudeSessionId {
            rows.append(ItemRowView(title: S.claudeCodeSessionId, subtitle: SessionDetails.shortId(claude), icon: icon("code-outline", SecondaryPalette.claude)) { [weak self] in
                self?.copy(claude, success: S.claudeCodeSessionIdCopied)
            })
        }
        if let codex = model.codexThreadId {
            rows.append(ItemRowView(title: S.codexThreadId, subtitle: SessionDetails.shortId(codex), icon: icon("terminal-outline", SecondaryPalette.codex)) { [weak self] in
                self?.copy(codex, success: S.codexThreadIdCopied)
            })
        }
        if let command = model.resumeCommand {
            // info.tsx CopyableItem: copies quietly and shows a check for 2s.
            let row = ItemRowView(title: S.resumeCommand, subtitle: command, icon: icon("play-circle-outline", SecondaryPalette.copied)) { [weak self] in
                self?.copyResumeCommand(command)
            }
            row.showsChevron = false
            row.trailingView = copiedResumeCommand
                ? DetailTrailingIcon(.ionicons("checkmark"), size: 18, tint: SecondaryPalette.copied)
                : DetailTrailingIcon(.ionicons("copy-outline"), size: 18, tint: SecondaryPalette.gray)
            rows.append(row)
        }
        rows.append(info(
            S.connectionStatus,
            detail: model.isConnected ? Strings.Status.online : Strings.Status.offline,
            icon: icon("pulse-outline", model.isConnected ? SecondaryPalette.green : SecondaryPalette.gray)
        ))
        rows.append(info(S.created, subtitle: SessionDetails.localeDateTime(model.createdAt), icon: icon("calendar-outline", SecondaryPalette.blue)))
        rows.append(info(S.lastUpdated, subtitle: SessionDetails.localeDateTime(model.updatedAt), icon: icon("time-outline", SecondaryPalette.blue)))
        rows.append(info(S.sequence, detail: String(model.seq), icon: icon("git-commit-outline", SecondaryPalette.blue)))
        return ItemGroupView(rows: rows)
    }

    private func metadataGroup(_ metadata: SessionInfoModel.Metadata, model: SessionInfoModel, record: SessionRecord) -> ItemGroupView {
        typealias S = Strings.SessionDetail
        let purple = SecondaryPalette.purple
        var rows: [ItemRowView] = []
        rows.append(info(S.host, subtitle: metadata.host, icon: icon("desktop-outline", purple)))
        rows.append(info(S.path, subtitle: metadata.path, icon: icon("folder-outline", purple)))
        if let version = metadata.cliVersion {
            rows.append(info(S.cliVersion, subtitle: version, detail: model.cliOutdated ? "⚠️" : nil,
                             icon: icon("git-branch-outline", model.cliOutdated ? SecondaryPalette.orange : purple)))
        }
        if let os = metadata.operatingSystem {
            rows.append(info(S.operatingSystem, subtitle: os, icon: icon("hardware-chip-outline", purple)))
        }
        if let client = metadata.client {
            rows.append(info(S.client, subtitle: client, icon: icon("terminal-outline", purple)))
        }
        rows.append(info(S.aiProvider, subtitle: metadata.aiProvider, icon: icon("sparkles-outline", purple)))
        if let modelName = metadata.model {
            rows.append(info(S.model, subtitle: modelName, icon: icon("hardware-chip-outline", purple)))
        }
        if let sandbox = metadata.sandbox {
            rows.append(info(S.sandbox, subtitle: sandbox, icon: icon("shield-outline", purple)))
        }
        if let skip = metadata.dangerouslySkipPermissions {
            rows.append(info(S.dangerouslySkipPermissions, subtitle: skip, icon: icon("warning-outline", purple)))
        }
        if let pid = metadata.processId {
            rows.append(info(S.processId, subtitle: pid, icon: icon("terminal-outline", purple)))
        }
        if let home = metadata.happyHome {
            rows.append(info(S.happyHome, subtitle: home, icon: icon("home-outline", purple)))
        }
        rows.append(ItemRowView(title: S.copyMetadata, icon: icon("copy-outline", SecondaryPalette.blue)) { [weak self] in
            self?.copyMetadata(record, withLogs: false)
        })
        rows.append(ItemRowView(title: S.copyMetadataAndLogs, icon: icon("document-text-outline", SecondaryPalette.blue)) { [weak self] in
            self?.copyMetadata(record, withLogs: true)
        })
        return ItemGroupView(title: S.metadata, rows: rows)
    }

    private func agentStateGroup(_ state: SessionInfoModel.AgentState) -> ItemGroupView {
        typealias S = Strings.SessionDetail
        let orange = SecondaryPalette.orange
        var rows = [info(S.controlledByUser, detail: state.controlledByUser ? S.yes : S.no, icon: icon("person-outline", orange))]
        if state.pendingRequests > 0 {
            rows.append(info(S.pendingRequests, detail: String(state.pendingRequests), icon: icon("hourglass-outline", orange)))
        }
        let group = ItemGroupView(title: S.agentState, rows: rows)
        group.keepsLastDivider(state.pendingRequests == 0)
        return group
    }

    private func activityGroup(_ model: SessionInfoModel) -> ItemGroupView {
        typealias S = Strings.SessionDetail
        let purple = SecondaryPalette.purple
        var rows = [info(S.thinking, detail: model.thinking ? S.yes : S.no,
                         icon: icon("bulb-outline", model.thinking ? SecondaryPalette.yellow : SecondaryPalette.gray))]
        if model.thinking {
            rows.append(info(S.thinkingSince, subtitle: SessionDetails.localeDateTime(model.thinkingAt), icon: icon("timer-outline", SecondaryPalette.yellow)))
        }
        if let subagents = model.activity.subagents {
            rows.append(info(S.subagents, detail: subagents, icon: icon("people-outline", purple)))
        }
        if let workflows = model.activity.workflows {
            rows.append(info(S.workflows, detail: workflows, icon: icon("git-network-outline", purple)))
        }
        if let processes = model.activity.processes {
            rows.append(info(S.backgroundProcesses, detail: processes, icon: icon("terminal-outline", purple)))
        }
        if let tasks = model.activity.tasks {
            rows.append(info(S.tasks, detail: tasks, icon: icon("checkbox-outline", purple)))
        }
        let group = ItemGroupView(title: S.activity, rows: rows)
        group.keepsLastDivider(model.activity.tasks == nil)
        return group
    }

    #if DEBUG
    /// info.tsx's "Raw JSON (Dev Mode)" group, shown in `__DEV__` builds;
    /// here in Debug builds. The rows sit in fragments, so every one keeps
    /// Item's default divider.
    private func rawJSON(_ record: SessionRecord) -> ItemGroupView {
        typealias S = Strings.SessionDetail
        var rows: [UIView] = []
        func block(_ title: String, _ icon: ItemIcon, _ value: JSONValue) {
            let row = info(title, icon: icon)
            rows.append(row)
            rows.append(CodeBlockView(code: SessionDetails.prettyJSON(value)))
        }
        if let state = record.agentState, state != .null {
            block(S.rawAgentState, icon("code-working-outline", SecondaryPalette.orange), state)
        }
        if let metadata = record.metadata, metadata != .null {
            block(S.rawMetadata, icon("information-circle-outline", SecondaryPalette.purple), metadata)
        }
        block(S.rawSession, icon("document-text-outline", SecondaryPalette.green), .object([
            "id": .string(record.id),
            "seq": .number(Double(record.seq)),
            "createdAt": .number(Double(record.createdAt)),
            "updatedAt": .number(Double(record.updatedAt)),
            "active": .bool(record.active),
            "activeAt": .number(Double(record.activeAt)),
            "metadata": record.metadata ?? .null,
            "metadataVersion": .number(Double(record.metadataVersion)),
            "agentState": record.agentState ?? .null,
            "agentStateVersion": .number(Double(record.agentStateVersion)),
            "thinking": .bool(record.thinking),
            "thinkingAt": .number(Double(record.thinkingAt)),
        ]))
        let group = ItemGroupView(title: S.rawJSON, rows: rows)
        group.keepsLastDivider(true)
        return group
    }
    #endif

    // MARK: Actions

    private var resumeMessages: SessionDetailActions.ResumeMessages {
        typealias S = Strings.SessionDetail
        return .init(
            missingMachine: S.resumeSessionMissingMachine,
            missingBackendId: S.resumeSessionMissingBackendId,
            sameMachineOnly: S.resumeSessionSameMachineOnly,
            machineOffline: S.resumeSessionMachineOffline,
            unexpectedDirectoryPrompt: S.resumeSessionUnexpectedDirectoryPrompt
        )
    }

    private func copy(_ text: String, success: String) {
        UIPasteboard.general.string = text
        Alerts.show(Strings.Common.success, success, on: self)
    }

    private func copyResumeCommand(_ command: String) {
        UIPasteboard.general.string = command
        copiedResumeCommand = true
        rebuild()
        copiedReset?.cancel()
        copiedReset = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self else { return }
            self.copiedResumeCommand = false
            self.rebuild()
        }
    }

    private func copyMetadata(_ record: SessionRecord, withLogs: Bool) {
        guard let metadata = record.metadata, metadata != .null else {
            Alerts.show(Strings.Common.error, Strings.SessionDetail.failedToCopyMetadata, on: self)
            return
        }
        UIPasteboard.general.string = SessionDetails.metadataClipboard(metadata, withLogs: withLogs)
        Alerts.show(Strings.Common.success, Strings.SessionDetail.metadataCopied, on: self)
    }

    /// useHappyAction: one run at a time; a failure is an alert.
    private func perform(_ action: Action, on presenter: @escaping @MainActor () -> UIViewController?, _ work: @escaping @MainActor () async throws -> Void) {
        guard !busy.contains(action) else { return }
        busy.insert(action)
        Task { @MainActor [weak self] in
            do {
                try await work()
            } catch {
                if let controller = presenter() { DetailActionAlert.show(error, on: controller) }
            }
            self?.busy.remove(action)
        }
    }

    /// The worktree prompt (useWorktreeCleanup.ts), asked over this screen.
    private var confirmWorktreeCleanup: SessionDetailActions.ConfirmWorktreeCleanup {
        { [weak self] in await self?.askWorktreeCleanup() ?? false }
    }

    private func askWorktreeCleanup() async -> Bool {
        typealias S = Strings.SessionDetail
        return await DetailAlerts.confirm(
            S.worktreeCleanupTitle,
            S.worktreeCleanupMessage,
            confirmTitle: S.worktreeCleanupDelete,
            cancelTitle: S.worktreeCleanupKeep,
            destructive: true,
            on: navigationController ?? self
        )
    }

    private func archive() {
        guard let record else { return }
        let actions = session.detailActions
        let confirm = confirmWorktreeCleanup
        perform(.archive, on: { [weak self] in self?.navigationController ?? self }) { [weak self] in
            try await actions.archive(record, confirmWorktreeCleanup: confirm)
            // Leave this screen and the chat behind it.
            self?.leaveSession()
        }
    }

    private func confirmDelete() {
        typealias S = Strings.SessionDetail
        let alert = UIAlertController(title: S.deleteSession, message: S.deleteSessionWarning, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: S.deleteSession, style: .destructive) { [weak self] _ in self?.delete() })
        present(alert, animated: true)
    }

    private func delete() {
        guard let record else { return }
        let actions = session.detailActions
        let navigation = navigationController
        let confirm = confirmWorktreeCleanup
        if record.isBot {
            DetailActionAlert.show(SessionDetailActions.Failure(SessionDetailActions.botDeleteMessage), on: self)
            return
        }
        perform(.delete, on: { navigation }) { [weak self] in
            // happy-app asks about the worktree, then leaves before deleting.
            await actions.maybeCleanupWorktree(
                sessionId: record.id,
                path: record.metadata?["path"]?.stringValue,
                machineId: record.metadata?["machineId"]?.stringValue,
                confirm: confirm
            )
            self?.leaveSession()
            try await actions.delete(record)
        }
    }

    private func resume() {
        guard let record else { return }
        let actions = session.detailActions
        let machineRecord = machine(for: record)
        let settings = snapshot?.settings.synced?.settings
        let composerValues = composer
        let messages = resumeMessages
        perform(.resume, on: { [weak self] in self }) { [weak self] in
            guard let sessionId = try await actions.resume(record, machine: machineRecord, settings: settings, composer: composerValues, messages: messages),
                  let self else { return }
            push(.session(id: sessionId), context: context)
        }
    }

    private func fork(canFork: Bool) {
        guard let record else { return }
        let actions = session.detailActions
        let messages = SessionDetailActions.ForkMessages(
            missingMetadata: Strings.SessionDetail.forkErrorMissingMetadata,
            generic: Strings.SessionDetail.forkErrorGeneric
        )
        forking = true
        rebuild()
        perform(.fork, on: { [weak self] in self }) { [weak self] in
            defer {
                self?.forking = false
                self?.rebuild()
            }
            let sessionId = try await actions.fork(record, canFork: canFork, messages: messages)
            guard let self else { return }
            push(.session(id: sessionId), context: context)
        }
    }

    private func openDuplicateSheet() {
        presentDuplicateSheet(sessionId: sessionId, context: context)
    }

    /// router.back() twice: off this screen and off the chat it came from.
    private func leaveSession() {
        guard let navigation = navigationController,
              let index = navigation.viewControllers.firstIndex(of: self) else { return }
        let target = navigation.viewControllers[max(0, index - 2)]
        navigation.popToViewController(target, animated: true)
    }
}
#endif

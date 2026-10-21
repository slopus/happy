#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import HappyStore
import UIKit

/// app/(app)/machine/[id].tsx: the daemon's status with Stop Daemon, the
/// CLIs it found, its recent sessions, the machine's details and Delete.
/// The pencil in the header renames it (metadata `displayName`).
final class MachineViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let machineId: String
    private let list = GroupedListView()
    private let refresh = UIRefreshControl()
    /// What the screen shows, worked out off the main thread by the
    /// account's machine feed; nil until the first one.
    private var content: MachineScreenContent?
    private var stoppingDaemon = false
    private var renaming = false
    private var deleting = false
    private var notFound: DetailMessageView?

    init(context: AppContext, session: AccountSession, machineId: String) {
        self.context = context
        self.session = session
        self.machineId = machineId
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        view = UIView()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        view.addSubview(list)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Header.tsx's title and every row's Text scale; the rows are
        // measured from their labels as drawn, as Settings' are.
        followsTextSize()
        // headerBackTitle: machine.back, for screens pushed from here.
        navigationItem.backButtonDisplayMode = .default
        navigationItem.backButtonTitle = Strings.MachineDetail.back
        dropsBackButtonOnTablet() // Tablet (HappyUI/Tablet): navigation/Header.tsx
        refresh.addTarget(self, action: #selector(pulledToRefresh), for: .valueChanged)
        list.refreshControl = refresh
    }

    /// The machine and its recent sessions, read only while this screen is
    /// on screen.
    private lazy var feed = VisibleFeed<MachineScreenContent> { [weak self] content in
        guard let self, self.context.account.session === self.session else { return false }
        ApplyPerf.measure(.screen) {
            // A new metadata version alone only updates what a rename
            // sends; the rows rebuild when what they show did.
            let rebuilds = content.model != self.content?.model || self.content == nil
            self.content = content
            if rebuilds { self.rebuild() }
            return rebuilds ? 1 : 0
        }
        return true
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        feed.start { session.machineDetails.snapshots(machineId: machineId) }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        feed.stop()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.frame = view.bounds
        notFound?.frame = view.bounds
    }

    private var machine: MachineRecord? {
        content?.machine
    }

    // MARK: Building

    private func rebuild() {
        guard let content else { return }
        guard let model = content.model else {
            setPlainHeaderTitle("")
            navigationItem.rightBarButtonItem = nil
            list.isHidden = true
            if notFound == nil {
                let message = DetailMessageView(lead: nil, lines: [
                    .init(text: Strings.MachineDetail.notFound, style: SecondaryTextStyles.machineNotFound, color: SecondaryPalette.notFound),
                ])
                notFound = message
                view.addSubview(message)
                message.frame = view.bounds
            }
            return
        }
        notFound?.removeFromSuperview()
        notFound = nil
        list.isHidden = false
        setPlainHeaderTitle(model.name)
        navigationItem.rightBarButtonItem = renameButton()

        var sections: [UIView] = [daemonGroup(model)]
        if let cli = model.cliAvailability { sections.append(cliGroup(cli)) }
        if !model.recentSessions.isEmpty { sections.append(sessionsGroup(model.recentSessions)) }
        sections.append(machineGroup(model))
        let danger = dangerZone()
        sections.append(danger.group)
        list.sections = sections
        // Title colours go on last: rows re-apply their own when they change.
        danger.tint()
        tintDaemonTitle?()
    }

    private var tintDaemonTitle: (() -> Void)?

    private func renameButton() -> UIBarButtonItem {
        // Octicons pencil 24 in the text colour, dimmed while renaming.
        let button = UIBarButtonItem(image: .icon(.octicons("pencil"), size: 24), style: .plain, target: self, action: #selector(renameTapped))
        button.tintColor = UIColor(Palette.text)
        button.isEnabled = !renaming
        button.accessibilityLabel = Strings.MachineDetail.renameTitle
        return button
    }

    private func info(_ title: String, subtitle: String? = nil, detail: String? = nil) -> ItemRowView {
        ItemRowView(title: title, subtitle: subtitle, detail: detail)
    }

    private func daemonGroup(_ model: MachineDetailsModel) -> ItemGroupView {
        typealias S = Strings.MachineDetail
        var rows: [ItemRowView] = []
        let status = info(S.status, detail: model.online ? Strings.Status.online : Strings.Status.offline)
        status.showsChevron = false
        status.tintDetail(model.online ? SecondaryPalette.green : Palette.textSecondary)
        rows.append(status)

        let stopTint = model.online ? SecondaryPalette.orange : Palette.textSecondary
        let stop = ItemRowView(title: S.stopDaemon)
        if model.online && !stoppingDaemon {
            stop.onTap = { [weak self] in self?.confirmStopDaemon() }
        }
        stop.trailingView = DetailTrailingIcon(.ionicons("stop-circle"), size: 20, tint: stopTint)
        stop.isLoading = stoppingDaemon
        rows.append(stop)
        tintDaemonTitle = { stop.tintTitle(stopTint) }

        if let daemon = model.daemon {
            if let pid = daemon.pid {
                let row = info(S.lastKnownPid, subtitle: pid)
                row.monoSubtitle(SecondaryTextStyles.monoSubtitle)
                rows.append(row)
            }
            if let port = daemon.httpPort {
                let row = info(S.lastKnownHttpPort, subtitle: port)
                row.monoSubtitle(SecondaryTextStyles.monoSubtitle)
                rows.append(row)
            }
            if let started = daemon.startedAt {
                rows.append(info(S.startedAt, subtitle: SessionDetails.localeDateTime(started)))
            }
            if let version = daemon.cliVersion {
                let row = info(S.cliVersion, subtitle: version)
                row.monoSubtitle(SecondaryTextStyles.monoSubtitle)
                rows.append(row)
            }
        }
        rows.append(info(S.daemonStateVersion, subtitle: String(model.daemonStateVersion)))
        return ItemGroupView(rows: rows)
    }

    private func cliGroup(_ cli: MachineDetailsModel.CLIAvailability) -> ItemGroupView {
        typealias S = Strings.MachineDetail
        func row(_ name: String, _ installed: Bool) -> ItemRowView {
            let row = ItemRowView(title: name)
            row.showsChevron = false
            row.trailingView = DetailTrailingText(installed ? S.cliInstalled : S.cliNotFound, color: installed ? SecondaryPalette.green : Palette.textSecondary)
            return row
        }
        var rows = [row("Claude", cli.claude), row("Codex", cli.codex), row("Gemini", cli.gemini), row("OpenClaw", cli.openclaw)]
        if let rig = cli.rig { rows.append(row("Rig", rig)) }
        let detected = ItemRowView(title: S.lastDetected, subtitle: SessionDetails.localeDateTime(cli.detectedAt))
        detected.showsChevron = false
        rows.append(detected)
        return ItemGroupView(title: S.cliAvailability, rows: rows)
    }

    private func sessionsGroup(_ sessions: [MachineDetailsModel.RecentSession]) -> ItemGroupView {
        ItemGroupView(title: Strings.MachineDetail.sessions, rows: sessions.map { recent in
            let row = ItemRowView(
                title: recent.title ?? Strings.Session.newChat,
                subtitle: recent.subtitle ?? Strings.MachineDetail.unknown
            ) { [weak self] in
                guard let self else { return }
                push(.session(id: recent.id), context: context)
            }
            row.trailingView = DetailTrailingIcon(.ionicons("chevron-forward"), size: 20, tint: SecondaryPalette.chevron)
            return row
        })
    }

    private func machineGroup(_ model: MachineDetailsModel) -> ItemGroupView {
        typealias S = Strings.MachineDetail
        var rows = [info(S.host, subtitle: model.host)]
        let id = info(S.machineId, subtitle: model.machineId)
        id.monoSubtitle(SecondaryTextStyles.monoSubtitleSmall)
        rows.append(id)
        if let username = model.username { rows.append(info(S.username, subtitle: username)) }
        if let home = model.homeDirectory {
            let row = info(S.homeDirectory, subtitle: home)
            row.monoSubtitle(SecondaryTextStyles.monoSubtitle)
            rows.append(row)
        }
        if let platform = model.platform { rows.append(info(S.platform, subtitle: platform)) }
        if let arch = model.architecture { rows.append(info(S.architecture, subtitle: arch)) }
        rows.append(info(S.lastSeen, subtitle: model.lastSeen.map { SessionDetails.localeDateTime($0) } ?? S.never))
        rows.append(info(S.metadataVersion, subtitle: String(model.metadataVersion)))
        return ItemGroupView(title: S.machineGroup, rows: rows)
    }

    private func dangerZone() -> (group: ItemGroupView, tint: () -> Void) {
        typealias S = Strings.MachineDetail
        let row = ItemRowView(title: S.delete)
        row.showsChevron = false
        if !deleting {
            row.onTap = { [weak self] in self?.confirmDelete() }
        }
        row.trailingView = DetailTrailingIcon(.ionicons("trash-outline"), size: 20, tint: SecondaryPalette.red)
        row.isLoading = deleting
        return (ItemGroupView(title: S.dangerZone, footer: S.deleteFooter, rows: [row]), { row.tintTitle(SecondaryPalette.red) })
    }

    // MARK: Actions

    @objc private func pulledToRefresh() {
        let actions = session.detailActions
        Task { @MainActor [weak self] in
            await actions.refreshMachines()
            self?.refresh.endRefreshing()
        }
    }

    private func confirmStopDaemon() {
        typealias S = Strings.MachineDetail
        let alert = UIAlertController(title: S.stopDaemonTitle, message: S.stopDaemonMessage, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: S.stopDaemonCancel, style: .cancel))
        alert.addAction(UIAlertAction(title: S.stopDaemonConfirm, style: .destructive) { [weak self] _ in self?.stopDaemon() })
        present(alert, animated: true)
    }

    private func stopDaemon() {
        let actions = session.detailActions
        let id = machineId
        stoppingDaemon = true
        rebuild()
        Task { @MainActor [weak self] in
            do {
                let message = try await actions.stopDaemon(machineId: id)
                if let self { Alerts.show(Strings.MachineDetail.daemonStopped, message, on: self) }
            } catch {
                if let self { Alerts.show(Strings.Common.error, Strings.MachineDetail.stopDaemonFailed, on: self) }
            }
            self?.stoppingDaemon = false
            self?.rebuild()
        }
    }

    @objc private func renameTapped() {
        typealias S = Strings.MachineDetail
        guard let machine, let model = content?.model, !renaming else { return }
        let actions = session.detailActions
        Task { @MainActor [weak self] in
            guard let self, let name = await DetailAlerts.prompt(
                S.renameTitle, S.renameMessage,
                defaultValue: model.displayName,
                placeholder: model.hostPlaceholder ?? S.renamePlaceholder,
                confirmTitle: S.rename,
                on: self
            ) else { return }
            renaming = true
            rebuild()
            do {
                try await actions.renameMachine(machine, displayName: name)
                Alerts.show(Strings.Common.success, S.renamed, on: self)
            } catch {
                Alerts.show(S.renameErrorTitle, (error as? LocalizedError)?.errorDescription ?? S.renameFailed, on: self)
            }
            renaming = false
            rebuild()
        }
    }

    private func confirmDelete() {
        typealias S = Strings.MachineDetail
        let actions = session.detailActions
        let id = machineId
        Task { @MainActor [weak self] in
            guard let self else { return }
            let confirmed = await DetailAlerts.confirm(
                S.deleteConfirmTitle, S.deleteConfirmMessage,
                confirmTitle: Strings.Common.delete, destructive: true, on: self
            )
            guard confirmed else { return }
            deleting = true
            rebuild()
            let result = await actions.deleteMachine(machineId: id)
            deleting = false
            rebuild()
            if result.success {
                navigationController?.popViewController(animated: true)
            } else {
                Alerts.show(Strings.Common.error, result.message.flatMap { $0.isEmpty ? nil : $0 } ?? S.deleteFailed, on: self)
            }
        }
    }
}
#endif

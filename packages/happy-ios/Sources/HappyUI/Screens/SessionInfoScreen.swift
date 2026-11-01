#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import HappyStore
import HappyWire
import UIKit

/// A legacy session's profile, app/(app)/session/[id]/info.tsx's rows in
/// the agent chat's profile's design: the same head (`ProfileHeaderView`:
/// its avatar as home draws it, its name, what it is and its status), its
/// model and start as tiles, then Settings' cards (`ProfileSections`) at
/// `SessionDetailLayout`'s frames: the chat's permission mode, quick
/// actions, the session's ids and state, its metadata, agent state and
/// activity. Only what a legacy session has is shown. Reads only the local
/// store; git status comes from `GitStatusSync`.
///
/// What it shows is worked out off the main thread from this session's own
/// snapshot (`LegacySessionDetailFeed`), never home's: `apply` makes only
/// the cards that changed, and a new message retexts "Last updated" and
/// "Sequence" in place. A tap reads what it acts on off the main thread too.
final class SessionInfoViewController: UIViewController, UIScrollViewDelegate {
    private let context: AppContext
    private let session: AccountSession
    private let sessionId: String
    private let scroll = DetailScrollView()
    /// The agent chat's profile's head.
    let header = ProfileHeaderView()
    /// Its model and when it started.
    private let tiles = (0..<2).map { _ in DetailTileView() }
    /// Its cards, by `ProfileSections`; read by the tests.
    private(set) lazy var sections = ProfileSections(in: scroll)
    private var heldSize = SessionDetailLayout.HeldSize()
    private var observation: ApplyObservation?
    private var pipeline: ApplyPipeline<SessionInfoInput, SessionInfoFrame?, SessionInfoUpdate>?
    private var gitTask: Task<Void, Never>?
    /// What the screen shows now.
    private var frame: SessionInfoFrame?
    private var busy = Set<Action>()
    private var copiedReset: Task<Void, Never>?
    private var stateView: UIView?
    typealias Snapshots = @Sendable (@escaping @Sendable (SessionDetailFailure) -> Void) -> AsyncStream<SessionDetailSnapshot>
    private let snapshots: Snapshots
    private let firstPaintTimeout: Duration
    private var observationGeneration = 0
    private var loadWatchdog: Task<Void, Never>?
    private var isVisible = false
    private var appActive = false
    private var loadState = LoadState.loading
    /// "Loading…", or what went wrong with Retry and Copy diagnostics.
    private var loadStatus: ProfileSection?
    private var firstFailureDiagnostics: [String: Any]?
    /// The word its status says while it thinks, as the chat's header has one.
    private let vibingWord = ComposerStatus.randomVibingWord()
    /// The picture home gave its avatar (its own, or its project's): the
    /// session's snapshot doesn't hold its project.
    private var avatarImage: AvatarImageSource?

    private enum LoadState: Equatable {
        case loading, delayed, failed(SessionDetailFailure), ready
    }
    /// Each group's cards as last made: one, or a raw JSON block's each.
    private var groups: [SessionInfoSection: [ProfileSection]] = [:]
    private var rawBlockViews: [CodeBlockView] = []

    private enum Action: Hashable { case archive, delete, resume, fork, leave }

    init(context: AppContext, session: AccountSession, sessionId: String,
         firstPaintTimeout: Duration = .seconds(5), snapshots: Snapshots? = nil) {
        self.context = context
        self.session = session
        self.sessionId = sessionId
        self.firstPaintTimeout = firstPaintTimeout
        let feed = session.sessionDetails
        self.snapshots = snapshots ?? { feed.snapshots(sessionId: sessionId, onError: $0) }
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        gitTask?.cancel()
        copiedReset?.cancel()
        loadWatchdog?.cancel()
        NotificationCenter.default.removeObserver(self)
    }

    override func loadView() {
        view = UIView()
        view.backgroundColor = UIColor(Palette.settingsGround)
        view.accessibilityIdentifier = "session-info"
        scroll.alwaysBounceVertical = true
        scroll.delegate = self
        view.addSubview(scroll)
        scroll.addSubview(header)
        for (tile, id) in zip(tiles, ["model", "started"]) {
            tile.accessibilityIdentifier = "detail-tile:\(id)"
            tile.isHidden = true
            scroll.addSubview(tile)
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        minimalBackButton()
        navigationItem.largeTitleDisplayMode = .never
        // Its name and avatar as home has them, from the first frame. The
        // first frame of the session's own snapshot says the same.
        if let seed = SessionInfoSeed(session.homeFeed.latest, sessionId: sessionId) {
            avatarImage = seed.avatar.image
            header.name.text = seed.title ?? Strings.Session.newChat
            header.avatar = .session(AvatarView.Content(avatar: seed.avatar, style: seed.avatarStyle, monochrome: seed.avatarMonochrome))
            header.subtitle.text = Self.kind(isBot: seed.avatar.isBot, isTask: seed.avatar.isTask)
        }
        header.pictures = session.avatarPictures
        // The way back when its body never shows: Retry and Copy
        // diagnostics stay reachable from the bar.
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            image: .icon(.materialIcons("more-horiz"), size: 22),
            menu: UIMenu(children: [
                UIAction(title: Strings.SessionInfoLoading.retry) { [weak self] _ in self?.retryLoading() },
                UIAction(title: Strings.SessionInfoLoading.copyDiagnostics) { [weak self] _ in self?.copyLoadingDiagnostics() },
            ])
        )
        navigationItem.rightBarButtonItem?.accessibilityLabel = Strings.SessionInfoLoading.actions
        appActive = UIApplication.shared.applicationState == .active
        NotificationCenter.default.addObserver(self, selector: #selector(appWillResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        showLoadStatus(.loading)
        beginObservation()
    }

    private func beginObservation() {
        observation?.cancel()
        gitTask?.cancel()
        observationGeneration += 1
        let generation = observationGeneration
        #if DEBUG
        let includesRaw = true
        #else
        let includesRaw = false
        #endif
        var input = SessionInfoInput(includesRaw: includesRaw)
        input.forking = busy.contains(.fork)
        input.copiedResumeCommand = frame?.copiedResumeCommand ?? false
        input.vibingWord = vibingWord
        let pipeline = ApplyPipeline<SessionInfoInput, SessionInfoFrame?, SessionInfoUpdate>(
            input: input,
            state: nil,
            derive: { SessionInfoDerivation.derive($0, applied: $1) },
            apply: { [weak self] update in
                // Worked out for an account that is no longer the active one.
                guard let self, self.observationGeneration == generation,
                      self.context.account.session === self.session else { return false }
                self.apply(update)
                return true
            }
        )
        pipeline.follow(snapshots { [weak self] failure in
            Task { @MainActor [weak self] in
                guard let self, self.observationGeneration == generation,
                      self.context.account.session === self.session else { return }
                self.recordFailure(reason: "store-failed", failure: failure)
                self.showLoadStatus(.failed(failure))
            }
        }) { $0.detail = $1 }
        self.pipeline = pipeline
        observation = pipeline.observation
        let git = session.detailGitStatus
        let id = sessionId
        gitTask = Task { [weak pipeline] in
            let statuses = await git.observe(sessionId: id)
            for await status in statuses {
                guard let pipeline, !Task.isCancelled else { return }
                pipeline.update { $0.git = status }
            }
        }
        Task { await git.refresh(sessionId: id) }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The chat under it, whose permission mode it shows, is known now.
        showSections()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        isVisible = true
        startLoadWatchdog()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        isVisible = false
        loadWatchdog?.cancel()
        loadWatchdog = nil
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Set again only when it changed, as the agent's profile does: a
        // scroll view given its frame while pulled past an end snaps back.
        if scroll.frame != view.bounds { scroll.frame = view.bounds }
        stateView?.frame = view.bounds
        let width = scroll.readableColumn(width: view.bounds.width)
        let showsTiles = frame?.model != nil
        let layout = SessionDetailLayout(
            width: width, nameHeight: header.nameHeight, nameWidth: header.nameWidth,
            subtitleHeight: header.subtitleHeight, tiles: showsTiles ? tiles.count : 0,
            sections: sections.specs(width: width),
            family: nil, running: 0, completed: 0, open: false
        )
        header.place(layout.header, width: width)
        for tile in tiles { tile.isHidden = !showsTiles }
        for (tile, frame) in zip(tiles, layout.tiles) { tile.place(frame) }
        sections.place(layout.sections)
        let size = CGSize(width: width, height: layout.contentHeight)
        if let size = heldSize.laidOut(size, current: scroll.contentSize, holding: holding) { scroll.contentSize = size }
    }

    /// A finger pulls it, or it bounces, past an end.
    private var holding: Bool {
        (scroll.isTracking || scroll.isDecelerating) && SessionDetailLayout.stretched(
            offset: scroll.contentOffset.y, top: scroll.adjustedContentInset.top, bottom: scroll.adjustedContentInset.bottom,
            contentHeight: scroll.contentSize.height, viewport: scroll.bounds.height
        )
    }

    private func applyHeldSize() {
        if let size = heldSize.release(current: scroll.contentSize, holding: holding) { scroll.contentSize = size }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if heldSize.held != nil { applyHeldSize() }
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { applyHeldSize() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { applyHeldSize() }

    // MARK: Building

    /// Shows `update.frame`, touching only what `update.changes` names.
    private func apply(_ update: SessionInfoUpdate) {
        let next = update.frame
        let changes = update.changes
        frame = next
        ApplyPerf.measure(.screen) {
            switch next.content {
            case .loading:
                if changes.state { showLoadStatus(.loading) }
                return 0
            case .deleted:
                loadState = .ready
                loadStatus = nil
                loadWatchdog?.cancel()
                groups = [:]
                rawBlockViews = []
                if changes.state { showState(deletedView()) }
                return 0
            case .shown(let model):
                if let stateView {
                    stateView.removeFromSuperview()
                    self.stateView = nil
                    scroll.isHidden = false
                }
                if changes.title || changes.header { applyHeader(model) }
                var made = 0
                for section in changes.rebuilt {
                    groups[section] = plan(section, model: model, frame: next)
                    made += 1
                }
                // "Last updated" and "Sequence" retexted where they are.
                if !changes.rebuilt.contains(.details), changes.lastUpdated || changes.sequence {
                    groups[.details] = [details(model, copied: next.copiedResumeCommand)]
                    made += 1
                }
                for index in changes.rawBlocks where rawBlockViews.indices.contains(index) {
                    rawBlockViews[index].code = next.raw[index].code
                }
                for gone in Set(groups.keys).subtracting(next.sections) { groups[gone] = nil }
                if case .failed = loadState {} else {
                    loadState = .ready
                    loadStatus = nil
                }
                showSections()
                return made + changes.rawBlocks.count
            }
        }
    }

    /// The head: its name, its avatar as home draws it, what it is and its
    /// status; its tiles.
    private func applyHeader(_ model: SessionInfoModel) {
        header.name.text = model.title ?? Strings.Session.newChat
        var avatar = model.avatar
        avatar.image = avatarImage
        header.avatar = .session(AvatarView.Content(avatar: avatar, style: model.avatarStyle, monochrome: model.avatarMonochrome))
        let status = SessionComposerView.headerStatus(model.status).text
        header.subtitle.text = [Self.kind(isBot: model.isBot, isTask: model.isTask), status].compactMap { $0 }.joined(separator: " · ")
        tiles[0].show(value: model.metadata?.model ?? Strings.none, label: Strings.model)
        tiles[1].show(value: Strings.started(DetailFormat.started(since: Double(model.createdAt), now: Date())), label: Strings.started)
        view.setNeedsLayout()
    }

    /// What it is, as the agent's profile says it: a bot, a task; a plain
    /// session says nothing.
    private static func kind(isBot: Bool, isTask: Bool) -> String? {
        isBot ? Strings.bot : isTask ? Strings.task : nil
    }

    /// The cards in the frame's order: the load status first, the chat's
    /// permission mode, the groups.
    private func showSections() {
        var shown: [ProfileSection] = []
        if let loadStatus { shown.append(loadStatus) }
        if let frame, frame.model != nil {
            if let choice = chatBeneath?.permissionChoice {
                shown.append(ProfileSection(id: "controls", rows: [SessionDetailViewController.permissionRow(
                    choice, choice: { [weak self] in self?.chatBeneath?.permissionChoice },
                    relaid: { [weak self] in self?.showSections() }
                )]))
            }
            shown += frame.sections.flatMap { groups[$0] ?? [] }
        }
        sections.show(shown)
        view.setNeedsLayout()
    }

    private func plan(_ section: SessionInfoSection, model: SessionInfoModel, frame: SessionInfoFrame) -> [ProfileSection] {
        switch section {
        case .quickActions: return [quickActions(model, forking: frame.forking)]
        case .cliWarning: return [cliWarning()]
        case .details: return [details(model, copied: frame.copiedResumeCommand)]
        case .metadata: return model.metadata.map { [metadataGroup($0, model: model)] } ?? []
        case .agentState: return model.agentState.map { [agentStateGroup($0)] } ?? []
        case .activity: return [activityGroup(model)]
        case .raw: return rawJSON(frame.raw)
        }
    }

    private func showState(_ view: UIView) {
        scroll.isHidden = true
        sections.show([])
        stateView?.removeFromSuperview()
        stateView = view
        self.view.addSubview(view)
        view.frame = self.view.bounds
    }

    // MARK: Loading and local diagnostics

    /// Status is a card of its own, so an observation failure or retry
    /// never throws away rows that the user can already read.
    private func showLoadStatus(_ state: LoadState) {
        ApplyPerf.measure(.screen) {
            loadState = state
            let message: String
            switch state {
            case .loading: message = Strings.SessionDetail.loading
            case .delayed: message = Strings.SessionInfoLoading.delayed
            case .failed: message = Strings.SessionInfoLoading.failed
            case .ready: return 0
            }
            var rows = [SettingsRow(id: "load-status", title: message, accessory: .none)]
            if state != .loading {
                rows.append(SettingsRow(id: "load-retry", title: Strings.SessionInfoLoading.retry, icon: ("refresh-outline", .action), accessory: .none, action: { [weak self] in
                    self?.retryLoading()
                }))
                rows.append(SettingsRow(id: "load-copy-diagnostics", title: Strings.SessionInfoLoading.copyDiagnostics, icon: ("copy-outline", .action), accessory: .none, action: { [weak self] in
                    self?.copyLoadingDiagnostics()
                }))
            }
            loadStatus = ProfileSection(id: "session-info-load-status", rows: rows)
            if stateView != nil, frame?.model == nil {
                stateView?.removeFromSuperview()
                stateView = nil
                scroll.isHidden = false
            }
            showSections()
            return rows.count
        }
    }

    private var hasVisibleBody: Bool {
        guard let window = view.window, !scroll.isHidden, scroll.alpha > 0 else { return false }
        var ancestor: UIView? = scroll
        while let current = ancestor {
            guard !current.isHidden, current.alpha > 0 else { return false }
            ancestor = current.superview
        }
        return groups.values.joined().contains { section in
            guard let card = sections.card(section.id) else { return false }
            return card.superview === scroll && !card.isHidden && card.alpha > 0
                && card.bounds.height > 0 && card.convert(card.bounds, to: window).intersects(window.bounds)
        }
    }

    private func startLoadWatchdog() {
        loadWatchdog?.cancel()
        guard isVisible, appActive, view.window?.windowScene?.activationState == .foregroundActive else { return }
        let timeout = firstPaintTimeout
        loadWatchdog = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: timeout) } catch { return }
            guard let self, self.isVisible, self.appActive,
                  self.view.window?.windowScene?.activationState == .foregroundActive, !Task.isCancelled else { return }
            if case .deleted = self.frame?.content { return }
            guard !self.hasVisibleBody else { return }
            if case .failed = self.loadState { return }
            self.recordFailure(reason: "first-paint-timeout")
            self.showLoadStatus(.delayed)
        }
    }

    @objc private func appWillResignActive() {
        appActive = false
        loadWatchdog?.cancel()
        loadWatchdog = nil
    }

    @objc private func appDidBecomeActive() {
        appActive = true
        if isVisible { startLoadWatchdog() }
    }

    @objc private func retryLoading() {
        showLoadStatus(.loading)
        beginObservation()
        startLoadWatchdog()
    }

    private func recordFailure(reason: String, failure: SessionDetailFailure? = nil) {
        guard firstFailureDiagnostics == nil else { return }
        firstFailureDiagnostics = diagnosticSnapshot(reason: reason, failure: failure)
    }

    @objc private func copyLoadingDiagnostics() {
        UIPasteboard.general.string = loadingDiagnostics()
        Alerts.show(Strings.Common.copied, "", on: self)
    }

    /// Only explicit Copy actions put this on the clipboard. The fixed
    /// fields below never inspect session data or stringify an Error.
    func loadingDiagnostics() -> String {
        var report: [String: Any] = ["schema": 1, "current": diagnosticSnapshot(reason: "manual-copy")]
        if let firstFailureDiagnostics { report["firstFailure"] = firstFailureDiagnostics }
        guard let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "Details diagnostics unavailable" }
        return text
    }

    private func diagnosticSnapshot(reason: String, failure: SessionDetailFailure? = nil) -> [String: Any] {
        let content: String
        switch frame?.content {
        case nil: content = "none"
        case .loading: content = "loading"
        case .deleted: content = "deleted"
        case .shown: content = "shown"
        }
        let cards = groups.values.joined().compactMap { sections.card($0.id) }
        let stage: String
        if hasVisibleBody { stage = "body-visible" }
        else if frame == nil { stage = "no-snapshot-or-apply" }
        else if cards.isEmpty { stage = "no-installed-groups" }
        else { stage = "installed-groups-not-visible" }
        let currentFailure: SessionDetailFailure?
        if let failure { currentFailure = failure }
        else if case .failed(let error) = loadState { currentFailure = error }
        else { currentFailure = nil }
        let first = sections.sections.first { $0.id != loadStatus?.id }.flatMap { sections.card($0.id) }
        let window = view.window
        let status: String
        switch loadState {
        case .loading: status = "loading"
        case .delayed: status = "delayed"
        case .failed: status = "failed"
        case .ready: status = "ready"
        }
        var result: [String: Any] = [
            "reason": reason, "stage": stage, "content": content, "loadState": status, "screenVisible": isVisible, "appActive": appActive,
            "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
            "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
            "os": UIDevice.current.systemVersion, "model": Self.deviceModel,
            "dark": traitCollection.userInterfaceStyle == .dark,
            "reduceMotion": UIAccessibility.isReduceMotionEnabled,
            "contentSizeCategory": traitCollection.preferredContentSizeCategory.rawValue,
            "accountMatches": context.account.session === session,
            "windowAttached": window != nil, "keyWindow": window?.isKeyWindow ?? false,
            "sceneState": window?.windowScene?.activationState.rawValue ?? -1,
            "viewBounds": NSCoder.string(for: view.bounds), "listBounds": NSCoder.string(for: scroll.bounds),
            "listHidden": scroll.isHidden, "listAlpha": scroll.alpha,
            "contentSize": NSCoder.string(for: scroll.contentSize), "contentOffset": NSCoder.string(for: scroll.contentOffset),
            "installedGroups": cards.count, "listSections": sections.sections.count,
            "firstGroupFrame": NSCoder.string(for: first?.frame ?? .zero),
            "firstGroupInWindow": NSCoder.string(for: first.flatMap { group in window.map { group.convert(group.bounds, to: $0) } } ?? CGRect.zero),
        ]
        if let counts = pipeline?.counts {
            result["pipeline"] = ["wakeups": counts.wakeups, "derivations": counts.derivations,
                                  "unchanged": counts.unchanged, "superseded": counts.superseded,
                                  "applies": counts.applies, "rejected": counts.rejected]
        }
        if let currentFailure {
            var error: [String: Any] = ["category": currentFailure.kind.rawValue]
            if let code = currentFailure.code { error["code"] = code }
            result["storeFailure"] = error
        }
        return result
    }

    private static var deviceModel: String {
        #if targetEnvironment(simulator)
        return ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? "simulator"
        #else
        var system = utsname()
        uname(&system)
        let capacity = MemoryLayout.size(ofValue: system.machine)
        return withUnsafePointer(to: &system.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: capacity) { String(cString: $0) }
        }
        #endif
    }

    private func deletedView() -> UIView {
        DetailMessageView(lead: IconView(.ionicons("trash-outline"), size: 48, tint: Palette.textSecondary), lines: [
            .init(text: Strings.SessionDetail.sessionDeleted, style: SecondaryTextStyles.infoDeletedTitle, color: Palette.text, spacingBefore: 16),
            .init(text: Strings.SessionDetail.sessionDeletedDescription, style: SecondaryTextStyles.infoDeletedBody, color: Palette.textSecondary,
                  spacingBefore: 8, horizontalPadding: 32, centered: true),
        ])
    }

    /// The chat this profile was opened over, which holds the composer the
    /// permission mode is picked through; nil opened from anywhere else.
    private var chatBeneath: LegacyChatViewController? {
        guard let stack = navigationController?.viewControllers, let index = stack.firstIndex(of: self), index > 0,
              let chat = stack[index - 1] as? LegacyChatViewController, chat.chatId == sessionId else { return nil }
        return chat
    }

    // MARK: Groups

    /// A row that says something: its title over what it is, or its
    /// value at its end.
    private func info(_ id: String, _ title: String, subtitle: String? = nil, value: String? = nil, glyph: String, tile: SettingsRow.Tile) -> SettingsRow {
        var row = SettingsRow(id: id, title: title, icon: (glyph, tile), value: value, accessory: .none)
        row.subtitle = subtitle
        return row
    }

    /// A row that does something: opens a screen (`opens`, with its
    /// chevron) or acts where it is.
    private func act(_ id: String, _ title: String, subtitle: String? = nil, glyph: String, tile: SettingsRow.Tile, opens: Bool = true,
                     destructive: Bool = false, action: @escaping () -> Void) -> SettingsRow {
        var row = SettingsRow(id: id, title: title, icon: (glyph, tile), accessory: opens ? .chevron : .none, destructive: destructive, action: action)
        row.subtitle = subtitle
        return row
    }

    private func quickActions(_ model: SessionInfoModel, forking: Bool) -> ProfileSection {
        typealias S = Strings.SessionDetail
        var rows: [SettingsRow] = []
        var changes = act("changes", Strings.FilesDetail.changes, glyph: "git-compare-outline", tile: .blue) { [weak self] in
            guard let self else { return }
            push(.sessionChanges(id: sessionId), context: context)
        }
        if model.git.hasAccessory { changes.valueView = DetailChangesAccessoryView(model.git, chevron: false) }
        rows.append(changes)
        if let machineId = model.machineId {
            rows.append(act("view-machine", S.viewMachine, subtitle: S.viewMachineSubtitle, glyph: "server-outline", tile: .blue) { [weak self] in
                guard let self else { return }
                push(.machine(id: machineId), context: context)
            })
        }
        if model.resume.showsRow {
            rows.append(act("resume", S.resumeSession, subtitle: model.resume.canResume ? S.resumeSessionSubtitle : resumeMessages.message(for: model.resume),
                            glyph: "play-circle-outline", tile: .blue) { [weak self] in self?.resume() })
        }
        if model.canFork {
            var fork = act("fork", S.forkAction, subtitle: S.forkSubtitle, glyph: "git-branch-outline", tile: .blue) { [weak self] in
                self?.fork(canFork: model.canFork)
            }
            if forking {
                let spinner = UIActivityIndicatorView(style: .medium)
                spinner.startAnimating()
                fork.valueView = spinner
                fork.accessory = .none
            }
            rows.append(fork)
            rows.append(act("duplicate", S.duplicateAction, subtitle: S.duplicateSubtitle, glyph: "time-outline", tile: .blue) { [weak self] in
                self?.openDuplicateSheet()
            })
        }
        if let parent = model.parentSessionId {
            rows.append(act("forked-from", S.forkedFromLabel, subtitle: S.forkedFromSubtitle, glyph: "return-up-back-outline", tile: .purple) { [weak self] in
                guard let self else { return }
                push(.session(id: parent), context: context)
            })
        }
        if model.canLeaveTask {
            // Out of this person's list; the task runs on for the rest.
            rows.append(act("leave-task", Strings.Tasks.leave, glyph: "exit-outline", tile: .red, opens: false, destructive: true) { [weak self] in
                self?.leaveTask()
            })
        }
        // A task is archived only by its owner or the team's.
        if model.canArchive {
            rows.append(act("archive", model.isTask ? Strings.Tasks.archive : S.archiveSession, subtitle: model.isTask ? nil : S.archiveSessionSubtitle,
                            glyph: "archive-outline", tile: .red, opens: false, destructive: true) { [weak self] in self?.archive() })
        }
        if !model.keepsConversation {
            rows.append(act("delete", S.deleteSession, subtitle: S.deleteSessionSubtitle, glyph: "trash-outline", tile: .red, opens: false, destructive: true) { [weak self] in
                self?.confirmDelete()
            })
        }
        return ProfileSection(id: "quick-actions", heading: S.quickActions, rows: rows)
    }

    private func cliWarning() -> ProfileSection {
        typealias S = Strings.SessionDetail
        return ProfileSection(id: "cli-warning", rows: [
            act("cli-outdated", S.cliVersionOutdated, subtitle: S.updateCliInstructions, glyph: "warning-outline", tile: .orange, opens: false) { [weak self] in
                guard let self else { return }
                UIPasteboard.general.string = S.updateCommand
                Alerts.show(Strings.Common.success, S.updateCommand, on: self)
            },
        ])
    }

    private func details(_ model: SessionInfoModel, copied: Bool) -> ProfileSection {
        typealias S = Strings.SessionDetail
        var rows: [SettingsRow] = []
        rows.append(act("happy-session-id", S.happySessionId, subtitle: model.sessionIdShort, glyph: "finger-print-outline", tile: .blue, opens: false) { [weak self] in
            self?.copy(model.sessionId, success: S.happySessionIdCopied)
        })
        if let claude = model.claudeSessionId {
            rows.append(act("claude-session-id", S.claudeCodeSessionId, subtitle: SessionDetails.shortId(claude), glyph: "code-outline", tile: .orange, opens: false) { [weak self] in
                self?.copy(claude, success: S.claudeCodeSessionIdCopied)
            })
        }
        if let codex = model.codexThreadId {
            rows.append(act("codex-thread-id", S.codexThreadId, subtitle: SessionDetails.shortId(codex), glyph: "terminal-outline", tile: .gray, opens: false) { [weak self] in
                self?.copy(codex, success: S.codexThreadIdCopied)
            })
        }
        if let command = model.resumeCommand {
            // info.tsx CopyableItem: copies quietly and shows a check for 2s.
            var row = act("resume-command", S.resumeCommand, subtitle: command, glyph: "play-circle-outline", tile: .green, opens: false) { [weak self] in
                self?.copyResumeCommand(command)
            }
            row.valueView = copied
                ? DetailTrailingIcon(.ionicons("checkmark"), size: 18, tint: SecondaryPalette.copied)
                : DetailTrailingIcon(.ionicons("copy-outline"), size: 18, tint: SecondaryPalette.gray)
            rows.append(row)
        }
        rows.append(info("connection-status", S.connectionStatus, value: model.isConnected ? Strings.Status.online : Strings.Status.offline,
                         glyph: "pulse-outline", tile: model.isConnected ? .green : .gray))
        rows.append(info("created", S.created, subtitle: SessionDetails.localeDateTime(model.createdAt), glyph: "calendar-outline", tile: .blue))
        rows.append(info("last-updated", S.lastUpdated, subtitle: SessionDetails.localeDateTime(model.updatedAt), glyph: "time-outline", tile: .blue))
        rows.append(info("sequence", S.sequence, value: String(model.seq), glyph: "git-commit-outline", tile: .blue))
        return ProfileSection(id: "details", rows: rows)
    }

    private func metadataGroup(_ metadata: SessionInfoModel.Metadata, model: SessionInfoModel) -> ProfileSection {
        typealias S = Strings.SessionDetail
        var rows: [SettingsRow] = []
        if let host = metadata.host { rows.append(info("host", S.host, subtitle: host, glyph: "desktop-outline", tile: .purple)) }
        rows.append(info("path", S.path, subtitle: metadata.path, glyph: "folder-outline", tile: .purple))
        // Once under the chat's name in its header, where its status is now.
        if let branch = model.branch {
            rows.append(info("branch", Strings.ChatActions.branch, subtitle: branch, glyph: "git-branch-outline", tile: .purple))
        }
        if let version = metadata.cliVersion {
            rows.append(info("cli-version", S.cliVersion, subtitle: version, value: model.cliOutdated ? "⚠️" : nil,
                             glyph: "git-branch-outline", tile: model.cliOutdated ? .orange : .purple))
        }
        if let os = metadata.operatingSystem {
            rows.append(info("os", S.operatingSystem, subtitle: os, glyph: "hardware-chip-outline", tile: .purple))
        }
        if let client = metadata.client {
            rows.append(info("client", S.client, subtitle: client, glyph: "terminal-outline", tile: .purple))
        }
        rows.append(info("ai-provider", S.aiProvider, subtitle: metadata.aiProvider, glyph: "sparkles-outline", tile: .purple))
        if let modelName = metadata.model {
            rows.append(info("model", S.model, subtitle: modelName, glyph: "hardware-chip-outline", tile: .purple))
        }
        if let sandbox = metadata.sandbox {
            rows.append(info("sandbox", S.sandbox, subtitle: sandbox, glyph: "shield-outline", tile: .purple))
        }
        if let skip = metadata.dangerouslySkipPermissions {
            rows.append(info("skip-permissions", S.dangerouslySkipPermissions, subtitle: skip, glyph: "warning-outline", tile: .purple))
        }
        if let pid = metadata.processId {
            rows.append(info("pid", S.processId, subtitle: pid, glyph: "terminal-outline", tile: .purple))
        }
        if let home = metadata.happyHome {
            rows.append(info("happy-home", S.happyHome, subtitle: home, glyph: "home-outline", tile: .purple))
        }
        rows.append(act("copy-metadata", S.copyMetadata, glyph: "copy-outline", tile: .blue, opens: false) { [weak self] in
            self?.copyMetadata(withLogs: false)
        })
        rows.append(act("copy-metadata-logs", S.copyMetadataAndLogs, glyph: "document-text-outline", tile: .blue, opens: false) { [weak self] in
            self?.copyMetadata(withLogs: true)
        })
        return ProfileSection(id: "metadata", heading: S.metadata, rows: rows)
    }

    private func agentStateGroup(_ state: SessionInfoModel.AgentState) -> ProfileSection {
        typealias S = Strings.SessionDetail
        var rows = [info("controlled-by-user", S.controlledByUser, value: state.controlledByUser ? S.yes : S.no, glyph: "person-outline", tile: .orange)]
        if state.pendingRequests > 0 {
            rows.append(info("pending-requests", S.pendingRequests, value: String(state.pendingRequests), glyph: "hourglass-outline", tile: .orange))
        }
        return ProfileSection(id: "agent-state", heading: S.agentState, rows: rows)
    }

    private func activityGroup(_ model: SessionInfoModel) -> ProfileSection {
        typealias S = Strings.SessionDetail
        var rows = [info("thinking", S.thinking, value: model.thinking ? S.yes : S.no, glyph: "bulb-outline", tile: model.thinking ? .orange : .gray)]
        if model.thinking {
            rows.append(info("thinking-since", S.thinkingSince, subtitle: SessionDetails.localeDateTime(model.thinkingAt), glyph: "timer-outline", tile: .orange))
        }
        if let subagents = model.activity.subagents {
            rows.append(info("subagents", S.subagents, value: subagents, glyph: "people-outline", tile: .purple))
        }
        if let workflows = model.activity.workflows {
            rows.append(info("workflows", S.workflows, value: workflows, glyph: "git-network-outline", tile: .purple))
        }
        if let processes = model.activity.processes {
            rows.append(info("background-processes", S.backgroundProcesses, value: processes, glyph: "terminal-outline", tile: .purple))
        }
        if let tasks = model.activity.tasks {
            rows.append(info("tasks", S.tasks, value: tasks, glyph: "checkbox-outline", tile: .purple))
        }
        return ProfileSection(id: "activity", heading: S.activity, rows: rows)
    }

    /// info.tsx's "Raw JSON (Dev Mode)" group, shown in `__DEV__` builds;
    /// here in Debug builds, printed off the main thread: each block's name
    /// over its code, a card each, under one heading.
    private func rawJSON(_ blocks: [SessionInfoRawBlock]) -> [ProfileSection] {
        typealias S = Strings.SessionDetail
        rawBlockViews = blocks.map { CodeBlockView(code: $0.code) }
        return zip(blocks.indices, zip(blocks, rawBlockViews)).map { index, pair in
            let (block, code) = pair
            let row = switch block.kind {
            case .agentState: info("raw-agent-state", S.rawAgentState, glyph: "code-working-outline", tile: .orange)
            case .metadata: info("raw-metadata", S.rawMetadata, glyph: "information-circle-outline", tile: .purple)
            case .session: info("raw-session", S.rawSession, glyph: "document-text-outline", tile: .green)
            }
            return ProfileSection(id: "raw-\(index)", heading: index == 0 ? S.rawJSON : nil, rows: [row], block: code)
        }
    }

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
        pipeline?.update { $0.copiedResumeCommand = true }
        copiedReset?.cancel()
        copiedReset = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self else { return }
            self.pipeline?.update { $0.copiedResumeCommand = false }
        }
    }

    /// The metadata as stored now, read and printed off the main thread.
    private func copyMetadata(withLogs: Bool) {
        let details = session.sessionDetails
        let id = sessionId
        Task { @MainActor [weak self] in
            let text: String? = await Task.detached(priority: .userInitiated) {
                guard let metadata = await details.current(sessionId: id)?.session?.metadata, metadata != .null else { return nil }
                return SessionDetails.metadataClipboard(metadata, withLogs: withLogs)
            }.value
            guard let self, self.context.account.session === self.session else { return }
            guard let text else {
                Alerts.show(Strings.Common.error, Strings.SessionDetail.failedToCopyMetadata, on: self)
                return
            }
            UIPasteboard.general.string = text
            Alerts.show(Strings.Common.success, Strings.SessionDetail.metadataCopied, on: self)
        }
    }

    /// The session, its computer, the settings and its composer as stored
    /// now, read off the main thread; nil once another account is active.
    private func current() async -> SessionDetailSnapshot? {
        let detail = await session.sessionDetails.current(sessionId: sessionId)
        guard context.account.session === session else { return nil }
        return detail
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
        let actions = session.detailActions
        let confirm = confirmWorktreeCleanup
        perform(.archive, on: { [weak self] in self?.navigationController ?? self }) { [weak self] in
            guard let record = await self?.current()?.session else { return }
            try await actions.archive(record, confirmWorktreeCleanup: confirm)
            // Leave this screen and the chat behind it.
            self?.leaveSession()
        }
    }

    private func leaveTask() {
        let actions = session.detailActions
        perform(.leave, on: { [weak self] in self?.navigationController ?? self }) { [weak self] in
            guard let record = await self?.current()?.session else { return }
            try await actions.leaveTask(record)
            // It is no longer in this account: leave the screen and the chat.
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
        let actions = session.detailActions
        let navigation = navigationController
        let confirm = confirmWorktreeCleanup
        perform(.delete, on: { navigation }) { [weak self] in
            guard let record = await self?.current()?.session else { return }
            if record.isBot { throw SessionDetailActions.Failure(SessionDetailActions.botDeleteMessage) }
            if record.isTask { throw SessionDetailActions.Failure(SessionDetailActions.taskDeleteMessage) }
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
        let actions = session.detailActions
        let messages = resumeMessages
        perform(.resume, on: { [weak self] in self }) { [weak self] in
            guard let detail = await self?.current(), let record = detail.session else { return }
            guard let sessionId = try await actions.resume(
                record, machine: detail.machine, settings: detail.settings.synced?.settings, composer: detail.composer, messages: messages
            ), let self else { return }
            push(.session(id: sessionId), context: context)
        }
    }

    private func fork(canFork: Bool) {
        let actions = session.detailActions
        let messages = SessionDetailActions.ForkMessages(
            missingMetadata: Strings.SessionDetail.forkErrorMissingMetadata,
            generic: Strings.SessionDetail.forkErrorGeneric
        )
        guard !busy.contains(.fork) else { return }
        pipeline?.update { $0.forking = true }
        perform(.fork, on: { [weak self] in self }) { [weak self] in
            defer { self?.pipeline?.update { $0.forking = false } }
            guard let record = await self?.current()?.session else { return }
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

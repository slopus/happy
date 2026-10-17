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
///
/// What it shows is worked out off the main thread from this session's own
/// snapshot (`SessionDetailFeed`), never home's: `apply` builds only the
/// groups that changed, and a new message retexts "Last updated" and
/// "Sequence" in place. A tap reads what it acts on off the main thread too.
///
/// Groups are made a few rows a frame (`sliceBudget`), out of sight in the
/// list, so each row's text is drawn once, at the screen's text size, in
/// the frame that made it; they join the list together once the last is
/// made.
final class SessionInfoViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let sessionId: String
    private let list = GroupedListView()
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
    private var loadStatusGroup: ItemGroupView?
    private var firstFailureDiagnostics: [String: Any]?

    private enum LoadState: Equatable {
        case loading, delayed, failed(SessionDetailFailure), ready
    }
    /// The groups on screen, and the rows retexted in place.
    private var sectionViews: [SessionInfoSection: UIView] = [:]
    private var shownSections: [SessionInfoSection] = []
    private weak var lastUpdatedRow: ItemRowView?
    private weak var sequenceRow: ItemRowView?
    private var rawBlockViews: [CodeBlockView] = []

    /// The longest a frame spends making rows: a third of the AGENTS.md
    /// block, leaving the rest for one row past it and for laying out and
    /// drawing what it made, which took up to about 1.5 ms a frame in Debug
    /// on the iPhone 17 Pro simulator.
    static let sliceBudget: CFTimeInterval = ApplyBudget.block / 3 / 1000
    /// Where groups are made: in the list, though not one of its sections,
    /// so they have the screen's traits and scroll view, but far above its
    /// content and clipped to nothing, out of sight, touch and VoiceOver.
    private let workshop = UIView()
    /// Groups still to make, made from the newest frame when their turn
    /// comes.
    private var queue: [SessionInfoSection] = []
    private var making: Making?
    /// Groups made, waiting in the workshop to join the list.
    private var made: [SessionInfoSection: UIView] = [:]
    /// Updates to a group already started belong to the next batch. The
    /// current batch must finish even while sync keeps changing the model.
    private var remakeAfterShowing = Set<SessionInfoSection>()
    private var makeLink: CADisplayLink?
    #if DEBUG
    /// Each frame's making: how long it took and the steps it made (tests).
    private(set) var slices: [(seconds: CFTimeInterval, steps: Int)] = []
    #endif

    /// A group made a row at a time: its rows in order, each made when its
    /// turn comes, and what is set on the group once they are all in. Only
    /// the screen makes them, so they hold it unowned.
    private struct GroupPlan {
        var title: String?
        var rows: [() -> UIView]
        var finish: (ItemGroupView) -> Void = { _ in }
    }

    private struct Making {
        var section: SessionInfoSection
        var group: ItemGroupView
        var plan: GroupPlan
        var next = 0
    }

    private enum Action: Hashable { case archive, delete, resume, fork }

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
        view.backgroundColor = UIColor(Palette.groupedBackground)
        workshop.frame = CGRect(x: 0, y: -10_000, width: 0, height: 0)
        workshop.clipsToBounds = true
        workshop.isUserInteractionEnabled = false
        workshop.accessibilityElementsHidden = true
        list.addSubview(workshop)
        view.addSubview(list)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Header.tsx's title and every row's Text scale; the rows are
        // measured from their labels as drawn, as Settings' are.
        followsTextSize()
        showsBackTitle()
        dropsBackButtonOnTablet() // Tablet (HappyUI/Tablet): navigation/Header.tsx
        // The title home already shows, in the bar as the screen slides in.
        // The first frame of the session's own snapshot sets the same title,
        // which changes nothing (`setPlainHeaderTitle`).
        if let seed = SessionInfoSeed(session.homeFeed.latest, sessionId: sessionId) {
            setPlainHeaderTitle(seed.title ?? Strings.Session.newChat)
        }
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

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.frame = view.bounds
        stateView?.frame = view.bounds
        // Making waits while the screen is off the window or has no size.
        if making != nil || !queue.isEmpty { scheduleMaking() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if making != nil || !queue.isEmpty { scheduleMaking() }
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

    // MARK: Building

    /// Shows `update.frame`, touching only what `update.changes` names.
    /// The groups it rebuilds are made over the next frames (`makeSlice`).
    private func apply(_ update: SessionInfoUpdate) {
        let next = update.frame
        let changes = update.changes
        frame = next
        ApplyPerf.measure(.screen) {
            switch next.content {
            case .loading:
                if changes.state { showLoadStatus(.loading) }
            case .deleted:
                loadState = .ready
                loadStatusGroup = nil
                loadWatchdog?.cancel()
                if changes.state { showState(deletedView(), title: Strings.SessionDetail.sessionDeleted) }
            case .shown(let model):
                if changes.title { setPlainHeaderTitle(model.title ?? Strings.Session.newChat) }
                for section in changes.rebuilt { remake(section) }
                if changes.lastUpdated { lastUpdatedRow?.subtitle = SessionDetails.localeDateTime(model.updatedAt) }
                if changes.sequence { sequenceRow?.detail = String(model.seq) }
                for index in changes.rawBlocks where rawBlockViews.indices.contains(index) {
                    rawBlockViews[index].code = next.raw[index].code
                }
            }
            return changes.rawBlocks.count + (changes.lastUpdated ? 1 : 0) + (changes.sequence ? 1 : 0)
        }
        guard case .shown = next.content else { return }
        // Groups are made from the next frame on, not in this one; with none
        // to make, the list takes the new order now.
        if making != nil || !queue.isEmpty { scheduleMaking() } else { showMade() }
    }

    /// Queued groups use the newest frame when they start. Once started,
    /// finish and show them before rebuilding for a newer frame: restarting
    /// an unfinished group on every update can hide the whole list forever.
    private func remake(_ section: SessionInfoSection) {
        if making?.section == section || made[section] != nil {
            remakeAfterShowing.insert(section)
            return
        }
        if !queue.contains(section) { queue.append(section) }
    }

    /// Makes rows for at most `sliceBudget` a frame, and the frame after
    /// the last is made, shows every group.
    @objc private func makeSlice() {
        guard making != nil || !queue.isEmpty else {
            stopMaking()
            showMade()
            return
        }
        // Made in the window, at the width the list will give them.
        guard list.window != nil, list.bounds.width > 0 else {
            stopMaking()
            return
        }
        let started = CACurrentMediaTime()
        var steps = 0
        ApplyPerf.measure(.screen) {
            while CACurrentMediaTime() - started < Self.sliceBudget, makeStep() { steps += 1 }
            return steps
        }
        #if DEBUG
        slices.append((CACurrentMediaTime() - started, steps))
        #endif
        scheduleMaking()
    }

    /// Goes on making from the next frame.
    private func scheduleMaking() {
        guard makeLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(makeSlice))
        link.add(to: .main, forMode: .common)
        makeLink = link
    }

    /// Starts the next group, makes one of its rows, or finishes it; false
    /// when nothing is left to make.
    private func makeStep() -> Bool {
        guard var making else {
            guard let frame, let model = frame.model else {
                queue = []
                return false
            }
            guard !queue.isEmpty else { return false }
            let section = queue.removeFirst()
            guard let plan = plan(section, model: model, frame: frame) else {
                made[section] = UIView()
                return true
            }
            let group = ItemGroupView(title: plan.title, rows: [])
            // Laid out at the width the list will give it.
            group.frame.size.width = GroupedListLayout.contentWidth(size: list.bounds.size, safeArea: LayoutInsets(list.safeAreaInsets))
            workshop.addSubview(group)
            self.making = Making(section: section, group: group, plan: plan)
            return true
        }
        if making.next < making.plan.rows.count {
            making.group.rows.append(making.plan.rows[making.next]())
            making.next += 1
            self.making = making
            return true
        }
        making.plan.finish(making.group)
        made[making.section] = making.group
        self.making = nil
        return true
    }

    private func stopMaking() {
        makeLink?.invalidate()
        makeLink = nil
    }

    /// The groups made join the list in the frame's order, retexted in
    /// place where a frame since they were planned moved on.
    private func showMade() {
        guard let frame, let model = frame.model else { return }
        let order = frame.sections
        let new = made
        made = [:]
        for (section, group) in new { sectionViews[section] = group }
        for gone in Set(sectionViews.keys).subtracting(order) {
            // Off the list below, or never on it.
            if let group = sectionViews.removeValue(forKey: gone), group.superview === workshop { group.removeFromSuperview() }
        }
        if new[.details] != nil {
            let updated = SessionDetails.localeDateTime(model.updatedAt)
            if let row = lastUpdatedRow, row.subtitle != updated { row.subtitle = updated }
            if let row = sequenceRow, row.detail != String(model.seq) { row.detail = String(model.seq) }
        }
        if new[.raw] != nil {
            for (view, block) in zip(rawBlockViews, frame.raw) where view.code != block.code { view.code = block.code }
            // Drawn near the screen once there (`CodeBlockView`).
            for view in rawBlockViews { view.setNeedsLayout() }
        }
        if let stateView {
            stateView.removeFromSuperview()
            self.stateView = nil
            list.isHidden = false
        }
        let removesStatus: Bool
        if case .failed = loadState {
            removesStatus = false
        } else {
            removesStatus = loadStatusGroup != nil
            loadState = .ready
            loadStatusGroup = nil
        }
        if order != shownSections || !new.isEmpty || removesStatus {
            ApplyPerf.measure(.screen) {
                shownSections = order
                installSections()
                return new.count
            }
        }
        let pending = remakeAfterShowing.intersection(order)
        remakeAfterShowing = []
        for section in pending { remake(section) }
        if !queue.isEmpty { scheduleMaking() }
    }

    private func plan(_ section: SessionInfoSection, model: SessionInfoModel, frame: SessionInfoFrame) -> GroupPlan? {
        switch section {
        case .quickActions: return quickActions(model, forking: frame.forking)
        case .cliWarning: return cliWarning()
        case .details: return details(model, copied: frame.copiedResumeCommand)
        case .metadata: return model.metadata.map { metadataGroup($0, model: model) }
        case .agentState: return model.agentState.map(agentStateGroup)
        case .activity: return activityGroup(model)
        case .raw: return rawJSON(frame.raw)
        }
    }

    private func showState(_ view: UIView, title: String) {
        setPlainHeaderTitle(title)
        stopMaking()
        queue = []
        remakeAfterShowing = []
        making?.group.removeFromSuperview()
        making = nil
        for group in made.values { group.removeFromSuperview() }
        made = [:]
        list.isHidden = true
        list.sections = []
        sectionViews = [:]
        shownSections = []
        rawBlockViews = []
        stateView?.removeFromSuperview()
        stateView = view
        self.view.addSubview(view)
        view.frame = self.view.bounds
    }

    // MARK: Loading and local diagnostics

    private func installSections() {
        let status: [UIView] = loadStatusGroup.map { [$0] } ?? []
        list.sections = status + shownSections.compactMap { sectionViews[$0] }
    }

    /// Status is a separate group, so an observation failure or retry never
    /// throws away rows that the user can already read. Construction can
    /// continue behind it and removes the waiting state when it finishes.
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
            let messageRow = ItemRowView(title: message)
            messageRow.showsChevron = false
            var rows: [UIView] = [messageRow]
            if state != .loading {
                rows.append(ItemRowView(title: Strings.SessionInfoLoading.retry) { [weak self] in self?.retryLoading() })
                rows.append(ItemRowView(title: Strings.SessionInfoLoading.copyDiagnostics) { [weak self] in self?.copyLoadingDiagnostics() })
            }
            loadStatusGroup = ItemGroupView(rows: rows)
            loadStatusGroup?.accessibilityIdentifier = "session-info-load-status"
            stateView?.removeFromSuperview()
            stateView = nil
            list.isHidden = false
            installSections()
            return rows.count
        }
    }

    private var hasVisibleBody: Bool {
        guard let window = view.window, !list.isHidden, list.alpha > 0 else { return false }
        var ancestor: UIView? = list
        while let current = ancestor {
            guard !current.isHidden, current.alpha > 0 else { return false }
            ancestor = current.superview
        }
        return sectionViews.values.contains { group in
            group.superview === list && !group.isHidden && group.alpha > 0
                && group.bounds.height > 0 && group.convert(group.bounds, to: window).intersects(window.bounds)
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
        stopMaking()
        making?.group.removeFromSuperview()
        making = nil
        for group in made.values { group.removeFromSuperview() }
        made = [:]
        queue = []
        remakeAfterShowing = []
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
        let stage: String
        if hasVisibleBody { stage = "body-visible" }
        else if frame == nil { stage = "no-snapshot-or-apply" }
        else if making != nil || !queue.isEmpty { stage = "building-groups" }
        else if !made.isEmpty { stage = "groups-awaiting-install" }
        else if !sectionViews.isEmpty { stage = "installed-groups-not-visible" }
        else { stage = "no-installed-groups" }
        let currentFailure: SessionDetailFailure?
        if let failure { currentFailure = failure }
        else if case .failed(let error) = loadState { currentFailure = error }
        else { currentFailure = nil }
        let first = shownSections.compactMap { sectionViews[$0] }.first
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
            "viewBounds": NSCoder.string(for: view.bounds), "listBounds": NSCoder.string(for: list.bounds),
            "listHidden": list.isHidden, "listAlpha": list.alpha,
            "contentSize": NSCoder.string(for: list.contentSize), "contentOffset": NSCoder.string(for: list.contentOffset),
            "installedGroups": sectionViews.count, "listSections": list.sections.count,
            "queuedGroups": queue.count, "madeGroups": made.count, "making": making != nil, "displayLink": makeLink != nil,
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

    private func icon(_ name: String, _ tint: ColorToken, size: CGFloat = 29) -> ItemIcon {
        ItemIcon(.ionicons(name), tint: tint, size: size)
    }

    private func info(_ title: String, subtitle: String? = nil, detail: String? = nil, icon: ItemIcon) -> ItemRowView {
        let row = ItemRowView(title: title, subtitle: subtitle, detail: detail, icon: icon)
        row.showsChevron = false
        return row
    }

    private func quickActions(_ model: SessionInfoModel, forking: Bool) -> GroupPlan {
        typealias S = Strings.SessionDetail
        var rows: [() -> UIView] = []
        rows.append { [unowned self] in
            let changes = ItemRowView(
                title: Strings.FilesDetail.changes,
                icon: ItemIcon(.octicons("file-diff"), tint: SecondaryPalette.blue, size: 26)
            ) { [weak self] in
                guard let self else { return }
                push(.sessionChanges(id: sessionId), context: context)
            }
            if model.git.hasAccessory { changes.trailingView = DetailChangesAccessoryView(model.git) }
            return changes
        }

        if let machineId = model.machineId {
            rows.append { [unowned self] in
                ItemRowView(title: S.viewMachine, subtitle: S.viewMachineSubtitle, icon: icon("server-outline", SecondaryPalette.blue)) { [weak self] in
                    guard let self else { return }
                    push(.machine(id: machineId), context: context)
                }
            }
        }
        if model.resume.showsRow {
            rows.append { [unowned self] in
                ItemRowView(title: S.resumeSession, subtitle: model.resume.canResume ? S.resumeSessionSubtitle : resumeMessages.message(for: model.resume),
                            icon: icon("play-circle-outline", SecondaryPalette.blue)) { [weak self] in
                    self?.resume()
                }
            }
        }
        if model.canFork {
            rows.append { [unowned self] in
                let fork = ItemRowView(title: S.forkAction, subtitle: S.forkSubtitle, icon: icon("git-branch-outline", SecondaryPalette.blue)) { [weak self] in
                    self?.fork(canFork: model.canFork)
                }
                fork.isLoading = forking
                return fork
            }
            rows.append { [unowned self] in
                ItemRowView(title: S.duplicateAction, subtitle: S.duplicateSubtitle, icon: icon("time-outline", SecondaryPalette.blue)) { [weak self] in
                    self?.openDuplicateSheet()
                }
            }
        }
        if let parent = model.parentSessionId {
            rows.append { [unowned self] in
                ItemRowView(title: S.forkedFromLabel, subtitle: S.forkedFromSubtitle, icon: icon("return-up-back-outline", SecondaryPalette.purple)) { [weak self] in
                    guard let self else { return }
                    push(.session(id: parent), context: context)
                }
            }
        }
        rows.append { [unowned self] in
            ItemRowView(title: S.archiveSession, subtitle: S.archiveSessionSubtitle, icon: icon("archive-outline", SecondaryPalette.red)) { [weak self] in
                self?.archive()
            }
        }
        if !model.isBot {
            rows.append { [unowned self] in
                ItemRowView(title: S.deleteSession, subtitle: S.deleteSessionSubtitle, icon: icon("trash-outline", SecondaryPalette.red)) { [weak self] in
                    self?.confirmDelete()
                }
            }
        }
        return GroupPlan(title: S.quickActions, rows: rows) { $0.keepsLastDivider(model.isBot) }
    }

    private func cliWarning() -> GroupPlan {
        typealias S = Strings.SessionDetail
        return GroupPlan(rows: [{ [unowned self] in
            let row = ItemRowView(title: S.cliVersionOutdated, subtitle: S.updateCliInstructions, icon: icon("warning-outline", SecondaryPalette.orange)) { [weak self] in
                guard let self else { return }
                UIPasteboard.general.string = S.updateCommand
                Alerts.show(Strings.Common.success, S.updateCommand, on: self)
            }
            row.showsChevron = false
            return row
        }])
    }

    private func details(_ model: SessionInfoModel, copied: Bool) -> GroupPlan {
        typealias S = Strings.SessionDetail
        var rows: [() -> UIView] = []
        rows.append { [unowned self] in
            ItemRowView(title: S.happySessionId, subtitle: model.sessionIdShort, icon: icon("finger-print-outline", SecondaryPalette.blue)) { [weak self] in
                self?.copy(model.sessionId, success: S.happySessionIdCopied)
            }
        }
        if let claude = model.claudeSessionId {
            rows.append { [unowned self] in
                ItemRowView(title: S.claudeCodeSessionId, subtitle: SessionDetails.shortId(claude), icon: icon("code-outline", SecondaryPalette.claude)) { [weak self] in
                    self?.copy(claude, success: S.claudeCodeSessionIdCopied)
                }
            }
        }
        if let codex = model.codexThreadId {
            rows.append { [unowned self] in
                ItemRowView(title: S.codexThreadId, subtitle: SessionDetails.shortId(codex), icon: icon("terminal-outline", SecondaryPalette.codex)) { [weak self] in
                    self?.copy(codex, success: S.codexThreadIdCopied)
                }
            }
        }
        if let command = model.resumeCommand {
            // info.tsx CopyableItem: copies quietly and shows a check for 2s.
            rows.append { [unowned self] in
                let row = ItemRowView(title: S.resumeCommand, subtitle: command, icon: icon("play-circle-outline", SecondaryPalette.copied)) { [weak self] in
                    self?.copyResumeCommand(command)
                }
                row.showsChevron = false
                row.trailingView = copied
                    ? DetailTrailingIcon(.ionicons("checkmark"), size: 18, tint: SecondaryPalette.copied)
                    : DetailTrailingIcon(.ionicons("copy-outline"), size: 18, tint: SecondaryPalette.gray)
                return row
            }
        }
        rows.append { [unowned self] in
            info(
                S.connectionStatus,
                detail: model.isConnected ? Strings.Status.online : Strings.Status.offline,
                icon: icon("pulse-outline", model.isConnected ? SecondaryPalette.green : SecondaryPalette.gray)
            )
        }
        rows.append { [unowned self] in info(S.created, subtitle: SessionDetails.localeDateTime(model.createdAt), icon: icon("calendar-outline", SecondaryPalette.blue)) }
        rows.append { [unowned self] in
            let row = info(S.lastUpdated, subtitle: SessionDetails.localeDateTime(model.updatedAt), icon: icon("time-outline", SecondaryPalette.blue))
            lastUpdatedRow = row
            return row
        }
        rows.append { [unowned self] in
            let row = info(S.sequence, detail: String(model.seq), icon: icon("git-commit-outline", SecondaryPalette.blue))
            sequenceRow = row
            return row
        }
        return GroupPlan(rows: rows)
    }

    private func metadataGroup(_ metadata: SessionInfoModel.Metadata, model: SessionInfoModel) -> GroupPlan {
        typealias S = Strings.SessionDetail
        let purple = SecondaryPalette.purple
        var rows: [() -> UIView] = []
        rows.append { [unowned self] in info(S.host, subtitle: metadata.host, icon: icon("desktop-outline", purple)) }
        rows.append { [unowned self] in info(S.path, subtitle: metadata.path, icon: icon("folder-outline", purple)) }
        if let version = metadata.cliVersion {
            rows.append { [unowned self] in
                info(S.cliVersion, subtitle: version, detail: model.cliOutdated ? "⚠️" : nil,
                     icon: icon("git-branch-outline", model.cliOutdated ? SecondaryPalette.orange : purple))
            }
        }
        if let os = metadata.operatingSystem {
            rows.append { [unowned self] in info(S.operatingSystem, subtitle: os, icon: icon("hardware-chip-outline", purple)) }
        }
        if let client = metadata.client {
            rows.append { [unowned self] in info(S.client, subtitle: client, icon: icon("terminal-outline", purple)) }
        }
        rows.append { [unowned self] in info(S.aiProvider, subtitle: metadata.aiProvider, icon: icon("sparkles-outline", purple)) }
        if let modelName = metadata.model {
            rows.append { [unowned self] in info(S.model, subtitle: modelName, icon: icon("hardware-chip-outline", purple)) }
        }
        if let sandbox = metadata.sandbox {
            rows.append { [unowned self] in info(S.sandbox, subtitle: sandbox, icon: icon("shield-outline", purple)) }
        }
        if let skip = metadata.dangerouslySkipPermissions {
            rows.append { [unowned self] in info(S.dangerouslySkipPermissions, subtitle: skip, icon: icon("warning-outline", purple)) }
        }
        if let pid = metadata.processId {
            rows.append { [unowned self] in info(S.processId, subtitle: pid, icon: icon("terminal-outline", purple)) }
        }
        if let home = metadata.happyHome {
            rows.append { [unowned self] in info(S.happyHome, subtitle: home, icon: icon("home-outline", purple)) }
        }
        rows.append { [unowned self] in
            ItemRowView(title: S.copyMetadata, icon: icon("copy-outline", SecondaryPalette.blue)) { [weak self] in
                self?.copyMetadata(withLogs: false)
            }
        }
        rows.append { [unowned self] in
            ItemRowView(title: S.copyMetadataAndLogs, icon: icon("document-text-outline", SecondaryPalette.blue)) { [weak self] in
                self?.copyMetadata(withLogs: true)
            }
        }
        return GroupPlan(title: S.metadata, rows: rows)
    }

    private func agentStateGroup(_ state: SessionInfoModel.AgentState) -> GroupPlan {
        typealias S = Strings.SessionDetail
        let orange = SecondaryPalette.orange
        var rows: [() -> UIView] = [{ [unowned self] in info(S.controlledByUser, detail: state.controlledByUser ? S.yes : S.no, icon: icon("person-outline", orange)) }]
        if state.pendingRequests > 0 {
            rows.append { [unowned self] in info(S.pendingRequests, detail: String(state.pendingRequests), icon: icon("hourglass-outline", orange)) }
        }
        return GroupPlan(title: S.agentState, rows: rows) { $0.keepsLastDivider(state.pendingRequests == 0) }
    }

    private func activityGroup(_ model: SessionInfoModel) -> GroupPlan {
        typealias S = Strings.SessionDetail
        let purple = SecondaryPalette.purple
        var rows: [() -> UIView] = [{ [unowned self] in
            info(S.thinking, detail: model.thinking ? S.yes : S.no,
                 icon: icon("bulb-outline", model.thinking ? SecondaryPalette.yellow : SecondaryPalette.gray))
        }]
        if model.thinking {
            rows.append { [unowned self] in info(S.thinkingSince, subtitle: SessionDetails.localeDateTime(model.thinkingAt), icon: icon("timer-outline", SecondaryPalette.yellow)) }
        }
        if let subagents = model.activity.subagents {
            rows.append { [unowned self] in info(S.subagents, detail: subagents, icon: icon("people-outline", purple)) }
        }
        if let workflows = model.activity.workflows {
            rows.append { [unowned self] in info(S.workflows, detail: workflows, icon: icon("git-network-outline", purple)) }
        }
        if let processes = model.activity.processes {
            rows.append { [unowned self] in info(S.backgroundProcesses, detail: processes, icon: icon("terminal-outline", purple)) }
        }
        if let tasks = model.activity.tasks {
            rows.append { [unowned self] in info(S.tasks, detail: tasks, icon: icon("checkbox-outline", purple)) }
        }
        return GroupPlan(title: S.activity, rows: rows) { $0.keepsLastDivider(model.activity.tasks == nil) }
    }

    /// info.tsx's "Raw JSON (Dev Mode)" group, shown in `__DEV__` builds;
    /// here in Debug builds, printed off the main thread. The rows sit in
    /// fragments, so every one keeps Item's default divider.
    private func rawJSON(_ blocks: [SessionInfoRawBlock]) -> GroupPlan {
        typealias S = Strings.SessionDetail
        var rows: [() -> UIView] = []
        rawBlockViews = []
        for block in blocks {
            rows.append { [unowned self] in
                switch block.kind {
                case .agentState: return info(S.rawAgentState, icon: icon("code-working-outline", SecondaryPalette.orange))
                case .metadata: return info(S.rawMetadata, icon: icon("information-circle-outline", SecondaryPalette.purple))
                case .session: return info(S.rawSession, icon: icon("document-text-outline", SecondaryPalette.green))
                }
            }
            rows.append { [unowned self] in
                let code = CodeBlockView(code: block.code)
                rawBlockViews.append(code)
                return code
            }
        }
        return GroupPlan(title: S.rawJSON, rows: rows) { $0.keepsLastDivider(true) }
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

#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import HappyStore
import UIKit

extension SessionStarter {
    /// A starter on this account's machines, sessions and sender. Its spawn
    /// requests are the account's own unless a caller hands it a scope of
    /// that account's (a child scope, say).
    static func make(for session: AccountSession, spawnRequests: SpawnRequests? = nil) -> SessionStarter {
        let sync = session.sync
        return SessionStarter(environment: .init(
            ops: session.homeOps,
            sessionOps: session.homeSessionOps,
            sender: session.sender,
            metadataTransport: session.realtime,
            refreshSessions: { await sync.run(.sessions) },
            paintBotFace: { try await BotFacePainter.png(seed: $0) },
            attachmentPlan: { [sender = session.sender] message, sessionId in
                try await sender.attachmentPlan(for: message, sessionId: sessionId)
            },
            spawnRequests: spawnRequests ?? session.spawnRequests
        ))
    }
}

/// app/(app)/new/index.tsx on a phone: the machine, path and worktree rows
/// over a glass composer with the harness, its settings and Send, each
/// picker in a glass popover above what opened it.
///
/// The pickers write the account's new-session draft, which home's dock
/// shares; the prompt is the draft's too. Send resolves the draft and runs
/// it through `SessionStarter`, then this screen gives way to the session.
/// The header is the system navigation bar's, so back and its swipe are
/// the platform's; the title capsule sits beside the back button.
@MainActor
final class NewSessionViewController: UIViewController {
    private enum Picker: Equatable {
        case machine
        case path
        case worktree
        case agent
        case settings

        var anchor: NewSessionPickerLayout.Anchor {
            switch self {
            case .machine: .row(0)
            case .path: .row(1)
            case .worktree: .row(2)
            case .agent, .settings: .composer
            }
        }
    }

    private let context: AppContext
    private let session: AccountSession
    private let composer: NewSessionComposer
    private let starter: SessionStarter
    private var model: NewSessionScreenModel
    private var observation: ApplyObservation?

    private let titleView = NewSessionTitleView(title: Strings.NewSession.title)
    private let scrollView = UIScrollView()
    /// Taps between the rows put the keyboard and any picker away
    /// (`mobileKeyboardDismissArea`).
    private let dismissArea = UIControl()
    private let machineRow = NewSessionConfigRowView(icon: .ionicons("desktop-outline"))
    private let offlineView = NewSessionOfflineView()
    private let pathRow = NewSessionConfigRowView(icon: .ionicons("folder-outline"))
    private let worktreeRow = NewSessionConfigRowView(icon: .materialCommunityIcons("tree"))
    private let composerView = NewSessionComposerView()
    /// Under the rows and over the composer (`NEW_SESSION_PICKER_LAYERS`):
    /// a tap on the composer closes the picker, a tap on a row switches it.
    private let backdrop = UIControl()
    private let keyboardTracker = UIView()
    /// Every label's size at the person's text size, measured off the main
    /// thread (`MeasuredLabelSizes`): the rows, the offline help, the
    /// harness's name and the pickers.
    private let labelSizes = MeasuredLabelSizes()

    private var activePicker: Picker?
    private var pickerView: NewSessionPickerView?
    private var settingsPage: NewSessionScreenModel.Setting.Kind?
    private var searchText = ""
    private var searchRow: NewSessionFieldRow?
    private var pathField: NewSessionFieldRow?
    private var pendingPicker: Picker?
    private var pendingTask: Task<Void, Never>?
    /// Send was tapped and the start is being resolved, before it runs.
    private var launching = false
    private var keyboardVisible = false
    private var lastConfigHeight: CGFloat = 0

    init(context: AppContext, session: AccountSession, machineId: String? = nil, path: String? = nil, prompt: String? = nil) {
        self.context = context
        self.session = session
        let drafts = NewSessionDraftStore.shared(for: context.account.localSettings)
        if let machineId { drafts.setMachineId(machineId) }
        if let path { drafts.setPath(path) }
        if let prompt { drafts.setInput(prompt) }
        // Nothing read on the main thread: the computers arrive from the
        // home feed (`viewDidLoad`), and until then the draft stays as saved.
        let snapshot = HomeSnapshot(machines: MachinesSnapshot(synced: false, machines: []), sessions: [])
        composer = NewSessionComposer(drafts: drafts, snapshot: snapshot, ops: session.homeOps)
        starter = SessionStarter.make(for: session)
        model = NewSessionScreenModel(
            choices: composer.choices,
            draft: drafts.draft,
            snapshot: snapshot,
            gitWorktrees: composer.gitWorktrees,
            isStarting: false,
            now: Self.now
        )
        super.init(nibName: nil, bundle: nil)
        hidesBottomBarWhenPushed = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private static var now: Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // new/index.tsx's Text and TextInputs scale; every height here is
        // measured at the size off the main thread (the prompt by
        // `ComposerTextHeights`, the labels by `labelSizes`).
        followsTextSize()
        labelSizes.onChange = { [weak self] in
            guard let self else { return }
            self.view.setNeedsLayout()
            self.pickerView?.content.setNeedsLayout()
        }
        composerView.sizes = labelSizes
        view.backgroundColor = UIColor(Palette.groupedBackground)
        setUpHeader()

        // Before the draft is set (`render`): its height, if this account
        // measured it last.
        composerView.heights = session.newSessionDraftHeight
        composerView.onTextChange = { [weak self] text in
            self?.composer.drafts.setInput(text)
        }
        composerView.onHeightChange = { [weak self] in
            self?.view.setNeedsLayout()
        }
        composerView.agentButton.addAction(UIAction { [weak self] _ in self?.toggle(.agent) }, for: .touchUpInside)
        composerView.settingsButton.addAction(UIAction { [weak self] _ in self?.toggle(.settings) }, for: .touchUpInside)
        // The microphone only brings the keyboard up.
        composerView.micButton.addAction(UIAction { [weak self] _ in self?.composerView.textView.becomeFirstResponder() }, for: .touchUpInside)
        composerView.sendButton.addAction(UIAction { [weak self] _ in self?.send() }, for: .touchUpInside)
        view.addSubview(composerView)

        backdrop.isHidden = true
        backdrop.addAction(UIAction { [weak self] _ in self?.closePicker() }, for: .touchUpInside)
        view.addSubview(backdrop)

        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.showsVerticalScrollIndicator = false
        scrollView.alwaysBounceVertical = true
        scrollView.keyboardDismissMode = .interactive
        scrollView.delegate = self
        dismissArea.addAction(UIAction { [weak self] _ in
            self?.view.endEditing(true)
            self?.closePicker()
        }, for: .touchUpInside)
        scrollView.addSubview(dismissArea)
        machineRow.addAction(UIAction { [weak self] _ in self?.toggle(.machine) }, for: .touchUpInside)
        pathRow.addAction(UIAction { [weak self] _ in self?.toggle(.path) }, for: .touchUpInside)
        worktreeRow.addAction(UIAction { [weak self] _ in self?.toggle(.worktree) }, for: .touchUpInside)
        for row in [machineRow, offlineView, pathRow, worktreeRow] as [UIView] {
            dismissArea.addSubview(row)
        }
        view.addSubview(scrollView)

        keyboardTracker.isHidden = true
        keyboardTracker.isUserInteractionEnabled = false
        keyboardTracker.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(keyboardTracker)
        view.keyboardLayoutGuide.followsUndockedKeyboard = false
        // KeyboardAvoidingView pads by the keyboard's whole height, so the
        // guide starts at the screen's foot, not the safe area's.
        view.keyboardLayoutGuide.usesBottomSafeArea = false
        NSLayoutConstraint.activate([
            keyboardTracker.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            keyboardTracker.widthAnchor.constraint(equalToConstant: 1),
            keyboardTracker.topAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            keyboardTracker.heightAnchor.constraint(equalToConstant: 1),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardDidShow), name: UIResponder.keyboardDidShowNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardDidHide), name: UIResponder.keyboardDidHideNotification, object: nil)

        starter.presenter = self
        starter.onPhaseChange = { [weak self] _ in self?.render() }
        composer.onChange = { [weak self] in self?.render() }
        // The pickers' snapshot from the account's shared feed, off the main
        // thread; a heartbeat or a cursor never reaches the composer.
        let pipeline = ApplyPipeline<HomeSnapshot?, HomeSnapshot?, HomeSnapshot>(
            input: nil,
            state: nil,
            derive: { snapshot, applied in NewSessionSnapshot.derive(snapshot, applied: applied) },
            apply: { [weak self] snapshot in
                guard let self, self.context.account.session === self.session else { return false }
                ApplyPerf.measure(.screen) {
                    self.composer.update(snapshot: snapshot)
                    return 1
                }
                return true
            }
        )
        pipeline.follow(session.homeFeed.snapshots()) { $0 = $1 }
        observation = pipeline.observation
        render()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Back while a session starts: put it down, as Stop would.
        if isMovingFromParent || navigationController == nil, starter.isStarting {
            starter.cancel()
        }
    }

    private func setUpHeader() {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        navigationItem.standardAppearance = appearance
        navigationItem.scrollEdgeAppearance = appearance
        navigationItem.compactAppearance = appearance
        navigationItem.compactScrollEdgeAppearance = appearance
        navigationItem.largeTitleDisplayMode = .never
        titleView.frame = CGRect(origin: .zero, size: titleView.sizeThatFits(.zero))
        let item = UIBarButtonItem(customView: titleView)
        if #available(iOS 26.0, *) {
            // The capsule is its own glass.
            item.hidesSharedBackground = true
        }
        navigationItem.leftItemsSupplementBackButton = true
        navigationItem.leftBarButtonItem = item
    }

    // MARK: State

    private func render() {
        guard isViewLoaded else { return }
        if fillPathIfNeeded() { return }
        let drafts = composer.drafts
        model = NewSessionScreenModel(
            choices: composer.choices,
            draft: drafts.draft,
            snapshot: composer.snapshot,
            gitWorktrees: composer.gitWorktrees,
            isStarting: starter.isStarting || launching,
            now: Self.now
        )

        machineRow.value = model.machineName
        offlineView.isHidden = model.offlineHelp == nil
        if let help = model.offlineHelp {
            let text = help == .happyAgent ? Strings.NewSession.happyAgentOffline : Strings.NewSession.offlineHelp
            offlineView.body.string = text + "\n" + Strings.NewSession.switchMachinesHint
        }
        pathRow.value = model.pathName
        worktreeRow.isHidden = !model.canPickWorktree
        worktreeRow.value = model.worktreeLabel
        let offline = model.offlineHelp != nil
        for row in [pathRow, worktreeRow] {
            row.alpha = offline ? NewSessionMaterial.offlineOpacity : 1
            row.isUserInteractionEnabled = !offline
        }

        composerView.placeholderText = model.placeholder
        composerView.agentButton.update(key: model.agentKey, label: model.agentLabel)
        composerView.showsSettings = !model.settings.isEmpty
        composerView.sendButton.canSend = model.canSend
        composerView.sendButton.isBusy = starter.isStarting || launching
        composerView.setText(drafts.draft.input)
        updateActiveControls()

        if activePicker != nil { rebuildPicker() }
        view.setNeedsLayout()
    }

    /// new/index.tsx's first-path effect: a computer with no place chosen
    /// starts in its first directory, or home. A project is a place.
    private func fillPathIfNeeded() -> Bool {
        let draft = composer.drafts.draft
        guard composer.choices.currentMachine != nil, draft.selectedPath == nil, draft.selectedProjectId == nil else { return false }
        let first = model.pathItems.first { $0.projectId == nil }?.key
        composer.typePath(first ?? "~")
        return true
    }

    private func updateActiveControls() {
        composerView.agentButton.isActive = activePicker == .agent
        composerView.settingsButton.isActive = activePicker == .settings
    }

    // MARK: Layout

    private var safeTop: CGFloat {
        navigationController?.view.safeAreaInsets.top ?? view.window?.safeAreaInsets.top ?? 0
    }

    private var keyboardOverlap: CGFloat {
        max(0, view.bounds.height - keyboardTracker.frame.minY)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = view.bounds.size
        guard size.width > 0 else { return }
        let composerWidth = max(0, size.width - 2 * NewSessionScreenLayout.Metrics.composerPaddingHorizontal)
        let composerHeight = composerView.layout(width: composerWidth).size.height
        let measure = labelSizes.measurable
        var rows: [NewSessionScreenLayout.Row] = [.config(label: measure(machineRow.label))]
        if !offlineView.isHidden { rows.append(.offline(title: measure(offlineView.title), body: measure(offlineView.body))) }
        rows.append(.config(label: measure(pathRow.label)))
        if !worktreeRow.isHidden { rows.append(.config(label: measure(worktreeRow.label))) }
        let layout = NewSessionScreenLayout(.init(
            size: size,
            safeTop: safeTop,
            safeBottom: view.safeAreaInsets.bottom,
            keyboardOverlap: keyboardOverlap,
            maxWidth: max(size.width, size.height),
            composerHeight: composerHeight,
            rows: rows
        ))

        composerView.setLayoutFrame(layout.composer)
        backdrop.frame = view.bounds
        scrollView.frame = layout.scroll
        scrollView.contentSize = layout.contentSize
        dismissArea.frame = CGRect(origin: .zero, size: layout.contentSize)
        var frames = layout.rows.makeIterator()
        if let frame = frames.next() { machineRow.apply(frame) }
        if !offlineView.isHidden, let frame = frames.next() { offlineView.apply(frame) }
        if let frame = frames.next() { pathRow.apply(frame) }
        if !worktreeRow.isHidden, let frame = frames.next() { worktreeRow.apply(frame) }
        // Measured with the keyboard down, as the popovers are placed.
        if keyboardOverlap == 0 { lastConfigHeight = layout.configHeight }
        layoutPicker(composerHeight: composerHeight)
    }

    private func layoutPicker(composerHeight: CGFloat) {
        guard let pickerView, let activePicker else { return }
        let size = view.bounds.size
        let contentWidth = max(0, size.width - 2 * NewSessionPickerLayout.Metrics.inset - 2 * NewSessionPickerLayout.Metrics.paddingHorizontal)
        let content = pickerView.content.layout(width: contentWidth)
        let layout = NewSessionPickerLayout(.init(
            size: size,
            safeTop: safeTop,
            safeBottom: view.safeAreaInsets.bottom,
            composerHeight: composerHeight,
            configHeight: lastConfigHeight,
            anchor: activePicker.anchor,
            contentHeight: content.height
        ))
        var frame = layout.frame
        // The path popover rides on the keyboard while its field is typed
        // in (KeyboardStickyView).
        if activePicker == .path { frame.origin.y -= keyboardOverlap }
        let snapped = PixelGrid.snap(frame, scale: view.layoutScale)
        pickerView.bounds = CGRect(origin: .zero, size: snapped.size)
        pickerView.center = CGPoint(x: snapped.midX, y: snapped.midY)
    }

    // MARK: Pickers

    /// `togglePicker`: the same control closes its picker; another opens
    /// its own once the keyboard is down.
    private func toggle(_ picker: Picker) {
        if activePicker == picker {
            closePicker()
            return
        }
        if pendingPicker == picker { return }
        closePicker()
        if picker == .worktree { composer.refreshWorktrees() }
        if picker == .settings { settingsPage = nil }
        guard keyboardVisible else {
            open(picker)
            return
        }
        pendingPicker = picker
        pendingTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(420))
            guard !Task.isCancelled else { return }
            self?.finishOpening()
        }
        view.endEditing(true)
    }

    private func finishOpening() {
        guard let picker = pendingPicker else { return }
        cancelPending()
        open(picker)
    }

    private func cancelPending() {
        pendingPicker = nil
        pendingTask?.cancel()
        pendingTask = nil
    }

    private func open(_ picker: Picker) {
        activePicker = picker
        searchText = ""
        let content = NewSessionPickerContentView()
        content.sizes = labelSizes
        let pickerView = NewSessionPickerView(content: content)
        self.pickerView = pickerView
        rebuildPicker()
        view.addSubview(pickerView)
        backdrop.isHidden = false
        updateActiveControls()
        view.setNeedsLayout()
        view.layoutIfNeeded()

        // AnimatedPopup: in from a little smaller and lower.
        pickerView.alpha = 0
        pickerView.transform = CGAffineTransform(translationX: 0, y: NewSessionPickerLayout.Metrics.enterOffset)
            .scaledBy(x: NewSessionPickerLayout.Metrics.enterScale, y: NewSessionPickerLayout.Metrics.enterScale)
        let animator = UIViewPropertyAnimator(
            duration: NewSessionPickerLayout.Metrics.enterDuration,
            controlPoint1: CGPoint(x: 0.215, y: 0.61),
            controlPoint2: CGPoint(x: 0.355, y: 1)
        ) {
            pickerView.alpha = 1
            pickerView.transform = .identity
        }
        animator.startAnimation()
    }

    /// `closePicker`: gone at once (`exitImmediately`).
    private func closePicker() {
        cancelPending()
        guard activePicker != nil else { return }
        activePicker = nil
        settingsPage = nil
        searchRow = nil
        pathField = nil
        pickerView?.removeFromSuperview()
        pickerView = nil
        backdrop.isHidden = true
        updateActiveControls()
    }

    private func rebuildPicker() {
        guard let activePicker, let content = pickerView?.content else { return }
        content.listMaxHeight = NewSessionPickerContentLayout.Metrics.listMaxHeight
        content.paddingTop = 0
        content.paddingBottom = NewSessionPickerContentLayout.Metrics.embeddedPaddingBottom
        switch activePicker {
        case .machine:
            buildList(
                content,
                fixed: [],
                items: model.machineItems,
                selected: model.selectedMachineKey,
                search: Strings.NewSession.searchMachines
            ) { [weak self] key in
                self?.composer.selectMachine(key)
                self?.closePicker()
            }
        case .worktree:
            buildList(
                content,
                fixed: model.worktreeFixedItems,
                items: model.worktreeItems,
                selected: model.worktreeKey,
                search: model.picksWorkspaces ? Strings.NewSession.searchWorkspaces : Strings.NewSession.searchWorktrees
            ) { [weak self] key in
                self?.composer.selectWorktree(key)
                self?.closePicker()
            }
        case .agent:
            buildList(
                content,
                fixed: [],
                items: model.agentItems,
                selected: model.agentKey,
                search: Strings.NewSession.searchAgents
            ) { [weak self] key in
                self?.composer.pickAgent(key)
                self?.closePicker()
            }
        case .path:
            buildPath(content)
        case .settings:
            if let page = settingsPage, let setting = model.settings.first(where: { $0.kind == page }) {
                buildSettingsPage(content, setting)
            } else {
                buildSettings(content)
            }
        }
        view.setNeedsLayout()
    }

    /// PickerContent, embedded: a search field past four rows, the fixed
    /// rows, a divider, then the rest under their section headings.
    private func buildList(
        _ content: NewSessionPickerContentView,
        fixed: [NewSessionScreenModel.Item],
        items: [NewSessionScreenModel.Item],
        selected: String?,
        search: String?,
        header extra: [NewSessionPickerContentView.Row] = [],
        select: @escaping (String) -> Void
    ) {
        var header = extra
        let searches = search != nil && fixed.count + items.count > 4
        if searches, let search {
            let row = searchRow ?? makeSearchRow(placeholder: search)
            searchRow = row
            header.append(.field(row))
        } else {
            searchText = ""
        }
        let query = searchText.lowercased()
        let filtered = searches && !query.isEmpty ? items.filter { $0.label.lowercased().contains(query) } : items
        var list: [NewSessionPickerContentView.Row] = fixed.map { .option(optionRow($0, selected: selected, select: select)) }
        if !fixed.isEmpty && !filtered.isEmpty {
            let divider = UIView()
            divider.backgroundColor = UIColor(Palette.divider)
            list.append(.divider(divider))
        }
        var section: String?
        for item in filtered {
            if let heading = item.section, heading != section {
                list.append(.text(sectionLabel(heading)))
            }
            section = item.section
            list.append(.option(optionRow(item, selected: selected, select: select)))
        }
        if filtered.isEmpty && !query.isEmpty {
            let empty = StyledLabel(style: TextStyles.newSessionEmpty, color: Palette.textSecondary, lines: 0, alignment: .center)
            empty.string = Strings.NewSession.noResults
            list.append(.empty(empty))
        }
        content.setRows(header: header, list: list)
    }

    private func makeSearchRow(placeholder: String) -> NewSessionFieldRow {
        let row = NewSessionFieldRow(icon: .ionicons("search"), placeholder: placeholder, isPath: false)
        row.field.addAction(UIAction { [weak self, weak row] _ in
            self?.searchText = row?.field.text ?? ""
            self?.rebuildPicker()
        }, for: .editingChanged)
        return row
    }

    private func optionRow(_ item: NewSessionScreenModel.Item, selected: String?, select: @escaping (String) -> Void) -> NewSessionOptionRow {
        let isSelected = item.key == selected
        let detail = item.status.map(Self.statusText) ?? item.subtitle
        let row = NewSessionOptionRow(
            icon: .octicons(isSelected ? "check-circle-fill" : "circle"),
            iconSize: 16,
            iconTint: isSelected ? Palette.text : Palette.textSecondary,
            label: .option(item.label),
            detail: detail.map(NewSessionOptionRow.Text.detail)
        )
        row.isDimmed = item.isDimmed
        if isSelected { row.accessibilityTraits.insert(.selected) }
        let key = item.key
        row.addAction(UIAction { _ in select(key) }, for: .touchUpInside)
        return row
    }

    private func sectionLabel(_ text: String) -> StyledLabel {
        let label = StyledLabel(style: TextStyles.newSessionSection, color: Palette.textSecondary, lines: 1)
        label.string = text
        return label
    }

    /// PathPickerContent, embedded: the field, what it resolves to, then
    /// the computer's recent places.
    private func buildPath(_ content: NewSessionPickerContentView) {
        let field = pathField ?? makePathField()
        pathField = field
        if !field.field.isFirstResponder, field.field.text != model.pathValue {
            field.field.text = model.pathValue
        }
        var header: [NewSessionPickerContentView.Row] = [.field(field)]
        let isCustomPath = !model.pathValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.matchedPathKey == nil
        if let name = model.selectedProjectName {
            header.append(.text(metaLabel(Strings.NewSession.usingProject(name))))
        } else if isCustomPath {
            header.append(.text(metaLabel(Strings.NewSession.usingCustomPath)))
        }
        header.append(.text(sectionLabel(Strings.NewSession.recent)))

        var list: [NewSessionPickerContentView.Row] = model.pathItems.map { item in
            let isSelected = model.selectedProjectKey.map { item.key == $0 } ?? (item.key == model.matchedPathKey)
            let row = NewSessionOptionRow(
                icon: .ionicons("folder-outline"),
                iconSize: 16,
                iconTint: Palette.textSecondary,
                label: .option(item.label),
                detail: nil,
                trailing: isSelected ? .ionicons("checkmark-circle") : nil,
                trailingSize: isSelected ? 18 : nil
            )
            if isSelected { row.accessibilityTraits.insert(.selected) }
            row.addAction(UIAction { [weak self] _ in self?.pickPath(item) }, for: .touchUpInside)
            return .option(row)
        }
        if list.isEmpty {
            let empty = StyledLabel(style: TextStyles.newSessionEmpty, color: Palette.textSecondary, lines: 0, alignment: .center)
            empty.string = Strings.NewSession.noRecentProjects
            list.append(.empty(empty))
        }
        content.setRows(header: header, list: list)
    }

    private func makePathField() -> NewSessionFieldRow {
        let row = NewSessionFieldRow(icon: .ionicons("folder-outline"), placeholder: Strings.NewSession.pathPlaceholder, isPath: true)
        row.field.addAction(UIAction { [weak self, weak row] _ in
            self?.composer.typePath(row?.field.text ?? "")
        }, for: .editingChanged)
        row.field.addAction(UIAction { [weak self] _ in self?.closePicker() }, for: .editingDidEndOnExit)
        return row
    }

    private func metaLabel(_ text: String) -> StyledLabel {
        let label = StyledLabel(style: TextStyles.newSessionMeta, color: Palette.textSecondary)
        label.string = text
        return label
    }

    /// `handleSuggestionPress`: a catalog project is picked whole; a
    /// directory goes into the field to be adjusted.
    private func pickPath(_ item: NewSessionScreenModel.Item) {
        if let projectId = item.projectId {
            composer.pickProject(projectId)
            closePicker()
            return
        }
        let value = model.fieldValue(for: item)
        composer.typePath(value)
        guard let field = pathField?.field else { return }
        field.text = value
        field.becomeFirstResponder()
        let end = field.endOfDocument
        field.selectedTextRange = field.textRange(from: end, to: end)
    }

    /// ComposerSettingsContent: a row per setting, each opening its page.
    private func buildSettings(_ content: NewSessionPickerContentView) {
        content.listMaxHeight = nil
        content.paddingTop = NewSessionPickerContentLayout.Metrics.settingsPaddingTop
        content.paddingBottom = NewSessionPickerContentLayout.Metrics.settingsPaddingBottom
        var list: [NewSessionPickerContentView.Row] = [.text(sectionLabel(Strings.NewSession.settings))]
        for setting in model.settings {
            let row = NewSessionOptionRow(
                icon: .ionicons(setting.icon),
                iconSize: 17,
                iconTint: Palette.textSecondary,
                label: .init(string: settingTitle(setting.kind), style: TextStyles.newSessionSettingName, color: Palette.textSecondary, lines: 0),
                detail: .init(string: setting.value, style: TextStyles.newSessionOption, color: Palette.text, lines: 1),
                trailing: .ionicons("chevron-forward"),
                trailingSize: 15,
                trailingTint: Palette.groupedChevron
            )
            let kind = setting.kind
            row.addAction(UIAction { [weak self] _ in
                self?.settingsPage = kind
                self?.rebuildPicker()
            }, for: .touchUpInside)
            list.append(.option(row))
        }
        content.setRows(header: [], list: list)
    }

    /// ComposerSettingsPickerContent: back, the setting's name, its options.
    private func buildSettingsPage(_ content: NewSessionPickerContentView, _ setting: NewSessionScreenModel.Setting) {
        content.paddingBottom = 2 * NewSessionPickerContentLayout.Metrics.embeddedPaddingBottom
        let back = NewSessionBackRow(title: settingTitle(setting.kind))
        back.back.addAction(UIAction { [weak self] _ in
            self?.settingsPage = nil
            self?.rebuildPicker()
        }, for: .touchUpInside)
        let kind = setting.kind
        buildList(content, fixed: [], items: setting.items, selected: setting.selectedKey, search: nil, header: [.back(back)]) { [weak self] key in
            guard let self else { return }
            switch kind {
            case .permission: self.composer.selectPermission(key)
            case .model: self.composer.selectModel(key)
            case .effort: self.composer.selectEffort(key)
            }
            self.settingsPage = nil
            self.rebuildPicker()
        }
    }

    private func settingTitle(_ kind: NewSessionScreenModel.Setting.Kind) -> String {
        switch kind {
        case .permission: model.isCodex ? Strings.Composer.codexPermissionModeTitle : Strings.Composer.permissionModeTitle
        case .model: Strings.Composer.modelTitle
        case .effort: Strings.Composer.effortTitle
        }
    }

    /// `status.online`, or `status.lastSeen` with `formatLastSeen`.
    private static func statusText(_ status: NewSessionScreenModel.MachineStatus) -> String {
        switch status {
        case .online:
            return Strings.Composer.online
        case .lastSeen(let lastSeen):
            let time: String
            switch lastSeen {
            case .justNow: time = Strings.Composer.justNow
            case .minutes(let count): time = Strings.Composer.minutesAgo(count)
            case .hours(let count): time = Strings.Composer.hoursAgo(count)
            case .days(let count): time = Strings.Composer.daysAgo(count)
            case .date(let ms):
                let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
                let formatter = DateFormatter()
                let sameYear = Calendar.current.component(.year, from: date) == Calendar.current.component(.year, from: Date())
                formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
                time = formatter.string(from: date)
            }
            return Strings.Composer.lastSeen(time)
        }
    }

    // MARK: Keyboard

    @objc private func keyboardDidShow() {
        keyboardVisible = true
    }

    @objc private func keyboardDidHide() {
        keyboardVisible = false
        finishOpening()
    }

    // MARK: Start

    /// `handleSend`: the draft resolved now, started, and the session
    /// opened in this screen's place. The prompt is optional.
    /// Resolves the start off the main thread, then runs it. One at a
    /// time: Send is busy while it resolves; if the target moved meanwhile
    /// (another computer, path or harness), nothing starts.
    private func send() {
        guard model.canSend, !launching else { return }
        closePicker()
        let drafts = composer.drafts
        let started = drafts.draft
        let bot = drafts.bot
        let prompt = started.input.trimmingCharacters(in: .whitespacesAndNewlines)
        let composer = composer
        launching = true
        render()
        Task { @MainActor [weak self] in
            let resolved = await composer.launchPrepared(prompt: prompt, attachments: [])
            guard let self else { return }
            self.launching = false
            guard composer.isCurrentTarget(started, bot: bot) else {
                self.render()
                return
            }
            let launch: NewSessionLaunch
            switch resolved {
            case .success(let value):
                launch = value
            case .failure(let refusal):
                self.render()
                self.showStartError(refusal.errorDescription ?? SessionStarter.Message.startFailed)
                return
            }
            self.render()
            guard let sessionId = await self.starter.start(launch, isCurrentTarget: { composer.isCurrentTarget(started, bot: bot) }) else {
                self.render()
                return
            }
            // Only what was sent is cleared: edits made while it ran stay.
            if drafts.draft.input == started.input { drafts.setInput("") }
            self.openSession(sessionId)
        }
    }

    /// `router.back()` then `navigateToSession`: the session takes this
    /// screen's place on the stack.
    private func openSession(_ sessionId: String) {
        guard let navigation = navigationController, let session = context.account.session else { return }
        var stack = navigation.viewControllers
        if stack.last === self { stack.removeLast() }
        stack.append(Screens.make(.session(id: sessionId), context: context, session: session))
        navigation.setViewControllers(stack, animated: true)
    }
}

extension NewSessionViewController: UIScrollViewDelegate {
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        view.endEditing(true)
        closePicker()
    }
}

extension NewSessionViewController: SessionStarterPresenter {
    func showStartError(_ message: String) {
        Alerts.show(Strings.Common.error, message, on: self)
    }

    func confirmDirectoryCreation(_ directory: String) async -> Bool {
        await Alerts.confirm(
            Strings.Home.createDirectoryTitle,
            Strings.Home.createDirectoryMessage(directory),
            confirmTitle: Strings.Home.create,
            on: self
        )
    }

    func showAttachmentsNotSupported() {
        Alerts.show(Strings.ImageUpload.notSupportedTitle, Strings.ImageUpload.notSupportedMessage, on: self)
    }

    /// Never asked here: this screen starts sessions, not bots.
    func offerBotFaceRetry(_ message: String) async -> Bool {
        await Alerts.confirm(
            Strings.Home.botFaceNotSet,
            message,
            confirmTitle: Strings.Home.botFaceTryAgain,
            cancelTitle: Strings.Home.botFaceNotNow,
            on: navigationController ?? self
        )
    }
}
#endif

#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import HappyStore
import HappyWire
import os
import UIKit

private let logger = Logger(subsystem: "engineering.happy", category: "composer")

/// The chat's composer: AgentInput.tsx as SessionView.tsx drives it on an
/// iPhone. The card (`AgentInputCardView`) with the connection status above
/// it and the week quota and context gauge under it; both rows fade while
/// the reader is back in history.
///
/// It keeps the draft (useDraft.ts), holds picked images (useImagePicker.ts),
/// suggests commands and files for the word at the caret (`/` and `@`),
/// sends through `environment.sender`, stops the agent, and shows the
/// permission, model and effort picks: the
/// session's own (its composer state) over the agent defaults over the
/// metadata (`ComposerModes`). A pick shows at once and goes out through
/// `sessionSetAgentModes`.
///
/// The store is never touched on the main thread. The draft, the session's
/// picks and the failed uploads arrive from `ComposerDraftWriter`, which
/// reads and writes them in order on a background task and delivers only
/// what moved; the view keeps the draft logic in `ComposerDraftModel`.
///
/// A chat still being started (`pending-chat:`) writes every keystroke to
/// its record (`environment.draftStorage`) and queues its send there; when
/// the session arrives, `retarget` moves the same composer over.
///
/// In a window wider than 700 points (happy-app's `screenWidth`, the
/// window's, not the chat column's) the card is the flat panel with the
/// gear, Stop, image and send (`desktopActionControls`). The same text view
/// carries across the line as the window is resized.
///
/// It follows the person's text size on its own (`FollowsTextSize`, set on
/// itself), as React Native scales AgentInput: every height it reports is
/// measured from its text as drawn, so the chat lays it out at that size
/// whether or not the rest of the screen follows yet.
final class SessionComposerView: UIView, ChatComposerView, AgentInputCardDelegate {
    weak var composerDelegate: (any ChatComposerDelegate)?

    private var environment: ChatComposerEnvironment
    private let card: AgentInputCardView
    private let statusDot = StatusDotView()
    private let statusLabel = UILabel()
    private let weekButton = UIButton(type: .custom)
    private let weekLabel = UILabel()
    private let contextButton = ContextUsageControl()

    private var state: ChatComposerState?
    private var picks = ComposerPicks()
    private var modes: ComposerModes
    private var status: ComposerStatus?
    private var vibingWord = ComposerStatus.randomVibingWord()
    private var usage: ComposerUsage?
    private var showsPreciseContext = false
    private var detailsVisible = true

    private var draft = ComposerDraftModel()
    private var draftWriter: ComposerDraftWriter
    /// The debounce of an edit to non-empty text (`DraftAutosave.interval`).
    private var draftSave: Task<Void, Never>?
    /// A read asked for after a composition ended, not yet delivered.
    private var draftRefreshPending = false
    /// The panel is being switched for the window (`followWindow`): the
    /// card's height change isn't passed on as it happens.
    private var followingWindow = false
    private var isAborting = false
    /// Stop was pressed; Stop stays hidden until the agent stops working
    /// (`stopRequested`), so a late status update can't leave it up.
    private var stopRequested = false
    private var isSending = false
    /// Picked images wait here until the outbox has its own copies.
    private let staging: ComposerAttachmentStaging
    private let images: ComposerImagePicker

    /// useActiveSuggestions: the last list and its highlighted row, kept
    /// while the query moves, shown only while there is a query.
    private let suggestionList = ComposerSuggestionListView()
    private var suggestions: (items: [ComposerSuggestion], selected: Int) = ([], -1)
    private var activeQuery: String?
    private var suggestionTask: Task<Void, Never>?
    private var isSuggestionListShown = false

    /// See `ChatComposerView.isRestored`.
    private(set) var isRestored = false
    private(set) var restoreGeneration = 0
    /// The width the screen last asked the height at.
    private var askedWidth: CGFloat?
    /// The card width the restore waits on the text's height at.
    private var restoreWaitWidth: CGFloat?
    private var restoreDeadline: Task<Void, Never>?
    /// `ChatComposerRestore.timeout`; a test that checks the draft is
    /// measured before it shows sets it beyond reach.
    private let restoreTimeout: Duration
    /// Inside `composerHeight(fitting:)`: a restore reached there is
    /// announced after it.
    private var answeringHeight = false

    private var statusSize: CGSize = .zero
    private var weekSize: CGSize = .zero
    /// The text size the status and usage rows were last drawn at.
    private var detailsScale: TextScale?

    /// Read each time, in the screens' language (a `let` would keep the
    /// first one across a language change).
    private static var titles: ComposerChipSet.Titles { ComposerChipSet.Titles(
        permission: Strings.Composer.permissionModeTitle,
        codexPermission: Strings.Composer.codexPermissionModeTitle,
        geminiPermission: Strings.Composer.geminiPermissionModeTitle,
        model: Strings.Composer.modelTitle,
        effort: Strings.Composer.effortTitle
    ) }

    init(environment: ChatComposerEnvironment, restoreTimeout: Duration = ChatComposerRestore.timeout) {
        self.environment = environment
        self.restoreTimeout = restoreTimeout
        draftWriter = Self.makeWriter(environment, generation: 0, after: nil)
        staging = ComposerAttachmentStaging(filesDirectory: environment.account.filesDirectory)
        images = ComposerImagePicker(staging: staging)
        modes = ComposerModes(metadata: nil, picks: ComposerPicks(), agentDefaultOverrides: [:])
        card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: Strings.Composer.inputPlaceholder))
        super.init(frame: .zero)
        // Before anything is measured: every height here is measured as
        // drawn (docs/DYNAMIC-TYPE.md).
        traitOverrides.followsTextSize = true

        statusDot.isUserInteractionEnabled = false
        addSubview(statusDot)
        statusLabel.isUserInteractionEnabled = false
        statusLabel.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(voiceStatusTapped)))
        addSubview(statusLabel)

        card.delegate = self
        addSubview(card)
        images.host = { [weak self] in self?.hostViewController }
        images.onChange = { [weak self] in self?.applyConfiguration() }

        weekLabel.isUserInteractionEnabled = false
        weekButton.addSubview(weekLabel)
        weekButton.showsMenuAsPrimaryAction = true
        weekButton.preferredMenuElementOrder = .fixed
        addSubview(weekButton)
        contextButton.addTarget(self, action: #selector(contextTapped), for: .touchUpInside)
        addSubview(contextButton)
        suggestionList.isHidden = true
        suggestionList.onSelect = { [weak self] index in self?.selectSuggestion(index) }
        addSubview(suggestionList)

        applyConfiguration()
        applyDetails()
        // The draft comes in once read; the text stays empty until then,
        // and the screen keeps the composer hidden (`isRestored`), at most
        // this long.
        draftWriter.start { [weak self] delivery in
            self?.receive(delivery)
        }
        let timeout = restoreTimeout
        restoreDeadline = Task { [weak self] in
            try? await Task.sleep(for: timeout)
            guard !Task.isCancelled else { return }
            self?.restored()
        }

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(appWillResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(appWillResignActive), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(voiceChanged), name: .voiceStateChanged, object: nil)
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitHorizontalSizeClass.self]) { (self: Self, _) in
            self.applyDetails()
            self.composerDelegate?.composerDidInvalidateHeight(self)
        }
        registerForTraitChanges([ZenModeTrait.self]) { (self: Self, _) in
            self.applyConfiguration()
        }
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            guard self.syncTextSize() else { return }
            self.setNeedsLayout()
            self.composerDelegate?.composerDidInvalidateHeight(self)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        draftWriter.close()
        restoreDeadline?.cancel()
    }

    private static func makeWriter(_ environment: ChatComposerEnvironment, generation: Int, after predecessor: ComposerDraftWriter?) -> ComposerDraftWriter {
        ComposerDraftWriter(
            sessionId: environment.sessionId,
            storage: environment.draftStorage,
            sending: environment.sender,
            generation: generation,
            after: predecessor,
            onFailure: { failure in
                logger.error("draft \(String(describing: failure.operation), privacy: .public) failed: \(String(describing: failure.error), privacy: .public)")
            }
        )
    }

    // MARK: ChatComposerView

    func composerHeight(fitting width: CGFloat) -> CGFloat {
        // The screen lays out with this answer.
        followWindow()
        answeringHeight = true
        defer { answeringHeight = false }
        let layout = layout(width: width)
        askedWidth = width
        awaitRestore(cardWidth: layout.card.width)
        return layout.size.height
    }

    // MARK: Restore

    /// Once the opening draft is in and the screen has asked for a height:
    /// waits for the card's text height at that width, measured off the
    /// main thread. The card follows the text if it moves meanwhile.
    private func awaitRestore(cardWidth: CGFloat? = nil) {
        guard !isRestored, draft.isLoaded, let askedWidth else { return }
        let width = cardWidth ?? layout(width: askedWidth).card.width
        guard width > 0, width != restoreWaitWidth else { return }
        restoreWaitWidth = width
        let generation = restoreGeneration
        // Started after the deadline was, so the deadline runs out first.
        card.whenTextMeasured(fitting: width, timeout: restoreTimeout) { [weak self] readiness in
            // A wait that ran out or was replaced: the deadline (or a newer
            // wait) decides.
            guard let self, readiness == .measured, generation == self.restoreGeneration else { return }
            self.restored()
        }
    }

    /// The composer may be shown: its draft is measured, the wait ran out,
    /// or the person reached it first. Nothing is measured here.
    private func restored() {
        guard !isRestored else { return }
        isRestored = true
        restoreDeadline?.cancel()
        restoreDeadline = nil
        restoreWaitWidth = nil
        card.cancelTextReadiness()
        let generation = restoreGeneration
        guard answeringHeight else {
            composerDelegate?.composerDidRestore(self, generation: generation)
            return
        }
        // The screen is laying out with this composer: it hears after.
        DispatchQueue.main.async { [weak self] in
            guard let self, generation == self.restoreGeneration else { return }
            self.composerDelegate?.composerDidRestore(self, generation: generation)
        }
    }

    var cardOffset: CGFloat {
        layout(width: bounds.width).cardOffset
    }

    func update(_ state: ChatComposerState) {
        guard state != self.state else { return }
        let previous = self.state
        let before = (composerHeight(fitting: bounds.width), cardOffset)
        let wasSynced = isDraftSynced
        self.state = state
        let record = state.session.record

        recomputeModes()
        if isDraftSynced, !wasSynced, draft.isLoaded {
            // A draft read before the session was known to be a Happy
            // Agent's was not taken as a remote edit; look again.
            draftWriter.refresh()
        }

        if let record {
            let sessionState = SessionState(record)
            if sessionState != status?.state {
                vibingWord = ComposerStatus.randomVibingWord()
            }
            // A stopped session's "last seen" comes worked out on the
            // presence clock, and changes only when its text does.
            status = ComposerStatus(record: record, lastSeen: state.session.lastSeen, now: Self.now, vibingWord: vibingWord)
        } else {
            status = nil
        }
        usage = ComposerUsage(
            usage: state.usage,
            usageLimits: record?.agentState?["usageLimits"],
            alwaysShowContextSize: state.session.settings.bool("alwaysShowContextSize"),
            showRemaining: state.session.settings.bool("usageLimitShowRemaining")
        )
        if !SessionComposerRules.showsAbortButton(record) {
            stopRequested = false
        }
        // Nothing to attach to: a picked image would be dropped at send.
        if !SessionComposerRules.canUseAttachments(record), !images.images.isEmpty {
            images.clear()
        }

        applyDetails()
        applyConfiguration()
        if previous == nil {
            // A draft that ends in "/co" opens on its suggestions.
            updateActiveWord()
        }
        if before != (composerHeight(fitting: bounds.width), cardOffset) {
            composerDelegate?.composerDidInvalidateHeight(self)
        }
        setNeedsLayout()
    }

    func retarget(_ environment: ChatComposerEnvironment) {
        guard environment.sessionId != self.environment.sessionId else { return }
        // The pending edit goes to the old store; the new writer waits for
        // the old one before it reads or writes.
        flushDraft()
        let previous = draftWriter
        previous.close()
        self.environment = environment
        draft.retarget()
        draftRefreshPending = false
        if !isRestored {
            // What was being waited for is the old store's draft: the new
            // store's first read is waited for instead, within the same
            // deadline.
            restoreGeneration += 1
            restoreWaitWidth = nil
            card.cancelTextReadiness()
        }
        draftWriter = Self.makeWriter(environment, generation: draft.generation, after: previous)
        draftWriter.start { [weak self] delivery in
            self?.receive(delivery)
        }
        // File suggestions come from the new session.
        activeQuery = nil
        suggestionTask?.cancel()
        suggestionTask = nil
        updateActiveWord()
    }

    func setDetailsVisible(_ visible: Bool, animated: Bool) {
        guard visible != detailsVisible else { return }
        detailsVisible = visible
        // AnimatedFade: 180ms in, 140ms out.
        let duration = visible ? AgentInputLayout.Metrics.fadeInDuration : AgentInputLayout.Metrics.fadeOutDuration
        UIView.animate(withDuration: animated ? duration : 0, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            self.applyDetailsAlpha()
        }
    }

    var isTextFocused: Bool { card.isTextFocused }

    func focus() {
        // Reached before it was shown: it shows now, at the height known.
        restored()
        card.focus()
    }

    func blur() {
        card.blur()
    }

    // MARK: Layout

    private var maxContentWidth: CGFloat {
        ContentWidth.maxWidth // Tablet (HappyUI/Tablet): layout.ts maxWidth, was 800 by size class.
    }

    /// useLayoutDimensions' width: the window's. Before the composer is in
    /// one, its own.
    private var screenWidth: CGFloat {
        window?.bounds.width ?? bounds.width
    }

    private var isWide: Bool {
        AgentInputLayout.isWide(screenWidth: screenWidth)
    }

    /// The window crossed 700 points (Split View, Slide Over, Stage
    /// Manager, a rotation, the composer arriving in its window): the
    /// panel follows. True if it changed.
    @discardableResult
    private func followWindow() -> Bool {
        guard isWide != (card.configuration.desktop != nil) else { return false }
        followingWindow = true
        applyConfiguration()
        followingWindow = false
        return true
    }

    /// The panel changed without the screen asking for a height: it hears
    /// of it after the current pass, unanimated.
    private func followWindowLater() {
        guard followWindow() else { return }
        setNeedsLayout()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.composerDelegate?.composerDidInvalidateHeight(self)
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        followWindowLater()
    }

    /// The person's text size, as the composer draws it.
    private var textScale: TextScale? {
        traitCollection.textEnvironment?.scale
    }

    /// Draws the rows again if the text size moved since; true if it did.
    /// The card and the suggestion rows keep up on their own.
    @discardableResult
    private func syncTextSize() -> Bool {
        guard textScale != detailsScale else { return false }
        applyDetails()
        return true
    }

    private func layout(width: CGFloat) -> AgentInputLayout {
        // Measured before the first trait update: measure what will be drawn.
        syncTextSize()
        let screenWidth = self.screenWidth
        let paddingH = AgentInputLayout.paddingH(screenWidth: screenWidth)
        let maxContentWidth = self.maxContentWidth
        let innerWidth = AgentInputLayout.innerWidth(width: width, paddingH: paddingH, maxContentWidth: maxContentWidth)
        return AgentInputLayout(.init(
            width: width,
            paddingH: paddingH,
            maxContentWidth: maxContentWidth,
            screenWidth: screenWidth,
            statusText: status == nil && voiceStatus == nil ? nil : statusSize,
            panel: card.panelInput(width: innerWidth),
            usageWeek: usage?.weekPercent == nil ? nil : weekSize,
            usageContext: usage?.context == nil ? nil : contextButton.labelSize
        ))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Normally caught when the screen asks for the height.
        followWindowLater()
        let layout = layout(width: bounds.width)
        if let row = layout.status {
            statusDot.setLayoutFrame(row.dot)
            statusLabel.setLayoutFrame(row.text)
        }
        card.setLayoutFrame(layout.card)
        if let week = layout.usage?.week {
            // The menu trigger is padded out 10 and pulled back in.
            let slop = AgentInputLayout.Metrics.usageWeekSlop
            weekButton.setLayoutFrame(week.insetBy(dx: -slop, dy: -slop))
            weekLabel.frame = CGRect(x: slop, y: slop, width: week.width, height: week.height)
        }
        if let context = layout.usage?.context, let text = layout.usage?.contextText, let gauge = layout.usage?.gauge {
            contextButton.setLayoutFrame(context)
            contextButton.place(
                label: text.offsetBy(dx: -context.minX, dy: -context.minY),
                gauge: gauge.offsetBy(dx: -context.minX, dy: -context.minY)
            )
        }
        if isSuggestionListShown {
            // Bounds and centre: the list may be mid-way through its rise.
            let frame = PixelGrid.snap(
                layout.autocomplete(rows: suggestionList.suggestions.count, border: suggestionList.border),
                scale: max(1, traitCollection.displayScale)
            )
            suggestionList.bounds = CGRect(origin: .zero, size: frame.size)
            suggestionList.center = CGPoint(x: frame.midX, y: frame.midY)
        }
    }

    /// The suggestion list hangs above the composer, outside its bounds.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        super.point(inside: point, with: event)
            || (isSuggestionListShown && suggestionList.frame.contains(point))
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        if newWindow == nil {
            flushDraft()
        }
    }

    // MARK: Modes

    private func recomputeModes() {
        modes = ComposerModes(
            metadata: state?.session.record?.metadata,
            picks: picks,
            agentDefaultOverrides: state?.session.settings.agentDefaultOverrides ?? [:]
        )
    }

    func agentInputCard(_ card: AgentInputCardView, didSelect key: String, in chip: AgentInputChip) {
        guard let record = state?.session.record else { return }
        let patch: SessionAgentModesPatch
        switch chip {
        case .permission:
            guard let mode = modes.availableModes.first(where: { $0.key == key }) else { return }
            patch = ComposerModes.patch(selectingPermission: mode)
        case .model:
            guard let model = modes.availableModels.first(where: { $0.key == key }) else { return }
            patch = ComposerModes.patch(
                selectingModel: model,
                flavor: record.metadata?["flavor"]?.stringValue,
                metadata: record.metadata,
                sessionEffortLevel: picks.effortLevel
            )
        case .effort:
            guard let level = modes.availableEffortLevels.first(where: { $0.key == key }) else { return }
            patch = ComposerModes.patch(selectingEffort: level)
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        // Shown at once; the op writes the composer state, then the metadata.
        picks = picks.applying(patch)
        recomputeModes()
        applyConfiguration()
        let account = environment.account
        let sessionId = environment.sessionId
        // It reads and writes the store before it goes out: not on main.
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                try await account.actions.sessionSetAgentModes(sessionId: sessionId, patch: patch, transport: account.realtime)
            } catch {
                logger.error("sessionSetAgentModes failed: \(String(describing: error), privacy: .public)")
                await self?.restoreStoredPicks()
            }
        }
    }

    /// A pick that never reached the store goes back to the stored one. One
    /// that did (only the network failed) comes back with the store's next
    /// read and stays.
    private func restoreStoredPicks() {
        guard let stored = draft.storePicks, stored != picks else { return }
        picks = stored
        recomputeModes()
        applyConfiguration()
    }

    // MARK: Card

    private func applyConfiguration() {
        let record = state?.session.record
        let chips = ComposerChipSet(modes: modes, record: record, titles: Self.titles)
        let canAttach = SessionComposerRules.canUseAttachments(record)
        let primary = AgentInputPrimaryAction.resolve(
            hasComposerContent: hasComposerContent,
            isSendBlocked: SessionComposerRules.isSendBlocked(record),
            isSendDisabled: false,
            showAbortButton: SessionComposerRules.showsAbortButton(record),
            canAbort: SessionComposerRules.canAbort(record) && !stopRequested,
            canVoice: record != nil && !environment.sessionId.hasPrefix("pending-chat:")
        )
        var configuration = card.configuration
        configuration.permission = chips.permission.map(Self.chip)
        configuration.model = Self.chip(chips.model)
        configuration.effort = chips.effort.map(Self.chip)
        configuration.primaryAction = primary
        configuration.primaryAccessibilityLabel = primary == .voice ? Strings.Voice.title : nil
        configuration.isPrimaryBusy = isAborting
        configuration.showsAdd = canAttach
        // localSettings.zenMode, as SessionView passes it.
        configuration.zenMode = traitCollection.isZenMode
        configuration.attachments = canAttach
            ? images.images.map { AgentInputAttachmentPreview(id: $0.id, fileURL: $0.attachment.fileURL) }
            : []
        configuration.desktop = isWide ? AgentInputDesktopConfiguration(
            settings: chips.showsSettings ? AgentInputSettingsMenu(sections: chips.settings.map(Self.settingsSection)) : nil,
            showsStop: SessionComposerRules.canAbort(record),
            isStopBusy: isAborting,
            // SessionView passes no `isSending`: a send never spins here.
            send: AgentInputDesktopSend(
                hasText: card.hasContent,
                hasComposerContent: hasComposerContent,
                isSendBlocked: SessionComposerRules.isSendBlocked(record)
            )
        ) : nil
        card.configuration = configuration
    }

    private static func settingsSection(_ section: ComposerChipSet.SettingsSection) -> AgentInputSettingsMenu.Section {
        let chip: AgentInputChip = switch section.kind {
        case .permission: .permission
        case .model: .model
        case .effort: .effort
        }
        return AgentInputSettingsMenu.Section(
            chip: chip,
            title: section.title,
            systemImage: section.systemImage,
            options: section.options.map { .init(key: $0.key, label: $0.label, isDisabled: $0.isDisabled) },
            selectedKey: section.selectedKey
        )
    }

    /// Text or a picked image (`hasComposerContent`), read live.
    private var hasComposerContent: Bool {
        card.hasContent || !images.images.isEmpty
    }

    private static func chip(_ chip: ComposerChipSet.Chip) -> AgentInputChipConfiguration {
        AgentInputChipConfiguration(
            content: chip.label.map { .label($0) } ?? .icon(.ionicons("shield-outline")),
            accessibilityLabel: chip.accessibilityLabel,
            menu: chip.sections.map { sections in
                AgentInputMenu(
                    sections: sections.map { section in
                        AgentInputMenu.Section(
                            title: section.title,
                            options: section.options.map { .init(key: $0.key, label: $0.label, isDisabled: $0.isDisabled) }
                        )
                    },
                    selectedKey: chip.selectedKey
                )
            }
        )
    }

    /// Something besides whitespace (`trim().length > 0`).
    private static func hasContent(_ text: String) -> Bool {
        !DraftAutosave.isBlank(text)
    }

    func agentInputCardDidChangeText(_ card: AgentInputCardView) {
        draftChanged()
        applyDeferredRemoteDraft()
        applyConfiguration()
        updateActiveWord()
    }

    func agentInputCardDidChangeSelection(_ card: AgentInputCardView) {
        applyDeferredRemoteDraft()
        updateActiveWord()
    }

    /// Return picks the highlighted suggestion (or the first) instead of
    /// starting a line.
    func agentInputCardShouldInsertNewline(_ card: AgentInputCardView) -> Bool {
        !pickSuggestionOnKey()
    }

    /// So does a hardware keyboard's Tab: Fabric reports the typed "\t" as
    /// "Tab" (TextInputEventEmitter), which AgentInput's handleKeyPress
    /// takes as Enter. With no list, the tab is typed.
    func agentInputCardShouldInsertTab(_ card: AgentInputCardView) -> Bool {
        !pickSuggestionOnKey()
    }

    /// Picks the highlighted suggestion, or the first; false with no list.
    private func pickSuggestionOnKey() -> Bool {
        guard activeQuery != nil, !suggestions.items.isEmpty else { return false }
        selectSuggestion(max(0, suggestions.selected))
        return true
    }

    func agentInputCardDidChangeFocus(_ card: AgentInputCardView) {
        if card.isTextFocused {
            restored()
        } else {
            flushDraft()
        }
        applyDeferredRemoteDraft()
        composerDelegate?.composerDidChangeFocus(self)
    }

    func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) {
        guard !followingWindow else { return }
        guard card.animatesHeightChange else {
            // The opening draft, measured a moment after it was set.
            UIView.performWithoutAnimation {
                self.composerDelegate?.composerDidInvalidateHeight(self)
            }
            return
        }
        UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            self.composerDelegate?.composerDidInvalidateHeight(self)
        }
    }

    /// Stop and send share the button; which one fires comes from the live
    /// text, not the configuration, which can lag a fast type-then-tap.
    func agentInputCardDidPressPrimary(_ card: AgentInputCardView) {
        if !hasComposerContent, card.configuration.primaryAction == .voice, let host = hostViewController {
            blur()
            VoiceCoordinator.shared.start(account: environment.account, sessionId: environment.sessionId, presenting: host)
            return
        }
        if !hasComposerContent, card.configuration.primaryAction == .stop {
            abort()
            return
        }
        sendPressed()
    }

    /// The flat panel's send and stop are buttons of their own.
    func agentInputCardDidPressSend(_ card: AgentInputCardView) {
        sendPressed()
    }

    func agentInputCardDidPressStop(_ card: AgentInputCardView) {
        abort()
    }

    func agentInputCardDidPressAdd(_ card: AgentInputCardView) {
        images.attach()
    }

    func agentInputCard(_ card: AgentInputCardView, didRemoveAttachment id: String) {
        images.remove(id: id)
    }

    // MARK: Send

    private func sendPressed() {
        restored()
        let record = state?.session.record
        if SessionComposerRules.isSendBlocked(record) {
            // The agent refuses steering while it works.
            guard card.hasContent, !isSending else { return }
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            card.shake()
            return
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        guard hasComposerContent else { return }
        stopRequested = false
        send()
    }

    private func send() {
        guard !isSending else { return }
        let text = card.text
        let picked = images.images
        let message = OutgoingMessage(text: text, attachments: picked.map(\.attachment))
        // sync.ts: images the agent can't take are named before anything
        // goes; with nothing else to send, nothing does. A few pictures
        // against the record the screen already holds.
        if !picked.isEmpty,
           let record = state?.session.record,
           case let plan = OutboxSender.attachmentPlan(message, session: record),
           plan.shouldShowUnsupportedAlert {
            alert(Strings.ImageUpload.notSupportedTitle, Strings.ImageUpload.notSupportedMessage)
            if !plan.shouldSendText || (!Self.hasContent(text) && plan.accepted.isEmpty) {
                return
            }
        }
        isSending = true
        let sentEdits = card.editCount
        // What the send does with the draft is its target's: a pending
        // chat's submit empties its record even if the session arrives
        // before it returns, and the handover carries the record over.
        let clearsStored = !isDraftSynced && !isPending
        // Behind the draft writes before it, ahead of the ones after.
        let sending = draftWriter.send(message)
        // The outbox copies the staged files; they outlive a composer
        // closed mid-send.
        let staging = staging
        Task { [weak self] in
            do {
                let localId = try await sending.value
                withExtendedLifetime(staging) {}
                guard let self else { return }
                self.isSending = false
                // Only clear what was sent: typing may have gone on.
                // A Happy Agent's send cleared its draft, a pending chat's
                // submit its record's. The text is compared only if it
                // was edited meanwhile.
                if self.card.editCount == sentEdits || self.card.text == text {
                    self.clearDraft(stored: clearsStored)
                    self.card.text = ""
                }
                self.images.removeSent(picked.map(\.id))
                self.applyConfiguration()
                self.loadAfterSend()
                self.composerDelegate?.composer(self, didSend: localId)
            } catch {
                self?.isSending = false
                self?.loadAfterSend()
                logger.error("send failed: \(String(describing: error), privacy: .public)")
                if error is ComposerDraftWriter.UnsavedDraftError {
                    // Nothing went; the text stays for another try.
                    UINotificationFeedbackGenerator().notificationOccurred(.error)
                    self?.card.shake()
                }
            }
        }
    }

    // MARK: Stop

    private func abort() {
        guard !isAborting else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        stopRequested = true
        isAborting = true
        applyConfiguration()
        let controls = environment.controls
        let sessionId = environment.sessionId
        let start = ContinuousClock.now
        Task { [weak self] in
            do {
                try await controls.abort(sessionId: sessionId)
                // At least 300ms of spinner.
                let elapsed = ContinuousClock.now - start
                if elapsed < .milliseconds(300) {
                    try? await Task.sleep(for: .milliseconds(300) - elapsed)
                }
            } catch {
                self?.stopRequested = false
                self?.card.shakePrimary()
                logger.error("abort failed: \(String(describing: error), privacy: .public)")
            }
            self?.isAborting = false
            self?.applyConfiguration()
        }
    }

    // MARK: Draft

    /// A Happy Agent session: every edit is written at once and others'
    /// edits come in through the store.
    private var isDraftSynced: Bool {
        !isPending && RigCatalog.isRigV1(state?.session.record?.metadata)
    }

    /// A chat still being started: every keystroke goes to its record at
    /// once (setPendingChatDraft), and nothing else writes there.
    private var isPending: Bool {
        PendingChats.isPendingChatId(environment.sessionId)
    }

    /// An edit, a keystroke at the end of a long text included: the
    /// draft hears only whether it is blank, which stops at the first
    /// character that isn't, and a write carries the field's snapshot, read
    /// off the main thread. Nothing here grows with the text.
    private func draftChanged() {
        draftSave?.cancel()
        draftSave = nil
        let card = card
        let (write, debounce) = draft.textChanged(
            isBlank: !card.hasContent, synced: isDraftSynced || isPending, text: ComposerDraftText(card.textSnapshot)
        )
        if let write {
            draftWriter.save(write)
        }
        if debounce {
            draftSave = Task { [weak self] in
                try? await Task.sleep(for: DraftAutosave.interval)
                guard !Task.isCancelled, let self else { return }
                self.flushDraft()
            }
        }
    }

    private func flushDraft() {
        draftSave?.cancel()
        draftSave = nil
        if let write = draft.flush(text: ComposerDraftText(card.textSnapshot)) {
            draftWriter.save(write)
        }
    }

    /// `stored`: also delete the stored draft. A Happy Agent session's
    /// send already cleared it, unless writing began during the send.
    private func clearDraft(stored: Bool) {
        draftSave?.cancel()
        draftSave = nil
        draftWriter.save(draft.clear(stored: stored))
    }

    /// A read from the writer: the opening draft, useDraft's store
    /// subscription (another device edited a Happy Agent session's draft:
    /// it replaces the text, caret at the end, but not under an input
    /// method's composition, which it would cut off), the session's picks
    /// and the uploads the outbox gave up on.
    private func receive(_ delivery: ComposerStoreDelivery) {
        draftRefreshPending = false
        let opening = !draft.isLoaded
        let card = card
        let change = draft.receive(
            delivery, field: ComposerDraftText(card.textSnapshot), fieldIsEmpty: card.isEmpty,
            fieldIsBlank: !card.hasContent, synced: isDraftSynced, composing: card.hasMarkedText, sending: isSending
        )
        // sessionSetAgentModes and the metadata reconciler write the picks.
        if let picks = change.picks, picks != self.picks {
            self.picks = picks
            recomputeModes()
            applyConfiguration()
        }
        if let write = change.write {
            draftWriter.save(write)
        }
        if let text = change.text {
            draftSave?.cancel()
            draftSave = nil
            if opening {
                // The draft the chat opens with: no animated growth, now
                // or when its height lands.
                UIView.performWithoutAnimation {
                    card.setText(text, selection: NSRange(location: (text as NSString).length, length: 0), animatesHeight: false)
                }
            } else {
                card.text = text
            }
        }
        // The opening draft is in (or there is none): its height is
        // waited for before the composer shows.
        awaitRestore()
        if change.newlyFailedAttachments > 0 {
            alert(Strings.ImageUpload.uploadFailedTitle, Strings.ImageUpload.uploadFailedMessage(change.newlyFailedAttachments))
        }
    }

    /// The send is back, the field cleared if it went: a first read put
    /// off for it (`ComposerDraftModel.receive`) is asked for again.
    private func loadAfterSend() {
        if draft.sendReturned() { draftWriter.refresh() }
    }

    /// The composition a remote edit waited for has ended (committed,
    /// cancelled or blurred). The text change runs first, so a committed
    /// edit is written before the store is read again, and stays.
    private func applyDeferredRemoteDraft() {
        guard draft.autosave.remoteDeferred, !card.hasMarkedText, !draftRefreshPending else { return }
        draftRefreshPending = true
        draftWriter.refresh()
    }

    /// On the way to the background: the pending edit goes to disk under a
    /// background task, so a suspension right after can't drop it.
    @objc private func appWillResignActive() {
        flushDraft()
        let writer = draftWriter
        let lease = DraftWriteLease()
        Task {
            if !(await writer.settle()) {
                // Still unsaved; the writer keeps trying while it can.
                logger.error("draft not saved before the background")
            }
            lease.end()
        }
    }

    // MARK: Autocomplete

    /// useActiveWord and useActiveSuggestions: the prefixed word at the
    /// caret is the query; its suggestions replace the list when they
    /// arrive (a newer query drops older answers).
    private func updateActiveWord() {
        // Read in place: each keystroke and caret move asks.
        let query = ComposerAutocomplete.findActiveWord(
            units: card.textUnits, selection: card.selectedRange, prefixes: ComposerAutocomplete.chatPrefixes
        )?.activeWord
        guard query != activeQuery else { return }
        activeQuery = query
        suggestionTask?.cancel()
        suggestionTask = nil
        applySuggestions()
        guard let query else { return }
        let metadata = state?.session.record?.metadata
        let sessionId = environment.sessionId
        let actions = environment.account.actions
        let files = environment.account.composerFileIndex
        suggestionTask = Task { [weak self] in
            // The search runs off main; only its list comes back.
            let results = await Task.detached(priority: .userInitiated) { () -> [ComposerSuggestion] in
                if query.hasPrefix("/") {
                    return ComposerCommands.suggestions(query, metadata: metadata)
                } else if query.hasPrefix("@") {
                    return await files.suggestions(query, sessionId: sessionId) { id in
                        try? await actions.sessionRipgrep(sessionId: id, args: ComposerFileIndex.ripgrepArguments)
                    }
                }
                return []
            }.value
            guard !Task.isCancelled, let self, self.activeQuery == query else { return }
            let selected = ComposerAutocomplete.selection(
                previous: self.suggestions.selected, previousCount: self.suggestions.items.count, count: results.count
            )
            self.suggestions = (results, selected)
            self.applySuggestions()
        }
    }

    private func applySuggestions() {
        let visible = activeQuery == nil ? [] : suggestions.items
        guard !visible.isEmpty else {
            guard isSuggestionListShown else { return }
            isSuggestionListShown = false
            suggestionList.animateOut { [weak self] in
                guard let self, !self.isSuggestionListShown else { return }
                self.suggestionList.isHidden = true
            }
            return
        }
        suggestionList.set(visible, selected: suggestions.selected)
        if !isSuggestionListShown {
            isSuggestionListShown = true
            suggestionList.isHidden = false
            setNeedsLayout()
            layoutIfNeeded()
            suggestionList.animateIn()
        } else {
            setNeedsLayout()
        }
    }

    /// `handleSuggestionSelect`: the whole active word becomes the pick and
    /// a space, the caret after it.
    private func selectSuggestion(_ index: Int) {
        guard activeQuery != nil, index < suggestions.items.count else { return }
        let result = ComposerAutocomplete.applySuggestion(
            card.text,
            selection: card.selectedRange,
            suggestion: suggestions.items[index].text,
            prefixes: ComposerAutocomplete.chatPrefixes,
            addSpace: true
        )
        card.setText(result.text, selection: NSRange(location: result.cursor, length: 0))
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    // MARK: Attachments

    private func alert(_ title: String, _ message: String) {
        guard let host = hostViewController else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .cancel))
        host.present(alert, animated: true)
    }

    private var hostViewController: UIViewController? {
        var responder: UIResponder? = self
        while let next = responder?.next {
            if let controller = next as? UIViewController {
                return controller
            }
            responder = next
        }
        return nil
    }

    // MARK: Status and usage

    private func applyDetails() {
        let scale = textScale
        detailsScale = scale
        let style = scale.map { TextStyles.composerStatus.scaled($0) } ?? TextStyles.composerStatus
        if let voiceStatus {
            let color = UIColor(Palette.iconBlue)
            statusLabel.attributedText = style.attributedString("\(Strings.Voice.title) · \(voiceStatus)", color: color, lineBreakMode: .byTruncatingTail)
            statusSize = statusLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
            statusDot.backgroundColor = color
            statusDot.isPulsing = true
        } else if let status {
            let color = UIColor(Self.color(status.tone))
            statusLabel.attributedText = style.attributedString(Self.text(status.text), color: color, lineBreakMode: .byTruncatingTail)
            statusSize = statusLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
            statusDot.backgroundColor = color
            statusDot.isPulsing = status.isPulsing
        }
        statusDot.isHidden = status == nil && voiceStatus == nil
        statusLabel.isHidden = status == nil && voiceStatus == nil
        statusLabel.isUserInteractionEnabled = voiceStatus != nil
        statusLabel.accessibilityTraits = voiceStatus == nil ? .staticText : .button

        if let percent = usage?.weekPercent {
            weekLabel.attributedText = style.attributedString(Strings.Composer.percentWeek(percent), color: UIColor(Palette.textSecondary))
            weekSize = weekLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        }
        weekButton.isHidden = usage?.weekPercent == nil
        weekButton.menu = usage.flatMap(Self.usageMenu)
        weekButton.isUserInteractionEnabled = weekButton.menu != nil

        if let context = usage?.context {
            let text = showsPreciseContext
                ? Strings.Composer.detailContext(
                    used: ComposerUsage.formatTokenCount(context.used),
                    total: ComposerUsage.formatTokenCount(context.total)
                )
                : Strings.Composer.percentContext(context.percent)
            let color: ColorToken = context.level == .critical ? Palette.warningCritical : Palette.textSecondary
            contextButton.configure(text: style.attributedString(text, color: UIColor(color)), percent: context.percent)
        }
        contextButton.isHidden = usage?.context == nil
        applyDetailsAlpha()
    }

    private func applyDetailsAlpha() {
        let alpha: CGFloat = detailsVisible ? 1 : 0
        for view in [statusDot, statusLabel, weekButton, contextButton] as [UIView] {
            view.alpha = alpha
        }
    }

    private var voiceStatus: String? {
        switch VoiceCoordinator.shared.state(for: environment.account) {
        case .connecting: Strings.Voice.connecting
        case .active(let activity, let muted):
            muted ? Strings.Voice.muted : activity == .agentSpeaking ? Strings.Voice.agentSpeaking : activity == .userSpeaking ? Strings.Voice.userSpeaking : Strings.Voice.listening
        default: nil
        }
    }

    @objc private func voiceChanged() {
        applyDetails()
        setNeedsLayout()
        composerDelegate?.composerDidInvalidateHeight(self)
    }

    @objc private func voiceStatusTapped() {
        guard let host = hostViewController else { return }
        blur()
        VoiceCoordinator.shared.start(account: environment.account, sessionId: environment.sessionId, presenting: host)
    }

    @objc private func contextTapped() {
        // Swaps the percent for the exact token counts.
        showsPreciseContext.toggle()
        applyDetails()
        setNeedsLayout()
    }

    /// The week text's menu: Session and Week, each with when it resets.
    private static func usageMenu(_ usage: ComposerUsage) -> UIMenu? {
        guard !usage.menu.isEmpty else { return nil }
        return UIMenu(children: usage.menu.map { row in
            let label = row.kind == .session ? Strings.Composer.usageSession : Strings.Composer.usageWeek
            let action = UIAction(title: "\(label) · \(row.percent)%") { _ in }
            if let resetsAt = row.resetsAt {
                action.subtitle = Strings.Composer.usageResets(resetTime(resetsAt))
            }
            return action
        })
    }

    /// sessionStatusBar.ts `formatUsageLimitResetTime`: a clock time within
    /// 22 hours, a date beyond.
    private static func resetTime(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate(ms - Double(now) < 22 * 3_600_000 ? "hhmm" : "MMMd")
        return formatter.string(from: date)
    }

    private static func color(_ tone: ComposerStatus.Tone) -> ColorToken {
        switch tone {
        case .disconnected: Palette.sessionStatusDisconnected
        case .attention: Palette.sessionStatusAttention
        case .thinking: Palette.sessionStatusThinking
        case .online: Palette.sessionStatusOnline
        }
    }

    private static func text(_ text: ComposerStatus.Text) -> String {
        switch text {
        case .lastSeen(let lastSeen): Strings.Composer.lastSeen(Self.lastSeen(lastSeen))
        case .permissionRequired: Strings.Composer.permissionRequired
        case .inputRequired: Strings.Composer.inputRequired
        case .thinking(let word): word
        case .online: Strings.Composer.online
        }
    }

    private static func lastSeen(_ lastSeen: ComposerStatus.LastSeen) -> String {
        switch lastSeen {
        case .justNow: return Strings.Composer.justNow
        case .minutes(let count): return Strings.Composer.minutesAgo(count)
        case .hours(let count): return Strings.Composer.hoursAgo(count)
        case .days(let count): return Strings.Composer.daysAgo(count)
        case .date(let ms):
            let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
            let formatter = DateFormatter()
            let sameYear = Calendar.current.component(.year, from: date) == Calendar.current.component(.year, from: Date())
            formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
            return formatter.string(from: date)
        }
    }

    private static var now: Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

/// A background task held until the draft writes before it are on disk.
@MainActor
private final class DraftWriteLease {
    private var task: UIBackgroundTaskIdentifier = .invalid

    init() {
        task = UIApplication.shared.beginBackgroundTask(withName: "happy.composer.draft") { [weak self] in
            self?.end()
        }
    }

    func end() {
        guard task != .invalid else { return }
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
    }
}

/// The context percent and its gauge: one tap target, slopped out
/// (top 12, left 10, bottom 14, right 14).
final class ContextUsageControl: UIControl {
    private let label = UILabel()
    private let gauge = ContextGaugeView()
    private(set) var labelSize: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.isUserInteractionEnabled = false
        addSubview(label)
        gauge.isUserInteractionEnabled = false
        addSubview(gauge)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(text: NSAttributedString, percent: Int) {
        label.attributedText = text
        labelSize = label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        gauge.percent = Double(percent)
        accessibilityLabel = text.string
    }

    func place(label frame: CGRect, gauge gaugeFrame: CGRect) {
        label.frame = frame
        gauge.frame = gaugeFrame
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let slop = AgentInputLayout.Metrics.usageContextSlop
        return CGRect(
            x: -slop.left,
            y: -slop.top,
            width: bounds.width + slop.left + slop.right,
            height: bounds.height + slop.top + slop.bottom
        ).contains(point)
    }
}

/// ContextGaugeIcon: a 14pt ring that fills clockwise from the top and
/// darkens as the context fills.
final class ContextGaugeView: UIView {
    var percent: Double = 0 {
        didSet { applyProgress() }
    }

    private let track = CAShapeLayer()
    private let progress = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        for ring in [track, progress] {
            ring.fillColor = nil
            ring.lineWidth = ContextGauge.strokeWidth
            layer.addSublayer(ring)
        }
        progress.lineCap = .round
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let radius = (min(bounds.width, bounds.height) - ContextGauge.strokeWidth) / 2
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let path = UIBezierPath(arcCenter: center, radius: radius, startAngle: -.pi / 2, endAngle: 3 * .pi / 2, clockwise: true).cgPath
        track.path = path
        progress.path = path
    }

    private func applyProgress() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        progress.strokeEnd = min(100, max(0, percent)) / 100
        CATransaction.commit()
        applyColors()
    }

    private func applyColors() {
        let dark = traitCollection.userInterfaceStyle == .dark
        let intensity = ContextGauge.intensity(percent: percent)
        track.strokeColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
        progress.strokeColor = UIColor(white: dark ? 1 : 0, alpha: intensity).cgColor
    }
}
#endif

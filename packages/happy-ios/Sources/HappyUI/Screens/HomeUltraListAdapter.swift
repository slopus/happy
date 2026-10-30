#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

@MainActor
enum HomeRendererPreference {
    static let didChange = Notification.Name("HappyHomeRendererPreferenceDidChange")
    static func set(_ renderer: HomeListRenderer, settings: LocalSettings) {
        guard renderer != settings.homeListRenderer else { return }
        settings.homeListRenderer = renderer
        NotificationCenter.default.post(name: didChange, object: settings)
    }
}

@MainActor
final class HomeUltraListAdapter {
    let view: HomeUltraListView
    var onSelect: ((HomeListRow.ID) -> Void)?
    var onLongPress: ((HomeListRow.ID) -> Void)?
    var onArchive: ((HomeListRow.ID) -> Void)?
    var onCreateWorkspace: ((HomeListRow.ID) -> Void)?
    var onArchivePersistenceFailure: (() -> Void)?
    private weak var pictures: AvatarPictures?
    private var insets: HomeContentInsets?
    private var topInset: CGFloat = 0
    private var bottomInset: CGFloat = 0
    private var banner: UIView?
    private var bannerHeight: CGFloat = 0
    private var plans: Prepared?
    private var cachedRows: [HomeListRow.ID: HomeUltraRow] = [:]
    private var cachedHiddenToggle: HomeUltraRow?
    private var shownRows: [HomeUltraRow]?
    private var hiddenRows: [HomeUltraRow]?
    private var rowsGeneration: UInt64 = 0
    private var displayedGeneration: (UInt64, Bool)?
    private(set) var displayedModel: HomeListModel?
    private var archiveSettings: HomeArchiveSettings?
    private var archiveIntent: ArchiveVisibilityWriter.Intent?
    private var archiveReceipt: ArchiveVisibilityWriter.Receipt?
    private var bannerRevision: UInt64 = 0
    private var active = true
    private var requested: Input?
    private var observation: ApplyObservation?
    private let language = AppLocalization.language

    struct Input: Equatable, Sendable {
        var model: HomeListModel
        var width: CGFloat
        var environment: HomeTextEnvironment
        var dark: Bool
        var selected: String?
        var tablet: TabletGroupedList? = nil
        var language = "en"
        var archiveModels: HomeArchiveModels? = nil
        var viewportHeight: CGFloat = 0

        var ids: [HomeListRow.ID] { tablet?.ids.map(\.ultraBridgeID) ?? model.ids }
    }
    struct Entry: Sendable {
        var row: HomeListRow?
        var tabletRow: TabletGroupedRow? = nil
        var plan: HomeRowDrawing
        var revision: UInt64
        var selected: Bool
        var usesArchiveBitmap = false
        var bitmap: HomeArchiveBitmap? = nil
    }
    struct Prepared: Sendable {
        var input: Input
        var entries: [HomeListRow.ID: Entry]
        var revisionSequence: UInt64
        var hiddenToggle: Entry? = nil
    }
    private lazy var pipeline = ApplyPipeline<Input?, Prepared?, Prepared>(
        input: nil,
        state: nil,
        derive: { input, previous in
            guard let input, input != previous?.input else { return nil }
            var entries: [HomeListRow.ID: Entry] = [:]
            var revisionSequence = previous?.revisionSequence ?? 0
            let catalog = TranslationCatalog.catalog(for: input.language)
            let sameEnvironment = previous.map { $0.input.language == input.language && $0.input.width == input.width && $0.input.environment == input.environment && $0.input.dark == input.dark && $0.input.model.grouped == input.model.grouped && $0.input.model.avatarStyle == input.model.avatarStyle && $0.input.model.avatarMonochrome == input.model.avatarMonochrome } ?? false
            if let tablet = input.tablet {
                for (tabletID, row) in zip(tablet.ids, tablet.rows) {
                    let id = tabletID.ultraBridgeID
                    let selected = input.selected != nil && row.sessionId == input.selected
                    let old = previous?.entries[id]
                    if sameEnvironment, let old, old.tabletRow == row, old.selected == selected { entries[id] = old; continue }
                    revisionSequence += 1
                    entries[id] = Entry(row: nil, tabletRow: row, plan: HomeRowDrawing.makeTablet(row, width: input.width, selected: selected, environment: input.environment, dark: input.dark, catalog: catalog), revision: revisionSequence, selected: selected)
                }
                let result = Prepared(input: input, entries: entries, revisionSequence: revisionSequence)
                return (result, result)
            }
            let archiveStart = input.archiveModels?.hidden.ids.last.flatMap { input.model.ids.firstIndex(of: $0) }
            for (index, pair) in zip(input.model.ids, input.model.rows).enumerated() {
                let (id, row) = pair
                let selected = input.selected != nil && row.sessionId == input.selected
                let old = previous?.entries[id]
                let usesBitmap: Bool
                if let start = archiveStart {
                    usesBitmap = index >= start
                } else { usesBitmap = false }
                if sameEnvironment, let old, old.row == row, old.selected == selected, old.usesArchiveBitmap == usesBitmap { entries[id] = old; continue }
                revisionSequence += 1
                entries[id] = Entry(row: row, plan: HomeRowDrawing.make(row, width: input.width, grouped: input.model.grouped, selected: selected, environment: input.environment, dark: input.dark, catalog: catalog, deferArchiveText: true), revision: revisionSequence, selected: selected, usesArchiveBitmap: usesBitmap)
            }
            var hiddenToggle: Entry?
            if let models = input.archiveModels, let row = models.hidden.rows.last,
               let toggleID = models.hidden.ids.last, let start = input.model.ids.firstIndex(of: toggleID) {
                if sameEnvironment, let old = previous?.hiddenToggle, old.row == row { hiddenToggle = old }
                else {
                    revisionSequence += 1
                    hiddenToggle = Entry(row: row, plan: HomeRowDrawing.make(row, width: input.width, grouped: input.model.grouped, selected: false, environment: input.environment, dark: input.dark, catalog: catalog), revision: revisionSequence, selected: false, usesArchiveBitmap: true)
                }
                // Only the first archive viewport, bounded independently of
                // archive size. Later rows draw when mounted, never on tap.
                var remaining = max(1, input.viewportHeight)
                var warmIDs: Set<HomeListRow.ID> = []
                for id in input.model.ids.dropFirst(start).prefix(64) {
                    guard var entry = entries[id], remaining > 0 else { break }
                    warmIDs.insert(id)
                    remaining -= entry.plan.size.height
                    if entry.bitmap == nil, let bitmap = HomeArchiveBitmap.draw(entry.plan) {
                        revisionSequence += 1; entry.revision = revisionSequence
                        entry.bitmap = bitmap; entries[id] = entry
                    }
                }
                // Row reordering must not turn a one-viewport cache into a
                // history of every row that ever occupied that viewport.
                // Keep its revision: an already-mounted, correct bitmap does
                // not need to blank or redraw merely to release cached owners.
                for id in entries.keys where !warmIDs.contains(id) && entries[id]?.bitmap != nil {
                    entries[id]?.bitmap = nil
                }
                if var entry = hiddenToggle, entry.bitmap == nil {
                    entry.bitmap = HomeArchiveBitmap.draw(entry.plan)
                    hiddenToggle = entry
                }
            }
            let result = Prepared(input: input, entries: entries, revisionSequence: revisionSequence, hiddenToggle: hiddenToggle)
            return (result, result)
        },
        apply: { [weak self] result in
            guard let self, self.active, let requested = self.requested,
                  result.input.width == requested.width,
                  result.input.environment == requested.environment,
                  result.input.dark == requested.dark else { return false }
            self.plans = result; self.publish(); return true
        }
    )

    init(view: HomeUltraListView, pictures: AvatarPictures?) {
        self.view = view; self.pictures = pictures
        observation = pipeline.observation
    }

    func update(_ input: Input) {
        var input = input; input.language = language
        if let models = input.archiveModels, input.tablet == nil { input.model = models.shown }
        guard active, input.width > 0 else { return }
        guard requested != input else { return }
        requested = input
        pipeline.update { $0 = input }
    }

    var archiveHidden: Bool? {
        archiveIntent?.hidden ?? archiveSettings?.hidden ?? displayedModel?.rows.compactMap { row -> Bool? in
            switch row { case .flat(.archiveToggle(let hidden)), .project(.archiveToggle(let hidden)): hidden; default: nil }
        }.first
    }

    var archiveBitmapCacheCount: Int {
        cachedRows.values.filter { $0.archiveBitmap != nil }.count + (cachedHiddenToggle?.archiveBitmap == nil ? 0 : 1)
    }

    func showArchiveIntent(_ intent: ArchiveVisibilityWriter.Intent) {
        guard active else { return }
        archiveIntent = intent; archiveReceipt = nil
        publishCachedRows(archiveToggle: true)
    }

    func receiveArchiveSettings(_ settings: HomeArchiveSettings?) {
        archiveSettings = settings
        reconcileArchiveReceipt()
        publishCachedRows()
    }

    func receiveArchiveReceipt(_ receipt: ArchiveVisibilityWriter.Receipt) {
        guard receipt.intent == archiveIntent else { return }
        guard receipt.baseline != nil else {
            archiveIntent = nil; archiveReceipt = nil
            publishCachedRows()
            onArchivePersistenceFailure?()
            return
        }
        archiveReceipt = receipt
        reconcileArchiveReceipt()
    }

    private func reconcileArchiveReceipt() {
        guard let intent = archiveIntent, let receipt = archiveReceipt, let settings = archiveSettings,
              receipt.acknowledges(intent, settings: settings) else { return }
        archiveIntent = nil; archiveReceipt = nil
    }

    func setInsets(_ insets: HomeContentInsets?) {
        guard self.insets != insets else { return }
        self.insets = insets
        setInsets(top: insets?.contentTop ?? 0, bottom: insets?.listBottom ?? 0)
    }
    func setInsets(top: CGFloat, bottom: CGFloat) {
        guard topInset != top || bottomInset != bottom else { return }
        topInset = top; bottomInset = bottom
        view.apply(top: top, bottom: bottom)
    }
    func setBanner(_ banner: UIView?, height: CGFloat) {
        if banner == nil, self.banner == nil, height == 0, bannerHeight == 0 { return }
        self.banner = banner; bannerHeight = height; bannerRevision += 1; publish()
    }

    func deactivate() {
        active = false
        observation?.cancel(); observation = nil
        plans = nil; banner = nil; cachedRows = [:]
        cachedHiddenToggle = nil; shownRows = nil; hiddenRows = nil; displayedModel = nil
        archiveIntent = nil; archiveReceipt = nil
        func cancelImages(in view: UIView) {
            if let avatar = view as? AvatarView { avatar.content = nil; avatar.pictures = nil }
            for child in view.subviews { cancelImages(in: child) }
        }
        cancelImages(in: view)
        view.deactivate()
        onSelect = nil; onLongPress = nil; onArchive = nil; onCreateWorkspace = nil; onArchivePersistenceFailure = nil
    }

    private func publish() {
        guard active, let prepared = plans else { return }
        let model = prepared.input.model
        let background = UIColor(prepared.input.tablet != nil || model.grouped ? Palette.groupedBackground : Palette.flatListBackground)
        view.backgroundColor = background; view.list.backgroundColor = background
        var rows: [HomeUltraRow] = []
        var nextRows: [HomeListRow.ID: HomeUltraRow] = [:]
        var changed = 0
        if let banner, bannerHeight > 0 {
            var plan = HomeRowDrawing(environment: prepared.input.environment, dark: prepared.input.dark)
            plan.size = CGSize(width: prepared.input.width, height: bannerHeight)
            rows.append(HomeUltraRow(identity: "home:banner", revision: bannerRevision, plan: plan, makeOverlay: { banner }))
        }
        func makeRow(_ id: HomeListRow.ID, _ entry: Entry) -> HomeUltraRow {
            let plan = entry.plan
            let overlay: @MainActor () -> UIView = { [weak self] in
                let view = HomeUltraOverlay(plan: plan, style: model.avatarStyle, monochrome: model.avatarMonochrome, pictures: self?.pictures)
                view.onCreateWorkspace = { [weak self] in self?.onCreateWorkspace?(id) }
                return view
            }
            // As the table's long press: a flat session, or a project card
            // that can make a workspace.
            let canHold = entry.tabletRow?.sessionId != nil || { if case .flat(.session)? = entry.row { return true }; if case .project(.task)? = entry.row { return true }; if case .project(.project(let project))? = entry.row { return project.origin != nil }; return false }()
            let canSelect = entry.row?.sessionId != nil || entry.tabletRow?.sessionId != nil || {
                switch entry.row {
                case .flat(.archiveToggle)?, .project(.archiveToggle)?, .project(.worktreeToggle)?: return true
                default: break
                }
                switch entry.tabletRow {
                case .archiveToggle?: return true
                case .machine(let id, _)?: return id?.isEmpty == false
                default: return false
                }
            }()
            let archives: Bool
            // A task's swipe leaves it, as Happy Desktop's row control does.
            var leaves = false
            if case .flat(.session(let row))? = entry.row { leaves = row.avatar.isTask; archives = !row.archived && (!leaves || row.leaves) }
            else if case .project(.task(let row))? = entry.row { archives = row.leaves; leaves = true }
            else if case .bot? = entry.tabletRow { archives = true }
            else if case .task(let row)? = entry.tabletRow { archives = row.leaves; leaves = true }
            else if case .chat? = entry.tabletRow { archives = true }
            else { archives = false }
            var select: (@MainActor () -> Void)?
            var hold: (@MainActor () -> Void)?
            var archive: (@MainActor () -> Void)?
            var createWorkspace: (@MainActor () -> Void)?
            if canSelect { select = { [weak self] in self?.onSelect?(id) } }
            if canHold { hold = { [weak self] in self?.onLongPress?(id) } }
            if archives { archive = { [weak self] in self?.onArchive?(id) } }
            if plan.addFrame != nil { createWorkspace = { [weak self] in self?.onCreateWorkspace?(id) } }
            let selectsOnRelease: Bool
            switch entry.row {
            case .flat(.archiveToggle)?, .project(.archiveToggle)?: selectsOnRelease = true
            default: selectsOnRelease = false
            }
            return HomeUltraRow(identity: id.ultraIdentity, revision: entry.revision, plan: plan, selected: entry.selected, makeOverlay: overlay,
                select: select, longPress: hold, archive: archive, leaves: leaves, createWorkspace: createWorkspace,
                usesArchiveBitmap: entry.usesArchiveBitmap, archiveBitmap: entry.bitmap, selectsOnRelease: selectsOnRelease)
        }
        for id in prepared.input.ids {
            guard let entry = prepared.entries[id] else { continue }
            let row: HomeUltraRow
            if let cached = cachedRows[id], cached.revision == entry.revision,
               (cached.archiveBitmap != nil) == (entry.bitmap != nil) { row = cached }
            else { changed += 1; row = makeRow(id, entry) }
            rows.append(row); nextRows[id] = row
        }
        cachedRows = nextRows
        shownRows = rows
        if let models = prepared.input.archiveModels, let entry = prepared.hiddenToggle, let id = models.hidden.ids.last {
            if cachedHiddenToggle?.revision != entry.revision { cachedHiddenToggle = makeRow(id, entry) }
            let bannerCount = rows.count - prepared.input.ids.count
            var hidden = Array(rows.prefix(bannerCount + models.hidden.ids.count - 1))
            if let toggle = cachedHiddenToggle { hidden.append(toggle) }
            hiddenRows = hidden
        } else { hiddenRows = nil; cachedHiddenToggle = nil }
        rowsGeneration += 1
        publishCachedRows(changed: changed)
    }

    private func publishCachedRows(changed: Int = 0, archiveToggle: Bool = false) {
        guard active, let prepared = plans, let shownRows else { return }
        let hidden = archiveHidden ?? false
        guard displayedGeneration?.0 != rowsGeneration || displayedGeneration?.1 != hidden else { return }
        displayedGeneration = (rowsGeneration, hidden)
        let rows = hidden ? hiddenRows ?? shownRows : shownRows
        displayedModel = prepared.input.archiveModels?.model(hidden: hidden) ?? prepared.input.model
        ApplyPerf.measure(.homeList) {
            view.apply(rows: rows, top: topInset, bottom: bottomInset, archiveToggle: archiveToggle)
            return changed
        }
    }
}

extension TabletGroupedRow.ID {
    var ultraBridgeID: HomeListRow.ID { .project("tablet:\(String(reflecting: self))") }
}

private extension HomeListRow.ID {
    var ultraIdentity: String {
        switch self {
        case .session(let id): "session:\(id)"
        case .archiveToggle: "archive"
        case .day(let day): "day:\(day)"
        case .project(let id): "project:\(id)"
        case .projectArchiveToggle: "project:archive"
        case .projectDay(let day): "project:day:\(day)"
        }
    }
}

@MainActor
final class HomeUltraOverlay: UIView {
    var onCreateWorkspace: (() -> Void)?
    init(plan: HomeRowDrawing, style: AvatarStyle, monochrome: Bool, pictures: AvatarPictures?) {
        super.init(frame: CGRect(origin: .zero, size: plan.size))
        if let face = plan.avatar {
            let avatar = AvatarView()
            avatar.pictures = pictures
            avatar.content = .init(avatar: face, style: style, monochrome: monochrome || plan.monochromeAvatar)
            avatar.alpha = plan.avatarAlpha
            avatar.frame = plan.avatarFrame
            addSubview(avatar)
        }
        if let (value, style, frame) = plan.shimmer {
            let label = LegacyShimmerLabel(style: style)
            label.string = value; label.isShimmering = true; label.frame = frame
            label.alpha = plan.contentAlpha
            addSubview(label)
        }
        for (color, frame) in plan.pulsingDots {
            let dot = StatusDotView(frame: frame)
            dot.backgroundColor = UIColor(color); dot.isPulsing = true
            addSubview(dot)
        }
        if let (kind, frame) = plan.provider {
            let provider = ProviderIconView(size: 13)
            provider.kind = kind; provider.frame = frame; addSubview(provider)
        }
        if let frame = plan.addFrame {
            if plan.roundAdd {
                let button = HitSlopControl()
                button.hitSlop = TabletWorkspaceHeaderLayout.Metrics.addHitSlop
                button.frame = frame; button.backgroundColor = UIColor(Palette.surfaceHighest)
                button.layer.cornerRadius = frame.width / 2
                button.isAccessibilityElement = true; button.accessibilityLabel = Strings.Tablet.newSession; button.accessibilityTraits = .button
                let icon = IconView(.ionicons("add"), size: TabletWorkspaceHeaderLayout.Metrics.addIconSize, tint: Palette.text)
                let side = TabletWorkspaceHeaderLayout.Metrics.addIconSize
                icon.frame = CGRect(x: (frame.width - side) / 2, y: (frame.height - side) / 2, width: side, height: side)
                icon.isUserInteractionEnabled = false; button.addSubview(icon)
                button.addAction(UIAction { [weak self] _ in self?.onCreateWorkspace?() }, for: .touchUpInside)
                addSubview(button)
                return
            }
            let button = HeaderIconButton(.ionicons("add"), size: 18, label: Strings.Home.createWorkspaceIn(plan.accessibilityLabel))
            button.iconView.tintColor = UIColor(Palette.textSecondary)
            button.frame = frame
            button.addAction(UIAction { [weak self] _ in self?.onCreateWorkspace?() }, for: .primaryActionTriggered)
            addSubview(button)
        }
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    func deactivate() {
        for avatar in subviews.compactMap({ $0 as? AvatarView }) { avatar.content = nil; avatar.pictures = nil }
    }
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        subviews.contains { $0 is UIControl && !$0.isHidden && $0.point(inside: $0.convert(point, from: self), with: event) }
    }
}
#endif

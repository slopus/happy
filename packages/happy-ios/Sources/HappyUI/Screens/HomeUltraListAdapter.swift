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
    private weak var pictures: AvatarPictures?
    private var insets: HomeContentInsets?
    private var topInset: CGFloat = 0
    private var bottomInset: CGFloat = 0
    private var banner: UIView?
    private var bannerHeight: CGFloat = 0
    private var plans: Prepared?
    private var cachedRows: [HomeListRow.ID: HomeUltraRow] = [:]
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

        var ids: [HomeListRow.ID] { tablet?.ids.map(\.ultraBridgeID) ?? model.ids }
    }
    struct Entry: Sendable {
        var row: HomeListRow?
        var tabletRow: TabletGroupedRow? = nil
        var plan: HomeRowDrawing
        var revision: UInt64
        var selected: Bool
    }
    struct Prepared: Sendable {
        var input: Input
        var entries: [HomeListRow.ID: Entry]
        var revisionSequence: UInt64
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
            for (id, row) in zip(input.model.ids, input.model.rows) {
                let selected = input.selected != nil && row.sessionId == input.selected
                let old = previous?.entries[id]
                if sameEnvironment, let old, old.row == row, old.selected == selected { entries[id] = old; continue }
                revisionSequence += 1
                entries[id] = Entry(row: row, plan: HomeRowDrawing.make(row, width: input.width, grouped: input.model.grouped, selected: selected, environment: input.environment, dark: input.dark, catalog: catalog), revision: revisionSequence, selected: selected)
            }
            let result = Prepared(input: input, entries: entries, revisionSequence: revisionSequence)
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
        guard active, input.width > 0 else { return }
        guard requested != input else { return }
        requested = input
        pipeline.update { $0 = input }
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
        func cancelImages(in view: UIView) {
            if let avatar = view as? AvatarView { avatar.content = nil; avatar.pictures = nil }
            for child in view.subviews { cancelImages(in: child) }
        }
        cancelImages(in: view)
        view.deactivate()
        onSelect = nil; onLongPress = nil; onArchive = nil; onCreateWorkspace = nil
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
        for id in prepared.input.ids {
            guard let entry = prepared.entries[id] else { continue }
            if let cached = cachedRows[id], cached.revision == entry.revision {
                rows.append(cached); nextRows[id] = cached; continue
            }
            changed += 1
            let plan = entry.plan
            let overlay: @MainActor () -> UIView = { [weak self] in
                let view = HomeUltraOverlay(plan: plan, style: model.avatarStyle, monochrome: model.avatarMonochrome, pictures: self?.pictures)
                view.onCreateWorkspace = { [weak self] in self?.onCreateWorkspace?(id) }
                return view
            }
            let canHold = entry.tabletRow?.sessionId != nil || { if case .flat(.session)? = entry.row { return true }; if case .project(.project)? = entry.row { return true }; return false }()
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
            if case .flat(.session(let row))? = entry.row { archives = !row.archived }
            else if case .bot? = entry.tabletRow { archives = true }
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
            let row = HomeUltraRow(identity: id.ultraIdentity, revision: entry.revision, plan: plan, selected: entry.selected, makeOverlay: overlay,
                select: select, longPress: hold, archive: archive, createWorkspace: createWorkspace)
            rows.append(row); nextRows[id] = row
        }
        cachedRows = nextRows
        ApplyPerf.measure(.homeList) {
            view.apply(rows: rows, top: topInset, bottom: bottomInset)
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
            let label = ShimmerLabel(style: style)
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

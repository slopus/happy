#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// WorktreeTabStrip.tsx: grouped by project, a chat is one tab of its
/// checkout, and this is where the checkout's other chats are reached. It
/// hangs under the header in a capsule of the header's own glass (a solid
/// surface on a tablet), scrolls sideways, and ends in a hairline and `+`.
///
/// The screen owns what the tabs mean: a tap asks it to switch in place, a
/// long press to show the chat's actions. `WorktreeTabStripLayout` places
/// everything.
///
/// The names follow the person's text size on their own, as the composer
/// does: the strip's heights are fixed and only its widths come from the
/// names. They are measured off the main thread and kept by name, face and
/// text size (`WorktreeTabNames`); new tabs are placed once theirs are in,
/// so the main thread only places frames.
final class ChatWorktreeTabStrip: UIView {
    struct Item: Equatable {
        var id: String
        var title: String
        /// The name shimmers: the agent works, or the chat is still arriving.
        var shimmers: Bool
        var blocked: Bool
        var unread: Bool
        /// A stand-in for a chat that hasn't started yet: no actions.
        var pending: Bool
    }

    var onSelect: ((String) -> Void)?
    var onLongPress: ((String) -> Void)?
    var onAdd: (() -> Void)?

    /// `layout.headerMaxWidth`.
    var maxWidth: CGFloat = .greatestFiniteMagnitude {
        didSet { if maxWidth != oldValue { setNeedsLayout() } }
    }

    /// TabletBranches' `worktreeStripGlass`: glass on a phone only.
    var glass = true {
        didSet { if glass != oldValue { applyMaterial() } }
    }

    var showsAdd = false {
        didSet {
            guard showsAdd != oldValue else { return }
            divider.isHidden = !showsAdd
            addButton.isHidden = !showsAdd
            setNeedsLayout()
        }
    }

    /// Where the tabs are scrolled to, for the screen that takes over on a
    /// switch to pick up from.
    var offset: CGFloat { scroller.contentOffset.x }

    /// The account's measured names; the screen hands in its account's.
    var names = WorktreeTabNames()

    /// The tabs placed, with their names' sizes.
    private(set) var items: [Item] = []
    private var selectedId: String?
    private var sizes: [CGSize] = []
    /// What was asked for last, placed once its names are measured.
    private var wanted: Wanted?
    private var measuring = 0
    /// Nothing is shown until the first tabs are placed: no empty capsule.
    private var named = false {
        didSet { if named != oldValue { applyMaterial() } }
    }
    /// The last placement, for tests.
    private(set) var layout: WorktreeTabStripLayout?
    private let glassView = HeaderGlassView()
    private let solidView = UIView()
    private let clip = UIView()
    private let scroller = TabScroller()
    private let divider = UIView()
    private let addButton = AddControl()
    private var tabs: [String: TabControl] = [:]
    /// Placed on the first layout, unanimated: where the last screen on
    /// this checkout left the strip, so there is nothing to slide from.
    private var restoredOffset: CGFloat?
    /// The open tab, to bring into view once it has been placed.
    private var revealId: String?
    private var placedOnce = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        glassView.isUserInteractionEnabled = false
        solidView.isUserInteractionEnabled = false
        solidView.layer.shadowColor = UIColor.black.cgColor
        solidView.layer.shadowOffset = CGSize(width: 0, height: HeaderGlassShadow.offsetY)
        solidView.layer.shadowRadius = HeaderGlassShadow.radius
        addSubview(glassView)
        addSubview(solidView)
        clip.clipsToBounds = true
        addSubview(clip)
        scroller.showsHorizontalScrollIndicator = false
        scroller.showsVerticalScrollIndicator = false
        scroller.alwaysBounceVertical = false
        scroller.scrollsToTop = false
        scroller.contentInsetAdjustmentBehavior = .never
        clip.addSubview(scroller)
        divider.isHidden = true
        clip.addSubview(divider)
        addButton.isHidden = true
        addButton.addTarget(self, action: #selector(add), for: .touchUpInside)
        clip.addSubview(addButton)
        applyMaterial()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyMaterial()
        }
        traitOverrides.followsTextSize = true
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.measureNames()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Only the capsule takes touches (`pointerEvents="box-none"`).
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let slop = WorktreeTabStripLayout.Metrics.addHitSlop
        return clip.frame.insetBy(dx: -slop, dy: -slop).contains(point)
    }

    func restore(offset: CGFloat) {
        restoredOffset = offset
        setNeedsLayout()
    }

    /// What was asked for last is placed, its names measured.
    var isSettled: Bool {
        wanted.map { named && $0.items == items && $0.selectedId == selectedId } ?? true
    }

    func update(items: [Item], selectedId: String) {
        let wanted = Wanted(items: items, selectedId: selectedId)
        guard wanted != self.wanted else { return }
        self.wanted = wanted
        measureNames()
    }

    private struct Wanted: Equatable {
        var items: [Item]
        var selectedId: String
    }

    /// Places what was asked for: at once when every name is kept,
    /// otherwise once the missing ones are measured off the main thread. A
    /// newer ask, or a new text size, drops what an older one measured.
    private func measureNames() {
        guard let wanted else { return }
        let environment = TextEnvironment(traitCollection)
        let names = wanted.items.map { WorktreeTabName(title: $0.title, selected: $0.id == wanted.selectedId, environment: environment) }
        measuring += 1
        if let sizes = self.names.sizes(names) {
            place(wanted, sizes: sizes)
            return
        }
        let generation = measuring
        let store = self.names
        Task { @MainActor [weak self] in
            let sizes = await Task.detached(priority: .userInitiated) { store.measure(names) }.value
            guard let self, self.measuring == generation else { return }
            self.place(wanted, sizes: sizes)
        }
    }

    private func place(_ wanted: Wanted, sizes: [CGSize]) {
        let selectionMoved = wanted.selectedId != selectedId
        guard wanted.items != items || selectionMoved || sizes != self.sizes || !named else { return }
        items = wanted.items
        selectedId = wanted.selectedId
        self.sizes = sizes
        var kept: [String: TabControl] = [:]
        for item in items {
            let tab = tabs[item.id] ?? makeTab()
            tab.configure(item, selected: item.id == selectedId)
            kept[item.id] = tab
        }
        for (id, tab) in tabs where kept[id] == nil { tab.removeFromSuperview() }
        tabs = kept
        // Keep the open tab in view, including one that didn't exist a
        // moment ago.
        if selectionMoved || revealId != nil { revealId = selectedId }
        named = true
        setNeedsLayout()
    }

    private func makeTab() -> TabControl {
        let tab = TabControl()
        tab.addTarget(self, action: #selector(tapped(_:)), for: .touchUpInside)
        tab.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:))))
        scroller.addSubview(tab)
        return tab
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let scale = layoutScale
        let layout = WorktreeTabStripLayout(
            width: bounds.width,
            maxWidth: maxWidth,
            border: glass ? WorktreeTabStripLayout.Metrics.glassBorder : 1 / scale,
            hairline: 1 / scale,
            tabs: zip(items, sizes).map { item, size in
                WorktreeTabStripLayout.Tab(label: .fixed(width: size.width, height: size.height), dot: TabControl.hasDot(item, selected: item.id == selectedId))
            },
            showsAdd: showsAdd
        )
        self.layout = layout
        glassView.setLayoutFrame(layout.pill)
        solidView.setLayoutFrame(layout.pill)
        solidView.layer.cornerRadius = layout.pill.height / 2
        solidView.layer.shadowPath = UIBezierPath(roundedRect: CGRect(origin: .zero, size: layout.pill.size), cornerRadius: layout.pill.height / 2).cgPath
        clip.setLayoutFrame(layout.inner.offsetBy(dx: layout.pill.minX, dy: layout.pill.minY))
        clip.layer.cornerRadius = layout.inner.height / 2
        scroller.setLayoutFrame(layout.scroller)
        scroller.contentSize = CGSize(width: layout.contentWidth, height: layout.scroller.height)
        for (item, frame) in zip(items, layout.tabs) {
            tabs[item.id]?.place(frame)
        }
        if let frame = layout.divider { divider.setLayoutFrame(frame) }
        if let frame = layout.add { addButton.setLayoutFrame(frame) }

        // Scrolled once there are tabs to scroll.
        guard named else { return }
        let maxOffset = max(0, layout.contentWidth - layout.scroller.width)
        if let restored = restoredOffset, layout.scroller.width > 0 {
            restoredOffset = nil
            scroller.contentOffset.x = min(max(0, restored), maxOffset)
        }
        if let id = revealId, layout.scroller.width > 0, let index = items.firstIndex(where: { $0.id == id }) {
            revealId = nil
            if let target = WorktreeTabStripLayout.revealOffset(
                tab: layout.tabs[index].frame, offset: scroller.contentOffset.x, viewport: layout.scroller.width, contentWidth: layout.contentWidth
            ) {
                // The first placement is where the strip already was, not a move.
                scroller.setContentOffset(CGPoint(x: target, y: 0), animated: placedOnce)
            }
        }
        placedOnce = layout.scroller.width > 0
    }

    private func applyMaterial() {
        glassView.isHidden = !glass || !named
        solidView.isHidden = glass || !named
        clip.isHidden = !named
        solidView.backgroundColor = UIColor(Palette.surfaceHigh)
        solidView.layer.borderWidth = 1 / layoutScale
        solidView.layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
        solidView.layer.shadowOpacity = traitCollection.userInterfaceStyle == .dark ? HeaderGlassShadow.darkOpacity : HeaderGlassShadow.lightOpacity
        divider.backgroundColor = UIColor(Palette.divider)
        setNeedsLayout()
    }

    @objc private func tapped(_ tab: TabControl) {
        guard let id = tab.item?.id else { return }
        onSelect?(id)
    }

    @objc private func longPressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, let item = (gesture.view as? TabControl)?.item, !item.pending else { return }
        onLongPress?(item.id)
    }

    @objc private func add() {
        onAdd?()
    }

    /// A drag that starts on a tab scrolls the strip; UIKit would otherwise
    /// leave the touch to the control.
    private final class TabScroller: UIScrollView {
        override func touchesShouldCancel(in view: UIView) -> Bool { true }
    }

    /// One chat: its name and the blocked or unread dot. The open one is a
    /// filled chip rather than an underline, which would run into the
    /// capsule's rounded ends.
    private final class TabControl: UIControl {
        private(set) var item: Item?
        private var isOpen = false
        private var label = ShimmerLabel(style: TextStyles.worktreeTab)
        private let dot = StatusDotView()

        override init(frame: CGRect) {
            super.init(frame: frame)
            layer.cornerRadius = WorktreeTabStripLayout.Metrics.tabHeight / 2
            label.isUserInteractionEnabled = false
            addSubview(label)
            dot.isUserInteractionEnabled = false
            addSubview(dot)
            isAccessibilityElement = true
            registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
                self.applySelection()
            }
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        static func hasDot(_ item: Item, selected: Bool) -> Bool {
            item.blocked || item.unread && !selected
        }

        func configure(_ item: Item, selected: Bool) {
            if selected != isOpen || self.item == nil {
                // The open tab's name is semibold.
                let next = ShimmerLabel(style: selected ? TextStyles.worktreeTabSelected : TextStyles.worktreeTab)
                next.isUserInteractionEnabled = false
                insertSubview(next, aboveSubview: label)
                label.removeFromSuperview()
                label = next
            }
            self.item = item
            isOpen = selected
            label.string = item.title
            label.color = selected ? Palette.headerTint : Palette.textSecondary
            label.isShimmering = item.shimmers
            dot.isHidden = !Self.hasDot(item, selected: selected)
            dot.backgroundColor = UIColor(item.blocked ? Palette.sessionBlockedDot : Palette.sessionReadyDot)
            dot.isPulsing = item.blocked
            accessibilityLabel = item.title
            accessibilityTraits = selected ? [.button, .selected] : .button
            applySelection()
        }

        func place(_ frame: WorktreeTabStripLayout.TabFrame) {
            setLayoutFrame(frame.frame)
            label.setLayoutFrame(frame.label)
            if let rect = frame.dot { dot.setLayoutFrame(rect) }
        }

        private func applySelection() {
            backgroundColor = isOpen ? UIColor(Palette.worktreeTabSelected) : .clear
        }

        override var isHighlighted: Bool {
            didSet { alpha = isHighlighted && !isOpen ? WorktreeTabStripLayout.Metrics.pressedOpacity : 1 }
        }
    }

    /// `+`: always the plus; how far along a start is belongs to the tab it
    /// opened.
    private final class AddControl: UIControl {
        private let icon = IconView(.ionicons("add"), size: WorktreeTabStripLayout.Metrics.addIconSize, tint: Palette.headerTint)

        override init(frame: CGRect) {
            super.init(frame: frame)
            addSubview(icon)
            isAccessibilityElement = true
            accessibilityTraits = .button
            accessibilityLabel = Strings.Tablet.newSession
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            icon.setLayoutFrame(bounds)
        }

        override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
            let slop = WorktreeTabStripLayout.Metrics.addHitSlop
            return bounds.insetBy(dx: -slop, dy: -slop).contains(point)
        }

        override var isHighlighted: Bool {
            didSet { alpha = isHighlighted ? WorktreeTabStripLayout.Metrics.pressedOpacity : 1 }
        }
    }
}

/// A tab's name as its label draws it: the text, the face (the open tab's
/// is semibold) and the text size.
struct WorktreeTabName: Hashable, Sendable {
    var title: String
    var selected: Bool
    var environment: TextEnvironment
}

/// The strip's names, measured off the main thread and kept by everything
/// their size depends on; a tab's width is then the layout's to cap. One
/// per account, since the names are its chats': the screen that takes over
/// on a tab switch places its tabs without measuring them again.
final class WorktreeTabNames: @unchecked Sendable {
    /// Past this many, the kept sizes start over.
    static let limit = 512

    private let lock = NSLock()
    private var kept: [WorktreeTabName: CGSize] = [:]
    private let measurer: @Sendable (WorktreeTabName) -> CGSize

    init(measure: @escaping @Sendable (WorktreeTabName) -> CGSize = { WorktreeTabNames.size($0) }) {
        measurer = measure
    }

    /// Every name's size if every one is kept; nil when one needs measuring.
    func sizes(_ names: [WorktreeTabName]) -> [CGSize]? {
        lock.withLock {
            var sizes: [CGSize] = []
            sizes.reserveCapacity(names.count)
            for name in names {
                guard let size = kept[name] else { return nil }
                sizes.append(size)
            }
            return sizes
        }
    }

    /// Every name's size, measuring the ones not kept. Off the main thread.
    func measure(_ names: [WorktreeTabName]) -> [CGSize] {
        names.map { name in
            if let size = lock.withLock({ kept[name] }) { return size }
            let size = measurer(name)
            lock.withLock {
                if kept.count >= Self.limit { kept.removeAll(keepingCapacity: true) }
                kept[name] = size
            }
            return size
        }
    }

    /// One line in the tab's face at the text size, laid out as its
    /// StyledLabel draws it, the box rounded up to the screen's pixels.
    /// Every TextKit object lives for one call, so it is safe off main.
    static func size(_ name: WorktreeTabName) -> CGSize {
        guard !name.title.isEmpty else { return .zero }
        // Before the first font, so no name is measured in the fallback.
        Fonts.registerBundledFonts()
        let style = (name.selected ? TextStyles.worktreeTabSelected : TextStyles.worktreeTab).scaled(name.environment.scale)
        let storage = NSTextStorage(attributedString: style.attributedString(name.title, color: .black, lineBreakMode: .byTruncatingTail))
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = 1
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        let scale = max(name.environment.displayScale, 1)
        return CGSize(width: (used.width * scale).rounded(.up) / scale, height: (used.height * scale).rounded(.up) / scale)
    }
}
#endif

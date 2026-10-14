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

    private(set) var items: [Item] = []
    private var selectedId: String?
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

    func update(items: [Item], selectedId: String) {
        let selectionMoved = selectedId != self.selectedId
        guard items != self.items || selectionMoved else { return }
        self.items = items
        self.selectedId = selectedId
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
            tabs: items.map { item in
                WorktreeTabStripLayout.Tab(label: tabs[item.id]?.labelMeasurable ?? .fixed(width: 0, height: 0), dot: TabControl.hasDot(item, selected: item.id == selectedId))
            },
            showsAdd: showsAdd
        )
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
        glassView.isHidden = !glass
        solidView.isHidden = glass
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

        var labelMeasurable: Measurable { label.measurable }

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
#endif

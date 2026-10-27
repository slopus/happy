#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A round glass control in Settings' bar, as Telegram's bar buttons are
/// (iOS's own glass, interactive, so a touch swells it).
final class StemCellsGlassView: UIView {
    let content: UIView
    private let glass: UIVisualEffectView

    override init(frame: CGRect) {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        glass = UIVisualEffectView(effect: effect)
        content = glass.contentView
        super.init(frame: frame)
        addSubview(glass)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        glass.cornerConfiguration = .corners(radius: .fixed(Double(bounds.height / 2)))
    }
}

/// Every paired computer and signed-in account as a strip of story
/// circles: the chosen one in the middle, larger and ringed. A drag scales
/// them as they pass the middle, a stop snaps to one (a selection tick on
/// each), a tap brings one to the middle; the "+" at the end only taps.
final class StemCellsProfileCarouselView: UIView, UIScrollViewDelegate {
    struct Item: Equatable {
        var id: String
        var label: String
        var image: UIImage?
        /// Shown when there is no picture: Happy's mark for a computer, a person for an account.
        var isDirect: Bool
    }

    /// A profile came to rest in the middle.
    var onSelect: ((Int) -> Void)?
    /// A profile's circle was tapped: it is chosen and settings goes.
    var onTap: ((Int) -> Void)?
    /// The circle last tapped, until the strip comes to rest on it.
    private var tapped: Int?
    /// The "+" was tapped, with where it is for a menu to point at.
    var onAdd: ((UIView) -> Void)?
    private(set) var items: [Item] = []
    private(set) var selected = 0
    private let scroll = UIScrollView()
    private var circles: [Circle] = []
    private let add = Circle(isAdd: true)
    /// The item in the middle while moving, for the tick.
    private var centered = 0
    /// The chosen item is to be brought to the middle at the next layout.
    private var needsCentering = true

    override init(frame: CGRect) {
        super.init(frame: frame)
        scroll.showsHorizontalScrollIndicator = false
        scroll.decelerationRate = .fast
        scroll.delegate = self
        scroll.clipsToBounds = false
        addSubview(scroll)
        add.accessibilityIdentifier = "stem-profile-add"
        add.accessibilityLabel = Strings.StemCells.addProfile
        add.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(addTapped)))
        scroll.addSubview(add)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Shows `items` with `selected` in the middle; the strip holds still
    /// when that one was already there.
    func set(_ items: [Item], selected: Int) {
        let resized = items.count != circles.count
        self.items = items
        while circles.count < items.count {
            let circle = Circle(isAdd: false)
            circle.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(circleTapped(_:))))
            scroll.addSubview(circle)
            circles.append(circle)
        }
        while circles.count > items.count { circles.removeLast().removeFromSuperview() }
        for (index, (circle, item)) in zip(circles, items).enumerated() {
            circle.show(item)
            // By place in the strip: a computer paired twice wears one name.
            circle.accessibilityIdentifier = "stem-profile:\(index)"
        }
        let moved = selected != self.selected || resized
        self.selected = selected
        centered = selected
        for (index, circle) in circles.enumerated() { circle.accessibilityTraits = index == selected ? [.button, .selected] : .button }
        if moved, !scroll.isDragging, !scroll.isDecelerating { needsCentering = true }
        setNeedsLayout()
    }

    func image(for id: String) -> UIImage? { items.first { $0.id == id }?.image }

    override func layoutSubviews() {
        super.layoutSubviews()
        scroll.frame = bounds
        // The "+" is one more place along, but never a resting place.
        let size = CGSize(width: StemCellsProfileCarousel.contentWidth(count: items.count + 1, width: bounds.width) - StemCellsProfileCarousel.Metrics.pitch, height: bounds.height)
        if scroll.contentSize != size { scroll.contentSize = size }
        // Only once there is a width to centre in.
        if needsCentering, bounds.width > 0 {
            needsCentering = false
            scroll.contentOffset.x = StemCellsProfileCarousel.offset(for: selected)
        }
        place()
    }

    private func place() {
        let offset = scroll.contentOffset.x
        for (index, circle) in circles.enumerated() {
            let item = StemCellsProfileCarousel.item(index, offset: offset, width: bounds.width)
            circle.place(item.frame, emphasis: item.emphasis)
        }
        let item = StemCellsProfileCarousel.item(items.count, offset: offset, width: bounds.width)
        add.place(item.frame, emphasis: 0)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        place()
        guard scrollView.isDragging || scrollView.isDecelerating else { return }
        let index = StemCellsProfileCarousel.index(at: scrollView.contentOffset.x, count: items.count)
        if index != centered {
            centered = index
            StemCellsHaptics.play(.pick)
        }
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        tapped = nil
        StemCellsHaptics.prepare(.pick)
    }

    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        targetContentOffset.pointee.x = StemCellsProfileCarousel.snapped(targetContentOffset.pointee.x, count: items.count)
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { rest() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { rest() }
    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { rest() }

    private func rest() {
        // A circle tapped while the strip still glided is where it rests.
        let index = tapped ?? StemCellsProfileCarousel.index(at: scroll.contentOffset.x, count: items.count)
        let target = StemCellsProfileCarousel.offset(for: index)
        // Far enough off to animate there (and come back here when it
        // ends); a sliver off may never report an end, so it is set at once.
        if abs(scroll.contentOffset.x - target) >= 1 { scroll.setContentOffset(CGPoint(x: target, y: 0), animated: true); return }
        if scroll.contentOffset.x != target { scroll.setContentOffset(CGPoint(x: target, y: 0), animated: false) }
        tapped = nil
        guard index != selected, items.indices.contains(index) else { return }
        selected = index
        for (i, circle) in circles.enumerated() { circle.accessibilityTraits = i == index ? [.button, .selected] : .button }
        onSelect?(index)
    }

    /// A tap chooses the profile at once, as Telegram's account list does:
    /// it comes to the middle, then settings goes back to its home.
    @objc private func circleTapped(_ gesture: UITapGestureRecognizer) {
        guard let circle = gesture.view as? Circle, let index = circles.firstIndex(where: { $0 === circle }) else { return }
        let target = StemCellsProfileCarousel.offset(for: index)
        StemCellsHaptics.play(.pick)
        centered = index
        tapped = index
        if index != selected {
            selected = index
            for (i, circle) in circles.enumerated() { circle.accessibilityTraits = i == index ? [.button, .selected] : .button }
        }
        if scroll.contentOffset.x != target { scroll.setContentOffset(CGPoint(x: target, y: 0), animated: true) }
        onTap?(index)
    }

    @objc private func addTapped() { onAdd?(add) }

    /// A touch on a circle while the strip still glides is a tap on it, not
    /// only a stop: the glide ends before the touch begins.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        if let hit, hit !== scroll, scroll.isDecelerating {
            scroll.setContentOffset(scroll.contentOffset, animated: false)
        }
        return hit
    }

    /// One circle: the picture clipped round, and a ring around it as far
    /// out as it is chosen.
    final class Circle: UIView {
        private let picture = UIImageView()
        private let ring = CAShapeLayer()
        private let isAdd: Bool

        init(isAdd: Bool) {
            self.isAdd = isAdd
            super.init(frame: .zero)
            isAccessibilityElement = true
            accessibilityTraits = .button
            picture.clipsToBounds = true
            picture.contentMode = isAdd ? .center : .scaleAspectFill
            addSubview(picture)
            ring.fillColor = nil
            ring.lineWidth = StemCellsProfileCarousel.Metrics.ringWidth
            layer.addSublayer(ring)
            if isAdd {
                picture.image = StemCellsGlyphs.image("add", size: 26)
                picture.tintColor = UIColor(Palette.stemCellsSettingsText)
                picture.backgroundColor = UIColor(Palette.stemCellsSettingsAddFill)
            }
            registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.colorRing() }
            colorRing()
        }

        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

        func show(_ item: Item) {
            accessibilityLabel = item.label
            if let image = item.image {
                picture.image = image
                picture.contentMode = .scaleAspectFill
                picture.backgroundColor = nil
            } else {
                picture.image = item.isDirect
                    ? UIImage.happy("logo-black")?.withRenderingMode(.alwaysTemplate)
                    : StemCellsGlyphs.image("person-outline", size: 28)
                picture.contentMode = .center
                picture.tintColor = UIColor(Palette.stemCellsSettingsText)
                picture.backgroundColor = UIColor(Palette.stemCellsSettingsAddFill)
            }
        }

        /// The picture at `frame`; the ring sits outside it by its gap.
        func place(_ frame: CGRect, emphasis: CGFloat) {
            typealias M = StemCellsProfileCarousel.Metrics
            let outset = M.ringGap + M.ringWidth
            self.frame = frame.insetBy(dx: -outset, dy: -outset)
            picture.frame = CGRect(x: outset, y: outset, width: frame.width, height: frame.height)
            picture.layer.cornerRadius = frame.width / 2
            CATransaction.begin(); CATransaction.setDisableActions(true)
            ring.frame = bounds
            ring.path = UIBezierPath(ovalIn: bounds.insetBy(dx: M.ringWidth / 2, dy: M.ringWidth / 2)).cgPath
            ring.opacity = isAdd ? 0 : Float(emphasis * emphasis)
            CATransaction.commit()
        }

        private func colorRing() {
            ring.strokeColor = UIColor(Palette.stemCellsSettingsRing).resolvedColor(with: traitCollection).cgColor
        }
    }
}

/// A row in a settings card: what it says and does.
struct StemCellsSettingsRow {
    enum Tile { case orange, gray, blue, purple, green, red, teal, indigo }
    var id: String
    var title: String
    var icon: (glyph: String, tile: Tile)?
    var value: String?
    var accessory: StemCellsSettingsLayout.Accessory = .chevron
    var destructive = false
    /// A switch's state, for `.toggle`.
    var isOn = false
    var action: (() -> Void)?
    var toggled: ((Bool) -> Void)?
}

/// A grouped card of rows, Telegram's inset style: a coloured square with a
/// white glyph, the title, a quieter value, a chevron or a switch, hairlines
/// between rows from the title's start.
final class StemCellsSettingsCardView: UIView {
    private var views: [RowView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.stemCellsSettingsCard)
        layer.cornerRadius = StemCellsSettingsLayout.Metrics.radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ rows: [StemCellsSettingsRow], layout: StemCellsSettingsLayout.Card) {
        while views.count < rows.count { let view = RowView(); addSubview(view); views.append(view) }
        while views.count > rows.count { views.removeLast().removeFromSuperview() }
        for (view, (row, frames)) in zip(views, zip(rows, layout.rows)) { view.show(row, frames: frames) }
    }

    /// Measures a value as a row draws it.
    static func valueWidth(_ text: String?) -> CGFloat? {
        text.map { ($0 as NSString).size(withAttributes: [.font: RowView.valueFont]).width }
    }

    final class RowView: UIView {
        static let titleFont = StemCellsFonts.ui(.regular, size: 17)
        static let valueFont = StemCellsFonts.ui(.regular, size: 17)
        private let tile = UIView()
        private let glyph = UIImageView()
        private let title = UILabel()
        private let value = UILabel()
        private let chevron = UIImageView(image: StemCellsGlyphs.image("chevron-right", size: 14))
        private let toggle = UISwitch()
        private let separator = UIView()
        private var row: StemCellsSettingsRow?
        /// A fold's chevron, turned down while what it folds is open.
        var chevronTurned = false {
            didSet { chevron.image = StemCellsGlyphs.image(chevronTurned ? "chevron-down" : "chevron-right", size: 14) }
        }

        override init(frame: CGRect) {
            super.init(frame: frame)
            tile.layer.cornerRadius = StemCellsSettingsLayout.Metrics.tileRadius
            tile.layer.cornerCurve = .continuous
            glyph.tintColor = UIColor(Palette.stemCellsSettingsGlyph)
            glyph.contentMode = .center
            tile.addSubview(glyph)
            title.font = Self.titleFont
            value.font = Self.valueFont
            value.textColor = UIColor(Palette.stemCellsSettingsSecondary)
            value.textAlignment = .right
            chevron.tintColor = UIColor(Palette.stemCellsSettingsSecondary)
            chevron.contentMode = .center
            separator.backgroundColor = UIColor(Palette.stemCellsSettingsSeparator)
            toggle.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                StemCellsHaptics.play(.pick)
                row?.toggled?(toggle.isOn)
            }, for: .valueChanged)
            for view in [tile, title, value, chevron, toggle, separator] as [UIView] { addSubview(view) }
            isAccessibilityElement = false
            addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        }

        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

        func show(_ row: StemCellsSettingsRow, frames: StemCellsSettingsLayout.Row) {
            self.row = row
            frame = frames.box
            let origin = frames.box.origin
            func local(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: -origin.x, dy: -origin.y) }
            tile.isHidden = frames.icon == nil
            if let icon = row.icon, let frame = frames.icon {
                tile.frame = local(frame)
                tile.backgroundColor = UIColor(Self.color(icon.tile))
                glyph.image = StemCellsGlyphs.image(icon.glyph, size: StemCellsSettingsLayout.Metrics.glyph)
                glyph.frame = tile.bounds
            }
            title.text = row.title
            title.textColor = UIColor(row.destructive ? Palette.stemCellsSettingsDestructive : Palette.stemCellsSettingsText)
            title.frame = local(frames.title)
            value.isHidden = frames.value == nil
            value.text = row.value
            if let frame = frames.value { value.frame = local(frame) }
            chevron.isHidden = frames.chevron == nil
            if let frame = frames.chevron { chevron.frame = local(frame) }
            toggle.isHidden = frames.toggle == nil
            if let frame = frames.toggle {
                toggle.frame = local(frame)
                // Not under a finger: a layout mid-tap would undo the tap.
                if toggle.isOn != row.isOn, !toggle.isTracking { toggle.setOn(row.isOn, animated: window != nil) }
            }
            separator.isHidden = frames.separator == nil
            if let frame = frames.separator { separator.frame = local(frame) }
            accessibilityIdentifier = "stem-settings:\(row.id)"
            // A switch row is the switch itself to VoiceOver and to tests.
            toggle.accessibilityIdentifier = "stem-settings-toggle:\(row.id)"
            toggle.accessibilityLabel = row.title
            isAccessibilityElement = row.accessory != .toggle
            accessibilityLabel = [row.title, row.value].compactMap { $0 }.joined(separator: ", ")
            accessibilityTraits = row.accessory == .toggle ? [] : .button
        }

        static func color(_ tile: StemCellsSettingsRow.Tile) -> ColorToken {
            switch tile {
            case .orange: Palette.stemCellsSettingsTileOrange
            case .gray: Palette.stemCellsSettingsTileGray
            case .blue: Palette.stemCellsSettingsTileBlue
            case .purple: Palette.stemCellsSettingsTilePurple
            case .green: Palette.stemCellsSettingsTileGreen
            case .red: Palette.stemCellsSettingsTileRed
            case .teal: Palette.stemCellsSettingsTileTeal
            case .indigo: Palette.stemCellsSettingsTileIndigo
            }
        }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
            super.touchesBegan(touches, with: event)
            if row?.action != nil { backgroundColor = UIColor(Palette.stemCellsRowPressed) }
        }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
            super.touchesEnded(touches, with: event)
            UIView.animate(withDuration: 0.2) { self.backgroundColor = nil }
        }

        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
            super.touchesCancelled(touches, with: event)
            backgroundColor = nil
        }

        @objc private func tapped() { row?.action?() }
    }
}

/// A profile's picture: a computer's own bytes, an account's from its
/// server, else the placeholder its thumbhash makes; decoded off main.
@MainActor
enum StemCellsProfilePictures {
    static func key(_ account: AccountSummary, context: AppContext) -> String {
        let direct = context.account.direct.accounts.first { $0.id == account.id }
        return direct.map { "\($0.avatarETag ?? ""):\($0.avatar?.count ?? 0):\($0.thumbhash ?? "")" } ?? account.avatarURL?.absoluteString ?? account.avatarThumbhash ?? ""
    }

    static func load(_ account: AccountSummary, context: AppContext) async -> UIImage? {
        let direct = context.account.direct.accounts.first { $0.id == account.id }
        let bytes = direct?.avatar
        let directHash = direct?.thumbhash
        var image = await Task.detached { () -> UIImage? in
            if let bytes, let image = AccountPictureImages.decode(bytes)?.picture as? UIImage { return image }
            return directHash.flatMap { AccountPictureImages.placeholder($0)?.picture as? UIImage }
        }.value
        guard image == nil, direct == nil else { return image }
        let pictures = context.account.pictures(for: account.id)
        if let url = account.avatarURL { image = await pictures?.image(url) }
        if image == nil, let hash = account.avatarThumbhash { image = await pictures?.placeholderImage(hash) }
        return image
    }
}
#endif

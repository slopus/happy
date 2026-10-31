#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A round glass control in Settings' bar, as Telegram's bar buttons are
/// (iOS's own glass, interactive, so a touch swells it).
final class GlassView: UIView {
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
final class ProfileCarouselView: UIView, UIScrollViewDelegate {
    struct Item: Equatable {
        var id: String
        var label: String
        var image: UIImage?
        /// Shown when there is no picture: Happy's mark for a computer, a person for an account.
        var isAgentConnection: Bool
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
        add.accessibilityIdentifier = "profile-add"
        add.accessibilityLabel = Strings.connectAgentTile
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
            circle.accessibilityIdentifier = "profile:\(index)"
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
        let size = CGSize(width: ProfileCarousel.contentWidth(count: items.count + 1, width: bounds.width) - ProfileCarousel.Metrics.pitch, height: bounds.height)
        if scroll.contentSize != size { scroll.contentSize = size }
        // Only once there is a width to centre in.
        if needsCentering, bounds.width > 0 {
            needsCentering = false
            scroll.contentOffset.x = ProfileCarousel.offset(for: selected)
        }
        place()
    }

    private func place() {
        let offset = scroll.contentOffset.x
        for (index, circle) in circles.enumerated() {
            let item = ProfileCarousel.item(index, offset: offset, width: bounds.width)
            circle.place(item.frame, emphasis: item.emphasis)
        }
        let item = ProfileCarousel.item(items.count, offset: offset, width: bounds.width)
        add.place(item.frame, emphasis: 0)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        place()
        guard scrollView.isDragging || scrollView.isDecelerating else { return }
        let index = ProfileCarousel.index(at: scrollView.contentOffset.x, count: items.count)
        if index != centered {
            centered = index
            Haptics.play(.pick)
        }
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        tapped = nil
        Haptics.prepare(.pick)
    }

    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        targetContentOffset.pointee.x = ProfileCarousel.snapped(targetContentOffset.pointee.x, count: items.count)
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { rest() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { rest() }
    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { rest() }

    private func rest() {
        // A circle tapped while the strip still glided is where it rests.
        let index = tapped ?? ProfileCarousel.index(at: scroll.contentOffset.x, count: items.count)
        let target = ProfileCarousel.offset(for: index)
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
        let target = ProfileCarousel.offset(for: index)
        Haptics.play(.pick)
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
            ring.lineWidth = ProfileCarousel.Metrics.ringWidth
            layer.addSublayer(ring)
            if isAdd {
                picture.image = Glyphs.image("add", size: 26)
                picture.tintColor = UIColor(Palette.settingsText)
                picture.backgroundColor = UIColor(Palette.settingsAddFill)
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
                picture.image = item.isAgentConnection
                    ? UIImage.happy("logo-black")?.withRenderingMode(.alwaysTemplate)
                    : Glyphs.image("person-outline", size: 28)
                picture.contentMode = .center
                picture.tintColor = UIColor(Palette.settingsText)
                picture.backgroundColor = UIColor(Palette.settingsAddFill)
            }
        }

        /// The picture at `frame`; the ring sits outside it by its gap.
        func place(_ frame: CGRect, emphasis: CGFloat) {
            typealias M = ProfileCarousel.Metrics
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
            ring.strokeColor = UIColor(Palette.settingsRing).resolvedColor(with: traitCollection).cgColor
        }
    }
}

/// A row in a settings card: what it says and does.
struct SettingsRow {
    enum Tile { case orange, gray, blue, purple, green, red, teal, indigo, action }
    var id: String
    var title: String
    var icon: (glyph: String, tile: Tile)?
    /// An account's or connection's row: `image` round in the icon's
    /// place, an empty circle until it comes, never a glyph.
    var avatar = false
    /// Its picture, drawn round in the icon's place; the icon is the
    /// fallback for one that hasn't come yet.
    var image: UIImage?
    var value: String?
    var accessory: SettingsLayout.Accessory = .chevron
    var destructive = false
    /// A switch's state, for `.toggle`.
    var isOn = false
    var action: (() -> Void)?
    var toggled: ((Bool) -> Void)?
    /// The line under this row's card, said by the card's last row.
    var footer: String?
    /// A block of text the card's width (a secret key), in monospace.
    var isCode = false
    /// Quieter, for a row that can't be used here.
    var dimmed = false
    /// What VoiceOver adds about it: why a dimmed row does nothing.
    var hint: String?
    /// What a hold on it offers (signing an account out), and VoiceOver's
    /// actions on it.
    var menu: [MenuItem] = []

    struct MenuItem {
        var title: String
        var glyph: String
        var destructive = false
        var run: () -> Void
    }

    /// Whether it takes the icon's lane.
    var hasIcon: Bool { icon != nil || avatar }
}

/// A grouped card of rows, Telegram's inset style: a coloured square with a
/// white glyph, the title, a quieter value, a chevron or a switch, hairlines
/// between rows from the title's start.
final class SettingsCardView: UIView {
    private var views: [RowView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.settingsCard)
        layer.cornerRadius = SettingsLayout.Metrics.radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ rows: [SettingsRow], layout: SettingsLayout.Card) {
        while views.count < rows.count { let view = RowView(); addSubview(view); views.append(view) }
        while views.count > rows.count { views.removeLast().removeFromSuperview() }
        for (view, (row, frames)) in zip(views, zip(rows, layout.rows)) { view.show(row, frames: frames) }
    }

    /// The row at `index` lights up and fades, as a found row does.
    func flash(_ index: Int) {
        guard views.indices.contains(index) else { return }
        views[index].flash()
    }

    /// Measures a value as a row draws it.
    static func valueWidth(_ text: String?) -> CGFloat? {
        text.map { ($0 as NSString).size(withAttributes: [.font: RowView.valueFont]).width }
    }

    /// The cards' rows as the layout takes them, a code row measured at
    /// the page's `width`.
    static func specs(_ cards: [[SettingsRow]], width: CGFloat) -> [[SettingsLayout.RowSpec]] {
        cards.map { card in
            card.map { row in
                let text = row.isCode ? height(row.title, font: RowView.codeFont, width: SettingsLayout.textWidth(width)) : nil
                return SettingsLayout.RowSpec(hasIcon: row.hasIcon && !row.isCode, valueWidth: row.isCode ? nil : valueWidth(row.value), accessory: row.isCode ? .none : row.accessory, textHeight: text)
            }
        }
    }

    /// Each card's footer, its last row's, measured at the page's `width`.
    static func footers(_ cards: [[SettingsRow]], width: CGFloat) -> [CGFloat?] {
        cards.map { card in card.last?.footer.map { height($0, font: SettingsFooters.font, width: SettingsLayout.footerWidth(width)) } }
    }

    private static func height(_ text: String, font: UIFont, width: CGFloat) -> CGFloat {
        ceil((text as NSString).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font], context: nil).height)
    }

    final class RowView: UIView, UIContextMenuInteractionDelegate {
        static let titleFont = Fonts.ui(.regular, size: 17)
        static let valueFont = Fonts.ui(.regular, size: 17)
        static let codeFont = Fonts.mono(bold: false, size: 15)
        private let tile = UIView()
        private let glyph = UIImageView()
        private let title = UILabel()
        private let value = UILabel()
        private let chevron = UIImageView(image: Glyphs.image("chevron-right", size: 14))
        private let toggle = UISwitch()
        private let separator = UIView()
        private var row: SettingsRow?
        private lazy var menuInteraction = UIContextMenuInteraction(delegate: self)
        /// A fold's chevron, turned down while what it folds is open.
        var chevronTurned = false {
            didSet { chevron.image = Glyphs.image(chevronTurned ? "chevron-down" : "chevron-right", size: 14) }
        }

        override init(frame: CGRect) {
            super.init(frame: frame)
            tile.layer.cornerRadius = SettingsLayout.Metrics.tileRadius
            tile.layer.cornerCurve = .continuous
            tile.clipsToBounds = true
            glyph.tintColor = UIColor(Palette.settingsGlyph)
            glyph.contentMode = .center
            tile.addSubview(glyph)
            title.font = Self.titleFont
            value.font = Self.valueFont
            value.textColor = UIColor(Palette.settingsSecondary)
            value.textAlignment = .right
            chevron.tintColor = UIColor(Palette.settingsSecondary)
            chevron.contentMode = .center
            separator.backgroundColor = UIColor(Palette.settingsSeparator)
            toggle.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                Haptics.play(.pick)
                row?.toggled?(toggle.isOn)
            }, for: .valueChanged)
            for view in [tile, title, value, chevron, toggle, separator] as [UIView] { addSubview(view) }
            isAccessibilityElement = false
            addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        }

        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

        func show(_ row: SettingsRow, frames: SettingsLayout.Row) {
            let previous = self.row
            self.row = row
            frame = frames.box
            let origin = frames.box.origin
            func local(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: -origin.x, dy: -origin.y) }
            tile.isHidden = frames.icon == nil
            if let frame = frames.icon {
                tile.frame = local(frame)
                if row.image != nil || row.avatar {
                    // Its own picture, round, filling the square an icon
                    // would have had: the rows read as the accounts they are.
                    tile.backgroundColor = row.image == nil ? UIColor(Palette.settingsAddFill) : .clear
                    tile.layer.cornerRadius = frame.height / 2
                    // The picture over the thumbhash it had: dissolved in.
                    ImageFade.show(row.image, in: glyph, fade: previous?.id == row.id && previous?.image != nil)
                    glyph.contentMode = .scaleAspectFill
                    glyph.clipsToBounds = true
                    glyph.frame = tile.bounds
                } else if let icon = row.icon {
                    tile.backgroundColor = icon.tile == .action ? .clear : UIColor(Self.color(icon.tile))
                    tile.layer.cornerRadius = SettingsLayout.Metrics.tileRadius
                    glyph.tintColor = UIColor(icon.tile == .action ? Palette.textLink : Palette.settingsGlyph)
                    glyph.image = Glyphs.image(icon.glyph, size: SettingsLayout.Metrics.glyph)
                    glyph.contentMode = .center
                    glyph.clipsToBounds = false
                    glyph.frame = tile.bounds
                }
            }
            title.text = row.title
            title.font = row.isCode ? Self.codeFont : Self.titleFont
            title.numberOfLines = row.isCode ? 0 : 1
            title.textColor = UIColor(row.destructive ? Palette.settingsDestructive : row.dimmed ? Palette.settingsSecondary : row.icon?.tile == .action ? Palette.textLink : Palette.settingsText)
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
            accessibilityIdentifier = "settings:\(row.id)"
            // A switch row is the switch itself to VoiceOver and to tests.
            toggle.accessibilityIdentifier = "settings-toggle:\(row.id)"
            toggle.accessibilityLabel = row.title
            isAccessibilityElement = row.accessory != .toggle
            accessibilityLabel = [row.title, row.value].compactMap { $0 }.joined(separator: ", ")
            accessibilityHint = row.hint
            accessibilityTraits = row.accessory == .toggle ? [] : row.action != nil ? .button : row.dimmed ? .notEnabled : .staticText
            if row.menu.isEmpty {
                removeInteraction(menuInteraction)
            } else if !interactions.contains(where: { $0 === menuInteraction }) {
                addInteraction(menuInteraction)
            }
            accessibilityCustomActions = row.menu.map { item in
                UIAccessibilityCustomAction(name: item.title) { _ in item.run(); return true }
            }
        }

        func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
            guard let items = row?.menu, !items.isEmpty else { return nil }
            return UIContextMenuConfiguration(actionProvider: { _ in
                UIMenu(children: items.map { item in
                    UIAction(title: item.title, image: Glyphs.image(item.glyph, size: 17), attributes: item.destructive ? .destructive : []) { _ in item.run() }
                })
            })
        }

        static func color(_ tile: SettingsRow.Tile) -> ColorToken {
            switch tile {
            case .orange: Palette.settingsTileOrange
            case .gray: Palette.settingsTileGray
            case .blue: Palette.settingsTileBlue
            case .purple: Palette.settingsTilePurple
            case .green: Palette.settingsTileGreen
            case .red: Palette.settingsTileRed
            case .teal: Palette.settingsTileTeal
            case .indigo: Palette.settingsTileIndigo
            case .action: Palette.textLink
            }
        }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
            super.touchesBegan(touches, with: event)
            if row?.action != nil { backgroundColor = UIColor(Palette.rowPressed) }
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

        func flash() {
            backgroundColor = UIColor(Palette.rowPressed)
            UIView.animate(withDuration: 0.8, delay: 0.6, options: [.allowUserInteraction, .curveEaseOut]) { self.backgroundColor = nil }
        }
    }
}

/// The lines under settings' cards, each where the layout put it.
final class SettingsFooters {
    static let font = Fonts.ui(.regular, size: 13)
    private weak var container: UIView?
    private var labels: [UILabel] = []

    init(in container: UIView) { self.container = container }

    /// `texts` by card, at `layout`'s footer frames.
    func show(_ texts: [String?], layout: [SettingsLayout.Card]) {
        let shown = zip(texts, layout).compactMap { text, card in text.flatMap { text in card.footer.map { (text, $0) } } }
        while labels.count < shown.count {
            let label = UILabel()
            label.font = Self.font
            label.textColor = UIColor(Palette.settingsSecondary)
            label.numberOfLines = 0
            container?.addSubview(label)
            labels.append(label)
        }
        while labels.count > shown.count { labels.removeLast().removeFromSuperview() }
        for (label, (text, frame)) in zip(labels, shown) {
            label.text = text
            label.frame = frame
        }
    }

    /// What they say, top to bottom: for the tests.
    var texts: [String] { labels.compactMap { $0.text } }
}

/// A profile's picture: a computer's own bytes, an account's from its
/// server, else the placeholder its thumbhash makes, else the one its ID
/// picks (`AvatarPlaceholder`); decoded off main.
@MainActor
enum ProfilePictures {
    /// The largest an account's placeholder is drawn: Settings' agent
    /// picture.
    static let placeholderSide = AgentEditButtonLayout.Metrics.avatar

    /// What the account's placeholder is picked by: an agent connection's
    /// computer, else the account's own ID (derived from its secret), so
    /// it is the same on every phone.
    static func placeholderSeed(_ account: AccountSummary, context: AppContext) -> String {
        context.account.agentConnections.placeholderSeed(for: account.id) ?? account.id
    }

    static func key(_ account: AccountSummary, context: AppContext) -> String {
        let direct = context.account.agentConnections.accounts.first { $0.id == account.id }
        return direct.map { "\($0.avatarETag ?? ""):\($0.avatar?.count ?? 0):\($0.thumbhash ?? "")" } ?? account.avatarURL?.absoluteString ?? account.avatarThumbhash ?? ""
    }

    /// What shows until `load` answers: the thumbhash, decoded now, so the
    /// first frame has it.
    static func placeholder(_ account: AccountSummary, context: AppContext) -> UIImage? {
        let direct = context.account.agentConnections.accounts.first { $0.id == account.id }
        return ThumbHashImages.image(direct.map { $0.thumbhash } ?? account.avatarThumbhash)
    }

    /// Nil only when the placeholder isn't bundled.
    static func load(_ account: AccountSummary, context: AppContext) async -> UIImage? {
        if let picture = await picture(account, context: context) { return picture }
        return await AvatarPlaceholderImages.image(seed: placeholderSeed(account, context: context), side: placeholderSide)
    }

    /// The account's own picture or its thumbhash, or nil.
    private static func picture(_ account: AccountSummary, context: AppContext) async -> UIImage? {
        let direct = context.account.agentConnections.accounts.first { $0.id == account.id }
        let bytes = direct?.avatar
        var image = await Task.detached { () -> UIImage? in
            bytes.flatMap { AccountPictureImages.decode($0)?.picture as? UIImage }
        }.value
        if image == nil, direct == nil, let url = account.avatarURL {
            image = await context.account.pictures(for: account.id)?.image(url)
        }
        return image ?? placeholder(account, context: context)
    }
}
#endif

#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// One row of the V2 sidebar as desktop's `Sidebar` draws it: a
/// rounded box, the mark in its leading lane, the label, and the trailing
/// square for a status or a section's fold. Unread is the title in bold,
/// nothing beside it. A row someone looped the person into is new until
/// opened: tinted, bold, with a dot in the trailing square, and it pulses
/// once when it arrives on screen. While agent stories are on, a
/// conversation's row is desktop's story row instead: a card with its mark
/// on a 50 disc inside its story ring, the title and the time, the lines its
/// work changed and the agent's status in up to two lines, the person's
/// draft or the empty mark on the last line, and one signal in the
/// bottom-right lane (no trailing mark). A bot, task or subtask whose
/// work runs shimmers its title (`shimmers`). In a grouped list
/// (`grouped`) a row is a cell of its card: the card's quiet fill, its corners
/// where the row ends the card, iOS's grey highlight under a finger, and
/// the hairline under it; a top-level glyph sits on a softly tinted tile;
/// a heading is a quiet title over the card. It
/// applies the frames `SidebarLayout` gives it and decides nothing about
/// where anything goes.
final class RowView: UIView {
    private let fill = UIView()
    private let separatorLine = UIView()
    private let seedling = MarkView()
    private let picture = UIImageView()
    /// A grouped row's glyph sits on this softly tinted square.
    private let tile = UIView()
    private let label = ShimmerLabel()
    private let trailing = UIImageView()
    private let chevron = UIImageView()
    private let rule = UIView()
    private let ring = StoryRingView()
    private let subtitle = TopLabel()
    private let time = UILabel()
    private let draft = UILabel()
    private let empty = EmptyMarkView(frame: .zero)
    private let corner = CornerView()
    private let markPicture = MarkPicture()
    private let placeholder = AvatarPlaceholderSlot()

    private(set) var row: Row?
    var images: Images?
    var frames: SidebarLayout.Frame? {
        didSet { if frames != oldValue { setNeedsLayout() } }
    }
    var selected = false {
        didSet { if selected != oldValue { applyState() } }
    }
    var pressed = false {
        didSet { if pressed != oldValue { applyState() } }
    }
    /// The row is being carried: it rides above the others.
    var lifted = false {
        didSet { if lifted != oldValue { applyState() } }
    }
    /// Drawn as a cell of an inset grouped card (`SidebarLayout.Style.grouped`).
    var grouped = false {
        didSet {
            guard grouped != oldValue, let row else { return }
            applyMark(row.mark)
            applyText(row)
            applyTrailing(row)
            applyState()
            setNeedsLayout()
        }
    }
    /// False while the list has the row scrolled out of sight: its title's
    /// sweep stops until it is back.
    var onScreen = true {
        didSet { label.onScreen = onScreen; corner.onScreen = onScreen }
    }
    /// When the title's running sweep began; nil while it doesn't run.
    var titleSweepBegan: CFTimeInterval? { label.sweepBegan }
    var workingSignalRunning: Bool { corner.animating }
    /// The story ring, for the viewer to grow out of and close into.
    var ringView: UIView? { ring.isHidden ? nil : ring }
    /// What the row wears as its mark, for the viewer's avatar.
    var markImage: UIImage? { picture.isHidden ? nil : picture.image }
    /// What a hold on the row offers, as VoiceOver's actions on it.
    var actions: (() -> [UIAccessibilityCustomAction]?)?

    override var accessibilityCustomActions: [UIAccessibilityCustomAction]? {
        get { actions?() ?? super.accessibilityCustomActions }
        set { super.accessibilityCustomActions = newValue }
    }
    private var field: RenameField?
    private var finish: ((String?) -> Void)?
    /// A title just saved, shown until the row says the same.
    private var held: (label: String, until: Task<Void, Never>)?
    /// The row as the sidebar last gave it.
    private var latest: Row?

    override init(frame: CGRect) {
        super.init(frame: frame)
        fill.layer.cornerRadius = Metrics.cornerRadius
        fill.layer.cornerCurve = .continuous
        fill.isUserInteractionEnabled = false
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.layer.cornerCurve = .continuous
        placeholder.liveHost = picture
        trailing.contentMode = .center
        chevron.contentMode = .center
        rule.backgroundColor = UIColor(Palette.divider)
        separatorLine.backgroundColor = UIColor(Palette.groupedSeparator)
        separatorLine.isUserInteractionEnabled = false
        separatorLine.isHidden = true
        tile.isUserInteractionEnabled = false
        tile.isHidden = true
        subtitle.numberOfLines = StoryRowMetrics.statusLines
        subtitle.lineBreakMode = .byTruncatingTail
        draft.numberOfLines = 1
        draft.lineBreakMode = .byTruncatingTail
        time.textColor = UIColor(Palette.rowText)
        time.textAlignment = .right
        ring.isHidden = true
        subtitle.isHidden = true
        time.isHidden = true
        draft.isHidden = true
        empty.isHidden = true
        for view in [fill, separatorLine, ring, tile, seedling, picture, label, subtitle, draft, empty, time, trailing, chevron, rule, corner] { addSubview(view) }
        isAccessibilityElement = true
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (self: Self, _) in self.textSizeChanged() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Shows `row`; a row equal to the one shown changes nothing.
    func configure(_ row: Row) {
        latest = row
        var row = row
        if let held {
            if row.label == held.label { held.until.cancel(); self.held = nil } else { row.label = held.label }
        }
        guard row != self.row else { return }
        let previous = self.row
        self.row = row
        if previous?.mark != row.mark || (previous?.story == nil) != (row.story == nil) || previous?.targetKind != row.targetKind || previous?.surfaceType != row.surfaceType {
            applyMark(row.mark)
            if case .seedling(let seed) = previous?.mark, case .clay(let slug) = row.mark, let image = ClayIconImages.image(slug) { hatch(seed: seed, into: image) }
        }
        // Ordinary titles are applied by applyState with their final weight
        // and colors. Don't assign and measure the same title twice.
        if row.kind == .section || row.kind == .separator { applyText(row) }
        applyTrailing(row)
        applyStory(row)
        applyState()
        if row.isNew, previous?.isNew != true { pulse() }
        accessibilityLabel = row.kind == .separator ? nil : row.label
        accessibilityTraits = row.kind == .section ? [.header, .button] : row.kind == .separator ? .none : .button
        isAccessibilityElement = row.kind != .separator
        accessibilityIdentifier = "row:\(row.kind):\(row.label)"
        // What the row wears, so a test can watch a seedling grow its icon.
        let wears: String? = switch row.mark {
        case .seedling: "seedling"
        case .clay(let slug): slug
        default: nil
        }
        let value = [row.isNew ? Strings.newRow : nil, wears, Self.shimmers(row) ? Strings.workingRow : nil].compactMap { $0 }
        accessibilityValue = value.isEmpty ? nil : value.joined(separator: ", ")
        if let story = row.story {
            let changes = row.lineChanges.flatMap { $0.isEmpty ? nil : "+\($0.added) \u{2212}\($0.deleted)" }
            accessibilityValue = [changes, row.statusLine, row.draft.map { "Draft: \($0)" }, story.unseen > 0 ? Strings.Stories.newStories(story.unseen) : nil]
                .compactMap { $0 }.joined(separator: ", ")
        }
        setNeedsLayout()
    }

    /// The text size story rows are drawn at.
    private var textScale: CGFloat { StoryRowText.scale(traitCollection) }

    /// The story row: the ring, the time, the status, the last line and the corner.
    private func applyStory(_ row: Row) {
        let story = row.story
        let scale = textScale
        ring.isHidden = story == nil || row.mark == .none
        ring.apply(story ?? .init())
        ring.accessibilityIdentifier = "ring:\(row.label)"
        let last = StoryRowText.lastLine(row)
        subtitle.isHidden = story == nil
        subtitle.numberOfLines = last == .status ? StoryRowMetrics.statusLines : 1
        subtitle.attributedText = story == nil ? nil : StoryRowText.status(row, scale: scale)
        subtitle.lineBreakMode = .byTruncatingTail
        draft.isHidden = story == nil || last != .draft
        draft.attributedText = row.draft.map { StoryRowText.draft($0, scale: scale) }
        draft.lineBreakMode = .byTruncatingTail
        empty.isHidden = story == nil || last != .empty
        let time = story == nil ? nil : StoryRowText.time(row)
        self.time.isHidden = time == nil
        self.time.text = time
        self.time.font = StoryRowText.timeFont(scale)
        corner.apply(story == nil && row.status != .working ? .none : row.corner)
        corner.accessibilityIdentifier = "corner:\(row.label)"
    }

    /// The time read again, as the clock has moved on.
    func refreshTime() {
        guard let row, row.story != nil else { return }
        let text = StoryRowText.time(row)
        guard time.text != text else { return }
        time.text = text
        time.isHidden = text == nil
    }

    /// Story rows draw at the person's text size; the list lays them out again.
    func textSizeChanged() {
        guard let row, row.story != nil else { return }
        applyText(row)
        applyStory(row)
        setNeedsLayout()
    }

    private func applyMark(_ mark: Row.Mark) {
        markPicture.cancel()
        placeholder.cancel()
        seedling.seed = nil
        seedling.isHidden = true
        picture.isHidden = true
        picture.image = nil
        picture.tintColor = nil
        picture.contentMode = .scaleAspectFit
        picture.layer.cornerRadius = 0
        tileTint = grouped && row?.story == nil ? row.flatMap(Self.tint) : nil
        tile.isHidden = tileTint == nil
        if let tileTint {
            tile.backgroundColor = UIColor(tileTint.fill)
            tile.layer.cornerRadius = GroupedSidebarMetrics.tileRadius
            tile.layer.cornerCurve = .continuous
        }
        switch mark {
        case .none:
            break
        case .glyph(let name) where tileTint != nil:
            picture.isHidden = false
            picture.contentMode = .center
            picture.image = Glyphs.image(name, size: GroupedSidebarMetrics.tileGlyph)
        case .seedling(let seed):
            seedling.isHidden = false
            seedling.seed = seed
        case .happy:
            picture.isHidden = false
            picture.image = ClayIconImages.happy
        case .clay(let slug):
            // Clay art stands as drawn: no frame, no rounding.
            picture.isHidden = false
            picture.image = ClayIconImages.image(slug)
        case .glyph(let name):
            picture.isHidden = false
            picture.contentMode = .center
            picture.image = Glyphs.image(name, size: Metrics.glyph)
        case .placeholder(let seed):
            // Drawn as a picture is, decoded at the size it is drawn.
            picture.isHidden = false
            picture.contentMode = .scaleAspectFill
            picture.layer.cornerRadius = row?.story != nil ? StoryRowMetrics.disc / 2 : grouped ? GroupedSidebarMetrics.tileRadius : Metrics.pictureRadius
            picture.layer.cornerCurve = .continuous
            placeholder.show(seed: seed, side: row?.story != nil ? StoryRowMetrics.disc : Metrics.mark) { [weak self] in self?.picture.image = $0 }
        case .image(let path, let thumbhash):
            // A picture is a rounded square; in a story ring, a circle.
            picture.isHidden = false
            picture.contentMode = .scaleAspectFill
            picture.layer.cornerRadius = row?.story != nil ? StoryRowMetrics.disc / 2 : grouped ? GroupedSidebarMetrics.tileRadius : Metrics.pictureRadius
            picture.layer.cornerCurve = .continuous
            let pixels = Int((row?.story != nil ? StoryRowMetrics.disc : Metrics.mark) * 3)
            markPicture.load(path, thumbhash: thumbhash, pixels: pixels, images: images, into: picture)
        }
    }

    /// A grouped row's glyph tile: its ink and its fill.
    private var tileTint: (ink: ColorToken, fill: ColorToken)?

    /// The tile a glyph mark sits on in a grouped list, by what the row
    /// opens: one tint per kind, a Surface's by its type. Nil for a row
    /// whose mark is a picture or art, or no mark at all.
    static func tint(_ row: Row) -> (ink: ColorToken, fill: ColorToken)? {
        guard case .glyph = row.mark, row.kind == .space || row.kind == .session else { return nil }
        switch row.targetKind {
        case "bot": return (Palette.tileIndigo, Palette.tileIndigoFill)
        case "task": return (Palette.tileOrange, Palette.tileOrangeFill)
        case "artifacts": return (Palette.tilePurple, Palette.tilePurpleFill)
        case "surface":
            switch row.surfaceType {
            case "todo": return (Palette.tileGreen, Palette.tileGreenFill)
            case "calendar": return (Palette.tileRed, Palette.tileRedFill)
            case "system_monitor", "chat": return (Palette.tileTeal, Palette.tileTealFill)
            default: return (Palette.tileBlue, Palette.tileBlueFill)
            }
        default: return (Palette.tileBlue, Palette.tileBlueFill)
        }
    }

    /// Desktop's `shimmerLabel` (`Sidebar.tsx`), as Steve's desktop has
    /// it with "Shimmer active titles" on: a place work runs in says so in
    /// its own name for as long as it runs, under the sheen band in its
    /// own colour. Places are bots and tasks (desktop's project and
    /// workspace rows) and the subtasks under them; a Surface can't be busy.
    nonisolated static func shimmers(_ row: Row) -> Bool {
        guard row.status == .working else { return false }
        switch row.kind {
        case .session: return true
        case .space: return row.targetKind != "surface"
        default: return false
        }
    }

    private func applyText(_ row: Row) {
        switch row.kind {
        case .section where grouped:
            // iOS's section header: small capitals in the quiet grey.
            label.attributedText = NSAttributedString(string: row.label.uppercased(), attributes: [
                .font: Self.groupedHeadingFont,
                .kern: GroupedSidebarMetrics.headingSize * Self.groupedHeadingTracking,
            ])
        case .section:
            let size = Self.headingSize(row)
            label.attributedText = NSAttributedString(string: row.label.uppercased(), attributes: [
                .font: Fonts.mono(bold: true, size: size),
                .kern: size * Metrics.sectionTracking,
            ])
        case .separator:
            label.attributedText = nil
        default:
            // A story row's title keeps one weight: unread is its corner's to say.
            let font = row.story != nil ? StoryRowText.titleFont(textScale) : Fonts.ui(row.unread || row.isNew ? .bold : selected ? .semiBold : .medium, size: Metrics.labelSize)
            label.attributedText = NSAttributedString(string: row.label, attributes: [.font: font])
        }
    }

    private func applyTrailing(_ row: Row) {
        trailing.isHidden = true
        // A heading search shows (`collapsed` nil) folds nothing.
        let folds = (row.kind == .section && row.collapsed != nil) || ((row.kind == .space || row.kind == .session) && row.collapsed != nil)
        chevron.isHidden = !folds
        rule.isHidden = row.kind != .separator
        if folds {
            // Closed while folded or while it has subtasks still to show.
            let closed = row.collapsed == true || row.hasHiddenSessions
            let size = grouped && row.kind == .section ? GroupedSidebarMetrics.headingGlyph : row.amongStories ? StoryRowMetrics.headingGlyph : Metrics.chevronGlyph
            chevron.image = Glyphs.image(closed ? "chevron-right" : "chevron-down", size: size)
        }
        // A story row's corner says all of this instead.
        guard row.story == nil else { return }
        switch row.status {
        case .awaitingInput:
            trailing.isHidden = false
            trailing.image = Glyphs.image("question", size: Metrics.questionGlyph)
            trailing.tintColor = UIColor(Palette.rowText)
        case .waiting:
            trailing.isHidden = false
            trailing.image = Glyphs.image("clock", size: Metrics.clockGlyph)
            trailing.tintColor = UIColor(Palette.rowText)
        case .working, .none:
            guard row.isNew else { break }
            trailing.isHidden = false
            trailing.image = Self.newDot
            trailing.tintColor = UIColor(Palette.rowNewDot)
        }
    }

    private func applyState() {
        // A story row's title is always in full ink, as Telegram's are.
        let ink = UIColor(selected || row?.unread == true || row?.isNew == true || row?.story != nil ? Palette.rowTextActive : Palette.rowText)
        let heading = grouped && row?.kind == .section
        label.textColor = heading ? UIColor(Palette.settingsSecondary) : ink
        picture.tintColor = picture.contentMode == .center ? tileTint.map { UIColor($0.ink) } ?? ink : nil
        chevron.tintColor = UIColor(heading ? Palette.settingsSecondary : Palette.rowText)
        if let row, row.kind != .section, row.kind != .separator { applyText(row) }
        label.shimmering = row.map(Self.shimmers) ?? false
        let carryable = row?.kind != .section && row?.kind != .separator
        // A story card is never tinted as new: its corner dot says so.
        let tinted = row?.isNew == true && row?.story == nil
        if grouped {
            // A cell is the card's own fill until a finger or the open
            // screen lights it; headings and separators stand on the ground.
            let highlight = UIColor(Palette.groupedCellHighlight)
            let rest: UIColor = carryable ? UIColor(Palette.groupedCard) : .clear
            fill.backgroundColor = lifted ? rest : selected || pressed && carryable ? highlight : tinted ? UIColor(Palette.rowNew) : rest
            label.ground = selected ? highlight : UIColor(Palette.groupedCard)
        } else {
            fill.backgroundColor = lifted ? UIColor(Palette.background) : selected ? UIColor(Palette.rowSelected) : pressed && carryable ? UIColor(Palette.rowPressed) : tinted ? UIColor(Palette.rowNew) : .clear
            label.ground = UIColor(selected ? Palette.rowSelected : Palette.surface)
        }
        applyCorners()
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = lifted ? 0.14 : 0
        layer.shadowRadius = 12
        layer.shadowOffset = CGSize(width: 0, height: 4)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let frames else { return }
        // Frames are in sidebar content coordinates; this view's own frame is the box.
        let origin = frames.box.origin
        func local(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: -origin.x, dy: -origin.y) }
        fill.frame = bounds
        applyCorners()
        // A hairline that comes (a row below arrived) is there at once, never grown from nothing.
        let line = frames.cell?.separator.map(local)
        if separatorLine.isHidden, let line { UIView.performWithoutAnimation { separatorLine.frame = line } } else if let line { separatorLine.frame = line }
        separatorLine.isHidden = line == nil
        let radius = row?.story != nil ? StoryRowMetrics.cornerRadius : Metrics.cornerRadius
        layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: radius).cgPath
        var mark = frames.mark.map(local) ?? .zero
        ring.frame = frames.ring.map(local) ?? .zero
        if frames.ring != nil, let row {
            // On the disc: art and glyphs at their own size in its middle,
            // a picture filling it.
            let side: CGFloat? = switch row.mark {
            case .clay, .happy, .seedling: StoryRowMetrics.plateArt
            case .glyph: StoryRowMetrics.plateGlyph
            default: nil
            }
            if let side {
                mark = mark.insetBy(dx: (mark.width - side) / 2, dy: (mark.height - side) / 2)
            }
        }
        seedling.frame = mark
        picture.frame = mark
        tile.frame = mark
        subtitle.frame = frames.subtitle.map(local) ?? .zero
        draft.frame = frames.draft.map(local) ?? .zero
        empty.frame = frames.empty.map(local) ?? .zero
        time.frame = frames.time.map(local) ?? .zero
        corner.frame = frames.corner.map(local) ?? .zero
        label.frame = local(frames.label)
        field?.frame = label.frame
        trailing.frame = frames.trailing.map(local) ?? .zero
        chevron.frame = frames.chevronGlyph.map(local) ?? .zero
        rule.frame = frames.rule.map(local) ?? .zero
    }

    /// The fill's corners: a cell rounds its card's where it ends the card
    /// and is square in the middle, so a highlight is the card's own shape;
    /// a plain row is rounded all round.
    private func applyCorners() {
        guard grouped else {
            fill.layer.cornerRadius = row?.story != nil ? StoryRowMetrics.cornerRadius : Metrics.cornerRadius
            fill.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner]
            return
        }
        var corners: CACornerMask = []
        if frames?.cell?.roundsTop == true { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
        if frames?.cell?.roundsBottom == true { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
        fill.layer.cornerRadius = corners.isEmpty ? 0 : GroupedSidebarMetrics.radius
        fill.layer.maskedCorners = corners
    }

    /// The fill's corners as drawn now, for the hosted tests.
    var fillCorners: (radius: CGFloat, mask: CACornerMask) { (fill.layer.cornerRadius, fill.layer.maskedCorners) }
    var fillColor: UIColor? { fill.backgroundColor }
    var hairlineFrame: CGRect? { separatorLine.isHidden ? nil : separatorLine.frame }
    var tileColor: UIColor? { tile.isHidden ? nil : tile.backgroundColor }

    /// A heading among story rows is desktop's 22 tall; a finger also gets
    /// the gaps around it.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard !grouped, row?.amongStories == true, row?.kind == .section else { return super.point(inside: point, with: event) }
        return bounds.insetBy(dx: 0, dy: -6).contains(point)
    }

    /// A section heading's type: desktop's own size among story rows.
    static func headingSize(_ row: Row) -> CGFloat {
        row.amongStories ? StoryRowMetrics.headingSize : Metrics.sectionLabelSize
    }

    /// A grouped list's heading (iOS's section header): 13, a little tracked.
    nonisolated static let groupedHeadingFont = Fonts.ui(.medium, size: GroupedSidebarMetrics.headingSize)
    nonisolated static let groupedHeadingTracking: CGFloat = 0.02

    // MARK: New

    /// The new row's dot, drawn once as a template to tint.
    private static let newDot: UIImage = {
        let size = CGSize(width: Metrics.newDot, height: Metrics.newDot)
        return UIGraphicsImageRenderer(size: size).image { _ in UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill() }
            .withRenderingMode(.alwaysTemplate)
    }()

    /// A row that just became new flashes its tint once, where the person can see it.
    private func pulse() {
        guard window != nil, !UIAccessibility.isReduceMotionEnabled, !selected else { return }
        let flash = UIColor(Palette.rowNewDot).withAlphaComponent(0.35)
        let rest = UIColor(Palette.rowNew)
        fill.backgroundColor = rest
        UIView.animateKeyframes(withDuration: Metrics.newPulseDuration, delay: 0.15, options: [.allowUserInteraction]) {
            UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 0.25) { self.fill.backgroundColor = flash }
            UIView.addKeyframe(withRelativeStartTime: 0.25, relativeDuration: 0.25) { self.fill.backgroundColor = rest }
            UIView.addKeyframe(withRelativeStartTime: 0.5, relativeDuration: 0.25) { self.fill.backgroundColor = flash }
            UIView.addKeyframe(withRelativeStartTime: 0.75, relativeDuration: 0.25) { self.fill.backgroundColor = rest }
        } completion: { [weak self] _ in self?.applyState() }
    }

    // MARK: Hatch

    /// The seedling grows into its picture where the person can see it;
    /// elsewhere the picture just shows.
    private func hatch(seed: String, into image: UIImage) {
        guard let frames, let mark = frames.mark, HatchView.canPlay(in: self) else { return }
        let hatch = HatchView(frame: mark.offsetBy(dx: -frames.box.minX, dy: -frames.box.minY))
        picture.alpha = 0
        insertSubview(hatch, aboveSubview: picture)
        HatchHaptics.shared.play(size: mark.width)
        hatch.play(seed: seed, image: image) { [weak self] in self?.picture.alpha = 1 }
    }

    // MARK: Rename in place

    /// The title becomes a field in its own frame and font, `text` selected
    /// and the keyboard up. `done` gets what was kept, or nil when Escape
    /// put the old one back. False, and nothing changed, when the field
    /// couldn't take the keyboard.
    @discardableResult
    func beginEditing(_ text: String, done: @escaping (String?) -> Void) -> Bool {
        guard field == nil, let row else { return false }
        let field = RenameField()
        let section = row.kind == .section
        if section, grouped {
            field.font = Self.groupedHeadingFont
            field.defaultTextAttributes[.kern] = GroupedSidebarMetrics.headingSize * Self.groupedHeadingTracking
        } else {
            field.font = section ? Fonts.mono(bold: true, size: Self.headingSize(row)) : row.story != nil ? StoryRowText.titleFont(textScale) : Fonts.ui(.medium, size: Metrics.labelSize)
            if section { field.defaultTextAttributes[.kern] = Self.headingSize(row) * Metrics.sectionTracking }
        }
        field.textColor = UIColor(Palette.rowTextActive)
        field.tintColor = UIColor(Palette.rowTextActive)
        field.text = text
        field.returnKeyType = .done
        field.autocapitalizationType = .sentences
        field.accessibilityIdentifier = "rename"
        field.frame = label.frame
        field.onFinish = { [weak self] kept in self?.finishEditing(kept) }
        addSubview(field)
        self.field = field
        finish = done
        label.isHidden = true
        guard field.becomeFirstResponder() else {
            finish = nil
            finishEditing(nil)
            return false
        }
        field.selectAll(nil)
        return true
    }

    /// Keeps what the field holds: by letting go of the keyboard, or at once
    /// when it no longer has it.
    func commitEditing() {
        guard let field else { return }
        if field.isFirstResponder { field.resignFirstResponder() } else { finishEditing(field.text) }
    }

    private func finishEditing(_ kept: String?) {
        guard let field else { return }
        self.field = nil
        field.onFinish = nil
        field.removeFromSuperview()
        label.isHidden = false
        let finish = finish
        self.finish = nil
        finish?(kept)
    }

    /// Shows `title` now and keeps it until the row says the same (or a
    /// moment passes), so a saved name never flickers back.
    func holdLabel(_ title: String) {
        held?.until.cancel()
        let until = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, let self else { return }
            held = nil
            if let latest { show(latest) }
        }
        held = (title, until)
        if var shown = latest {
            shown.label = title
            show(shown)
        }
    }

    /// A row that differs only in its title.
    private func show(_ shown: Row) {
        row = shown
        applyText(shown)
        accessibilityLabel = shown.label
        accessibilityIdentifier = "row:\(shown.kind):\(shown.label)"
    }
}

/// The field a title turns into: Return and losing focus keep it, Escape
/// puts the old one back.
final class RenameField: UITextField, UITextFieldDelegate {
    var onFinish: ((String?) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        borderStyle = .none
        backgroundColor = .clear
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(cancel))]
    }

    @objc private func cancel() {
        let finish = onFinish
        onFinish = nil
        resignFirstResponder()
        finish?(nil)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        resignFirstResponder()
        return false
    }

    func textFieldDidEndEditing(_ textField: UITextField) {
        let finish = onFinish
        onFinish = nil
        finish?(text ?? "")
    }
}

#endif

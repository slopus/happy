#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// One slot of home's list on screen: the row's part of its card, the
/// bitmap UltraView drew of its text (`SidebarItemDrawing`), and the live
/// views over it a bitmap can't be: the mark (a tinted tile, a picture
/// fading in over its thumbhash or placeholder, clay art, a seedling) and
/// the working signal. The slot is the list's whole width
/// and reaches up to the row before it; only the row's box takes a touch.
///
/// It looks as `RowView` does in a grouped list: the card's quiet fill,
/// rounded where the row ends the card, iOS's grey highlight under a
/// finger and while its screen comes in, a new row's tint and pulse.
@MainActor
final class SidebarItemView: ListRowView {
    private(set) var item: SidebarItem
    private let fill = UIView()
    private var drawingView: ListRowView
    private let tile = UIView()
    private let seedling = MarkView()
    private let picture = UIImageView()
    private let signal = WorkingSignalView()
    /// The outline a task's or bot's icon wears while it has a live story.
    private let ring = UIView()
    private let placeholder = AvatarPlaceholderSlot()
    private let markPicture = MarkPicture()
    /// The mark as last applied, so a row that only changed its title keeps its picture.
    private var shownMark: (mark: Row.Mark, tint: String?)?
    /// The finger came down on a list still gliding: it stops the list, and opens nothing.
    private var stoppedGlide = false

    /// What the slot shows: its item's, or the one a width change laid out
    /// for it (`SidebarItem.entry(at:)`).
    private var entry: SidebarList.Entry
    var row: Row { item.entry.row }
    /// The row's frames, from the slot's top-left.
    var frames: SidebarLayout.Frame { entry.drawing.frame }
    /// The row's box, from the slot's top-left.
    var box: CGRect { entry.box }
    var selected = false {
        didSet { if selected != oldValue { applyFill() } }
    }
    var pressed = false {
        didSet { if pressed != oldValue { applyFill() } }
    }
    /// What the row wears as its mark.
    var markImage: UIImage? { picture.isHidden ? nil : picture.image }

    // MARK: Title

    /// The sheen over a working title (`SidebarItemDrawing.shimmers`), at
    /// the title's frame over the bitmap, which still draws the title under
    /// it. Its copy is drawn off the main thread.
    private(set) var titleBand: ShimmerBand?

    private func applyTitleBand(_ entry: SidebarList.Entry, fresh: Bool) {
        guard let run = entry.titleRun else {
            titleBand?.removeFromSuperview()
            titleBand = nil
            return
        }
        guard fresh || titleBand == nil else { return }
        let drawing = entry.drawing
        let band = ShimmerBand(
            frame: drawing.frame.label, run: CGRect(x: 0, y: 0, width: run, height: drawing.frame.label.height),
            scale: drawing.displayScale, draw: { drawing.drawShimmerCopy(in: $0) }
        )
        band.accessibilityIdentifier = "shimmer"
        titleBand?.removeFromSuperview()
        insertSubview(band, aboveSubview: drawingView)
        titleBand = band
    }
    override var isDisplayReady: Bool { drawingView.isDisplayReady }

    init(item: SidebarItem) {
        self.item = item
        entry = item.entry
        drawingView = item.node.makeView()
        super.init(frame: .zero)
        fill.isUserInteractionEnabled = false
        fill.layer.cornerCurve = .continuous
        drawingView.isUserInteractionEnabled = false
        drawingView.onDisplayReady = { [weak self] in self?.reportDisplayReady() }
        picture.clipsToBounds = true
        picture.layer.cornerCurve = .continuous
        placeholder.liveHost = picture
        tile.isUserInteractionEnabled = false
        tile.layer.cornerRadius = GroupedSidebarMetrics.tileRadius
        tile.layer.cornerCurve = .continuous
        ring.isUserInteractionEnabled = false
        ring.layer.borderWidth = StoryLayout.Metrics.ringWidth
        ring.layer.cornerCurve = .continuous
        for view in [fill, drawingView, tile, seedling, picture, signal, ring] { addSubview(view) }
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyRing() }
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        addGestureRecognizer(tap)
        let press = PressRecognizer(target: self, action: #selector(pressChanged(_:)))
        press.delegate = PressRecognizer.simultaneous
        addGestureRecognizer(press)
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        hold.minimumPressDuration = 0.5
        hold.cancelsTouchesInView = false
        hold.delegate = PressRecognizer.simultaneous
        addGestureRecognizer(hold)
        apply(item, transition: .none)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func apply(_ next: SidebarItem, transition: ListTransition) {
        let previous = item.entry.row
        // The view was made from `item`'s node: only another one draws anew.
        let fresh = next !== item
        item = next
        entry = next.entry
        if fresh { next.node.apply(to: drawingView, transition: transition) }
        applyTitleBand(next.entry, fresh: fresh)
        selected = next.entry.drawing.selected
        let row = next.entry.row
        let tint = Self.tint(row)
        if shownMark.map({ $0.mark != row.mark || $0.tint != tint?.key }) ?? true {
            applyMark(row, tint: tint)
            if case .seedling(let seed) = previous.mark, case .clay(let slug) = row.mark, previous.id == row.id,
               let image = ClayIconImages.image(slug) { hatch(seed: seed, into: image) }
        }
        tile.backgroundColor = tint.map { UIColor($0.fill) }
        picture.tintColor = picture.contentMode == .center ? tint.map { UIColor($0.ink) } ?? UIColor(ink(row)) : nil
        signal.apply(working: row.status == .working)
        signal.accessibilityIdentifier = "corner:\(row.label)"
        applyRing()
        applyFill()
        applyAccessibility()
        if row.isNew, !previous.isNew || previous.id != row.id, window != nil { pulse() }
        setNeedsLayout()
    }

    // MARK: Look

    private func applyRing() {
        ring.isHidden = row.story == nil
        ring.accessibilityIdentifier = row.story.map { "story:\($0):\(row.label)" }
        let color = row.story == .unseen ? Palette.storyUnseen : Palette.storySeen
        ring.layer.borderColor = UIColor(color).resolvedColor(with: traitCollection).cgColor
    }

    private func ink(_ row: Row) -> ColorToken {
        selected || row.unread || row.isNew ? Palette.rowTextActive : Palette.rowText
    }

    /// The fill: the card's own until a finger or the open screen lights
    /// it; a heading stands on the ground.
    private func applyFill() {
        let row = row
        let carryable = row.kind != .section && row.kind != .separator
        let tinted = row.isNew
        let rest: UIColor = carryable ? UIColor(Palette.groupedCard) : .clear
        fill.backgroundColor = selected || pressed && carryable ? UIColor(Palette.groupedCellHighlight) : tinted ? UIColor(Palette.rowNew) : rest
        var corners: CACornerMask = []
        if frames.cell?.roundsTop == true { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
        if frames.cell?.roundsBottom == true { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
        fill.layer.cornerRadius = corners.isEmpty ? 0 : GroupedSidebarMetrics.radius
        fill.layer.maskedCorners = corners
    }

    /// A glyph's tile, by what the row opens (`RowView.tint`), with a key to tell them apart.
    private static func tint(_ row: Row) -> (key: String, ink: ColorToken, fill: ColorToken)? {
        guard let tint = RowView.tint(row) else { return nil }
        return ("\(row.targetKind ?? "")|\(row.surfaceType ?? "")", tint.ink, tint.fill)
    }

    /// The mark, as a grouped `RowView` wears it.
    private func applyMark(_ row: Row, tint: (key: String, ink: ColorToken, fill: ColorToken)?) {
        shownMark = (row.mark, tint?.key)
        markPicture.cancel()
        placeholder.cancel()
        seedling.seed = nil
        seedling.isHidden = true
        picture.isHidden = true
        picture.image = nil
        picture.contentMode = .scaleAspectFit
        picture.layer.cornerRadius = 0
        tile.isHidden = tint == nil
        let radius = GroupedSidebarMetrics.tileRadius
        switch row.mark {
        case .none:
            break
        case .glyph(let name) where tint != nil:
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
            picture.isHidden = false
            picture.contentMode = .scaleAspectFill
            picture.layer.cornerRadius = radius
            placeholder.show(seed: seed, side: Metrics.mark) { [weak self] in self?.picture.image = $0 }
        case .image(let path, let thumbhash):
            // A picture is a rounded square.
            picture.isHidden = false
            picture.contentMode = .scaleAspectFill
            picture.layer.cornerRadius = radius
            let pixels = Int(Metrics.mark * 3)
            markPicture.load(path, thumbhash: thumbhash, pixels: pixels, images: item.owner?.images, into: picture)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        drawingView.frame = bounds
        fill.frame = box
        let frames = frames
        let mark = frames.mark ?? .zero
        seedling.frame = mark
        picture.frame = mark
        tile.frame = mark
        let outline = StoryLayout.ring(around: mark, markRadius: GroupedSidebarMetrics.tileRadius)
        ring.frame = outline.frame
        ring.layer.cornerRadius = outline.radius
        signal.frame = frames.corner ?? .zero
        titleBand?.frame = frames.label
    }

    override func applyPreparation(_ preparation: ListPreparation, width: Double, environment: RenderEnvironment) {
        drawingView.applyPreparation(preparation, width: width, environment: environment)
        // Drawn for a width change: the fill, the mark and the sheen follow
        // the drawing in the same pass.
        let shown = item.entry(at: width)
        guard abs(shown.size.width - entry.size.width) > 0.5 else { return }
        entry = shown
        applyTitleBand(shown, fresh: true)
        applyFill()
        setNeedsLayout()
    }

    override func update(width: Double, transition: ListTransition) -> Double { entry.size.height }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        signal.onScreen = window != nil
        if window == nil { pressed = false }
    }

    // MARK: Touch

    /// Only the row's box takes a touch: the gap above it and the margins
    /// beside its card are the list's.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        row.kind != .separator && box.contains(point)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        stoppedGlide = item.owner?.isGliding ?? false
        super.touchesBegan(touches, with: event)
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard !stoppedGlide else { return }
        item.owner?.tap(self, at: gesture.location(in: self))
    }

    @objc private func pressChanged(_ gesture: PressRecognizer) {
        guard let owner = item.owner else { return }
        let down = gesture.state == .began || gesture.state == .changed
        pressed = down && !stoppedGlide && owner.lightsOnPress(row)
        if gesture.state == .began, !stoppedGlide { owner.pressed(self) }
    }

    @objc private func held(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, !stoppedGlide else { return }
        item.owner?.openHold(self)
    }

    // MARK: VoiceOver

    private func applyAccessibility() {
        let row = row
        isAccessibilityElement = row.kind != .separator
        accessibilityLabel = row.kind == .separator ? nil : row.label
        accessibilityIdentifier = "row:\(row.kind):\(row.label)"
        var traits: UIAccessibilityTraits = row.kind == .section ? .header : row.kind == .separator ? .none : .button
        if selected { traits.insert(.selected) }
        accessibilityTraits = traits
        let wears: String? = switch row.mark {
        case .seedling: "seedling"
        case .clay(let slug): slug
        default: nil
        }
        let value = [row.isNew ? Strings.newRow : nil, wears, item.entry.drawing.shimmers ? Strings.workingRow : nil, SidebarLineChanges.accessibility(row.lineChanges), row.story.map { $0 == .unseen ? "story unseen" : "story seen" }].compactMap { $0 }
        accessibilityValue = value.isEmpty ? nil : value.joined(separator: ", ")
    }

    override var accessibilityFrame: CGRect {
        get { UIAccessibility.convertToScreenCoordinates(box, in: self) }
        set { super.accessibilityFrame = newValue }
    }

    override var accessibilityCustomActions: [UIAccessibilityCustomAction]? {
        get { item.owner?.actions(for: self) }
        set { super.accessibilityCustomActions = newValue }
    }

    override func accessibilityActivate() -> Bool {
        guard row.kind != .section, row.kind != .separator, let owner = item.owner else { return false }
        owner.tap(self, at: CGPoint(x: frames.label.midX, y: box.midY))
        return true
    }

    // MARK: Motion

    /// A row that just became new flashes its tint once, where the person can see it.
    private func pulse() {
        guard !UIAccessibility.isReduceMotionEnabled, !selected else { return }
        let flash = UIColor(Palette.rowNewDot).withAlphaComponent(0.35)
        let rest = UIColor(Palette.rowNew)
        let fill = fill
        fill.backgroundColor = rest
        UIView.animateKeyframes(withDuration: Metrics.newPulseDuration, delay: 0.15, options: [.allowUserInteraction]) {
            UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 0.25) { fill.backgroundColor = flash }
            UIView.addKeyframe(withRelativeStartTime: 0.25, relativeDuration: 0.25) { fill.backgroundColor = rest }
            UIView.addKeyframe(withRelativeStartTime: 0.5, relativeDuration: 0.25) { fill.backgroundColor = flash }
            UIView.addKeyframe(withRelativeStartTime: 0.75, relativeDuration: 0.25) { fill.backgroundColor = rest }
        }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Metrics.newPulseDuration + 0.15))
            self?.applyFill()
        }
    }

    /// The seedling grows into its picture where the person can see it;
    /// elsewhere the picture just shows.
    private func hatch(seed: String, into image: UIImage) {
        guard let mark = frames.mark, HatchView.canPlay(in: self) else { return }
        let hatch = HatchView(frame: mark)
        picture.alpha = 0
        insertSubview(hatch, aboveSubview: picture)
        HatchHaptics.shared.play(size: mark.width)
        hatch.play(seed: seed, image: image) { [weak self] in self?.picture.alpha = 1 }
    }

    // MARK: Tests

    var fillColor: UIColor? { fill.backgroundColor }
    var fillCorners: (radius: CGFloat, mask: CACornerMask) { (fill.layer.cornerRadius, fill.layer.maskedCorners) }
    var tileColor: UIColor? { tile.isHidden ? nil : tile.backgroundColor }
    var workingSignalRunning: Bool { signal.animating }
}
#endif

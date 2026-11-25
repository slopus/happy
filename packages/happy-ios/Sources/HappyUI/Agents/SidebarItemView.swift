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
///
/// A row that can be archived swipes toward its leading edge
/// (`SidebarSwipeLayout`): what it draws slides inside its card, over the
/// red action the swipe uncovers, both clipped to the card while it moves.
@MainActor
final class SidebarItemView: ListRowView, UIGestureRecognizerDelegate {
    private(set) var item: SidebarItem
    /// The row's card, clipping what is in it only while it is swiped.
    private let clip = UIView()
    /// Everything the row draws, in the slot's coordinates: a swipe slides it.
    private let content = UIView()
    private let action = SidebarSwipeActionView()
    private let swipe = UIPanGestureRecognizer()
    /// How far the row stands swiped open, and whether its action fills it.
    private(set) var reveal: CGFloat = 0
    private(set) var revealFull = false
    /// Where the finger's swipe began, as a reveal.
    private var swipeStart: CGFloat = 0
    private let fill = UIView()
    private var drawingView: ListRowView
    private let tile = UIView()
    private let seedling = MarkView()
    private let picture = UIImageView()
    private let signal = WorkingSignalView()
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
    /// Its row is in a finger's hand, its picture over the list: here only
    /// the card's part stays, an empty place in the card.
    var isCarried = false {
        didSet {
            guard isCarried != oldValue else { return }
            for view in [drawingView, tile, seedling, picture, signal, titleBand].compactMap({ $0 }) { view.alpha = isCarried ? 0 : 1 }
        }
    }
    /// A voice touch on the row (`VoiceTouch`): lit in its fill's shape,
    /// under its words, and pressed as a finger presses it.
    var voiceTouch: VoiceTouch.Mark {
        VoiceTouch.Mark(host: self, frame: fill.frame, radius: fill.layer.cornerRadius, corners: fill.layer.maskedCorners, above: fill) { [weak self] down, _ in
            self?.pressed = down
        }
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
        // The band fades with the title: placed at once, never glided in
        // by a list pass that animates the row.
        UIView.performWithoutAnimation {
            let band = ShimmerBand(
                frame: drawing.frame.label, run: CGRect(x: 0, y: 0, width: run, height: drawing.frame.label.height),
                scale: drawing.displayScale, draw: { drawing.drawShimmerCopy(in: $0) }
            )
            band.accessibilityIdentifier = "shimmer"
            titleBand?.removeFromSuperview()
            content.insertSubview(band, aboveSubview: drawingView)
            band.alpha = isCarried ? 0 : 1
            titleBand = band
        }
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
        clip.isUserInteractionEnabled = false
        clip.layer.cornerCurve = .continuous
        content.isUserInteractionEnabled = false
        addSubview(clip)
        clip.addSubview(action)
        clip.addSubview(content)
        action.isHidden = true
        for view in [fill, drawingView, tile, seedling, picture, signal] { content.addSubview(view) }
        swipe.addTarget(self, action: #selector(swiped(_:)))
        swipe.maximumNumberOfTouches = 1
        swipe.delegate = self
        addGestureRecognizer(swipe)
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
        // The view was made from `item`'s node: only another one draws
        // anew. A row that changed only what isn't drawn keeps it.
        let fresh = next.node !== item.node
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
        applyFill()
        applyAccessibility()
        if row.isNew, !previous.isNew || previous.id != row.id, window != nil { pulse() }
        setNeedsLayout()
    }

    // MARK: Look

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
        let radius = corners.isEmpty ? 0 : GroupedSidebarMetrics.radius
        // Swiped, the card rounds what slides inside it; the fill sliding
        // with the row has no corners of its own.
        fill.layer.cornerRadius = reveal > 0 ? 0 : radius
        fill.layer.maskedCorners = corners
        clip.layer.cornerRadius = radius
        clip.layer.maskedCorners = corners
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
        let box = box
        clip.frame = box
        // The slot's coordinates inside the card, slid by the swipe.
        content.frame = CGRect(origin: CGPoint(x: -box.minX, y: -box.minY), size: bounds.size)
        let swiped = SidebarSwipeLayout.frames(box: box.size, reveal: reveal, full: revealFull, icon: SidebarSwipeActionView.iconSize, title: action.titleSize)
        content.bounds.origin.x = -swiped.offset
        action.apply(swiped)
        drawingView.frame = bounds
        fill.frame = box
        let frames = frames
        let mark = frames.mark ?? .zero
        seedling.frame = mark
        picture.frame = mark
        tile.frame = mark
        signal.frame = frames.corner ?? .zero
        titleBand?.frame = frames.label
    }

    override func applyPreparation(_ preparation: ListPreparation, width: Double, environment: RenderEnvironment) {
        drawingView.applyPreparation(preparation, width: width, environment: environment)
        // Drawn for a width change: the fill, the mark and the sheen follow
        // the drawing in the same pass, from a slot laid out at that width.
        // One not made there yet (the list's slots were replaced since)
        // falls back to the item's own, which would put the fill back at
        // the old width.
        let shown = item.entry(at: width)
        guard abs(shown.size.width - width) <= 0.5, abs(shown.size.width - entry.size.width) > 0.5 else { return }
        entry = shown
        applyTitleBand(shown, fresh: true)
        applyFill()
        setNeedsLayout()
    }

    override func update(width: Double, transition: ListTransition) -> Double { entry.size.height }

    /// The list's pass is over: the bitmap's view hears it too, so a
    /// shorter drawing waiting for the pass's end shows.
    override func visibleRectUpdated(_ rect: CGRect?) {
        super.visibleRectUpdated(rect)
        drawingView.visibleRectUpdated(rect)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        signal.onScreen = window != nil
        if window == nil {
            pressed = false
            setReveal(0, full: false, animated: false)
        }
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

    // MARK: Swipe

    /// Whether `point`, in the slot, is on the action the swipe uncovered.
    func isOnAction(_ point: CGPoint) -> Bool {
        reveal > 0 && action.frame.offsetBy(dx: box.minX, dy: box.minY).contains(point)
    }

    /// Stands the row `reveal` open (`full`: its action filling it), at
    /// once or on iOS's spring; `then` runs once it is there.
    func setReveal(_ reveal: CGFloat, full: Bool, animated: Bool, then: (() -> Void)? = nil) {
        let moved = reveal != self.reveal || full != revealFull
        self.reveal = reveal
        revealFull = full
        if reveal > 0, action.isHidden {
            clip.clipsToBounds = true
            action.isHidden = false
            applyFill()
        }
        let settled = { [weak self] in
            guard let self else { return }
            if self.reveal == 0, !action.isHidden {
                clip.clipsToBounds = false
                action.isHidden = true
                applyFill()
            }
            then?()
        }
        guard moved else { return settled() }
        guard animated, window != nil else {
            setNeedsLayout()
            layoutIfNeeded()
            return settled()
        }
        setNeedsLayout()
        UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.layoutIfNeeded()
        } completion: { _ in settled() }
    }

    @objc private func swiped(_ gesture: UIPanGestureRecognizer) {
        guard let owner = item.owner else { return }
        let width = box.width
        switch gesture.state {
        case .began:
            owner.swipeBegan(self)
            swipeStart = reveal
            pressed = false
        case .changed:
            let shown = SidebarSwipeLayout.shown(swipeStart - gesture.translation(in: self).x, width: width)
            let full = SidebarSwipeLayout.isFull(shown, width: width)
            if full, !revealFull { Haptics.play(.armed) }
            // The label crosses to the content's edge on a spring; the rest follows the finger.
            setReveal(shown, full: full, animated: full != revealFull)
        case .ended, .cancelled, .failed:
            let velocity = gesture.state == .ended ? -gesture.velocity(in: self).x : 0
            let outcome = SidebarSwipeLayout.release(reveal: reveal, velocity: velocity, width: width)
            owner.swipeEnded(self, outcome: outcome)
        default:
            break
        }
    }

    override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard gesture === swipe else { return super.gestureRecognizerShouldBegin(gesture) }
        let moved = swipe.translation(in: self)
        // Sideways only, and toward the leading edge unless it stands open.
        guard heldAt == nil, abs(moved.x) > abs(moved.y), moved.x < 0 || reveal > 0 else { return false }
        return item.owner?.swipes(row) == true
    }

    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard gesture === swipe, let owner = item.owner else { return true }
        return owner.swipes(row) && !owner.isGliding
    }

    /// The list's pan, and any pan around it, waits until a sideways swipe
    /// is ruled out.
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        guard gesture === swipe, let list = item.owner?.list, let view = other.view, other is UIPanGestureRecognizer,
              !(other is UIScreenEdgePanGestureRecognizer), other !== swipe else { return false }
        return view === list.contentView || list.isDescendant(of: view)
    }

    @objc private func pressChanged(_ gesture: PressRecognizer) {
        guard let owner = item.owner else { return }
        let down = gesture.state == .began || gesture.state == .changed
        pressed = down && !stoppedGlide && owner.lightsOnPress(row)
        if gesture.state == .began, !stoppedGlide { owner.pressed(self) }
    }

    /// The finger held still on the row long enough to hold it, and where
    /// it was then, in the list's view; nil while it isn't held.
    private var heldAt: CGPoint?

    /// A hold opens the row's preview; a held finger that then moves
    /// carries the row (`SidebarList.carry`), and lets it go where it lifts.
    @objc private func held(_ gesture: UILongPressGestureRecognizer) {
        guard let owner = item.owner else { return }
        switch gesture.state {
        case .began:
            guard !stoppedGlide, reveal == 0 else { return }
            heldAt = gesture.location(in: owner)
            owner.openHold(self)
        case .changed:
            guard let heldAt else { return }
            owner.holdMoved(self, to: gesture.location(in: owner), from: heldAt)
        case .ended, .cancelled, .failed:
            guard heldAt != nil else { return }
            heldAt = nil
            owner.holdEnded(self, cancelled: gesture.state != .ended)
        default:
            break
        }
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
        let value = [row.isNew ? Strings.newRow : nil, wears, item.entry.drawing.shimmers ? Strings.workingRow : nil, SidebarLineChanges.accessibility(row.lineChanges), row.count.map(Strings.Feed.unreadCount)].compactMap { $0 }
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
        content.insertSubview(hatch, aboveSubview: picture)
        HatchHaptics.shared.play(size: mark.width)
        hatch.play(seed: seed, image: image) { [weak self] in self?.picture.alpha = 1 }
    }

    // MARK: Tests

    var fillColor: UIColor? { fill.backgroundColor }
    var fillCorners: (radius: CGFloat, mask: CACornerMask) { (fill.layer.cornerRadius, fill.layer.maskedCorners) }
    var tileColor: UIColor? { tile.isHidden ? nil : tile.backgroundColor }
    var workingSignalRunning: Bool { signal.animating }

    /// What the bitmap's view shows now: the hosts it holds, shown or still
    /// hidden, each with its drawing, its size and the bitmap on screen (in
    /// points); and how many other views stand in it (a picture of a host it
    /// gave away).
    var shownDrawing: (shown: [(drawing: SidebarItemDrawing?, size: CGSize, bitmap: CGSize?)], hidden: Int, others: Int) {
        let hosts = drawingView.subviews.compactMap { $0 as? NodeHostView }
        let shown = hosts.filter { !$0.isHidden }.map { host -> (SidebarItemDrawing?, CGSize, CGSize?) in
            let layer = host.rootNode.view?.layer
            let drawn = ([layer] + (layer?.sublayers ?? [])).lazy.compactMap { $0 }.first { $0.contents != nil }
            let bitmap = drawn.map { layer -> CGSize in
                let image = layer.contents as! CGImage
                return CGSize(width: CGFloat(image.width) / layer.contentsScale, height: CGFloat(image.height) / layer.contentsScale)
            }
            return (host.rootNode.drawing as? SidebarItemDrawing, host.bounds.size, bitmap)
        }
        return (shown, hosts.count - shown.count, drawingView.subviews.count - hosts.count)
    }

    /// The views drawing the bitmap now, shown or waiting.
    var drawingHosts: [NodeHostView] { drawingView.subviews.compactMap { $0 as? NodeHostView } }

    /// The bitmap view's state, for a log.
    var drawingDiagnostics: String {
        let hosts = drawingView.subviews.map { view -> String in
            guard let host = view as? NodeHostView else { return "other \(type(of: view)) \(view.frame)" }
            let drawing = host.rootNode.drawing as? SidebarItemDrawing
            return "host hidden \(host.isHidden) hasContent \(host.hasContent) complete \(host.isContentComplete) frame \(host.frame) label.y \(drawing?.frame.label.minY ?? -1)"
        }
        return "drawingView \(drawingView.frame) ready \(drawingView.isDisplayReady) window \(window != nil) [" + hosts.joined(separator: ", ") + "]"
    }
}
#endif

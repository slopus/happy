#if canImport(UIKit)
import HappyLayout
import os
import UIKit

/// The "+" menu's library grid, kept off the main thread's way: the grid
/// shows what the library last committed, and a change in the library
/// waits for the next frame, where it lands as one batch of inserts,
/// deletes and moves, the changed pictures reconfigured in place. The
/// library is never reloaded once the grid has it. Thumbnails come at
/// Telegram's 128 points (no more than two pixels each), and the library
/// caches them in a window that runs ahead of the scroll.
@MainActor
final class AttachGridFeed: NSObject, UICollectionViewDataSource, UICollectionViewDataSourcePrefetching {
    let library: AttachLibrary
    private weak var grid: UICollectionView?
    /// The picked number of a picture, from 1.
    var number: (String) -> Int? = { _ in nil }
    /// The circle tapped, and the picture.
    var onCheck: ((Int) -> Void)?
    var onOpen: ((Int) -> Void)?
    /// A change landed in the grid.
    var onApplied: ((AttachLibraryChange) -> Void)?
    /// The picture the preview shows, hidden in its cell meanwhile.
    var hidden: String? {
        didSet {
            guard hidden != oldValue, let grid else { return }
            for case let cell as AttachGridCell in grid.visibleCells { cell.hidesPicture = cell.itemID != nil && cell.itemID == hidden }
        }
    }
    /// What the grid shows, as the library last committed it.
    private(set) var count = 0
    private(set) var loaded = false
    private var link: CADisplayLink?
    /// How many batches landed, for tests.
    private(set) var batches = 0
    /// The caching window's middle when it last moved, and which way the grid went.
    private var preheatedAt: CGFloat?
    private var lastMinY: CGFloat = 0

    init(library: AttachLibrary, grid: UICollectionView) {
        self.library = library
        self.grid = grid
        super.init()
        grid.register(AttachGridCell.self, forCellWithReuseIdentifier: AttachGridCell.id)
        grid.dataSource = self
        grid.prefetchDataSource = self
        grid.isPrefetchingEnabled = true
    }

    /// Telegram's thumbnail: 128 points square, at no more than 2×.
    var pixels: CGSize {
        let scale = min(2, grid?.layoutScale ?? 2)
        return CGSize(width: 128 * scale, height: 128 * scale)
    }

    /// The library's first fetch: the grid's one reload.
    func load() {
        _ = library.commit()
        count = library.count
        loaded = true
        preheatedAt = nil
        grid?.reloadData()
        scrolled()
    }

    /// Something changed in the library: it lands on the next frame, once,
    /// however many changes come before it.
    func changed() {
        guard loaded, link == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick() {
        link?.invalidate()
        link = nil
        apply()
    }

    /// Lands what the library has waiting, now.
    func apply() {
        guard let grid, loaded else { return }
        var change = AttachLibraryChange.none
        let signpost = AttachMenuSignpost.begin("grid-apply")
        let layout = grid.collectionViewLayout as? AttachGridCollectionLayout
        // Scrolled, what shows stays where it is (Telegram's stationary
        // item); at the top, the new pictures come in above.
        let scrolledAway = grid.contentOffset.y > -grid.adjustedContentInset.top + 1
        let first = scrolledAway ? grid.indexPathsForVisibleItems.map(\.item).min() : nil
        UIView.performWithoutAnimation {
            grid.performBatchUpdates {
                change = library.commit()
                count = library.count
                if let first, let frame = layout?.grid?.frame(at: first), let moved = Self.follow(first, through: change, count: count) {
                    layout?.anchor = (moved, frame.minY - grid.contentOffset.y)
                }
                switch change {
                case .none:
                    break
                case let .reload(from, to):
                    if to > from {
                        grid.insertItems(at: (from..<to).map { IndexPath(item: $0, section: 0) })
                    } else if to < from {
                        grid.deleteItems(at: (to..<from).map { IndexPath(item: $0, section: 0) })
                    }
                case let .update(removed, inserted, _, moves):
                    grid.deleteItems(at: removed.map { IndexPath(item: $0, section: 0) })
                    grid.insertItems(at: inserted.map { IndexPath(item: $0, section: 0) })
                    for move in moves {
                        grid.moveItem(at: IndexPath(item: move.from, section: 0), to: IndexPath(item: move.to, section: 0))
                    }
                }
            }
        }
        layout?.anchor = nil
        AttachMenuSignpost.end("grid-apply", signpost)
        batches += 1
        // What changed in place, or everything showing after a wholesale
        // change, takes its new picture in the cell it has.
        var again: [IndexPath]
        switch change {
        case .none: again = []
        case .reload: again = grid.indexPathsForVisibleItems
        case let .update(_, _, changed, _): again = changed.map { IndexPath(item: $0, section: 0) }
        }
        again = again.filter { $0.item < count }
        if !again.isEmpty { grid.reconfigureItems(at: again) }
        if case .none = change {} else {
            preheatedAt = nil
            scrolled()
        }
        onApplied?(change)
    }

    /// Where picture `index` is after `change`: past the removed (old
    /// indexes) and the inserted (new ones), as PhotoKit counts them.
    static func follow(_ index: Int, through change: AttachLibraryChange, count: Int) -> Int? {
        guard case let .update(removed, inserted, _, _) = change else { return nil }
        if removed.contains(index) { return nil }
        var moved = index - removed.filter { $0 < index }.count
        for slot in inserted.sorted() where slot <= moved { moved += 1 }
        return moved < count ? moved : nil
    }

    // MARK: Data source

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { count }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let signpost = AttachMenuSignpost.begin("grid-cell")
        defer { AttachMenuSignpost.end("grid-cell", signpost) }
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: AttachGridCell.id, for: indexPath) as! AttachGridCell
        guard let item = library.item(at: indexPath.item) else { return cell }
        let wasShowing = cell.itemID == item.id
        cell.show(item, index: indexPath.item, library: library, pixels: pixels)
        cell.setNumber(number(item.id), animated: false)
        cell.hidesPicture = item.id == hidden
        if !wasShowing {
            cell.onCheck = { [weak self] index in self?.onCheck?(index) }
            cell.onOpen = { [weak self] index in self?.onOpen?(index) }
        }
        return cell
    }

    /// The caching window runs ahead of the scroll: what UIKit is about to
    /// ask for is already in it.
    func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
        scrolled()
    }

    // MARK: Caching

    /// Moves the caching window once the grid has gone a third of a screen
    /// since it last moved: half a screen behind, a screen and a half ahead.
    func scrolled() {
        guard let grid, loaded, count > 0, let layout = (grid.collectionViewLayout as? AttachGridCollectionLayout)?.grid else { return }
        let bounds = grid.bounds
        let height = max(1, bounds.height)
        let down = bounds.minY >= lastMinY
        lastMinY = bounds.minY
        if let at = preheatedAt, abs(bounds.midY - at) < height / 3 { return }
        preheatedAt = bounds.midY
        let window = down
            ? (bounds.minY - height / 2, bounds.maxY + 1.5 * height)
            : (bounds.minY - 1.5 * height, bounds.maxY + height / 2)
        let range = layout.visible(minY: window.0, maxY: window.1).clamped(to: 0..<count)
        library.prepare(range, pixels: pixels)
    }

    /// The picture under `point`, in the grid's content space.
    func index(at point: CGPoint) -> Int? {
        grid?.indexPathForItem(at: point)?.item
    }

    /// The numbers on the cells showing, after a pick: the one picked or
    /// unpicked animates, the rest close up.
    /// Picture `id` shows anew where its cell is: its edit came or went.
    func redraw(_ id: String) {
        guard let grid else { return }
        for case let cell as AttachGridCell in grid.visibleCells where cell.itemID == id {
            guard let path = grid.indexPath(for: cell), let item = library.item(at: path.item) else { continue }
            cell.show(item, index: path.item, library: library, pixels: pixels, again: true)
        }
    }

    func refreshNumbers(animating id: String?) {
        guard let grid else { return }
        for case let cell as AttachGridCell in grid.visibleCells {
            guard let cellID = cell.itemID else { continue }
            cell.setNumber(number(cellID), animated: cellID == id)
        }
    }
}

/// Signpost intervals over the grid's main-thread work, for Instruments
/// (subsystem `engineering.happy`, category `AttachMenu`) and the scroll
/// budget test, which reads the longest.
@MainActor
enum AttachMenuSignpost {
    private static let signposter = OSSignposter(subsystem: "engineering.happy", category: "AttachMenu")

    struct Interval {
        let state: OSSignpostIntervalState
        let start: CFTimeInterval
    }

    static func begin(_ name: StaticString) -> Interval {
        Interval(state: signposter.beginInterval(name), start: CACurrentMediaTime())
    }

    static func end(_ name: StaticString, _ interval: Interval) {
        signposter.endInterval(name, interval.state)
        let took = CACurrentMediaTime() - interval.start
        longest = max(longest, took)
        longestByName["\(name)", default: 0] = max(longestByName["\(name)", default: 0], took)
    }

    /// The longest interval since it was last reset.
    static var longest: CFTimeInterval = 0
    static var longestByName: [String: CFTimeInterval] = [:]
}

/// The grid's frames, straight from `AttachMenuGridLayout`.
final class AttachGridCollectionLayout: UICollectionViewLayout {
    var grid: AttachMenuGridLayout? {
        didSet { if grid != oldValue { invalidateLayout() } }
    }
    /// After a batch, the picture that was at the grid's top, by its new
    /// index, and where its frame began against the top: the offset
    /// follows it, so pictures arriving above the scroll don't move what shows.
    var anchor: (index: Int, offset: CGFloat)?

    // A batch changes the count before the sheet lays the grid out again.
    override func prepare() {
        super.prepare()
        guard let current = grid, let count = collectionView?.numberOfItems(inSection: 0), count != current.count else { return }
        grid = current.with(count: count)
    }

    override func targetContentOffset(forProposedContentOffset proposed: CGPoint) -> CGPoint {
        guard let anchor, let grid else { return proposed }
        self.anchor = nil
        return CGPoint(x: proposed.x, y: grid.frame(at: anchor.index).minY - anchor.offset)
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: collectionView?.bounds.width ?? 0, height: grid?.contentHeight ?? 0)
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        guard let grid, let count = collectionView?.numberOfItems(inSection: 0) else { return nil }
        return grid.visible(minY: rect.minY, maxY: rect.maxY).filter { $0 < count }.map { attributes(grid, $0) }
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard let grid else { return nil }
        return attributes(grid, indexPath.item)
    }

    private func attributes(_ grid: AttachMenuGridLayout, _ index: Int) -> UICollectionViewLayoutAttributes {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
        attributes.frame = grid.frame(at: index)
        return attributes
    }

    // Inserts and deletes land in place: Telegram's grid doesn't fade them.
    override func initialLayoutAttributesForAppearingItem(at itemIndexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        layoutAttributesForItem(at: itemIndexPath)
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool { false }
}

/// One picture of the grid, Telegram's `MediaPickerGridItemNode`: the
/// thumbnail filling the square on the placeholder colour; for a video a
/// camera glyph at the top left and its length 6 in from the bottom right,
/// each on a soft corner shadow; the number circle 3 in from the top right.
/// The circle picks, and so does the 44 point corner around it; the rest
/// of the picture opens the preview.
final class AttachGridCell: UICollectionViewCell, UIGestureRecognizerDelegate, AttachPreviewSource {
    static let id = "attach-cell"
    private let picture = UIImageView()
    private let leftShadow = UIImageView(image: AttachGridCell.leftShadowImage)
    private let rightShadow = UIImageView(image: AttachGridCell.rightShadowImage)
    private let typeIcon = UIImageView(image: AttachGridCell.videoGlyph)
    private let duration = UILabel()
    let check = AttachCheckView()
    private weak var library: AttachLibrary?
    private var request: Int?
    private(set) var itemID: String?
    private(set) var index = 0
    private var length: String?
    var onCheck: ((Int) -> Void)?
    var onOpen: ((Int) -> Void)?
    var number: Int? { check.number }
    /// The preview has this picture: Telegram hides it in the grid.
    var hidesPicture = false { didSet { picture.isHidden = hidesPicture } }
    var previewImage: UIImage? { picture.image }

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = UIColor(Palette.attachMenuCellPlaceholder)
        contentView.clipsToBounds = true
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.accessibilityIgnoresInvertColors = true
        contentView.addSubview(picture)
        for view in [leftShadow, rightShadow, typeIcon] {
            view.isHidden = true
            contentView.addSubview(view)
        }
        typeIcon.contentMode = .center
        typeIcon.tintColor = .white
        duration.isHidden = true
        contentView.addSubview(duration)
        check.addAction(UIAction { [weak self] _ in
            guard let self, check.press() else { return }
            onCheck?(index)
        }, for: .touchUpInside)
        contentView.addSubview(check)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.delegate = self
        contentView.addGestureRecognizer(tap)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityCustomActions = [UIAccessibilityCustomAction(name: Strings.AttachMenu.preview) { [weak self] _ in
            guard let self else { return false }
            onOpen?(index)
            return true
        }]
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    @objc private func tapped() { onOpen?(index) }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        !(touch.view?.isDescendant(of: check) ?? false)
    }

    // VoiceOver's activate picks, as the circle does; the preview is a custom action.
    override func accessibilityActivate() -> Bool {
        onCheck?(index)
        return true
    }

    /// `again`: the same picture changed (edited), drawn anew in place.
    func show(_ item: AttachLibraryItem, index: Int, library: AttachLibrary, pixels: CGSize, again: Bool = false) {
        self.index = index
        accessibilityIdentifier = "attach-photo:\(index)"
        guard item.id != itemID || picture.image == nil || again else { return }
        let keep = again && item.id == itemID
        if let request { self.library?.cancelThumbnail(request) }
        request = nil
        self.library = library
        itemID = item.id
        length = item.duration.map { LibraryPickerLayout.duration(seconds: $0) }
        let video = length != nil
        if let length {
            duration.attributedText = NSAttributedString(string: length, attributes: Self.durationAttributes)
        }
        duration.isHidden = !video
        typeIcon.isHidden = !video
        leftShadow.isHidden = !video
        rightShadow.isHidden = !video
        if !keep { picture.image = nil }
        let id = item.id
        request = library.thumbnail(at: index, pixels: pixels) { [weak self] image in
            guard let self, itemID == id else { return }
            picture.image = image
        }
        setNeedsLayout()
    }

    func setNumber(_ number: Int?, animated: Bool) {
        check.set(number, animated: animated)
        accessibilityLabel = length.map { Strings.Library.video($0, index: number) } ?? Strings.Library.photo(number)
        accessibilityValue = number.map(String.init)
        if number != nil { accessibilityTraits.insert(.selected) } else { accessibilityTraits.remove(.selected) }
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        if let request { library?.cancelThumbnail(request) }
        request = nil
        itemID = nil
        picture.image = nil
        hidesPicture = false
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let bounds = contentView.bounds
        picture.frame = bounds
        let shadow = Self.shadowSize
        leftShadow.frame = CGRect(x: 0, y: 0, width: min(shadow, bounds.width), height: shadow)
        rightShadow.frame = CGRect(x: bounds.width - min(shadow, bounds.width), y: bounds.height - shadow, width: min(shadow, bounds.width), height: shadow)
        typeIcon.frame = CGRect(x: 0, y: 1, width: 19, height: 19)
        let size = duration.intrinsicContentSize
        duration.frame = CGRect(x: bounds.width - ceil(size.width) - 6, y: bounds.height - ceil(size.height) - 6, width: ceil(size.width), height: ceil(size.height))
        check.frame = CGRect(x: bounds.width - AttachCheckView.side - AttachCheckView.inset, y: AttachCheckView.inset, width: AttachCheckView.side, height: AttachCheckView.side)
    }

    /// Semibold 11, white, on a 4 point black shadow at 40%.
    private static let durationAttributes: [NSAttributedString.Key: Any] = {
        let shadow = NSShadow()
        shadow.shadowColor = UIColor(white: 0, alpha: 0.4)
        shadow.shadowBlurRadius = 4
        shadow.shadowOffset = .zero
        return [.font: UIFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: UIColor.white, .shadow: shadow]
    }()

    /// Telegram's `MediaGridShadow`: a soft dark oval in a 120 point
    /// corner, at most 16% black; the top-left one turned round.
    private static let shadowSize: CGFloat = 120
    private static let leftShadowImage = shadow(flipped: true)
    private static let rightShadowImage = shadow(flipped: false)
    private static func shadow(flipped: Bool) -> UIImage {
        let side = shadowSize
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { context in
            let cg = context.cgContext
            if flipped {
                cg.translateBy(x: side, y: side)
                cg.scaleBy(x: -1, y: -1)
            }
            let colors = [UIColor(white: 0, alpha: 0.16).cgColor, UIColor(white: 0, alpha: 0).cgColor] as CFArray
            guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) else { return }
            cg.saveGState()
            // An oval wider than tall, its middle near the corner.
            cg.translateBy(x: side * 0.86, y: side * 0.95)
            cg.scaleBy(x: 1, y: 0.42)
            cg.drawRadialGradient(gradient, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: side * 0.62, options: [])
            cg.restoreGState()
        }
    }

    /// Telegram's `MediaVideo` glyph: a small filled video camera.
    private static let videoGlyph: UIImage? = UIImage(systemName: "video.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .semibold))?.withRenderingMode(.alwaysTemplate)
}

/// Telegram's `CheckNode` in its overlay style, with `InteractiveCheckNode`'s
/// press: a white ring with a soft shadow over the picture; picked, the
/// accent fills it from the middle out (0.21 s, ease out, the fill a third
/// faster than the number) and the circle dips to 0.9, swells to 1.1 and
/// settles; unpicked, the fill and number shrink and fade (0.15 s, ease
/// in) under the ring as it dips and settles. A press shrinks it to 0.85.
final class AttachCheckView: UIControl {
    static let side: CGFloat = 29
    /// From the cell's top and right edges.
    static let inset: CGFloat = 3
    /// The corner of the cell it takes touches in. Telegram's circle takes
    /// only its own 29 (`MediaPickerGridItemNode`, Telegram-Android's 42
    /// `checkFrame`); 44, the system's smallest target, is kinder to a thumb.
    static let reach: CGFloat = 44
    private(set) var number: Int?
    /// 0 empty, 1 picked.
    private var progress: CGFloat = 0
    /// Drawing the way out: the fill full, the whole scaled by progress.
    private var animatingOut = false
    private var shown: Int?
    private var animation: (from: CGFloat, to: CGFloat, start: CFTimeInterval, duration: CFTimeInterval, curve: (CGFloat, CGFloat, CGFloat, CGFloat))?
    private var link: CADisplayLink?
    private var lastPress: CFTimeInterval = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        accessibilityIdentifier = "attach-check"
        isAccessibilityElement = false
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func set(_ number: Int?, animated: Bool) {
        let was = self.number
        self.number = number
        if let number { shown = number }
        let picked = number != nil
        guard (was != nil) != picked else {
            if was != number { setNeedsDisplay() }
            return
        }
        guard animated, window != nil else {
            stopAnimation()
            animatingOut = false
            progress = picked ? 1 : 0
            setNeedsDisplay()
            return
        }
        animatingOut = !picked
        animation = (progress, picked ? 1 : 0, CACurrentMediaTime(), picked ? 0.21 : 0.15, picked ? (0, 0, 0.58, 1) : (0.42, 0, 1, 1))
        if link == nil {
            let link = CADisplayLink(target: self, selector: #selector(step))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
        bounce(picked)
    }

    /// 1 → 0.9 → 1.1 → 1 picked, 1 → 0.9 → 1 unpicked.
    private func bounce(_ picked: Bool) {
        let scale = CAKeyframeAnimation(keyPath: "transform.scale")
        let easeOut = CAMediaTimingFunction(name: .easeOut)
        if picked {
            scale.values = [1.0, 0.9, 1.1, 1.0]
            scale.keyTimes = [0, 0.08 / 0.31, 0.21 / 0.31, 1] as [NSNumber]
            scale.timingFunctions = [easeOut, easeOut, CAMediaTimingFunction(name: .easeIn)]
            scale.duration = 0.31
        } else {
            scale.values = [1.0, 0.9, 1.0]
            scale.keyTimes = [0, 0.08 / 0.21, 1] as [NSNumber]
            scale.timingFunctions = [easeOut, easeOut]
            scale.duration = 0.21
        }
        layer.add(scale, forKey: "bounce")
    }

    @objc private func step() {
        guard let animation else { return stopAnimation() }
        let t = min(1, (CACurrentMediaTime() - animation.start) / animation.duration)
        progress = animation.from + (animation.to - animation.from) * Self.bezier(CGFloat(t), animation.curve)
        setNeedsDisplay()
        if t >= 1 {
            animatingOut = false
            stopAnimation()
        }
    }

    private func stopAnimation() {
        link?.invalidate()
        link = nil
        animation = nil
    }

    override func removeFromSuperview() {
        stopAnimation()
        super.removeFromSuperview()
    }

    // Telegram's press: down to 0.85 in 0.15 s, back in 0.25; and a second
    // tap within half a second does nothing.
    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != oldValue else { return }
            let from = (layer.presentation()?.value(forKeyPath: "transform.scale") as? CGFloat) ?? 1
            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = from
            scale.toValue = isHighlighted ? 0.85 : 1
            scale.duration = isHighlighted ? 0.15 : 0.25
            scale.fillMode = .forwards
            scale.isRemovedOnCompletion = false
            layer.add(scale, forKey: "press")
        }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let outset = Self.reach - Self.side - Self.inset
        return bounds.inset(by: UIEdgeInsets(top: -Self.inset, left: -outset, bottom: -outset, right: -Self.inset)).contains(point)
    }

    /// Whether a press counts: not within half a second of the last.
    func press() -> Bool {
        let now = CACurrentMediaTime()
        guard now - lastPress >= 0.5 else { return false }
        lastPress = now
        return true
    }

    override func draw(_ rect: CGRect) {
        guard let cg = UIGraphicsGetCurrentContext() else { return }
        let size = bounds.size
        let pixel = 1 / max(1, layoutScale)
        let borderWidth: CGFloat = 1.5
        let inset = 2 - pixel
        let fill = animatingOut ? 1 : min(1, progress * 1.35)
        // The ring, always whole, with its shadow.
        let borderInset = borderWidth / 2 + inset
        let ring = CGRect(origin: .zero, size: size).insetBy(dx: borderInset, dy: borderInset)
        cg.saveGState()
        cg.setShadow(offset: .zero, blur: 2.5, color: UIColor(Palette.attachMenuCheckShadow).cgColor)
        cg.setStrokeColor(UIColor(Palette.attachMenuCheckRing).cgColor)
        cg.setLineWidth(borderWidth)
        cg.strokeEllipse(in: ring)
        cg.restoreGState()
        if animatingOut {
            cg.translateBy(x: size.width / 2, y: size.height / 2)
            cg.scaleBy(x: progress, y: progress)
            cg.translateBy(x: -size.width / 2, y: -size.height / 2)
            cg.setAlpha(progress)
        }
        // The fill grows from the middle, inside the ring.
        let fillInset = borderWidth + inset
        let frame = CGRect(origin: .zero, size: size).insetBy(dx: fillInset, dy: fillInset)
        let disc = frame.insetBy(dx: frame.width / 2 * (1 - fill), dy: frame.height / 2 * (1 - fill))
        if disc.width > 0 {
            cg.setFillColor(UIColor(Palette.attachMenuAccent).cgColor)
            cg.fillEllipse(in: disc)
        }
        guard let shown, progress > 0 else { return }
        let string = "\(shown)"
        let fontSize: CGFloat = string.count == 1 ? 16 : string.count == 2 ? 15 : 13
        let font = UIFont.systemFont(ofSize: fontSize, weight: .medium).rounded
        let text = NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: UIColor(Palette.attachMenuOnAccent).withAlphaComponent(progress)])
        let box = text.boundingRect(with: CGSize(width: 100, height: 100), options: [.usesLineFragmentOrigin], context: nil)
        let x = box.minX + floor((size.width - box.width) / 2 / pixel) * pixel
        let y = box.minY + floor((size.height - box.height) / 2 / pixel) * pixel
        text.draw(at: CGPoint(x: x, y: y))
    }

    /// A CSS cubic Bézier's y for x = t.
    static func bezier(_ t: CGFloat, _ c: (CGFloat, CGFloat, CGFloat, CGFloat)) -> CGFloat {
        func coordinate(_ s: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat {
            let u = 1 - s
            return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s
        }
        var low: CGFloat = 0, high: CGFloat = 1, s = t
        for _ in 0..<24 {
            s = (low + high) / 2
            if coordinate(s, c.0, c.2) < t { low = s } else { high = s }
        }
        return coordinate(s, c.1, c.3)
    }
}

private extension UIFont {
    /// The same font in SF Pro Rounded, as Telegram's `.round` design.
    var rounded: UIFont {
        guard let descriptor = fontDescriptor.withDesign(.rounded) else { return self }
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
#endif

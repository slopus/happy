#if canImport(UIKit)
import HappyLayout
import UIKit

// A reply streaming in, shown as Telegram shows a bot's streaming reply
// (`ChatMessageTextBubbleContentNode.updateTextRevealAnimation` and
// `InteractiveTextComponent.updateRevealMask`): the row's words come out a
// character at a time behind the newest one (`TextReveal`), each fading in,
// rising and growing into place; the row grows a line at a time as the
// reveal moves onto it, on the list's own height animation, so the rows
// above slide up by exactly that. The row's drawing is the plan's as ever:
// a mask shows what has come out, and short-lived copies of the drawn
// glyphs (the same bitmap, cut to one character) move in over it.
//
// Adapted from Telegram-iOS
// `submodules/TelegramUI/Components/Chat/ChatMessageTextBubbleContentNode/Sources/ChatMessageTextBubbleContentNode.swift`
// and `submodules/TelegramUI/Components/InteractiveTextComponent/Sources/InteractiveTextComponent.swift`
// (permission from Steve).

/// Where a plan's words are, for `RevealMap`. Text lines as drawn; a code
/// block, a table, a picture as one block each, with the box drawn behind it.
enum ChatRevealMapping {
    static func map(_ plan: ChatRowPlan) -> RevealMap {
        var lines: [RevealMap.Line] = []
        var boxes: [CGRect] = []
        for item in plan.items {
            switch item {
            case .text(let layout, let frame):
                lines += layout.revealLines(at: frame.origin)
            case .box(let box):
                boxes.append(box.frame)
            case .icon, .image:
                continue
            case .scroller(let content, let frame, _, _):
                lines.append(RevealMap.Line(block: card(frame, boxes), length: textLength(content)))
            default:
                lines.append(RevealMap.Line(block: card(item.markFrame, boxes), length: 1))
            }
        }
        return RevealMap(lines: lines, size: plan.size)
    }

    /// What `new` is next to `old`, the row's plan in the update before:
    /// it grew if it says all `old` said and more (words that streamed on,
    /// not words that changed).
    static func change(from old: ChatRowPlan?, to new: ChatRowPlan) -> RevealFocus.Change {
        guard let old else { return .new }
        guard old !== new, old.revealable, new.revealable,
              let before = old.accessibilityLabel, let after = new.accessibilityLabel else { return .same }
        let added = after.utf16.count - before.utf16.count
        return added > 0 && after.hasPrefix(before) ? .grew(by: added) : .same
    }

    /// A block with the boxes it sits on (a code block's card).
    private static func card(_ frame: CGRect, _ boxes: [CGRect]) -> CGRect {
        boxes.reduce(frame) { card, box in box.contains(CGPoint(x: frame.midX, y: frame.midY)) ? card.union(box) : card }
    }

    private static func textLength(_ plan: ChatRowPlan) -> Int {
        plan.items.reduce(0) { total, item in
            switch item {
            case .text(let layout, _): total + layout.string.length
            case .scroller(let content, _, _, _): total + textLength(content)
            default: total
            }
        }
    }
}

/// A transcript whose rows reveal: it finds a row's view and lays the list
/// out again when a row's height moves.
@MainActor
protocol ChatRevealHost: AnyObject {
    /// The presenter of `identity`'s view, if it has one on the list.
    func revealPresenter(_ identity: String) -> ChatRevealPresenter?
    /// A revealing row moved onto a new line: its height is `height(_:)`.
    func revealHeightsChanged()
}

/// The rows of one transcript that are revealing, and the display link
/// that moves them. Only the main thread's few steps a frame are here:
/// the count, the mask's rectangles, and new glyph copies. Which row
/// reveals is `RevealFocus`'s.
@MainActor
final class ChatRevealDriver: NSObject {
    weak var host: ChatRevealHost?
    private var focus = RevealFocus()
    private struct Entry {
        var reveal: TextReveal
        var map: RevealMap
        var shown: Int
        var height: CGFloat
        var completing = false
        /// When it last had something to do, for finishing one that waits.
        var activeAt: Double
    }
    private var entries: [String: Entry] = [:]
    private var link: CADisplayLink?
    /// A reveal that showed everything and heard of nothing more this long
    /// takes its words as whole: Telegram's draft ending.
    static let quiet = 1.0

    /// Reduce Motion and Low Power Mode show replies as they come.
    static var enabled: Bool { !UIAccessibility.isReduceMotionEnabled && !ProcessInfo.processInfo.isLowPowerModeEnabled && !off }
    /// Replies show as they come, as before the reveal: for comparing.
    static var off = ProcessInfo.processInfo.environment["HAPPY_REVEAL_OFF"] != nil
    #if DEBUG || HAPPY_FIXTURES
    /// The main thread's time in each of the reveal's frames, in seconds.
    static var ticks: [Double] = []
    /// Of those, the list's passes for rows growing a line.
    static var passes: [Double] = []
    /// Every row that started coming out, in order.
    static var starts: [String] = []
    #endif

    override init() {
        super.init()
        // In the background nothing is seen: replies show whole, and what
        // arrives on the way back (the catch-up) does too.
        NotificationCenter.default.addObserver(self, selector: #selector(wentAway), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(cameBack), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    func isRevealing(_ identity: String) -> Bool { entries[identity] != nil }

    /// The row coming out at the stream's pace.
    var target: String? { focus.target }

    /// The rows still coming out, the target and any finishing.
    var revealing: Set<String> { Set(entries.keys) }

    /// The row's height while it reveals; nil once it shows whole.
    func height(_ identity: String) -> CGFloat? { entries[identity]?.height }

    /// What a row's view shows of it now.
    func state(_ identity: String) -> (map: RevealMap, count: Int)? {
        entries[identity].map { ($0.map, $0.shown) }
    }

    /// How far the pace has come for a row: ahead of what shows while a
    /// glyph's drawing is on its way.
    func paced(_ identity: String) -> Int? { entries[identity]?.reveal.count }

    /// What each row's reveal does with this update (`RevealFocus`), the
    /// transcript's rows oldest first. `onScreen`: it is in a window.
    func focus(_ rows: [RevealFocus.Row], streaming: Bool, onScreen: Bool) -> [String: RevealFocus.Step] {
        focus.update(rows, streaming: streaming, onScreen: onScreen, revealing: Set(entries.keys))
    }

    /// Carries out `focus`'s steps. `plan` is a row's plan now, `previous`
    /// the one it had before this update. Returns the rows that started.
    func perform(_ steps: [String: RevealFocus.Step], plan: (String) -> ChatRowPlan?, previous: (String) -> ChatRowPlan?) -> [String] {
        var started: [String] = []
        for (identity, step) in steps {
            guard let plan = plan(identity) else { continue }
            let old = previous(identity)
            switch step {
            case .start:
                guard Self.enabled, let map = plan.revealMap else { continue }
                // From the words it showed whole until now.
                start(identity, map: map, from: min(old?.revealMap?.length ?? 0, map.length), finishing: false)
                started.append(identity)
            case .grow:
                if old !== plan, let map = plan.revealMap { update(identity, map: map, finishing: false) }
            case .finish:
                if old === plan {
                    finish(identity)
                } else if let map = plan.preparedRevealMap {
                    update(identity, map: map, finishing: true)
                } else {
                    // Planned again as it stopped being the newest, and not
                    // mapped off the main thread: it shows whole.
                    stop(identity)
                }
            case .stop:
                stop(identity)
            }
        }
        return started
    }

    /// No longer the newest: what is left of `identity` comes out in
    /// `TextReveal.finishTime`.
    func finish(_ identity: String) {
        guard var entry = entries[identity], !entry.reveal.isFinishing else { return }
        entry.reveal.finish(length: entry.map.length)
        entries[identity] = entry
        run()
    }

    /// `identity` shows whole at once. Its height is the plan's again by
    /// the transcript's next pass.
    func stop(_ identity: String) {
        guard entries.removeValue(forKey: identity) != nil else { return }
        host?.revealPresenter(identity)?.clear()
        if entries.isEmpty { link?.isPaused = true }
    }

    @objc private func wentAway() {
        focus.wentAway()
        guard !entries.isEmpty else { return }
        for identity in Array(entries.keys) { host?.revealPresenter(identity)?.clear() }
        entries.removeAll()
        link?.isPaused = true
        host?.revealHeightsChanged()
    }

    @objc private func cameBack() { focus.cameBack() }

    /// Starts showing `identity` from `count` characters. `finishing`: its
    /// words are whole already, and come out in `TextReveal.finishTime`.
    func start(_ identity: String, map: RevealMap, from count: Int, finishing: Bool) {
        let now = CACurrentMediaTime()
        var reveal = TextReveal(revealed: count, length: map.length)
        if finishing { reveal.finish(length: map.length) } else { reveal.observe(length: map.length, at: now) }
        let shown = min(count, map.length)
        entries[identity] = Entry(reveal: reveal, map: map, shown: shown, height: map.height(showing: shown), activeAt: now)
        #if DEBUG || HAPPY_FIXTURES
        Self.starts.append(identity)
        #endif
        run()
    }

    /// `identity`'s words as they stand now.
    func update(_ identity: String, map: RevealMap, finishing: Bool) {
        guard var entry = entries[identity] else { return }
        let now = CACurrentMediaTime()
        if !finishing, entry.reveal.isFinishing, map.length > entry.map.length {
            // More came after all: a new reveal from what shows.
            entry.reveal = TextReveal(revealed: entry.shown, length: entry.map.length)
            entry.completing = false
        }
        if finishing { entry.reveal.finish(length: map.length) } else { entry.reveal.observe(length: map.length, at: now) }
        entry.map = map
        entry.shown = min(entry.shown, map.length)
        // Words still arriving may lay out shorter for a moment (a table's
        // first line is a paragraph until its rule comes): the row keeps
        // its room until it shows whole.
        entry.height = max(entry.height, map.height(showing: entry.shown))
        entry.activeAt = now
        entries[identity] = entry
        run()
    }

    /// Rows that left the list stop.
    func keep(_ present: (String) -> Bool) {
        for identity in Array(entries.keys) where !present(identity) {
            entries.removeValue(forKey: identity)
            host?.revealPresenter(identity)?.clear()
        }
        if entries.isEmpty { link?.isPaused = true }
    }

    func stopAll() {
        for identity in Array(entries.keys) { host?.revealPresenter(identity)?.clear() }
        entries.removeAll()
        link?.invalidate()
        link = nil
    }

    private func run() {
        if link == nil {
            let link = CADisplayLink(target: ChatRevealTarget(self), selector: #selector(ChatRevealTarget.tick))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            link.add(to: .main, forMode: .common)
            self.link = link
        }
        link?.isPaused = false
    }

    fileprivate func tick() {
        let now = CACurrentMediaTime()
        #if DEBUG || HAPPY_FIXTURES
        defer {
            let spent = CACurrentMediaTime() - now
            Self.ticks.append(spent)
        }
        #endif
        var moved = false
        var busy = false
        for identity in Array(entries.keys) {
            guard var entry = entries[identity] else { continue }
            let (target, complete) = entry.reveal.tick(at: now)
            let presenter = host?.revealPresenter(identity)
            let shown = presenter?.advance(entry.map, to: target, at: now) ?? target
            if shown != entry.shown { entry.activeAt = now }
            entry.shown = shown
            let height = max(entry.height, entry.map.height(showing: shown))
            if height != entry.height {
                entry.height = height
                moved = true
            }
            if complete, shown >= entry.map.length {
                if !entry.completing {
                    entry.completing = true
                    presenter?.complete(at: now)
                }
                if presenter?.isAnimating != true {
                    presenter?.clear()
                    entries.removeValue(forKey: identity)
                    // Kept taller than its words came to: it settles.
                    if entry.height != entry.map.size.height { moved = true }
                    continue
                }
                busy = true
            } else if shown < entry.map.length || presenter?.isAnimating == true || entry.reveal.isFinishing {
                busy = true
            } else if now - entry.activeAt >= Self.quiet {
                entry.reveal.finish(length: entry.map.length)
                busy = true
            } else {
                // Everything shows and more may come: nothing to do each
                // frame until it does, or until it has been quiet long enough.
                checkQuiet(after: Self.quiet - (now - entry.activeAt))
            }
            entries[identity] = entry
        }
        if moved {
            #if DEBUG || HAPPY_FIXTURES
            let began = CACurrentMediaTime()
            defer { Self.passes.append(CACurrentMediaTime() - began) }
            #endif
            host?.revealHeightsChanged()
        }
        if !busy { link?.isPaused = true }
    }

    private var quietCheck = false

    private func checkQuiet(after delay: Double) {
        guard !quietCheck else { return }
        quietCheck = true
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.05, delay)) { [weak self] in
            guard let self else { return }
            quietCheck = false
            if !entries.isEmpty { run() }
        }
    }
}

/// CADisplayLink holds its target strongly.
@MainActor
private final class ChatRevealTarget: NSObject {
    weak var driver: ChatRevealDriver?
    init(_ driver: ChatRevealDriver) { self.driver = driver }
    @objc func tick() {
        guard let driver else { return }
        driver.tick()
    }
}

/// One row view's reveal: the mask over its drawing and the glyphs moving
/// in over it. The mask leaves out each glyph still moving, so its copy is
/// all that shows of it; when the copy lands, the mask takes it in, in the
/// same transaction, and the drawing underneath is the same pixels.
@MainActor
final class ChatRevealPresenter {
    private weak var content: UIView?
    /// Glyph copies, over the drawing, in its coordinates.
    let overlay = CALayer()
    private let mask = CALayer()
    private var rects: [CALayer] = []
    private struct Moving {
        var index: Int
        var layer: CALayer
        var until: Double
    }
    private var moving: [Moving] = []
    private struct Fading {
        /// The static mask covers it once this many characters show.
        var end: Int
        var layer: CALayer
        var until: Double
    }
    private var fading: [Fading] = []
    private var finale: Fading?
    private(set) var map: RevealMap?
    private(set) var shown = 0
    private var heldSince: Double?
    /// Waiting for the drawing of a glyph coming out longer than this, it
    /// comes out fading instead.
    private static let longestHold = 0.1

    var isActive: Bool { map != nil }
    var isAnimating: Bool { !moving.isEmpty || !fading.isEmpty || finale != nil }

    /// `content` is the view drawing the row; `host` the view holding it.
    func attach(content: UIView, host: UIView) {
        self.content = content
        overlay.zPosition = 1
        mask.anchorPoint = .zero
        host.layer.addSublayer(overlay)
    }

    /// The overlay lies over the drawing.
    func layout(_ frame: CGRect) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        overlay.frame = frame
        mask.frame = CGRect(origin: .zero, size: frame.size)
        CATransaction.commit()
    }

    /// Shows `count` characters of `map` at once: a view taking a row that
    /// is revealing, or a new plan for it.
    func show(_ map: RevealMap, count: Int) {
        self.map = map
        shown = min(count, map.length)
        for glyph in moving where glyph.index >= shown { glyph.layer.removeFromSuperlayer() }
        moving.removeAll { $0.index >= shown }
        install()
        updateMask()
    }

    /// Moves on to `target` characters, the new ones coming out. Returns
    /// how many show, fewer while a glyph's drawing is on its way.
    func advance(_ map: RevealMap, to target: Int, at now: Double) -> Int {
        // Another plan's map (compared cheaply: this runs every frame).
        if self.map?.length != map.length || self.map?.size != map.size || self.map?.lines.count != map.lines.count {
            self.map = map
            install()
        }
        expire(now)
        let target = min(target, map.length)
        if target < shown {
            shown = target
            for glyph in moving where glyph.index >= shown { glyph.layer.removeFromSuperlayer() }
            moving.removeAll { $0.index >= shown }
        } else if target > shown {
            shown = bringOut(map.glyphs(from: shown, to: target), upTo: target, at: now)
        }
        updateMask()
        return shown
    }

    /// Everything shows: what is under the words fades in, then the mask goes.
    func complete(at now: Double) {
        guard let map, let content else { return }
        let words = map.size.height - map.bottomPadding
        guard map.bottomPadding > 0.5 else { return }
        let layer = maskRect(CGRect(x: 0, y: words, width: max(map.size.width, content.bounds.width), height: map.bottomPadding))
        fade(layer)
        finale = Fading(end: map.length, layer: layer, until: now + StreamingRevealMotion.fadeDuration)
        updateMask()
    }

    /// Shows the row whole, with nothing moving.
    func clear() {
        for glyph in moving { glyph.layer.removeFromSuperlayer() }
        moving.removeAll()
        for fade in fading { fade.layer.removeFromSuperlayer() }
        fading.removeAll()
        finale?.layer.removeFromSuperlayer()
        finale = nil
        map = nil
        shown = 0
        heldSince = nil
        if content?.layer.mask === mask { content?.layer.mask = nil }
    }

    private func install() {
        guard let content, content.layer.mask !== mask else { return }
        mask.frame = CGRect(origin: .zero, size: content.bounds.size)
        content.layer.mask = mask
    }

    private func expire(_ now: Double) {
        let landed = moving.filter { $0.until <= now }
        for glyph in landed { glyph.layer.removeFromSuperlayer() }
        moving.removeAll { $0.until <= now }
        let limit = staticLimit
        let faded = fading.filter { $0.until <= now && $0.end <= limit }
        for fade in faded { fade.layer.removeFromSuperlayer() }
        fading.removeAll { $0.until <= now && $0.end <= limit }
        if let finale, finale.until <= now {
            finale.layer.removeFromSuperlayer()
            self.finale = nil
        }
    }

    /// What the mask shows outright: up to the first glyph still moving.
    private var staticLimit: Int { moving.map(\.index).min() ?? shown }

    /// The glyphs coming out, each copied from the drawing and moving in; a
    /// block, or a glyph whose drawing can't be found, fades in its place.
    /// Off screen, a glyph just shows. Returns how many show: it stops at a
    /// glyph whose drawing hasn't arrived yet, for a moment.
    private func bringOut(_ glyphs: [RevealMap.Glyph], upTo target: Int, at now: Double) -> Int {
        guard let content, let window = content.window else { return target }
        let screen = window.bounds
        let onScreen = glyphs.filter { content.convert($0.frame, to: nil).intersects(screen) }
        if onScreen.count > StreamingRevealMotion.glyphsPerFrame {
            // A burst: a line at a time, fading.
            var lines: [(rect: CGRect, end: Int)] = []
            for glyph in onScreen {
                if let last = lines.last, abs(last.rect.minY - glyph.frame.minY) < 0.5, !glyph.isBlock {
                    lines[lines.count - 1] = (last.rect.union(glyph.frame), glyph.index + 1)
                } else {
                    lines.append((glyph.frame, glyph.index + 1))
                }
            }
            for line in lines { addFade(line.rect, end: line.end, at: now) }
            heldSince = nil
            return target
        }
        let sources = ChatRevealSources(content)
        for glyph in onScreen {
            if glyph.isBlock {
                addFade(glyph.frame, end: glyph.index + 1, at: now)
                continue
            }
            switch sources.source(for: glyph.frame) {
            case .drawn(let image, let rect, let scale):
                addGlyph(glyph, image: image, rect: rect, scale: scale, at: now)
            case .pending:
                if now - (heldSince ?? now) < Self.longestHold {
                    if heldSince == nil { heldSince = now }
                    return glyph.index
                }
                addFade(glyph.frame, end: glyph.index + 1, at: now)
            case .none:
                addFade(glyph.frame, end: glyph.index + 1, at: now)
            }
        }
        heldSince = nil
        return target
    }

    private func addGlyph(_ glyph: RevealMap.Glyph, image: CGImage, rect: CGRect, scale: CGFloat, at now: Double) {
        typealias Motion = StreamingRevealMotion
        let layer = CALayer()
        layer.contents = image
        layer.contentsRect = rect
        layer.contentsScale = scale
        layer.contentsGravity = .resize
        layer.frame = glyph.frame
        overlay.addSublayer(layer)
        let timing = CAMediaTimingFunction(name: .easeInEaseOut)
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        let rise = CABasicAnimation(keyPath: "position")
        rise.fromValue = CGPoint(x: 0, y: Motion.glyphRise)
        rise.toValue = CGPoint.zero
        rise.isAdditive = true
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = Motion.glyphScale
        grow.toValue = 1
        for animation in [fade, rise, grow] {
            animation.duration = Motion.glyphDuration
            animation.timingFunction = timing
            layer.add(animation, forKey: animation.keyPath)
        }
        moving.append(Moving(index: glyph.index, layer: layer, until: now + Motion.glyphDuration))
    }

    private func addFade(_ rect: CGRect, end: Int, at now: Double) {
        let layer = maskRect(rect)
        fade(layer)
        fading.append(Fading(end: end, layer: layer, until: now + StreamingRevealMotion.fadeDuration))
    }

    private func maskRect(_ rect: CGRect) -> CALayer {
        let layer = CALayer()
        layer.backgroundColor = UIColor.white.cgColor
        layer.frame = rect
        mask.addSublayer(layer)
        return layer
    }

    private func fade(_ layer: CALayer) {
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = StreamingRevealMotion.fadeDuration
        fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.add(fade, forKey: "opacity")
    }

    private func updateMask() {
        guard let map else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let limit = staticLimit
        var frames: [CGRect]
        if limit >= map.length {
            // Everything shows, but what is under the words waits for the
            // reply to end (`complete`).
            let words = map.size.height - map.bottomPadding
            frames = [CGRect(x: 0, y: 0, width: max(map.size.width, content?.bounds.width ?? 0), height: words)]
        } else {
            frames = map.mask(showing: limit)
        }
        while rects.count < frames.count {
            let layer = CALayer()
            layer.backgroundColor = UIColor.white.cgColor
            mask.insertSublayer(layer, at: 0)
            rects.append(layer)
        }
        for (index, layer) in rects.enumerated() {
            if index < frames.count {
                layer.frame = frames[index]
                layer.isHidden = false
            } else {
                layer.isHidden = true
            }
        }
        CATransaction.commit()
    }
}

/// The drawn bitmaps under a row's glyphs: each layer of the row's drawing
/// that holds one, where it lies in the drawing.
@MainActor
private struct ChatRevealSources {
    enum Source {
        /// A glyph's pixels: the bitmap and the part of it.
        case drawn(CGImage, CGRect, CGFloat)
        /// Drawn, but not yet as far as this glyph.
        case pending
        case none
    }

    private struct Drawn {
        var frame: CGRect
        var image: CGImage
        var pixels: CGRect
        var scale: CGFloat
    }

    private var drawn: [Drawn] = []
    /// Where words are being drawn again.
    private var pending: [CGRect] = []

    init(_ content: UIView) {
        collect(content.layer, in: content.layer)
    }

    private mutating func collect(_ layer: CALayer, in root: CALayer) {
        guard !layer.isHidden, layer.opacity > 0 else { return }
        if layer !== root, let contents = layer.contents, CFGetTypeID(contents as CFTypeRef) == CGImage.typeID {
            // Words that grew show their last drawing until the new one
            // comes: none of it is theirs yet.
            if let text = layer.delegate as? ChatOffMainTextView, !text.showsItsLayout {
                pending.append(layer.convert(layer.bounds, to: root))
                return
            }
            let image = contents as! CGImage
            let frame = layer.convert(layer.bounds, to: root)
            let scale = max(1, layer.contentsScale)
            // A bitmap drawn for the text before it grew sits at the top
            // left, at its own size (`ChatOffMainTextView`).
            let pixels = layer.contentsGravity == .resize
                ? frame
                : CGRect(origin: frame.origin, size: CGSize(width: CGFloat(image.width) / scale, height: CGFloat(image.height) / scale))
            drawn.append(Drawn(frame: frame, image: image, pixels: pixels, scale: scale))
        }
        for sublayer in layer.sublayers ?? [] { collect(sublayer, in: root) }
    }

    func source(for rect: CGRect) -> Source {
        let middle = CGPoint(x: rect.midX, y: rect.midY)
        if pending.contains(where: { $0.insetBy(dx: -0.5, dy: -0.5).contains(middle) }) { return .pending }
        guard let found = drawn.last(where: { $0.frame.insetBy(dx: -0.5, dy: -0.5).contains(middle) }) else { return .none }
        guard found.pixels.insetBy(dx: -0.5, dy: -0.5).contains(rect.intersection(found.frame)), found.pixels.width > 0, found.pixels.height > 0 else {
            return .pending
        }
        let part = CGRect(
            x: (rect.minX - found.pixels.minX) / found.pixels.width, y: (rect.minY - found.pixels.minY) / found.pixels.height,
            width: rect.width / found.pixels.width, height: rect.height / found.pixels.height
        )
        return .drawn(found.image, part, found.scale)
    }
}
#endif

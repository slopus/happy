#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// A tool section's one line as planned (`ChatPlanner.section`): its glyph
/// and its runs of words, in the line's own coordinates, and what it shows,
/// which says whether a new plan for the row is a new line or the same one.
struct ChatToolLine: @unchecked Sendable {
    enum Glyph {
        case icon(Icon, ColorToken)
        /// The latest call is still running.
        case spinner(ColorToken)
    }

    struct Run {
        var text: ChatTextLayout
        var frame: CGRect
    }

    /// The row it is the line of: a view handed another row's line shows it at rest.
    var row: String
    /// What it shows: a call, by its item's ID, or the run summed up.
    var shows: String
    /// The run may yet take another call: a line first drawn while it
    /// runs comes in, one first drawn ended is history and lies still.
    var live: Bool
    var glyph: Glyph
    var glyphFrame: CGRect
    var runs: [Run]

    /// What is drawn, to tell a plan that changes nothing on the line.
    var drawn: String {
        let mark = switch glyph {
        case .icon(let icon, _): "\(icon)"
        case .spinner: "spinner"
        }
        return ([mark, "\(glyphFrame)"] + runs.map { "\($0.frame)\u{1}\($0.text.string.string)" }).joined(separator: "\u{2}")
    }
}

/// Draws a `ChatToolLine` and moves from one to the next as desktop's tool
/// section does (`AgentToolSection`, `ArrivingText`): when what the line
/// shows changes under the reader, the line it replaces stays laid over it
/// and both run on one clock that depends on a character's place alone
/// (`StreamingRevealMotion.lineDelay`). As each place's turn comes, the old
/// character rises out (6 up, half size, fading, 0.16 s) and the new one
/// comes in (from 6 below and half size, 0.2 s), the reply's own motion
/// (`StreamingRevealMotion`); what is left past the new line's end goes on
/// leaving in the same order, and the glyph goes first.
///
/// Each character is a slice of its run's drawing, so the line never moves
/// as a whole and nothing outside its 32 does: only opacity and transforms
/// animate. At rest each run is one layer of that drawing. A line first
/// drawn ended, a change of the same call (it finished), Reduce Motion and
/// a line off screen show at rest.
@MainActor
final class ChatToolLineView: UIView {
    /// One drawn line: its glyph's view and each run's bitmap.
    private struct Drawn {
        var line: ChatToolLine
        var glyph: UIView
        var runs: [(image: CGImage, frame: CGRect, scale: CGFloat, map: RevealMap)]
    }

    private var shown: Drawn?
    /// The layers drawing `shown`: a run each at rest, a character each
    /// while it comes in.
    private var layers: [CALayer] = []
    private var sliced = false
    /// What is leaving, laid over the line until its last character is out.
    private var leaving: [CALayer] = []
    private var leavingGlyph: UIView?
    /// Bumped by each change, so a settle timed for an earlier one does nothing.
    private var generation = 0
    /// First drawn live while not yet on screen: it comes in once it is.
    private var arrivesOnScreen = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            guard let line = self.shown?.line else { return }
            self.show(line, motion: .rest)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private enum Motion { case rest, arrive, replace }

    func apply(_ line: ChatToolLine?) {
        guard let line else {
            clear()
            shown = nil
            return
        }
        let previous = shown?.line
        if let previous, previous.row == line.row, previous.shows == line.shows, previous.drawn == line.drawn { return }
        let watched = window != nil && !UIAccessibility.isReduceMotionEnabled
        let motion: Motion
        if let previous, previous.row == line.row {
            motion = previous.shows != line.shows && watched ? .replace : .rest
        } else {
            motion = line.live && watched ? .arrive : .rest
            arrivesOnScreen = line.live && window == nil
        }
        show(line, motion: motion)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, arrivesOnScreen, let line = shown?.line else { return }
        arrivesOnScreen = false
        if !UIAccessibility.isReduceMotionEnabled { show(line, motion: .arrive) }
    }

    private func show(_ line: ChatToolLine, motion: Motion) {
        generation += 1
        let now = CACurrentMediaTime()
        clearLeaving()
        let old = shown
        if motion == .replace, let old {
            // The old line leaves from wherever it is: still coming in, or at rest.
            if !sliced { slice(old) }
            leaving = layers
            leavingGlyph = old.glyph
            old.glyph.layer.removeAllAnimations()
            leave(old.glyph.layer, at: now, place: 0)
            for layer in leaving { leave(layer, at: now, place: (layer.value(forKey: Self.placeKey) as? Int) ?? 0) }
        } else {
            for layer in layers { layer.removeFromSuperlayer() }
            old?.glyph.removeFromSuperview()
        }
        layers = []
        sliced = false
        let drawn = draw(line)
        shown = drawn
        addSubview(drawn.glyph)
        if motion == .rest {
            settle(drawn)
            return
        }
        slice(drawn)
        arrive(drawn.glyph.layer, at: now, place: 0)
        var last = 0
        for layer in layers {
            let place = (layer.value(forKey: Self.placeKey) as? Int) ?? 0
            last = max(last, place)
            if let inner = layer.sublayers?.first { arrive(inner, at: now, place: place) }
        }
        let leftLast = leaving.compactMap { $0.value(forKey: Self.placeKey) as? Int }.max() ?? 0
        let done = max(StreamingRevealMotion.lineDelay(last) + StreamingRevealMotion.glyphDuration,
                       StreamingRevealMotion.lineDelay(leftLast) + StreamingRevealMotion.leaveDuration)
        let generation = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + done + 0.02) { [weak self] in
            guard let self, self.generation == generation, let shown = self.shown else { return }
            self.clearLeaving()
            self.settle(shown)
        }
    }

    private static let placeKey = "happyPlace"

    /// The line's glyph and each run's drawing, resolved for this view's
    /// appearance and scale.
    private func draw(_ line: ChatToolLine) -> Drawn {
        let glyph: UIView
        switch line.glyph {
        case .icon(let icon, let tint):
            let view = UIImageView(image: .icon(icon, size: 12))
            view.contentMode = .center
            view.tintColor = UIColor(tint)
            glyph = view
        case .spinner(let tint):
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.color = UIColor(tint)
            spinner.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
            spinner.startAnimating()
            glyph = spinner
        }
        glyph.bounds = CGRect(origin: .zero, size: line.glyphFrame.size)
        glyph.center = CGPoint(x: line.glyphFrame.midX, y: line.glyphFrame.midY)
        let scale = max(1, traitCollection.displayScale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = false
        var runs: [(image: CGImage, frame: CGRect, scale: CGFloat, map: RevealMap)] = []
        traitCollection.performAsCurrent {
            for run in line.runs where run.frame.width > 0 && run.frame.height > 0 {
                let image = UIGraphicsImageRenderer(size: run.frame.size, format: format).image { _ in
                    run.text.draw(at: .zero)
                }
                guard let cgImage = image.cgImage else { continue }
                let map = RevealMap(lines: run.text.revealLines(at: .zero), size: run.frame.size)
                runs.append((cgImage, run.frame, scale, map))
            }
        }
        return Drawn(line: line, glyph: glyph, runs: runs)
    }

    /// At rest: each run one layer of its drawing.
    private func settle(_ drawn: Drawn) {
        for layer in layers { layer.removeFromSuperlayer() }
        layers = drawn.runs.map { run in
            let layer = CALayer()
            layer.contents = run.image
            layer.contentsScale = run.scale
            layer.frame = run.frame
            self.layer.addSublayer(layer)
            return layer
        }
        sliced = false
    }

    /// A character each: an outer layer that leaves, holding a slice of its
    /// run's drawing that arrives, so a character still coming in can go.
    private func slice(_ drawn: Drawn) {
        for layer in layers { layer.removeFromSuperlayer() }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        var slices: [CALayer] = []
        var offset = 0
        for run in drawn.runs {
            let size = run.frame.size
            for glyph in run.map.glyphs(from: 0, to: run.map.length) {
                let rect = CGRect(x: glyph.frame.minX, y: 0, width: glyph.frame.width, height: size.height)
                let outer = CALayer()
                outer.frame = rect.offsetBy(dx: run.frame.minX, dy: run.frame.minY)
                outer.setValue(offset + glyph.index, forKey: Self.placeKey)
                let inner = CALayer()
                inner.frame = CGRect(origin: .zero, size: rect.size)
                inner.contents = run.image
                inner.contentsScale = run.scale
                inner.contentsGravity = .resize
                inner.contentsRect = CGRect(x: rect.minX / size.width, y: 0, width: rect.width / size.width, height: 1)
                outer.addSublayer(inner)
                layer.addSublayer(outer)
                slices.append(outer)
            }
            offset += run.map.length
        }
        CATransaction.commit()
        layers = slices
        sliced = true
    }

    private func arrive(_ layer: CALayer, at now: CFTimeInterval, place: Int) {
        typealias Motion = StreamingRevealMotion
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
            animation.beginTime = layer.convertTime(now, from: nil) + Motion.lineDelay(place)
            animation.duration = Motion.glyphDuration
            animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            // Hidden until its place's turn.
            animation.fillMode = .backwards
            layer.add(animation, forKey: "arrive." + (animation.keyPath ?? ""))
        }
    }

    private func leave(_ layer: CALayer, at now: CFTimeInterval, place: Int) {
        typealias Motion = StreamingRevealMotion
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        let rise = CABasicAnimation(keyPath: "position")
        rise.fromValue = CGPoint.zero
        rise.toValue = CGPoint(x: 0, y: -Motion.glyphRise)
        rise.isAdditive = true
        let shrink = CABasicAnimation(keyPath: "transform.scale")
        shrink.fromValue = 1
        shrink.toValue = Motion.glyphScale
        for animation in [fade, rise, shrink] {
            animation.beginTime = layer.convertTime(now, from: nil) + Motion.lineDelay(place)
            animation.duration = Motion.leaveDuration
            animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            // Whole until its place's turn, then gone.
            animation.fillMode = .forwards
            animation.isRemovedOnCompletion = false
            layer.add(animation, forKey: "leave." + (animation.keyPath ?? ""))
        }
    }

    private func clearLeaving() {
        for layer in leaving { layer.removeFromSuperlayer() }
        leaving = []
        leavingGlyph?.removeFromSuperview()
        leavingGlyph = nil
    }

    private func clear() {
        generation += 1
        clearLeaving()
        for layer in layers { layer.removeFromSuperlayer() }
        layers = []
        sliced = false
        shown?.glyph.removeFromSuperview()
        arrivesOnScreen = false
    }
}
#endif

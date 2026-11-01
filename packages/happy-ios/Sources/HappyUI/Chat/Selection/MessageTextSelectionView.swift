#if canImport(UIKit)
import HappyLayout
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Selects part of a lifted message's words, as Telegram's
/// `TextSelectionNode` does over a message's text: a press in the words
/// selects the one under the finger, handles at the ends drag the
/// selection across lines and blocks, and a menu over it copies or shares
/// exactly what is selected. It lies over the message's plan, in the
/// plan's coordinates, and its highlight is worked out from the very text
/// layouts that drew the glyphs (`ChatSelectable`).
final class MessageTextSelectionView: UIView, UIGestureRecognizerDelegate, @preconcurrency UIEditMenuInteractionDelegate {
    typealias M = SelectionGeometry.Metrics

    let selectable: ChatSelectable
    let run: SelectionText
    /// Where the selection was started and where it was dragged to, as
    /// Telegram keeps them: either may be the earlier.
    private var ends: (start: Int, end: Int)?
    /// The selected characters of `run`.
    var selected: Range<Int>? {
        ends.flatMap { $0.start == $0.end ? nil : min($0.start, $0.end)..<max($0.start, $0.end) }
    }
    /// What copying the selection gives.
    var selectedText: String? { selected.map { run.copy($0) } }
    private(set) var rects: [CGRect] = []

    /// A selection came or went.
    var onActive: ((Bool) -> Void)?
    var onCopy: ((String) -> Void)?
    var onShare: ((String) -> Void)?

    private let highlight = CAShapeLayer()
    let startKnob = SelectionKnobView(knob: .start)
    let endKnob = SelectionKnobView(knob: .end)
    private let recognizer = SelectionGestureRecognizer()
    private var editMenu: UIEditMenuInteraction?

    init(selectable: ChatSelectable, size: CGSize) {
        self.selectable = selectable
        run = selectable.run
        super.init(frame: CGRect(origin: .zero, size: size))
        backgroundColor = .clear
        isAccessibilityElement = false
        highlight.frame = bounds
        highlight.opacity = 0
        layer.addSublayer(highlight)
        for knob in [startKnob, endKnob] {
            knob.alpha = 0
            addSubview(knob)
        }
        recognizer.delegate = self
        recognizer.canBegin = { [weak self] point in self?.word(at: point) != nil || self?.selected != nil }
        recognizer.knobAt = { [weak self] point in
            guard let self, selected != nil else { return nil }
            return SelectionGeometry.knob(at: point, start: startKnob.frame, end: endKnob.frame)
        }
        recognizer.began = { [weak self] point in self?.selectWord(at: point) }
        recognizer.moved = { [weak self] knob, point in self?.move(knob, to: point) }
        recognizer.startedMoving = { [weak self] in
            self?.editMenu?.dismissMenu()
            self?.holdScrolling()
        }
        recognizer.finishedMoving = { [weak self] in self?.showMenu() }
        recognizer.tapped = { [weak self] in self?.clear() }
        addGestureRecognizer(recognizer)
        let menu = UIEditMenuInteraction(delegate: self)
        addInteraction(menu)
        editMenu = menu
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private func applyColors() {
        highlight.fillColor = UIColor(Palette.selectionHighlight).resolvedColor(with: traitCollection).cgColor
        for knob in [startKnob, endKnob] { knob.color = UIColor(Palette.selectionKnob).resolvedColor(with: traitCollection) }
    }

    // MARK: Geometry

    /// The highlight's rects for `range`, one a line of each text, in the
    /// view's (the plan's) coordinates, kept inside the strip a code block
    /// or table shows through.
    static func rects(for range: Range<Int>, in selectable: ChatSelectable, run: SelectionText) -> [CGRect] {
        var result: [CGRect] = []
        for part in run.split(range) {
            let text = selectable.texts[part.piece]
            let lines = text.layout.selectionRects(for: NSRange(location: part.range.lowerBound, length: part.range.count))
                .map { $0.offsetBy(dx: text.frame.minX, dy: text.frame.minY) }
            for rect in SelectionGeometry.joined(lines) {
                let shown = text.clip.map { rect.intersection($0) } ?? rect
                if !shown.isNull, shown.width > 0 { result.append(shown) }
            }
        }
        return result
    }

    /// The text nearest `point`: the one it is in, else the closest by
    /// line, then sideways.
    private func nearestText(to point: CGPoint) -> Int? {
        selectable.texts.indices.min { a, b in
            func distance(_ index: Int) -> CGFloat {
                let frame = selectable.texts[index].frame
                let dy = max(0, frame.minY - point.y, point.y - frame.maxY)
                let dx = max(0, frame.minX - point.x, point.x - frame.maxX)
                return dy * 10_000 + dx
            }
            return distance(a) < distance(b)
        }
    }

    /// The place in `run` nearest `point`, wherever it is.
    func caret(nearest point: CGPoint) -> Int? {
        guard let index = nearestText(to: point) else { return nil }
        let text = selectable.texts[index]
        let local = CGPoint(x: point.x - text.frame.minX, y: point.y - text.frame.minY)
        return run.starts[index] + text.layout.caretIndex(nearest: local)
    }

    /// The word under `point` in `run`, if the point is on words.
    func word(at point: CGPoint) -> Range<Int>? {
        for (index, text) in selectable.texts.enumerated() where text.frame.insetBy(dx: -4, dy: -4).contains(point) {
            if let clip = text.clip, !clip.contains(point) { continue }
            let local = CGPoint(x: point.x - text.frame.minX, y: point.y - text.frame.minY)
            guard let character = text.layout.characterIndex(at: local) else { continue }
            let word = text.layout.wordRange(at: character)
            guard word.length > 0 else { continue }
            return (run.starts[index] + word.location)..<(run.starts[index] + word.location + word.length)
        }
        return nil
    }

    // MARK: Selecting

    /// All of it, as Telegram's Select does, with its menu.
    func selectAll() {
        guard run.length > 0 else { return }
        setSelection(0..<run.length, animateIn: true)
        showMenu()
    }

    func setSelection(_ range: Range<Int>, animateIn: Bool) {
        let wasActive = selected != nil
        ends = (range.lowerBound, range.upperBound)
        update(animateIn: animateIn)
        if !wasActive { onActive?(true) }
    }

    private func selectWord(at point: CGPoint) {
        clear(notify: false)
        guard let word = word(at: point) else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        setSelection(word, animateIn: true)
        showMenu()
    }

    private func move(_ knob: SelectionGeometry.Knob, to point: CGPoint) {
        guard var ends, let index = caret(nearest: point) else { return }
        switch knob {
        case .start: ends.start = index
        case .end: ends.end = index
        }
        if ends.start != self.ends?.start || ends.end != self.ends?.end {
            self.ends = ends
            update(animateIn: false)
        }
        // A handle near the viewport's edge brings more of the message in.
        if let scroll = enclosingScrollView {
            let at = convert(point, to: scroll)
            scroll.scrollRectToVisible(CGRect(x: at.x, y: at.y - 50, width: 1, height: 100), animated: false)
        }
    }

    func clear(notify: Bool = true) {
        guard ends != nil else { return }
        ends = nil
        editMenu?.dismissMenu()
        update(animateIn: false)
        if notify { onActive?(false) }
    }

    private var enclosingScrollView: UIScrollView? {
        sequence(first: superview, next: { $0?.superview }).lazy.compactMap { $0 as? UIScrollView }.first
    }

    /// A handle took the finger: the viewport's own drag lets go of it.
    private func holdScrolling() {
        guard let pan = enclosingScrollView?.panGestureRecognizer else { return }
        pan.isEnabled = false
        pan.isEnabled = true
    }

    // MARK: Drawing

    private func update(animateIn: Bool) {
        rects = selected.map { Self.rects(for: $0, in: selectable, run: run) } ?? []
        accessibilityValueChanged()
        guard let first = rects.first, let last = rects.last else {
            guard highlight.opacity > 0 else { return }
            fadeOut()
            return
        }
        let path = UIBezierPath()
        for rect in rects { path.append(UIBezierPath(roundedRect: rect, cornerRadius: M.cornerRadius)) }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        highlight.frame = bounds
        highlight.path = path.cgPath
        CATransaction.commit()
        startKnob.frame = SelectionGeometry.startKnob(edge: CGRect(x: first.minX, y: first.minY, width: 0, height: first.height))
        endKnob.frame = SelectionGeometry.endKnob(edge: CGRect(x: last.maxX, y: last.minY, width: 0, height: last.height))
        if highlight.opacity == 0 { appear(around: rects.dropFirst().reduce(first) { $0.union($1) }, animateIn: animateIn) }
    }

    /// Telegram's way in: the highlight fades in (shrinking onto the words
    /// from twice their size when it starts afresh), then the handles.
    private func appear(around union: CGRect, animateIn: Bool) {
        highlight.opacity = 1
        startKnob.alpha = 1
        endKnob.alpha = 1
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = M.highlightFade
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        highlight.add(fade, forKey: "fade")
        if animateIn {
            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 2
            scale.toValue = 1
            scale.duration = M.highlightShrink
            scale.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            highlight.add(scale, forKey: "shrink")
            // The words' middle stays put while the rest shrinks onto it.
            let move = CABasicAnimation(keyPath: "position")
            move.fromValue = NSValue(cgPoint: CGPoint(x: bounds.midX - union.midX, y: bounds.midY - union.midY))
            move.toValue = NSValue(cgPoint: .zero)
            move.isAdditive = true
            move.duration = M.highlightShrink
            move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            highlight.add(move, forKey: "shrink-position")
        }
        for knob in [startKnob, endKnob] {
            let now = knob.layer.convertTime(CACurrentMediaTime(), from: nil)
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0
            fade.toValue = 1
            fade.duration = M.knobFade
            fade.beginTime = now + M.knobFadeDelay
            fade.fillMode = .backwards
            knob.layer.add(fade, forKey: "fade")
            let grow = LiftMotion.spring("transform.scale", from: 0.5, to: 1, duration: M.knobSpring, damping: M.knobSpringDamping)
            grow.beginTime = now + M.knobSpringDelay
            grow.fillMode = .backwards
            knob.layer.add(grow, forKey: "grow")
        }
    }

    private func fadeOut() {
        let duration = UIAccessibility.isReduceMotionEnabled ? 0 : M.fadeOut
        for layer in [highlight, startKnob.layer, endKnob.layer] {
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = layer.presentation()?.opacity ?? layer.opacity
            fade.toValue = 0
            fade.duration = duration
            layer.add(fade, forKey: "fade")
            layer.opacity = 0
        }
    }

    // MARK: Menu

    /// Copy, then Select All, or Share once all of it is selected, as
    /// Telegram's selection menu ends.
    private func showMenu() {
        guard let anchor = SelectionGeometry.menuAnchor(rects) else { return }
        editMenu?.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: CGPoint(x: anchor.midX, y: visible(anchor).minY)))
    }

    /// What of `rect` the viewport shows, so the menu stays on screen.
    private func visible(_ rect: CGRect) -> CGRect {
        guard let scroll = enclosingScrollView else { return rect }
        let shown = rect.intersection(convert(scroll.bounds, from: scroll))
        return shown.isNull ? rect : shown
    }

    func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
        guard let selected, let text = selectedText else { return nil }
        var actions: [UIMenuElement] = [UIAction(title: Strings.Chat.copy) { [weak self] _ in self?.onCopy?(text) }]
        if selected.count < run.length {
            actions.append(UIAction(title: Strings.MessageSelection.selectAll) { [weak self] _ in
                guard let self else { return }
                setSelection(0..<run.length, animateIn: false)
                showMenu()
            })
        } else if onShare != nil {
            actions.append(UIAction(title: Strings.MessageSelection.share) { [weak self] _ in self?.onShare?(text) })
        }
        return UIMenu(children: actions)
    }

    func editMenuInteraction(_ interaction: UIEditMenuInteraction, targetRectFor configuration: UIEditMenuConfiguration) -> CGRect {
        SelectionGeometry.menuAnchor(rects).map(visible) ?? .null
    }

    // MARK: Touches

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }

    /// Its handles reach a little past its edges.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        if super.point(inside: point, with: event) { return true }
        return selected != nil && SelectionGeometry.knob(at: point, start: startKnob.frame, end: endKnob.frame) != nil
    }

    // MARK: Accessibility

    /// For VoiceOver and the UI tests: what is selected.
    var onSelectionRead: ((String?) -> Void)?

    private func accessibilityValueChanged() {
        onSelectionRead?(selectedText)
    }
}

/// One of Telegram's selection handles (`generateKnobImage`): a 2 wide
/// stem down the line and a 12 dot, over it for the start, under it for
/// the end.
final class SelectionKnobView: UIView {
    let knob: SelectionGeometry.Knob
    var color: UIColor = .systemBlue { didSet { setNeedsDisplay() } }

    init(knob: SelectionGeometry.Knob) {
        self.knob = knob
        super.init(frame: .zero)
        isOpaque = false
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
        #if DEBUG || HAPPY_FIXTURES
        isAccessibilityElement = true
        accessibilityIdentifier = knob == .start ? "selection-start" : "selection-end"
        #endif
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func draw(_ rect: CGRect) {
        typealias M = SelectionGeometry.Metrics
        guard let context = UIGraphicsGetCurrentContext() else { return }
        context.setFillColor(color.cgColor)
        let size = bounds.size
        let dot = M.knobDiameter
        let stemX = (size.width - M.stemWidth) / 2
        switch knob {
        case .start:
            context.fillEllipse(in: CGRect(x: (size.width - dot) / 2, y: 0, width: dot, height: dot))
            context.fill(CGRect(x: stemX, y: dot / 2, width: M.stemWidth, height: size.height - dot / 2))
        case .end:
            context.fill(CGRect(x: stemX, y: 0, width: M.stemWidth, height: size.height - dot / 2))
            context.fillEllipse(in: CGRect(x: (size.width - dot) / 2, y: size.height - dot, width: dot, height: dot))
        }
    }
}

/// Telegram's `TextSelectionGestureRecognizer`: a touch on a handle drags
/// it at once; one held 0.3 s in the words starts a selection there; a
/// tap lets the selection go. A touch that moves before it is held is
/// left to the viewport's scrolling.
final class SelectionGestureRecognizer: UIGestureRecognizer {
    var canBegin: ((CGPoint) -> Bool)?
    var knobAt: ((CGPoint) -> (knob: SelectionGeometry.Knob, grab: CGPoint)?)?
    var began: ((CGPoint) -> Void)?
    var moved: ((SelectionGeometry.Knob, CGPoint) -> Void)?
    var startedMoving: (() -> Void)?
    var finishedMoving: (() -> Void)?
    var tapped: (() -> Void)?

    private var timer: Timer?
    private var start: CGPoint?
    private var location: CGPoint?
    private var moving: (knob: SelectionGeometry.Knob, grab: CGPoint, from: CGPoint)?

    override func reset() {
        super.reset()
        timer?.invalidate()
        timer = nil
        moving = nil
        start = nil
        location = nil
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        guard touches.count == 1, let point = touches.first?.location(in: view) else {
            state = .failed
            return
        }
        start = point
        location = point
        if let (knob, grab) = knobAt?(point) {
            moving = (knob, grab, point)
            startedMoving?()
            state = .began
        } else if canBegin?(point) ?? false {
            let timer = Timer(timeInterval: SelectionGeometry.Metrics.pressDuration, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.held() }
            }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
        } else {
            state = .failed
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        guard let point = touches.first?.location(in: view) else { return }
        location = point
        if let moving {
            moved?(moving.knob, CGPoint(x: moving.grab.x + point.x - moving.from.x, y: moving.grab.y + point.y - moving.from.y))
            state = .changed
        } else if let start, hypot(point.x - start.x, point.y - start.y) > 10 {
            timer?.invalidate()
            timer = nil
            state = .failed
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        if let timer {
            timer.invalidate()
            self.timer = nil
            tapped?()
        } else if moving != nil {
            finishedMoving?()
        }
        state = moving != nil ? .ended : (state == .possible ? .ended : state)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        if moving != nil { finishedMoving?() }
        state = .cancelled
    }

    private func held() {
        timer = nil
        guard let location else { return }
        began?(location)
        state = .ended
    }
}
#endif

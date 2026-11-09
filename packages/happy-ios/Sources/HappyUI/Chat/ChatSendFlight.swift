#if canImport(UIKit)
import HappyLayout
import UIKit
import UltraView

/// What a send transition needs of a person's own message: its bubble,
/// where its words start, and its time and mark, in row coordinates.
struct ChatRowFlight {
    var bubble: ChatBox
    var text: CGRect?
    var status: CGRect?
    /// Pictures under the bubble: the row fades and slides in instead.
    var media = false
}

/// Telegram's send transition (ChatMessageTransitionNode's `.textInput`):
/// the words leave the composer as the bubble grows around them from the
/// input field into its place, while the list makes room for it. A draft
/// that scrolled in the field isn't carried: what the field showed fades
/// there and the row rises from the composer (`SendFlightLayout`). The
/// overlay clips to `host`, so nothing of a flight is drawn off screen.
///
/// The row stays in the list, veiled, where it is laid out; a copy of it
/// flies over the screen, above the composer, and lands on it, and the row
/// shows again in the same transaction the copy goes. Everything moves on
/// Core Animation: the copy's place is the row's, and the flight is
/// additive on top of it, so the row moving under it (the keyboard, the
/// composer shrinking) moves the copy too (`follow`).
@MainActor
final class ChatSendFlight {
    enum Motion {
        static let duration: CFTimeInterval = 0.3
        static var vertical: CAMediaTimingFunction { CAMediaTimingFunction(controlPoints: 0.19919472913616398, 0.010644531250000006, 0.27920937042459737, 0.91025390625) }
        static var horizontal: CAMediaTimingFunction { CAMediaTimingFunction(controlPoints: 0.23, 1.0, 0.32, 1.0) }
        /// The rows above make room on the vertical curve.
        static let list = ListTransition(duration: duration, curve: .bezier(0.19919472913616398, 0.010644531250000006, 0.27920937042459737, 0.91025390625))
        /// The composer's words go in 0.1 s, the bubble's come in 0.08 s.
        static let sourceFade: CFTimeInterval = 0.1
        static let textFade: CFTimeInterval = 0.08
        static let bubbleFade: CFTimeInterval = 0.1
        static let statusFade: CFTimeInterval = 0.25
        /// A row with pictures fades in this long.
        static let mediaFade: CFTimeInterval = 0.2
        /// A send whose row never came is let go of.
        static let patience: TimeInterval = 1.5
        /// How long the landed copy waits for the row to have drawn.
        static let revealWait: TimeInterval = 0.5
    }

    /// The composer's words, and where its input field is, in `host`.
    struct Source {
        /// The words, laid out whole: only for a draft the field shows whole.
        var text: ChatTextLayout?
        var textOrigin: CGPoint
        var field: CGRect
        /// What the field showed of a draft that scrolled in it.
        var snapshot: UIView?
        var layout: SendFlightLayout.Source
    }

    /// The message the next row must be: nil takes the next new row of
    /// the person's own that the list inserts (a legacy send learns its id
    /// only once the outbox has it).
    private(set) var message: String?
    private let host: UIView
    let source: Source
    private let overlay = PassthroughView()
    private let words = ChatTextView()
    /// What the field showed, for a draft that scrolled in it.
    private var snapshot: UIView?
    /// The copy, at the row's place in `host`, and its bubble and words.
    private(set) var container: UIView?
    private(set) var bubble: UIView?
    private(set) var body: UIView?
    /// Where the copy lands, in `host`.
    private var target: CGRect?
    private(set) weak var row: UIView?
    private(set) var finished = false
    /// Its row came, whether it morphs onto it or slides in.
    private var landed = false
    /// Told when the flight is over, landed or let go of.
    var onFinish: (() -> Void)?
    /// For tests: what the flight draws over the screen.
    var overlayView: UIView { overlay }

    /// Shows the composer's words over it at once, where they are, so the
    /// composer emptying shows nothing go.
    init(source: Source, host: UIView, message: String?) {
        self.source = source
        self.host = host
        self.message = message
        overlay.frame = host.bounds
        overlay.clipsToBounds = true
        overlay.isUserInteractionEnabled = false
        overlay.accessibilityElementsHidden = true
        host.addSubview(overlay)
        if let text = source.text, let frame = source.layout.words {
            words.isAccessibilityElement = false
            words.layout = text
            words.frame = frame
            overlay.addSubview(words)
        } else if let view = source.snapshot, let frame = source.layout.snapshot {
            // Only the part of the field on screen, as it showed it.
            let clip = UIView(frame: frame)
            clip.clipsToBounds = true
            clip.isUserInteractionEnabled = false
            view.frame = CGRect(origin: CGPoint(x: source.field.minX - frame.minX, y: source.field.minY - frame.minY), size: source.field.size)
            clip.addSubview(view)
            overlay.addSubview(clip)
            snapshot = clip
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Motion.patience) { [weak self] in
            guard let self, !landed else { return }
            letGo()
        }
    }

    /// The composer's words and its input field, in `host`. A draft taller
    /// than the field is never laid out here: the field's own picture of it
    /// stands in, at no cost to the main thread.
    static func source(from card: AgentInputCardView, in host: UIView) -> Source {
        let view = card.textView
        let field = view.convert(view.bounds, to: host)
        let hasText = (view.attributedText?.length ?? 0) > 0
        let scrolls = hasText && view.contentSize.height > view.bounds.height + 0.5
        if scrolls || !hasText {
            let layout = SendFlightLayout.Source(screen: host.bounds, field: field, text: nil, scrolls: scrolls)
            let snapshot = layout.snapshot == nil ? nil : view.snapshotView(afterScreenUpdates: false)
            return Source(text: nil, textOrigin: field.origin, field: field, snapshot: snapshot, layout: layout)
        }
        let inset = view.textContainerInset
        let width = view.textContainer.size.width
        let text = view.attributedText.map { ChatTextLayout($0, width: width) }
        let origin = view.convert(CGPoint(x: inset.left + view.textContainer.lineFragmentPadding, y: inset.top), to: host)
        let frame = text.map { CGRect(origin: origin, size: $0.size) }
        let layout = SendFlightLayout.Source(screen: host.bounds, field: field, text: frame, scrolls: false)
        let snapshot = layout.snapshot == nil ? nil : view.snapshotView(afterScreenUpdates: false)
        return Source(text: layout.words == nil ? nil : text, textOrigin: origin, field: field, snapshot: snapshot, layout: layout)
    }

    /// A quick reply's pill and its words, in `host`: the bubble grows
    /// from the pill as it would from the input field (whose edge it
    /// widens by the bubble's padding, the pill's own), and the words
    /// leave the pill.
    static func source(pill: CGRect, label: CGRect, text: ChatTextLayout, in host: UIView) -> Source {
        let field = pill.insetBy(dx: label.minX - pill.minX, dy: 0)
        let layout = SendFlightLayout.Source(screen: host.bounds, field: field, text: label, scrolls: false)
        return Source(text: layout.words == nil ? nil : text, textOrigin: label.origin, field: field, snapshot: nil, layout: layout)
    }

    /// Whether the transition may fly at all: not for a reader up in history
    /// (`distance` from the end), nor with Reduce Motion on.
    static func flies(distance: CGFloat) -> Bool {
        SendFollow.Send(distanceFromEnd: distance).flies && !UIAccessibility.isReduceMotionEnabled
    }

    /// The id the send was given, once it is known.
    func identify(_ message: String) {
        if self.message == nil { self.message = message }
    }

    /// Whether `plan`, new in the list, is the row this send is waiting for.
    func awaits(_ plan: ChatRowPlan) -> Bool {
        guard !landed, !finished, plan.flight != nil else { return false }
        return message == nil || message == plan.id
    }

    /// Lands the copy of `plan` on `row`, which is laid out where it ends,
    /// veiled. `drawn` says when the row has drawn itself; `reveal` shows it.
    func land(on row: UIView, plan: ChatRowPlan, drawn: @escaping () -> Bool, reveal: @escaping () -> Void) {
        guard !landed, !finished, let flight = plan.flight else { return }
        landed = true
        message = plan.id
        self.row = row
        let frame = row.convert(row.bounds, to: host)
        target = frame
        if SendFlightLayout(screen: host.bounds, row: frame, source: source.layout, media: flight.media).style == .slide {
            words.removeFromSuperview()
            fadeSnapshot()
            reveal()
            fadeAndSlide(row, flight: flight)
            if snapshot == nil { finish() }
            return
        }
        let container = UIView(frame: frame)
        container.isUserInteractionEnabled = false
        self.container = container
        overlay.addSubview(container)

        // The bubble, the words and the time each have a view of their own,
        // each moving as Telegram's do.
        let bubble = UIView()
        style(bubble, flight.bubble)
        self.bubble = bubble
        let statusFrame = flight.status ?? .null
        func inStatus(_ item: ChatDrawItem) -> Bool {
            switch item {
            case .delivery: true
            case .text(_, let frame): statusFrame.contains(frame)
            default: false
            }
        }
        let bubbleIndex = plan.items.firstIndex { if case .box(let box) = $0 { box.frame == flight.bubble.frame } else { false } }
        let rest = plan.items.enumerated().filter { $0.offset != bubbleIndex && !inStatus($0.element) }.map(\.element)
        let body = ChatPlanView(frame: CGRect(origin: .zero, size: plan.size))
        body.apply(ChatRowPlan(id: "\(plan.id)#flight", size: plan.size, items: rest))
        self.body = body
        let status = ChatPlanView(frame: CGRect(origin: .zero, size: plan.size))
        status.apply(ChatRowPlan(id: "\(plan.id)#flight-status", size: plan.size, items: plan.items.filter(inStatus)))
        container.addSubview(bubble)
        container.addSubview(body)
        container.addSubview(status)

        // The bubble's foot and left edge start on the input field's.
        let field = source.field.insetBy(dx: -(flight.text.map { $0.minX - flight.bubble.frame.minX } ?? 0), dy: 0)
        let landing = flight.bubble.frame
        let shift = CGPoint(x: field.minX - (frame.minX + landing.minX), y: field.maxY - (frame.minY + landing.maxY))
        let start = CGRect(x: landing.minX, y: landing.maxY - field.height, width: field.width, height: field.height)

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        CATransaction.setCompletionBlock { [weak self] in
            self?.settle(drawn: drawn, reveal: reveal, waited: 0)
        }
        container.layer.add(Self.additive("position.x", from: shift.x, timing: Motion.horizontal), forKey: "flight.x")
        container.layer.add(Self.additive("position.y", from: shift.y, timing: Motion.vertical), forKey: "flight.y")
        Self.animateFrame(bubble.layer, from: start, to: landing)
        bubble.layer.add(Self.fade(from: 0, to: 1, duration: Motion.bubbleFade), forKey: "flight.fade")

        // The words: from where the composer had them to the bubble's.
        if words.superview != nil, let text = flight.text {
            let from = CGPoint(x: source.textOrigin.x - frame.minX - shift.x, y: source.textOrigin.y - frame.minY - shift.y)
            let offset = CGPoint(x: from.x - text.minX, y: from.y - text.minY)
            body.layer.add(Self.additive("position.x", from: offset.x, timing: Motion.vertical), forKey: "flight.x")
            body.layer.add(Self.additive("position.y", from: offset.y, timing: Motion.vertical), forKey: "flight.y")
            body.layer.add(Self.fade(from: 0, to: 1, duration: Motion.textFade), forKey: "flight.fade")
            container.addSubview(words)
            words.frame = CGRect(origin: CGPoint(x: text.minX, y: text.minY), size: words.bounds.size)
            words.layer.add(Self.additive("position.x", from: offset.x, timing: Motion.horizontal), forKey: "flight.x")
            words.layer.add(Self.additive("position.y", from: offset.y, timing: Motion.vertical), forKey: "flight.y")
            words.layer.opacity = 0
            words.layer.add(Self.fade(from: 1, to: 0, duration: Motion.sourceFade), forKey: "flight.fade")
        } else {
            words.removeFromSuperview()
            body.layer.add(Self.fade(from: 0, to: 1, duration: Motion.textFade), forKey: "flight.fade")
        }
        // The time comes in from the input field's right edge.
        status.layer.add(Self.fade(from: 0, to: 1, duration: Motion.statusFade), forKey: "flight.fade")
        status.layer.add(Self.additive("position.x", from: -(landing.width - field.width), timing: Motion.horizontal), forKey: "flight.x")
        CATransaction.commit()
    }

    /// The row moved under the copy outside the flight (an inset pass on
    /// `list`): the copy moves with it, on the list's own motion.
    func follow(in list: UltraListView) {
        guard let container, let row, let target, !finished else { return }
        let frame = row.convert(row.bounds, to: host)
        let moved = frame.minY - target.minY
        guard abs(moved) > 0.01 else { return }
        self.target = frame
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        container.layer.position.y += moved
        CATransaction.commit()
        list.applyViewportMotion(to: container.layer, keyPath: "position.y", displacement: -moved)
    }

    /// Lets go of the flight at once: its row shows, the copy goes.
    func cancel() {
        guard !finished else { return }
        finish()
    }

    private func settle(drawn: @escaping () -> Bool, reveal: @escaping () -> Void, waited: TimeInterval) {
        guard !finished else { return }
        // A row not yet drawn would show its background first: the copy
        // stays over it a few frames more.
        if !drawn(), waited < Motion.revealWait {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60) { [weak self] in
                self?.settle(drawn: drawn, reveal: reveal, waited: waited + 1.0 / 60)
            }
            return
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        reveal()
        finish()
        CATransaction.commit()
    }

    /// The row never came: the composer's words fade where they are.
    private func letGo() {
        guard !finished else { return }
        words.layer.opacity = 0
        words.layer.add(Self.fade(from: 1, to: 0, duration: Motion.sourceFade), forKey: "flight.fade")
        fadeSnapshot()
        DispatchQueue.main.asyncAfter(deadline: .now() + Motion.sourceFade) { [weak self] in self?.finish() }
    }

    /// What the field showed of a scrolled draft fades where it was, and
    /// the flight is over once it has.
    private func fadeSnapshot() {
        guard let snapshot, snapshot.layer.animation(forKey: "flight.fade") == nil else { return }
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in self?.finish() }
        snapshot.layer.opacity = 0
        snapshot.layer.add(Self.fade(from: 1, to: 0, duration: Motion.sourceFade), forKey: "flight.fade")
        CATransaction.commit()
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        overlay.removeFromSuperview()
        onFinish?()
        onFinish = nil
    }

    /// Telegram's media send: the row fades in as it comes up from the composer.
    private func fadeAndSlide(_ row: UIView, flight: ChatRowFlight) {
        guard let target else { return }
        let rise = source.field.maxY - (target.minY + flight.bubble.frame.maxY)
        guard let content = row.subviews.first else { return }
        // It comes up from behind the composer, past the row's own edge.
        let clips = row.clipsToBounds
        row.clipsToBounds = false
        // Upright in the row, a rise on screen is a rise in it.
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak row] in row?.clipsToBounds = clips }
        content.layer.add(Self.additive("position.y", from: max(0, rise), timing: Motion.vertical), forKey: "flight.y")
        content.layer.add(Self.fade(from: 0, to: 1, duration: Motion.mediaFade), forKey: "flight.fade")
        CATransaction.commit()
    }

    private func style(_ view: UIView, _ box: ChatBox) {
        view.frame = box.frame
        view.backgroundColor = box.fill.map { UIColor($0) } ?? .clear
        view.layer.cornerRadius = box.radius
        view.layer.maskedCorners = box.corners
        view.layer.cornerCurve = .continuous
        view.layer.borderWidth = box.borderWidth
        view.layer.borderColor = box.border.map { UIColor($0).resolvedColor(with: host.traitCollection).cgColor }
    }

    private static func additive(_ keyPath: String, from offset: CGFloat, timing: CAMediaTimingFunction) -> CABasicAnimation {
        let animation = CABasicAnimation(keyPath: keyPath)
        animation.fromValue = offset
        animation.toValue = 0
        animation.isAdditive = true
        animation.duration = Motion.duration
        animation.timingFunction = timing
        animation.fillMode = .backwards
        return animation
    }

    private static func fade(from: Float, to: Float, duration: CFTimeInterval) -> CABasicAnimation {
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = from
        animation.toValue = to
        animation.duration = duration
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        animation.fillMode = .backwards
        return animation
    }

    /// A frame's change as Telegram's CombinedTransition makes it: across
    /// on the horizontal curve, up and down on the vertical one.
    private static func animateFrame(_ layer: CALayer, from: CGRect, to: CGRect) {
        layer.add(additive("position.x", from: from.midX - to.midX, timing: Motion.horizontal), forKey: "flight.x")
        layer.add(additive("position.y", from: from.midY - to.midY, timing: Motion.vertical), forKey: "flight.y")
        layer.add(additive("bounds.size.width", from: from.width - to.width, timing: Motion.horizontal), forKey: "flight.width")
        layer.add(additive("bounds.size.height", from: from.height - to.height, timing: Motion.vertical), forKey: "flight.height")
    }
}
#endif

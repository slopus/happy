#if canImport(UIKit)
import HappyLayout
import UIKit

/// The mark at the foot of a person's own bubble, after its time: the
/// clock while it is on its way, one check when it arrived, two when the
/// agent took it, a red mark when it was refused. Its frames are in the
/// item's own frame, which is the slot after the time.
struct ChatDeliveryMark: Equatable, Sendable {
    var state: MessageDelivery
    var tint: ColorToken
    /// The message it marks. Its mark moving on animates; a pooled view
    /// that shows another message's shows it at once.
    var message: String
    var clock: CGRect
    var sentCheck: CGRect
    var readCheck: CGRect

    /// The time and the mark of `status` placed at `box`, in row
    /// coordinates: the time is drawn with the row, the mark live over it.
    static func items(_ status: MessageStatusLayout, box: CGRect, time: ChatTextLayout?, state: MessageDelivery, tint: ColorToken, message: String) -> (items: [ChatDrawItem], mark: CGRect) {
        // One frame for every state: what any of the marks may draw over,
        // out to whole points, so snapping the view to pixels never cuts
        // into a mark drawn at another text size.
        let exact = status.mark.offsetBy(dx: box.minX, dy: box.minY)
        let frame = CGRect(x: exact.minX.rounded(.down), y: exact.minY.rounded(.down),
                           width: exact.maxX.rounded(.up) - exact.minX.rounded(.down), height: exact.maxY.rounded(.up) - exact.minY.rounded(.down))
        let (dx, dy) = (box.minX - frame.minX, box.minY - frame.minY)
        let mark = ChatDeliveryMark(
            state: state, tint: tint, message: message,
            clock: status.clock.offsetBy(dx: dx, dy: dy),
            sentCheck: status.sentCheck.offsetBy(dx: dx, dy: dy),
            readCheck: status.readCheck.offsetBy(dx: dx, dy: dy)
        )
        var items: [ChatDrawItem] = []
        if let time { items.append(.text(time, status.time.offsetBy(dx: box.minX, dy: box.minY))) }
        items.append(.delivery(mark, frame: frame))
        return (items, frame)
    }
}

/// A message's time as the bubble shows it: hours and minutes, the
/// locale's way, in tabular digits, so times of one format are one width.
/// Safe off main.
enum MessageTime {
    private static let formatter = makeFormatter(.autoupdatingCurrent)

    /// Hours and minutes in `locale`'s clock, 12 or 24 hours.
    static func makeFormatter(_ locale: Locale, timeZone: TimeZone = .autoupdatingCurrent) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateFormat = DateFormatter.dateFormat(fromTemplate: "jmm", options: 0, locale: locale) ?? "HH:mm"
        return formatter
    }

    /// `milliseconds` since 1970.
    static func string(_ milliseconds: Double) -> String {
        formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1000))
    }

    /// `messageTime` at the row's text size with every digit one width
    /// (Telegram's date node draws its digits monospaced too).
    static func attributed(_ text: String, ink: ColorToken, in environment: TextEnvironment?) -> NSAttributedString {
        let style = ChatTextStyles.messageTime
        let size = environment.map { style.scaled($0.scale).size } ?? style.size
        let font = UIFont.monospacedDigitSystemFont(ofSize: size, weight: .regular)
        return NSAttributedString(string: text, attributes: style.attributes(color: UIColor(ink), font: font, lineBreakMode: .byClipping, in: environment))
    }

    /// The time measured in the bubble's style at the row's text size, in `ink`.
    static func text(_ milliseconds: Double?, ink: ColorToken, in environment: TextEnvironment?) -> ChatTextLayout? {
        guard let milliseconds else { return nil }
        return ChatTextLayout(attributed(string(milliseconds), ink: ink, in: environment), width: 1000, maxLines: 1)
    }

    /// The status box around `text`, its marks at the row's text size: a
    /// message with no time (one kept before times were) keeps the line's
    /// height for its mark.
    static func status(_ text: ChatTextLayout?, in environment: TextEnvironment?) -> MessageStatusLayout {
        let time = text?.size ?? CGSize(width: 0, height: ChatTextLayout(attributed("0", ink: Palette.deliveryInk, in: environment), width: 1000, maxLines: 1).size.height)
        return MessageStatusLayout(time: time, scale: environment?.scale.effective(maxScale: ChatTextStyles.messageTime.maxScale) ?? 1)
    }
}

/// Telegram's outgoing status marks, live over a row's drawing: the
/// clock's two hands turning while the message is on its way, every
/// clock in step, and each check popping in as it comes.
final class ChatDeliveryView: UIView {
    private enum Motion {
        /// The frame with the hour hand goes round once in 6 s, the minute
        /// hand in 1 s.
        static let hourPeriod: CFTimeInterval = 6
        static let minutePeriod: CFTimeInterval = 1
        /// Every clock's turn counts from the same moment, long past.
        static let epoch: CFTimeInterval = 1
        static let popScale: CGFloat = 1.3
        static let popDuration: CFTimeInterval = 0.1
        static let turnKey = "delivery.turn"
        static let popKey = "delivery.pop"
    }

    /// The circle, and the hour hand inside it, turn together.
    private let clockFrame = CAShapeLayer()
    private let clockHour = CAShapeLayer()
    private let clockMinute = CAShapeLayer()
    private let sent = CAShapeLayer()
    private let read = CAShapeLayer()
    private let failed = CAShapeLayer()
    private let failedBang = CAShapeLayer()
    private(set) var mark: ChatDeliveryMark?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        for layer in [clockFrame, clockMinute, sent, read, failed, failedBang] {
            layer.contentsScale = UIScreen.main.scale
            self.layer.addSublayer(layer)
        }
        for check in [sent, read] {
            check.fillColor = nil
            check.lineWidth = 0.99
            check.lineCap = .round
            check.lineJoin = .round
        }
        clockFrame.lineWidth = 1
        clockFrame.fillColor = nil
        clockHour.contentsScale = UIScreen.main.scale
        clockFrame.addSublayer(clockHour)
        sent.path = Self.fullCheck
        read.path = Self.partialCheck
        clockFrame.path = Self.clockFrame
        clockHour.path = Self.clockHour
        clockMinute.path = Self.clockMinute
        failedBang.path = Self.bang
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// Shows `mark`; nil puts the view away.
    func apply(_ mark: ChatDeliveryMark?) {
        let before = self.mark
        self.mark = mark
        guard let mark else {
            stopTurning()
            return
        }
        // The same message moving on animates, as Telegram's status does
        // when its message is updated; a view shown again doesn't.
        let moves = before?.message == mark.message && window != nil && !UIAccessibility.isReduceMotionEnabled
        let showedSent = before?.message == mark.message && (before?.state == .received || before?.state == .accepted)
        let showedRead = before?.message == mark.message && before?.state == .accepted
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let ink = UIColor(mark.tint).resolvedColor(with: traitCollection).cgColor
        clockFrame.strokeColor = ink
        clockHour.fillColor = ink
        clockMinute.fillColor = ink
        sent.strokeColor = ink
        read.strokeColor = ink
        failed.fillColor = UIColor(Palette.deliveryFailed).resolvedColor(with: traitCollection).cgColor
        failedBang.fillColor = UIColor.white.cgColor
        scale(to: mark.clock.width / MessageStatusLayout.Metrics.clock)
        place(clockFrame, mark.clock)
        clockHour.frame = CGRect(origin: .zero, size: mark.clock.size)
        place(clockMinute, mark.clock)
        place(sent, mark.sentCheck)
        place(read, mark.readCheck)
        // The failed disc is the clock's square, so it takes no more room.
        place(failed, mark.clock)
        place(failedBang, mark.clock)
        failed.path = CGPath(ellipseIn: CGRect(origin: .zero, size: mark.clock.size), transform: nil)

        let sending = mark.state == .sending
        clockFrame.isHidden = !sending
        clockMinute.isHidden = !sending
        sent.isHidden = !(mark.state == .received || mark.state == .accepted)
        read.isHidden = mark.state != .accepted
        failed.isHidden = mark.state != .failed
        failedBang.isHidden = mark.state != .failed
        if sending { startTurning() } else { stopTurning() }
        CATransaction.commit()
        if moves {
            if !sent.isHidden && !showedSent { pop(sent) }
            if !read.isHidden && !showedRead { pop(read) }
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Core Animation drops an animation when its layer leaves the window.
        if window != nil, mark?.state == .sending {
            stopTurning()
            startTurning()
        }
    }

    /// The marks are drawn at the 17-point base; at another text size
    /// their paths and lines grow with the slot.
    private var scale: CGFloat = 1

    private func scale(to next: CGFloat) {
        guard next > 0, next != scale else { return }
        scale = next
        var transform = CGAffineTransform(scaleX: next, y: next)
        func scaled(_ path: CGPath) -> CGPath { path.copy(using: &transform) ?? path }
        sent.path = scaled(Self.fullCheck)
        read.path = scaled(Self.partialCheck)
        clockFrame.path = scaled(Self.clockFrame)
        clockHour.path = scaled(Self.clockHour)
        clockMinute.path = scaled(Self.clockMinute)
        failedBang.path = scaled(Self.bang)
        sent.lineWidth = 0.99 * next
        read.lineWidth = 0.99 * next
        clockFrame.lineWidth = next
    }

    private func place(_ layer: CALayer, _ frame: CGRect) {
        layer.bounds = CGRect(origin: .zero, size: frame.size)
        layer.position = CGPoint(x: frame.midX, y: frame.midY)
    }

    private func startTurning() {
        turn(clockFrame, period: Motion.hourPeriod)
        turn(clockMinute, period: Motion.minutePeriod)
    }

    private func stopTurning() {
        clockFrame.removeAnimation(forKey: Motion.turnKey)
        clockMinute.removeAnimation(forKey: Motion.turnKey)
    }

    private func turn(_ layer: CALayer, period: CFTimeInterval) {
        guard layer.animation(forKey: Motion.turnKey) == nil else { return }
        let animation = CABasicAnimation(keyPath: "transform.rotation.z")
        animation.fromValue = 0
        animation.toValue = CGFloat.pi * 2
        animation.duration = period
        animation.repeatCount = .infinity
        animation.timingFunction = CAMediaTimingFunction(name: .linear)
        animation.beginTime = Motion.epoch
        layer.add(animation, forKey: Motion.turnKey)
    }

    private func pop(_ layer: CALayer) {
        let animation = CABasicAnimation(keyPath: "transform.scale")
        animation.fromValue = Motion.popScale
        animation.toValue = 1
        animation.duration = Motion.popDuration
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.add(animation, forKey: Motion.popKey)
    }

    // The marks' shapes, in their own squares, at the 17-point base.

    /// A circle on a 1-point line.
    private static let clockFrame = CGPath(ellipseIn: CGRect(x: 0.5, y: 0.5, width: 10, height: 10), transform: nil)

    /// The hour hand, pointing down from the middle.
    private static let clockHour = CGPath(rect: CGRect(x: 5, y: 5.5, width: 1, height: 2.5), transform: nil)

    /// The minute hand, pointing right from the middle.
    private static let clockMinute: CGPath = CGPath(rect: CGRect(x: 5, y: 5, width: 4.5, height: 1), transform: nil)

    /// The full check, 11×9, its stroke a point in from the corner.
    private static let fullCheck: CGPath = {
        let path = CGMutablePath()
        path.move(to: CGPoint(x: 1, y: 5))
        path.addLine(to: CGPoint(x: 3.95157047, y: 7.95157047))
        path.addCurve(to: CGPoint(x: 4.04490857, y: 7.95157047), control1: CGPoint(x: 3.97734507, y: 7.97734507), control2: CGPoint(x: 4.01913396, y: 7.97734507))
        path.addCurve(to: CGPoint(x: 4.04660389, y: 7.9498112), control1: CGPoint(x: 4.04548448, y: 7.95099456), control2: CGPoint(x: 4.04604969, y: 7.95040803))
        path.addLine(to: CGPoint(x: 10.5, y: 1))
        return path
    }()

    /// The second check: its long stroke only.
    private static let partialCheck: CGPath = {
        let path = CGMutablePath()
        path.move(to: CGPoint(x: 1.5, y: 8))
        path.addLine(to: CGPoint(x: 8, y: 1))
        return path
    }()

    /// "!" in the failed disc.
    private static let bang: CGPath = {
        let path = CGMutablePath()
        path.addRoundedRect(in: CGRect(x: 4.75, y: 2.25, width: 1.5, height: 4.5), cornerWidth: 0.75, cornerHeight: 0.75)
        path.addEllipse(in: CGRect(x: 4.75, y: 7.5, width: 1.5, height: 1.5))
        return path
    }()
}
#endif

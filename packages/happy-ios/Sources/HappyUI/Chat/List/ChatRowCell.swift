#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// The one cell every row uses: it draws a `ChatRowPlan` with a pool of
/// plain views (boxes, text, icons) it reuses from row to row. It measures
/// nothing and lays out nothing of its own.
final class ChatRowCell: UICollectionViewCell {
    static let reuseIdentifier = "ChatRowCell"

    private(set) var plan: ChatRowPlan?
    private var boxes: [UIView] = []
    private var texts: [ChatTextView] = []
    private var icons: [UIImageView] = []
    private var spinners: [UIActivityIndicatorView] = []
    private var timers: [ChatElapsedLabel] = []
    private var pulses: [ChatPulseView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        isAccessibilityElement = true
        accessibilityTraits = .staticText
        // CGColor borders don't follow the appearance by themselves.
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            guard let plan = self.plan else { return }
            self.plan = nil
            self.apply(plan)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ plan: ChatRowPlan) {
        guard plan !== self.plan else { return }
        self.plan = plan
        contentView.alpha = plan.alpha
        accessibilityLabel = plan.accessibilityLabel

        // Views are taken in draw order; keeping them in one subview order
        // means a box always sits under the text that follows it.
        var boxIndex = 0
        var textIndex = 0
        var iconIndex = 0
        var spinnerIndex = 0
        var timerIndex = 0
        var pulseIndex = 0
        var order: [UIView] = []
        for item in plan.items {
            switch item {
            case .box(let box):
                let view = take(&boxes, &boxIndex) { UIView() }
                style(view, box)
                order.append(view)
            case .text(let layout, let frame):
                let view = take(&texts, &textIndex) { ChatTextView() }
                view.isAccessibilityElement = false
                view.setLayoutFrame(frame)
                view.layout = layout
                order.append(view)
            case .icon(let icon, let size, let frame, let tint):
                let view = take(&icons, &iconIndex) { UIImageView() }
                view.contentMode = .center
                view.image = .icon(icon, size: size)
                view.tintColor = UIColor(tint)
                view.setLayoutFrame(frame)
                order.append(view)
            case .spinner(let frame, let tint, let scale):
                let view = take(&spinners, &spinnerIndex) { UIActivityIndicatorView(style: .medium) }
                view.bounds = CGRect(origin: .zero, size: frame.size)
                view.center = CGPoint(x: frame.midX, y: frame.midY)
                view.transform = CGAffineTransform(scaleX: scale, y: scale)
                view.color = UIColor(tint)
                view.startAnimating()
                order.append(view)
            case .elapsed(let since, let frame):
                let view = take(&timers, &timerIndex) { ChatElapsedLabel() }
                view.setLayoutFrame(frame)
                view.since = since
                order.append(view)
            case .pulse(let box):
                let view = take(&pulses, &pulseIndex) { ChatPulseView() }
                style(view, box)
                view.startPulsing()
                order.append(view)
            }
        }
        for view in boxes[boxIndex...] { view.isHidden = true }
        for view in texts[textIndex...] { view.isHidden = true }
        for view in icons[iconIndex...] { view.isHidden = true }
        for view in spinners[spinnerIndex...] {
            view.stopAnimating()
            view.isHidden = true
        }
        for view in timers[timerIndex...] {
            view.since = nil
            view.isHidden = true
        }
        for view in pulses[pulseIndex...] {
            view.stopPulsing()
            view.isHidden = true
        }
        for view in order {
            view.isHidden = false
            contentView.bringSubviewToFront(view)
        }
    }

    private func style(_ view: UIView, _ box: ChatBox) {
        view.setLayoutFrame(box.frame)
        view.backgroundColor = box.fill.map { UIColor($0) } ?? .clear
        view.alpha = box.alpha
        view.layer.cornerRadius = box.radius
        view.layer.maskedCorners = box.corners
        view.layer.cornerCurve = .continuous
        view.layer.borderWidth = box.borderWidth
        view.layer.borderColor = box.border.map { UIColor($0).resolvedColor(with: traitCollection).cgColor }
    }

    private func take<View: UIView>(_ pool: inout [View], _ index: inout Int, make: () -> View) -> View {
        if index == pool.count {
            let view = make()
            pool.append(view)
            contentView.addSubview(view)
        }
        defer { index += 1 }
        return pool[index]
    }

    /// What a tap at `point` (in this cell) does, if anything.
    func action(at point: CGPoint) -> ChatRowAction? {
        guard let plan else { return nil }
        return plan.hits.first { $0.frame.contains(point) }?.action
    }

    /// The link under `point`, if the tap landed on one.
    func link(at point: CGPoint) -> String? {
        for view in texts where !view.isHidden && view.frame.contains(point) {
            if let link = view.link(at: CGPoint(x: point.x - view.frame.minX, y: point.y - view.frame.minY)) {
                return link
            }
        }
        return nil
    }
}

/// ToolView's ElapsedView: whole seconds since the tool started, ticking
/// once a second while on screen ("12.0s", useElapsedTime + toFixed(1)).
final class ChatElapsedLabel: UILabel {
    var since: Int64? {
        didSet {
            guard since != oldValue else { return }
            tick()
            updateTimer()
        }
    }

    private var timer: Timer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        font = ChatTextStyles.toolElapsed.font
        textColor = UIColor(Palette.textSecondary)
        textAlignment = .right
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateTimer()
    }

    private func updateTimer() {
        let running = since != nil && window != nil
        if running && timer == nil {
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
            tick()
        } else if !running {
            timer?.invalidate()
            timer = nil
        }
    }

    private func tick() {
        guard let since else {
            text = nil
            return
        }
        let seconds = max(0, (Int64(Date().timeIntervalSince1970 * 1000) - since) / 1000)
        text = "\(seconds).0s"
    }
}

/// PermissionFooter's loading ring: its opacity runs 0.18 → 0.52 → 0.18,
/// 720 ms each way.
final class ChatPulseView: UIView {
    private static let key = "pulse"

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func startPulsing() {
        guard layer.animation(forKey: Self.key) == nil else { return }
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = 0.18
        animation.toValue = 0.52
        animation.duration = 0.72
        animation.autoreverses = true
        animation.repeatCount = .infinity
        animation.timingFunction = CAMediaTimingFunction(controlPoints: 0.455, 0.03, 0.515, 0.955)
        animation.isRemovedOnCompletion = false
        layer.add(animation, forKey: Self.key)
    }

    func stopPulsing() {
        layer.removeAnimation(forKey: Self.key)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Core Animation drops an animation when its layer leaves the window.
        if window != nil && !isHidden {
            stopPulsing()
            startPulsing()
        }
    }
}
#endif

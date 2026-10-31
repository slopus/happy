#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// Telegram's radial status over a sending photo (`RadialStatusNode`,
/// `RadialProgressContentNode`): a dark disc, the share of bytes sent as
/// a white arc that turns while it fills, a cross to take the picture out.
/// Waiting its turn, a short arc turns; failed, a retry arrow.
final class UploadRingView: UIView {
    enum State: Equatable {
        case waiting
        case progress(Double)
        case failed
        case done
    }

    private let disc = UIView()
    private let arc = CAShapeLayer()
    private let cross = CAShapeLayer()
    private let retry = UIImageView()
    private(set) var state: State = .waiting
    /// The share the arc is drawn to now (or heading to).
    private(set) var shown: Double = 0
    /// How far round the arc is drawn, for tests.
    var drawn: CGFloat { arc.strokeEnd }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        disc.isUserInteractionEnabled = false
        addSubview(disc)
        for shape in [arc, cross] {
            shape.fillColor = nil
            shape.lineCap = .round
            disc.layer.addSublayer(shape)
        }
        arc.strokeStart = 0
        // It starts out waiting, so the short arc, not a whole ring.
        arc.strokeEnd = UploadRingLayout.waitingShare
        retry.contentMode = .center
        retry.isHidden = true
        disc.addSubview(retry)
        updateColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.updateColors() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func updateColors() {
        disc.backgroundColor = UIColor(Palette.uploadDisc)
        let ink = UIColor(Palette.uploadInk).resolvedColor(with: traitCollection).cgColor
        arc.strokeColor = ink
        cross.strokeColor = ink
        retry.tintColor = UIColor(Palette.uploadInk)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = min(bounds.width, bounds.height)
        guard side > 0, disc.bounds.width != side else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        disc.frame = CGRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side)
        disc.layer.cornerRadius = side / 2
        let factor = UploadRingLayout.factor(side)
        let center = CGPoint(x: side / 2, y: side / 2)
        arc.frame = disc.bounds
        arc.lineWidth = max(1.6, UploadRingLayout.lineWidth * factor)
        arc.path = UIBezierPath(arcCenter: center, radius: UploadRingLayout.arcRadius(side), startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: true).cgPath
        cross.frame = disc.bounds
        cross.lineWidth = max(1.3, UploadRingLayout.crossLine * factor)
        let arm = UploadRingLayout.cross * factor / 2
        let path = UIBezierPath()
        path.move(to: CGPoint(x: center.x - arm, y: center.y - arm))
        path.addLine(to: CGPoint(x: center.x + arm, y: center.y + arm))
        path.move(to: CGPoint(x: center.x + arm, y: center.y - arm))
        path.addLine(to: CGPoint(x: center.x - arm, y: center.y + arm))
        cross.path = path.cgPath
        retry.frame = disc.bounds
        retry.image = .icon(.ionicons("refresh"), size: (side * 0.48).rounded())
        CATransaction.commit()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        turn()
    }

    /// Shows `state`; `animated` tweens the arc as Telegram does and lets a
    /// finished ring shrink away.
    func set(_ state: State, animated: Bool) {
        guard state != self.state else { return }
        let was = self.state
        self.state = state
        switch state {
        case .waiting:
            show()
            arc.isHidden = false; cross.isHidden = false; retry.isHidden = true
            stroke(to: UploadRingLayout.waitingShare, animated: false)
        case .progress(let share):
            show()
            arc.isHidden = false; cross.isHidden = false; retry.isHidden = true
            // From waiting's short arc, the real share starts from nothing.
            if was == .waiting || was == .failed || was == .done { stroke(to: 0, animated: false) }
            stroke(to: share, animated: animated)
        case .failed:
            show()
            arc.isHidden = true; cross.isHidden = true; retry.isHidden = false
        case .done:
            stroke(to: 1, animated: animated)
            guard animated else { isHidden = true; return }
            // Telegram's way out: the cross shrinks and the disc fades.
            UIView.animate(withDuration: 0.25, delay: UploadRingLayout.tween(from: shown, to: 1)) {
                self.alpha = 0
                self.disc.transform = CGAffineTransform(scaleX: 0.2, y: 0.2)
            } completion: { _ in
                guard self.state == .done else { return }
                self.isHidden = true
            }
        }
        turn()
    }

    private func show() {
        layer.removeAllAnimations()
        disc.layer.removeAllAnimations()
        isHidden = false
        alpha = 1
        disc.transform = .identity
    }

    private func stroke(to share: Double, animated: Bool) {
        let from = arc.presentation()?.strokeEnd ?? arc.strokeEnd
        arc.removeAnimation(forKey: "share")
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        arc.strokeEnd = CGFloat(share)
        CATransaction.commit()
        if animated {
            let tween = CABasicAnimation(keyPath: "strokeEnd")
            tween.fromValue = from
            tween.toValue = CGFloat(share)
            tween.duration = UploadRingLayout.tween(from: Double(from), to: share)
            tween.timingFunction = CAMediaTimingFunction(name: .linear)
            arc.add(tween, forKey: "share")
        }
        shown = share
    }

    /// Turns once every 1.5 s while it has something to show, as Telegram's does.
    private func turn() {
        let turning = window != nil && (state == .waiting || { if case .progress = state { true } else { false } }())
        if !turning {
            arc.removeAnimation(forKey: "turn")
        } else if arc.animation(forKey: "turn") == nil {
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = 2 * Double.pi
            spin.duration = 1.5
            spin.repeatCount = .infinity
            spin.isRemovedOnCompletion = false
            spin.timingFunction = CAMediaTimingFunction(name: .linear)
            arc.add(spin, forKey: "turn")
        }
    }
}

/// The tiles showing a sending picture, by its key, and the one drain of
/// `UploadProgressBoard` a frame that moves their rings: however fast the
/// bytes go, each ring is touched at most once a frame, with its latest
/// share, and nothing else on screen is.
@MainActor
final class UploadRings {
    static let shared = UploadRings(board: .shared)

    private let board: UploadProgressBoard
    private let tiles = NSMapTable<NSString, ChatMediaView>.strongToWeakObjects()
    private var link: CADisplayLink?
    /// Applies a frame has made, for tests.
    private(set) var applied = 0

    init(board: UploadProgressBoard) {
        self.board = board
        board.observe { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.wake() } }
        }
        // Whatever changed before anyone watched.
        wake()
    }

    func phase(_ key: String) -> UploadPhase? { board.phase(key) }

    func show(_ tile: ChatMediaView, key: String) { tiles.setObject(tile, forKey: key as NSString) }

    func forget(_ tile: ChatMediaView, key: String) {
        if tiles.object(forKey: key as NSString) === tile { tiles.removeObject(forKey: key as NSString) }
    }

    private func wake() {
        if link == nil {
            let link = CADisplayLink(target: self, selector: #selector(frame))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
        link?.isPaused = false
    }

    @objc private func frame() {
        link?.isPaused = true
        drain()
    }

    /// Everything that changed since the last frame, each to its own tile.
    func drain() {
        for (key, phase) in board.drain() {
            guard let tile = tiles.object(forKey: key as NSString) else { continue }
            tile.setUpload(phase, animated: true)
            applied += 1
        }
    }
}
#endif

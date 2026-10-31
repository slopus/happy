#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// Telegram's radial status over chat media (`RadialStatusNode`,
/// `RadialProgressContentNode`), one component for a file on its way out
/// and on its way in: a dark disc, the share of bytes moved as a white
/// arc that turns while it fills, a cross to stop it. Waiting its turn, a
/// short arc turns; failed, a retry arrow. A file not here yet shows the
/// download arrow; a video, the play glyph, with the arc round it while
/// it downloads, and a small spinner from a tap on it until it can play.
final class MediaRingView: UIView {
    enum State: Equatable {
        case waiting
        case progress(Double)
        case failed
        case done
        /// Not on this phone: a tap reads it.
        case download
        /// A video, ready to play from what is here and what streams in.
        case play
        /// A video while it downloads: the play glyph inside the arc (nil:
        /// its size isn't known yet, so the short arc turns).
        case playing(Double?)
        /// A video asked to play, while its first playable range comes: a
        /// small arc turning on its own, inside where the play glyph was.
        case starting
    }

    /// The disc and what is drawn on it.
    struct Colors: Equatable {
        var disc: ColorToken
        var ink: ColorToken
        static let overMedia = Colors(disc: Palette.uploadDisc, ink: Palette.uploadInk)
        static let onCard = Colors(disc: Palette.fileRingDisc, ink: Palette.fileRingInk)
    }

    private let disc = UIView()
    private let arc = CAShapeLayer()
    /// The small spinner of a video starting to play.
    private let spinner = CAShapeLayer()
    private let cross = CAShapeLayer()
    private let arrow = CAShapeLayer()
    private let retry = UIImageView()
    private let play = UIImageView()
    private(set) var state: State = .waiting
    /// The share the arc is drawn to now (or heading to).
    private(set) var shown: Double = 0
    /// How far round the arc is drawn, for tests.
    var drawn: CGFloat { arc.strokeEnd }
    var colors = Colors.overMedia {
        didSet { if colors != oldValue { updateColors() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        disc.isUserInteractionEnabled = false
        addSubview(disc)
        for shape in [arc, cross, arrow, spinner] {
            shape.fillColor = nil
            shape.lineCap = .round
            shape.lineJoin = .round
            disc.layer.addSublayer(shape)
        }
        arc.strokeStart = 0
        // It starts out waiting, so the short arc, not a whole ring.
        arc.strokeEnd = UploadRingLayout.waitingShare
        arrow.isHidden = true
        spinner.isHidden = true
        spinner.strokeStart = 0
        spinner.strokeEnd = 0.7
        for glyph in [retry, play] {
            glyph.contentMode = .center
            glyph.isHidden = true
            disc.addSubview(glyph)
        }
        updateColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.updateColors() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func updateColors() {
        disc.backgroundColor = UIColor(colors.disc)
        let ink = UIColor(colors.ink).resolvedColor(with: traitCollection).cgColor
        arc.strokeColor = ink
        cross.strokeColor = ink
        arrow.strokeColor = ink
        spinner.strokeColor = ink
        retry.tintColor = UIColor(colors.ink)
        play.tintColor = UIColor(colors.ink)
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
        arrow.frame = disc.bounds
        arrow.lineWidth = cross.lineWidth
        let points = MediaStatusLayout.arrow(side: side)
        let arrowPath = UIBezierPath()
        arrowPath.move(to: points.shaft[0])
        arrowPath.addLine(to: points.shaft[1])
        arrowPath.move(to: points.head[0])
        arrowPath.addLine(to: points.head[1])
        arrowPath.addLine(to: points.head[2])
        arrow.path = arrowPath.cgPath
        spinner.frame = disc.bounds
        spinner.lineWidth = arc.lineWidth
        spinner.path = UIBezierPath(arcCenter: center, radius: MediaStatusLayout.spinnerRadius(side: side), startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: true).cgPath
        retry.frame = disc.bounds
        retry.image = .icon(.ionicons("refresh"), size: (side * 0.48).rounded())
        // The play glyph's triangle sits a little right of the middle, as it looks centred.
        play.frame = disc.bounds.offsetBy(dx: (side * 0.04).rounded(), dy: 0)
        play.image = .icon(.ionicons("play"), size: MediaStatusLayout.playGlyph(side: side))
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
        let wasProgress: Bool = switch was {
        case .progress, .playing(.some): true
        default: false
        }
        switch state {
        case .waiting:
            show(glyph: cross, arc: true)
            stroke(to: UploadRingLayout.waitingShare, animated: false)
        case .progress(let share):
            show(glyph: cross, arc: true)
            // From waiting's short arc, the real share starts from nothing.
            if !wasProgress { stroke(to: 0, animated: false) }
            stroke(to: share, animated: animated && wasProgress)
        case .playing(let share):
            show(glyph: play, arc: true)
            if let share {
                if !wasProgress { stroke(to: 0, animated: false) }
                stroke(to: share, animated: animated && wasProgress)
            } else {
                stroke(to: UploadRingLayout.waitingShare, animated: false)
            }
        case .failed:
            show(glyph: retry, arc: false)
        case .download:
            show(glyph: arrow, arc: false)
        case .play:
            show(glyph: play, arc: false)
        case .starting:
            show(glyph: spinner, arc: false)
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

    /// Which glyph shows, and whether the arc does.
    private func show(glyph: AnyObject, arc showsArc: Bool) {
        layer.removeAllAnimations()
        disc.layer.removeAllAnimations()
        isHidden = false
        alpha = 1
        disc.transform = .identity
        arc.isHidden = !showsArc
        cross.isHidden = glyph !== cross
        arrow.isHidden = glyph !== arrow
        spinner.isHidden = glyph !== spinner
        retry.isHidden = glyph !== retry
        play.isHidden = glyph !== play
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
        let turning: Bool = switch state {
        case .waiting, .progress, .playing: window != nil
        default: false
        }
        spin(arc, turning, duration: 1.5)
        // The spinner quicker, as a system spinner turns.
        spin(spinner, state == .starting && window != nil, duration: 0.8)
    }

    private func spin(_ shape: CAShapeLayer, _ turning: Bool, duration: CFTimeInterval) {
        if !turning {
            shape.removeAnimation(forKey: "turn")
        } else if shape.animation(forKey: "turn") == nil {
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = 2 * Double.pi
            spin.duration = duration
            spin.repeatCount = .infinity
            spin.isRemovedOnCompletion = false
            spin.timingFunction = CAMediaTimingFunction(name: .linear)
            shape.add(spin, forKey: "turn")
        }
    }

    /// The ring for a download in `phase`: a picture's or file's, or a
    /// video's play button (its spinner while it is `starting`).
    static func state(_ phase: DownloadPhase?, video: Bool, starting: Bool = false) -> State {
        if video {
            if starting { return .starting }
            guard case .downloading = phase else { return .play }
            return .playing(phase?.share)
        }
        switch phase {
        case nil: return .done
        case .remote, .paused: return .download
        case .downloading: return phase?.share.map { .progress($0) } ?? .waiting
        case .failed: return .failed
        case .complete: return .done
        }
    }
}

/// A tile that shows a sending picture's ring: the agent chat's media
/// (`ChatMediaView`) and the legacy chat's attachment (`ChatAttachmentView`).
@MainActor
protocol UploadRingTile: AnyObject {
    /// Where its bytes are, as the board last said.
    func setUpload(_ phase: UploadPhase?, animated: Bool)
}

/// The tiles showing a sending picture, by its key, and the one drain of
/// `UploadProgressBoard` a frame that moves their rings: however fast the
/// bytes go, each ring is touched at most once a frame, with its latest
/// share, and nothing else on screen is.
@MainActor
final class UploadRings {
    static let shared = UploadRings(board: .shared)

    private let board: UploadProgressBoard
    /// By key: more than one tile may show the same picture a moment (a row
    /// drawn again beside the one going), and each hears every frame.
    private var tiles: [String: NSHashTable<AnyObject>] = [:]
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

    func show(_ tile: UploadRingTile, key: String) {
        let shown = tiles[key] ?? .weakObjects()
        shown.add(tile)
        tiles[key] = shown
    }

    func forget(_ tile: UploadRingTile, key: String) {
        guard let shown = tiles[key] else { return }
        shown.remove(tile)
        if shown.allObjects.isEmpty { tiles[key] = nil }
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

    /// Everything that changed since the last frame, each to its own tiles.
    func drain() {
        for (key, phase) in board.drain() {
            guard let shown = tiles[key] else { continue }
            let live = shown.allObjects.compactMap { $0 as? UploadRingTile }
            if live.isEmpty { tiles[key] = nil }
            for tile in live {
                tile.setUpload(phase, animated: true)
                applied += 1
            }
        }
    }
}

/// A view that shows one download's ring or size.
@MainActor
protocol DownloadShowing: AnyObject {
    func setDownload(_ phase: DownloadPhase?, animated: Bool)
    /// Its video was asked to play and waits for its first range.
    func setStarting(_ starting: Bool)
}

extension DownloadShowing {
    func setStarting(_ starting: Bool) {}
}

/// The views showing each download, by its board key, and the one drain
/// of `DownloadBoard` a frame that moves them, as `UploadRings` does for
/// uploads. Several views may show one download (a tile and the viewer).
@MainActor
final class DownloadRings {
    static let shared = DownloadRings(board: .shared)

    private let board: DownloadBoard
    private var views: [String: NSHashTable<AnyObject>] = [:]
    private var link: CADisplayLink?
    private var token: UUID?
    /// Applies a frame has made, for tests.
    private(set) var applied = 0

    init(board: DownloadBoard) {
        self.board = board
        token = board.observe { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.wake() } }
        }
        wake()
    }

    func phase(_ key: String) -> DownloadPhase? { board.phase(key) }

    /// Videos asked to play that can't yet, by board key (`VideoOpening`).
    private(set) var starting: Set<String> = []

    func isStarting(_ key: String) -> Bool { starting.contains(key) }

    /// Tells every view of `key` whether its video is starting.
    func setStarting(_ key: String, _ value: Bool) {
        guard starting.contains(key) != value else { return }
        if value { starting.insert(key) } else { starting.remove(key) }
        for case let view as DownloadShowing in views[key]?.allObjects ?? [] {
            view.setStarting(value)
        }
    }

    func show(_ view: DownloadShowing, key: String) {
        let table = views[key] ?? NSHashTable<AnyObject>.weakObjects()
        table.add(view)
        views[key] = table
    }

    func forget(_ view: DownloadShowing, key: String) {
        views[key]?.remove(view)
        if views[key]?.allObjects.isEmpty == true { views[key] = nil }
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

    func drain() {
        for (key, phase) in board.drain() {
            for case let view as DownloadShowing in views[key]?.allObjects ?? [] {
                view.setDownload(phase, animated: true)
                applied += 1
            }
        }
    }
}
#endif

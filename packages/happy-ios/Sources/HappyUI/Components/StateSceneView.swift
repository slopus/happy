#if canImport(UIKit)
import Lottie
import UIKit

/// The state pictures Happy ships, each for exactly one meaning, as
/// desktop's LottieScene vocabulary has them (happy-desktop
/// `packages/happy-desktop-ui/src/LottieScene.tsx`). This is a closed list
/// on purpose: a scene belongs to the design system, not a slot a screen
/// can point at arbitrary art.
///
/// The files are desktop's own, compacted back to the exact bytes its
/// `assets/animations/PROVENANCE.md` records, so iOS and Android ship the
/// same five files. See `Resources/Animations/PROVENANCE.md`.
///
/// Errors, offline, and small inline tiles get no picture, as on desktop:
/// a glyph at most.
public enum StateScene: String, CaseIterable, Sendable {
    /// Something is being read right now, and it is taking a moment.
    case snail
    /// The thing that is missing is one you can make right here.
    case wand
    /// An agent is ready to work, and waiting to be told what to do.
    case robot
    /// The absence is the good outcome; there is nothing left to do.
    case sparkles
    /// We are looking, and there is nothing found yet (search).
    case owl
}

/// One state picture in a fixed square, drawn the way desktop draws it
/// (`LottieScene`).
///
/// It never loops. The scene plays once when the state it illustrates
/// appears and then holds its last frame, which for every animation is the
/// pose it was drawn to return to, so the held picture is worth holding.
/// After that it moves only when a reader asks: a tap, or the accessibility
/// action. A replay is refused while one is running, so a repeated tap
/// cannot turn "again" into a loop.
///
/// It stops whenever no one is looking — off screen, hidden, or the app in
/// the background — and resumes where it stopped, because a play that was
/// interrupted has still not been seen.
///
/// A reader who asked for reduced motion never sees it move: it holds the
/// same final frame, nothing starts it, and it is not offered as a control,
/// because the least surprising reading of "reduce motion" is that this
/// picture does not move.
///
/// Until the animation has been read, and forever if it cannot be, the view
/// draws nothing and leaves whatever its host drew underneath in place. An
/// empty state that keeps its ordinary glyph is a correct empty state, so
/// nothing here is load-bearing.
///
/// The box never changes: `sizeThatFits` ignores what it is offered and
/// `intrinsicContentSize` is the same square, so the view cannot resize its
/// container or invalidate a list's layout.
@MainActor
public final class StateSceneView: UIView {
    /// When the one play happens (desktop's `LottieScenePlay`). `onAppear`
    /// is the product default: the scene plays once as the state it belongs
    /// to appears. `onDemand` skips that first play and shows the same held
    /// frame from the start — the right choice for a surface that should
    /// not move on its own.
    public enum Play: Sendable {
        case onAppear
        case onDemand
    }

    /// The square the view draws in, whatever it is offered.
    public let sceneSize: CGFloat

    public var scene: StateScene {
        didSet {
            guard scene != oldValue else { return }
            load()
        }
    }

    private let animationView: LottieAnimationView
    private let play: Play
    /// Only the main actor touches this; it is `nonisolated(unsafe)` so
    /// that `deinit` can cancel without being an isolated deinit, which on
    /// 26.3 is the shape behind the malloc abort the Watch screens hit.
    private nonisolated(unsafe) var loading: Task<Void, Never>?
    /// Set once the first `onAppear` play has been asked for, so reaching a
    /// window again is a resume and not a fresh play.
    private var hasPlayed = false
    /// True between asking Lottie to play and its completion.
    private var isPlaying = false

    public init(scene: StateScene, size: CGFloat, play: Play = .onAppear, replayLabel: String) {
        self.scene = scene
        self.sceneSize = size
        self.play = play
        animationView = LottieAnimationView(configuration: LottieConfiguration(renderingEngine: .coreAnimation))
        super.init(frame: CGRect(x: 0, y: 0, width: size, height: size))
        animationView.contentMode = .scaleAspectFit
        animationView.loopMode = .playOnce
        // Lottie's own restore would start frames again without asking
        // whether anyone is looking; `apply()` decides that.
        animationView.backgroundBehavior = .pause
        animationView.isUserInteractionEnabled = false
        addSubview(animationView)

        accessibilityLabel = replayLabel
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        addGestureRecognizer(tap)
        for name in [
            UIApplication.didBecomeActiveNotification,
            UIApplication.didEnterBackgroundNotification,
            UIAccessibility.reduceMotionStatusDidChangeNotification,
        ] {
            NotificationCenter.default.addObserver(self, selector: #selector(conditionsChanged), name: name, object: nil)
        }
        applyAccessibility()
        load()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        loading?.cancel()
    }

    // MARK: Layout

    public override var intrinsicContentSize: CGSize { CGSize(width: sceneSize, height: sceneSize) }

    public override func sizeThatFits(_ size: CGSize) -> CGSize { intrinsicContentSize }

    public override func layoutSubviews() {
        super.layoutSubviews()
        animationView.frame = bounds
    }

    // MARK: Loading

    private func load() {
        loading?.cancel()
        animationView.stop()
        animationView.animation = nil
        isPlaying = false
        hasPlayed = false
        let scene = scene
        loading = Task { [weak self] in
            let animation = await Task.detached(priority: .userInitiated) { Self.read(scene) }.value
            guard let self, !Task.isCancelled, self.scene == scene, let animation else { return }
            self.animationView.animation = animation
            self.apply()
        }
    }

    /// The scene's bytes, read and decoded off the main thread. A file that
    /// is missing or will not decode leaves the view empty, on purpose.
    nonisolated static func read(_ scene: StateScene) -> LottieAnimation? {
        guard let url = Bundle.module.url(forResource: scene.rawValue, withExtension: "json")
            ?? Bundle.module.url(forResource: scene.rawValue, withExtension: "json", subdirectory: "Animations"),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return try? LottieAnimation.from(data: data)
    }

    // MARK: Playing

    /// Plays it again, if it is not already playing and motion is allowed.
    /// This is what a tap and the accessibility action do.
    public func replay() {
        guard !UIAccessibility.isReduceMotionEnabled, animationView.animation != nil, !isPlaying else { return }
        animationView.currentProgress = 0
        start()
    }

    @objc private func tapped() {
        replay()
    }

    /// VoiceOver's double tap, which does not go through the gesture.
    public override func accessibilityActivate() -> Bool {
        guard isAccessibilityElement else { return false }
        replay()
        return true
    }

    @objc private func conditionsChanged() {
        applyAccessibility()
        apply()
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        apply()
    }

    public override var isHidden: Bool {
        didSet {
            guard isHidden != oldValue else { return }
            apply()
        }
    }

    /// Whether anyone can see it: on a window, not hidden, app in front.
    var isVisible: Bool {
        window != nil && !isHidden && UIApplication.shared.applicationState != .background
    }

    /// Whether frames are moving now. Tests read this; screens do not need it.
    var isAnimating: Bool { animationView.isAnimationPlaying }

    /// Where the one play has got to, 0…1. The last frame is 1.
    var progress: CGFloat { animationView.currentProgress }

    /// Whether the animation has been read yet.
    var isLoaded: Bool { animationView.animation != nil }

    /// Decides, from what it has and what the reader asked for, whether
    /// frames should be moving at all.
    private func apply() {
        guard animationView.animation != nil else { return }
        guard !UIAccessibility.isReduceMotionEnabled else {
            // The pose it was drawn to return to, held, for good.
            isPlaying = false
            animationView.pause()
            animationView.currentProgress = 1
            return
        }
        guard isVisible else {
            if isPlaying {
                // It keeps its progress: an interrupted play has not been
                // seen, so coming back resumes rather than restarts.
                isPlaying = false
                animationView.pause()
            }
            return
        }
        guard !isPlaying else { return }
        switch play {
        case .onDemand where !hasPlayed:
            // Never played on its own: the held frame from the start.
            animationView.currentProgress = 1
        case .onDemand, .onAppear:
            // Mid-play and interrupted, or appearing for the first time.
            guard !hasPlayed || animationView.currentProgress < 1 else { return }
            start()
        }
    }

    private func start() {
        hasPlayed = true
        isPlaying = true
        animationView.play(fromProgress: animationView.currentProgress, toProgress: 1, loopMode: .playOnce) { [weak self] finished in
            guard let self else { return }
            self.isPlaying = false
            // Hold the last frame whether it ran to the end or was stopped
            // at it; a pause mid-way leaves progress where it was.
            if finished { self.animationView.currentProgress = 1 }
        }
    }

    /// The artwork carries no information — whatever it illustrates is
    /// written beside it — so the only thing assistive technology is told
    /// about is the one action: play it again. With motion reduced there is
    /// no action, so there is nothing to tell.
    private func applyAccessibility() {
        let offered = !UIAccessibility.isReduceMotionEnabled
        isAccessibilityElement = offered
        accessibilityTraits = offered ? .button : .none
        isUserInteractionEnabled = offered
    }
}
#endif

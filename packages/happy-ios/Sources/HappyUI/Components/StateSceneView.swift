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
/// same files; the TV is the sticker Kirill chose. See `Resources/Animations/PROVENANCE.md`.
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
    /// The first screen's slides (desktop's welcome deck): a team in one
    /// session, and every agent in one app.
    case alienMonster = "alien-monster"
    case llama
    /// The screen after Start: Happy on the computer (a 📺 sticker).
    case tv
    /// Supporting Happy every month, which comes with voice time: Settings'
    /// Support Happy row (a 🧋 sticker; `PROVENANCE.md`).
    case boba
    /// Voice: what voice does and what it costs, voice's welcome and paywall
    /// sheets (a 🎙️ sticker; `PROVENANCE.md`).
    case podcastMic = "podcast-mic"
    /// Nothing made yet where what agents make is kept: the Artifacts list
    /// with none (a 🎟️ sticker; `PROVENANCE.md`).
    case tickets
    /// A task about to be made: over new work's Task (a 🪄 sticker;
    /// `PROVENANCE.md`). A bot stands under the `robot`.
    case magicWand = "magic-wand"
    /// Happy Cloud's welcome (desktop's CLOUD_SLIDES): permissions, and its
    /// source shared with those who review it.
    case closedLock = "closed-lock"
    case openHands = "open-hands"
    /// Drifting down the sides of Happy Cloud's welcome (desktop's
    /// CLOUD_DRIFT, `SetupDriftView`), with the robot, sparkles, llama and
    /// lock.
    case cloudVariation = "cloud-variation"
    case tree

    /// Whether it rests on its first frame rather than its last: the magic
    /// wand, a loop whose ends are the same still wand, so a tap plays its
    /// whole spell from the start. Such a scene plays only when asked, from
    /// the start to the end once, and then shows its first frame again.
    var restsOnFirstFrame: Bool {
        self == .magicWand
    }
}

/// One state picture in a fixed square, drawn the way desktop draws it
/// (`LottieScene`).
///
/// It never loops; this is the rule for every animated emoji and sticker
/// in the app, so any new one is a scene drawn here. The scene plays once when the state it illustrates
/// appears and then holds its last frame, which for every animation is the
/// pose it was drawn to return to, so the held picture is worth holding. A
/// scene whose last frame isn't that pose rests on its first instead
/// (`StateScene.restsOnFirstFrame`), and moves only when asked.
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
            load(switching: true)
        }
    }

    private let animationView: LottieAnimationView
    private let play: Play
    /// Drawn in the first frame it is on screen (`init(immediate:)`).
    private let immediate: Bool
    /// Only the main actor touches this; it is `nonisolated(unsafe)` so
    /// that `deinit` can cancel without being an isolated deinit, which on
    /// 26.3 is the shape behind the malloc abort the Watch screens hit.
    private nonisolated(unsafe) var loading: Task<Void, Never>?
    /// Set once the first `onAppear` play has been asked for, so reaching a
    /// window again is a resume and not a fresh play.
    private var hasPlayed = false
    /// True between asking Lottie to play and its completion.
    private var isPlaying = false
    /// Read, and waiting to go on screen (`waits`).
    private var pending: LottieAnimation?

    /// It waits to go on screen: its animation, once read, stays off the
    /// layer tree until this turns false. For a scene no one can see yet (a
    /// drift scene before its fade, a slide out of view): going on screen
    /// builds its layers and commits their animations on the main thread,
    /// tens of milliseconds for the larger scenes, so a screen with many
    /// brings them on one by one rather than all in its push.
    var waits = false {
        didSet { if !waits { attach() } }
    }

    /// `immediate`: its picture is there in the very frame it first goes on
    /// screen, as new work's robot and magic wand are. A scene already
    /// read (`preload`) is put up at once; one not yet read is read here, on
    /// the main thread, rather than leave a blank frame while it arrives.
    public init(scene: StateScene, size: CGFloat, play: Play = .onAppear, replayLabel: String, immediate: Bool = false) {
        self.scene = scene
        self.sceneSize = size
        self.play = play
        self.immediate = immediate
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

    /// `switching`: from one scene to another on screen, where one already
    /// read is shown at once rather than a blank frame while it arrives.
    private func load(switching: Bool = false) {
        loading?.cancel()
        animationView.stop()
        animationView.animation = nil
        pending = nil
        isPlaying = false
        hasPlayed = false
        let scene = scene
        if immediate || switching, let animation = immediate ? Self.read(scene) : Self.cache.object(forKey: scene.rawValue as NSString) {
            loading = nil
            pending = animation
            attach()
            return
        }
        loading = Task { [weak self] in
            let animation = await Task.detached(priority: .userInitiated) { Self.read(scene) }.value
            guard let self, !Task.isCancelled, self.scene == scene, let animation else { return }
            self.pending = animation
            self.attach()
        }
    }

    /// Puts the read animation on screen, unless it `waits`.
    private func attach() {
        guard !waits, let animation = pending else { return }
        pending = nil
        animationView.animation = animation
        apply()
    }

    /// Each scene read once: Lottie's models are immutable, so every view
    /// showing a scene, now or later, shares one.
    private nonisolated(unsafe) static let cache = NSCache<NSString, LottieAnimation>()

    /// Forgets every scene read, as at launch. Tests start cold with this.
    static func forgetRead() {
        cache.removeAllObjects()
    }

    /// Reads `scenes` off the main thread ahead of need, from app launch, so
    /// a view made `immediate` finds them read and costs the main thread
    /// nothing.
    public static func preload(_ scenes: [StateScene]) {
        Task.detached(priority: .utility) {
            for scene in scenes { _ = read(scene) }
        }
    }

    /// The scene's bytes, read and decoded off the main thread. A file that
    /// is missing or will not decode leaves the view empty, on purpose.
    nonisolated static func read(_ scene: StateScene) -> LottieAnimation? {
        if let animation = cache.object(forKey: scene.rawValue as NSString) { return animation }
        guard let url = Bundle.module.url(forResource: scene.rawValue, withExtension: "json")
            ?? Bundle.module.url(forResource: scene.rawValue, withExtension: "json", subdirectory: "Animations"),
            let data = try? Data(contentsOf: url),
            let animation = try? LottieAnimation.from(data: data)
        else { return nil }
        cache.setObject(animation, forKey: scene.rawValue as NSString)
        return animation
    }

    // MARK: Playing

    /// Plays it again, if it is not already playing and motion is allowed.
    /// This is what a tap and the accessibility action do.
    public func replay() {
        guard !UIAccessibility.isReduceMotionEnabled, animationView.animation != nil, !isPlaying else { return }
        animationView.currentProgress = 0
        guard scene.restsOnFirstFrame else {
            start()
            return
        }
        // Once through, then its first frame again.
        hasPlayed = true
        isPlaying = true
        animationView.play(fromProgress: 0, toProgress: 1, loopMode: .playOnce) { [weak self] finished in
            guard let self, finished, self.isPlaying else { return }
            self.isPlaying = false
            self.hold()
        }
    }

    /// The frame it holds: its first, or its last.
    private func hold() {
        animationView.currentProgress = scene.restsOnFirstFrame ? 0 : 1
    }

    /// Hears every tap, motion reduced or not.
    public var onTap: (() -> Void)? {
        didSet { applyAccessibility() }
    }

    @objc private func tapped() {
        onTap?()
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
            hold()
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
        if scene.restsOnFirstFrame {
            // It moves only when asked; a play cut short goes back to rest.
            if animationView.currentProgress != 0 { hold() }
            return
        }
        switch play {
        case .onDemand where !hasPlayed:
            // Never played on its own: the held frame from the start.
            hold()
        case .onDemand, .onAppear:
            // Mid-play and interrupted, or appearing for the first time.
            guard !hasPlayed || animationView.currentProgress < 1 else { return }
            start()
        }
    }

    private func start() {
        hasPlayed = true
        isPlaying = true
        animationView.play(fromProgress: animationView.currentProgress, toProgress: 1, loopMode: .playOnce) { [weak self] _ in
            guard let self else { return }
            self.isPlaying = false
            // A play that ran to the end holds its last frame by itself; a
            // pause mid-way leaves progress where it was. Setting progress
            // here would rebuild every layer's animations on the main
            // thread, tens of milliseconds, as each play ends.
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
        isUserInteractionEnabled = offered || onTap != nil
    }
}
#endif

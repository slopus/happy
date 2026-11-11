#if canImport(UIKit)
import HappyLayout
import UIKit

/// The first screen's slides: happy-desktop's welcome deck (WelcomeDeck.tsx)
/// on a phone. Each is its art over its title and a line; they page by a
/// swipe or a dot, and move on by themselves every `advanceInterval`,
/// wrapping to the first with a crossfade. Any change, by hand or by
/// itself, starts the wait again; a drag holds it. A slide's animation
/// plays once each time the slide arrives and holds its last frame, as
/// desktop's deck remounts its scene on every visit; a tap plays it again.
/// A slide arrives when the pager comes to rest on it, so a swipe never
/// carries a scene starting over. Until the screen is up only the slide
/// showing has its scene on screen (`StateSceneView.waits`); then the
/// others come on one at a time, nearest first, while the pager is still,
/// so neither the push nor a swipe builds them.
///
/// With Reduce Motion on (or VoiceOver running) nothing moves by itself and
/// the dots change pages without the slide. Off screen, it waits
/// (`isRunning`). `StartLayout` places everything; `apply` only sets frames.
final class StartGalleryView: UIView, UIScrollViewDelegate {
    enum Art: Equatable {
        /// The Happy mark, in the words' colour.
        case logo
        /// The Happy Cloud mark in liquid metal (`LiquidMetalView`), in
        /// `StartLayout.metal`, wider than the art; it moves only while its slide shows.
        case cloud
        /// One of desktop's animated scenes.
        case scene(StateScene)
    }

    /// One slide: its art, its title and its line.
    struct Slide {
        let art: Art
        let title: String
        let body: String
    }

    /// Desktop's art for each slide: its logo, then its scenes (👾, 🦙, 🪄).
    static let arts: [Art] = [.logo, .scene(.alienMonster), .scene(.llama), .scene(.wand)]

    /// The first screen's: desktop's welcome deck.
    static var startSlides: [Slide] {
        zip(arts, Strings.Start.slides).map { Slide(art: $0, title: $1.title, body: $1.body) }
    }

    /// Desktop holds a slide 15 s for its longer words; a phone's are one
    /// line.
    static let advanceInterval: TimeInterval = 8
    static let crossfade: TimeInterval = 0.35
    /// The beat between one slide's scene coming on and the next's.
    static let stageDelay: TimeInterval = 0.25

    private let pager = UIScrollView()
    let dots = UIPageControl()
    private let pages: [Page]
    private(set) var index = 0
    /// The slide that arrives when the pager comes to rest.
    private var arriving: Int?
    /// A slide's scene is due to come on (`stage`).
    private var staging = false
    private var timer: Timer?
    private var layout: StartLayout?
    /// How long a slide shows before the next: `advanceInterval` unless
    /// the slides' lines are longer.
    private let interval: TimeInterval
    /// A tap on the logo's mark (Happy Cloud's ten taps to its test
    /// sign-in); the scenes keep their own tap, a replay.
    var onArtTap: (() -> Void)? {
        didSet { pages.forEach { $0.onMarkTap = onArtTap } }
    }

    /// The screen is showing: only then does it move on by itself.
    var isRunning = false {
        didSet {
            guard isRunning != oldValue else { return }
            schedule()
            if isRunning { pages[index].arrive() }
            updateMotion()
            stage()
        }
    }

    /// Whether it moves on by itself: never with Reduce Motion or VoiceOver.
    static var advances: Bool { !UIAccessibility.isReduceMotionEnabled && !UIAccessibility.isVoiceOverRunning }

    init(slides: [Slide] = StartGalleryView.startSlides, interval: TimeInterval = StartGalleryView.advanceInterval) {
        pages = slides.map { Page(art: $0.art, title: $0.title, body: $0.body) }
        self.interval = interval
        super.init(frame: .zero)
        pager.isPagingEnabled = true
        pager.showsHorizontalScrollIndicator = false
        pager.contentInsetAdjustmentBehavior = .never
        pager.scrollsToTop = false
        pager.delegate = self
        pages.forEach(pager.addSubview)
        addSubview(pager)
        dots.numberOfPages = pages.count
        dots.hidesForSinglePage = true
        dots.currentPageIndicatorTintColor = UIColor(Palette.startText)
        dots.pageIndicatorTintColor = UIColor(Palette.startDot)
        dots.accessibilityIdentifier = "start-dots"
        dots.addTarget(self, action: #selector(dotChosen), for: .valueChanged)
        addSubview(dots)
        updateAccessibility()
        stage()
        for name in [UIAccessibility.reduceMotionStatusDidChangeNotification, UIAccessibility.voiceOverStatusDidChangeNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(motionChanged), name: name, object: nil)
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Every slide's words, for `StartLayout` to give them the tallest's room.
    var slides: [StartLayout.Slide] {
        pages.map { StartLayout.Slide(title: $0.title.measurable, body: $0.body.measurable) }
    }

    /// The dots' own size.
    var dotsSize: CGSize {
        dots.size(forNumberOfPages: pages.count)
    }

    /// The slides' words alone, drawn as a page draws them but never
    /// shown: for the next screen to lay itself out as this one is
    /// (`InstallDesktopLayout`). Keep them in the view hierarchy, hidden,
    /// so they measure at the person's text size.
    @MainActor final class Measure {
        let labels: [(title: StyledLabel, body: StyledLabel)]
        private let dots = UIPageControl()

        init(slides: [Slide] = StartGalleryView.startSlides) {
            labels = slides.map { (StartGalleryView.titleLabel($0.title), StartGalleryView.bodyLabel($0.body)) }
        }

        var slides: [StartLayout.Slide] {
            labels.map { StartLayout.Slide(title: $0.title.measurable, body: $0.body.measurable) }
        }

        var dotsSize: CGSize {
            dots.size(forNumberOfPages: labels.count)
        }
    }

    /// A slide's title as a page draws it.
    static func titleLabel(_ string: String) -> StyledLabel {
        let label = StyledLabel(style: TextStyles.startSlideTitle, color: Palette.startText, alignment: .center)
        label.string = string
        label.accessibilityTraits = .header
        return label
    }

    /// A slide's line as a page draws it: a centred line never ends on one word alone.
    static func bodyLabel(_ string: String) -> StyledLabel {
        let label = StyledLabel(style: TextStyles.startSlideBody, color: Palette.startTextSecondary, alignment: .center)
        label.string = string
        label.decoration = noOrphan
        return label
    }

    /// A centred line never ends on one word alone.
    static let noOrphan: (NSMutableAttributedString) -> Void = { text in
        text.enumerateAttribute(.paragraphStyle, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            guard let style = (value as? NSParagraphStyle)?.mutableCopy() as? NSMutableParagraphStyle else { return }
            style.lineBreakStrategy = .pushOut
            text.addAttribute(.paragraphStyle, value: style, range: range)
        }
    }

    /// Takes the screen's layout: `frame` must already be its `gallery`.
    func apply(_ layout: StartLayout) {
        self.layout = layout
        pager.setLayoutFrame(layout.pager)
        pager.contentSize = layout.pagerContent(count: pages.count)
        for (number, page) in pages.enumerated() {
            page.setLayoutFrame(layout.page(number))
            page.apply(layout, number: number)
        }
        dots.setLayoutFrame(layout.dots)
        // A new width (a rotation) keeps the slide that was showing.
        if !pager.isDragging, !pager.isDecelerating {
            pager.contentOffset = layout.page(index).origin
        }
        updateMotion()
    }

    /// Art that moves on its own (the liquid metal cloud) moves only while
    /// its page is in view and the screen is showing.
    private func updateMotion() {
        for page in pages {
            page.isPaused = !isRunning || !page.frame.intersects(pager.bounds)
        }
    }

    /// Puts the showing slide's scene on screen now and, once the screen
    /// is up, the others a beat apart, nearest first; a scene once on
    /// stays on.
    private func stage() {
        guard pages.indices.contains(index) else { return }
        pages[index].waits = false
        guard isRunning, !staging, pages.contains(where: \.waits) else { return }
        staging = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.stageDelay) { [weak self] in
            guard let self else { return }
            staging = false
            guard isRunning else { return }
            // Never while the pager moves: it waits for the next beat.
            if !pager.isTracking, !pager.isDecelerating,
               let next = pages.indices.filter({ pages[$0].waits }).min(by: { abs($0 - index) < abs($1 - index) }) {
                pages[next].waits = false
            }
            stage()
        }
    }

    /// The pager came to rest: the slide it rests on arrives.
    private func rest() {
        guard let arriving else { return }
        self.arriving = nil
        // Swiped to before its turn came: on now.
        pages[arriving].waits = false
        pages[arriving].arrive()
    }

    /// Shows slide `number`. The next or the previous slides in; a jump
    /// further (the wrap back to the first, a far dot) crossfades rather
    /// than running past the others.
    func show(_ number: Int, animated: Bool) {
        guard let layout, pages.indices.contains(number) else { return }
        let offset = layout.page(number).origin
        let animated = animated && !UIAccessibility.isReduceMotionEnabled
        pages[number].waits = false
        let slides = animated && abs(number - index) == 1
        if animated, abs(number - index) > 1 {
            UIView.transition(with: pager, duration: Self.crossfade, options: [.transitionCrossDissolve, .allowUserInteraction]) {
                self.pager.contentOffset = offset
            }
        } else {
            pager.setContentOffset(offset, animated: animated)
        }
        settle(on: number)
        // A slide in arrives when it lands (`scrollViewDidEndScrollingAnimation`).
        if !slides { rest() }
    }

    private func settle(on number: Int) {
        guard number != index else { return }
        index = number
        dots.currentPage = number
        updateAccessibility()
        schedule()
        arriving = number
    }

    /// One wait for the next slide, from now.
    private func schedule() {
        timer?.invalidate()
        timer = nil
        guard isRunning, Self.advances, pages.count > 1, !pager.isTracking else { return }
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.show((self.index + 1) % self.pages.count, animated: true)
            }
        }
    }

    /// Only the slide showing is read out.
    private func updateAccessibility() {
        for (number, page) in pages.enumerated() {
            page.accessibilityElementsHidden = number != index
        }
    }

    @objc private func dotChosen() {
        show(dots.currentPage, animated: true)
    }

    @objc private func motionChanged() {
        schedule()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        updateMotion()
        // Only a drag picks the slide from where the pager is; the dots and
        // the timer pick it themselves.
        guard let layout, scrollView.isTracking || scrollView.isDecelerating else { return }
        settle(on: layout.pageShowing(offset: scrollView.contentOffset.x, count: pages.count))
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        schedule()
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate {
            schedule()
            rest()
        }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        schedule()
        rest()
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        rest()
    }
}

/// One slide: the art, the title, the line.
private final class Page: UIView {
    let title: StyledLabel
    let body: StyledLabel
    private let mark = UIImageView()
    private let scene: StateSceneView?
    private let metal: LiquidMetalView?
    var onMarkTap: (() -> Void)? {
        didSet {
            mark.isUserInteractionEnabled = onMarkTap != nil
            metal?.isUserInteractionEnabled = onMarkTap != nil
        }
    }
    /// Its art holds still: the page is out of view.
    var isPaused = true {
        didSet { metal?.isPaused = isPaused }
    }
    /// Its scene waits to go on screen (`StateSceneView.waits`).
    var waits: Bool {
        get { scene?.waits ?? false }
        set { scene?.waits = newValue }
    }

    init(art: StartGalleryView.Art, title: String, body: String) {
        switch art {
        case .logo:
            scene = nil
            metal = nil
        case .cloud:
            scene = nil
            metal = LiquidMetalView(mark: .cloud)
        case .scene(let name):
            // Held on its last frame until its slide arrives (`arrive`).
            scene = StateSceneView(scene: name, size: StartLayout.Metrics.art, play: .onDemand, replayLabel: Strings.Start.replay(title))
            scene?.waits = true
            metal = nil
        }
        self.title = StartGalleryView.titleLabel(title)
        self.body = StartGalleryView.bodyLabel(body)
        super.init(frame: .zero)
        if case .logo = art {
            mark.image = UIImage.happy("logo-black")?.withRenderingMode(.alwaysTemplate)
            mark.tintColor = UIColor(Palette.startText)
            mark.contentMode = .scaleAspectFit
            // The mark says nothing the title doesn't.
            mark.isAccessibilityElement = false
            mark.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(markTapped)))
            addSubview(mark)
        }
        if let metal {
            metal.isPaused = isPaused
            metal.fallbackColor = UIColor(Palette.startText)
            metal.accessibilityIdentifier = "cloud-liquid-metal"
            metal.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(markTapped)))
            addSubview(metal)
        }
        if let scene { addSubview(scene) }
        addSubview(self.title)
        addSubview(self.body)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    @objc private func markTapped() { onMarkTap?() }

    /// The slide is showing now: its animation plays from the start.
    func arrive() {
        scene?.replay()
    }

    func apply(_ layout: StartLayout, number: Int) {
        mark.setLayoutFrame(layout.mark)
        scene?.setLayoutFrame(layout.art)
        metal?.setLayoutFrame(layout.metal)
        title.setLayoutFrame(layout.titles[number])
        body.setLayoutFrame(layout.bodies[number])
    }
}
#endif

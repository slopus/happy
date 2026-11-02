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
///
/// With Reduce Motion on (or VoiceOver running) nothing moves by itself and
/// the dots change pages without the slide. Off screen, it waits
/// (`isRunning`). `StartLayout` places everything; `apply` only sets frames.
final class StartGalleryView: UIView, UIScrollViewDelegate {
    enum Art: Equatable {
        /// The Happy mark, in the words' colour.
        case logo
        /// One of desktop's animated scenes.
        case scene(StateScene)
    }

    /// Desktop's art for each slide: its logo, then its scenes (👾, 🦙, 🪄).
    static let arts: [Art] = [.logo, .scene(.alienMonster), .scene(.llama), .scene(.wand)]

    /// Desktop holds a slide 15 s for its longer words; a phone's are one
    /// line.
    static let advanceInterval: TimeInterval = 8
    static let crossfade: TimeInterval = 0.35

    private let pager = UIScrollView()
    let dots = UIPageControl()
    private let pages: [Page]
    private(set) var index = 0
    private var timer: Timer?
    private var layout: StartLayout?

    /// The screen is showing: only then does it move on by itself.
    var isRunning = false {
        didSet {
            guard isRunning != oldValue else { return }
            schedule()
            if isRunning { pages[index].arrive() }
        }
    }

    /// Whether it moves on by itself: never with Reduce Motion or VoiceOver.
    static var advances: Bool { !UIAccessibility.isReduceMotionEnabled && !UIAccessibility.isVoiceOverRunning }

    override init(frame: CGRect) {
        pages = zip(Self.arts, Strings.Start.slides).map { Page(art: $0, title: $1.title, body: $1.body) }
        super.init(frame: frame)
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
        let labels: [(title: StyledLabel, body: StyledLabel)] = Strings.Start.slides.map {
            (StartGalleryView.titleLabel($0.title), StartGalleryView.bodyLabel($0.body))
        }
        private let dots = UIPageControl()

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
    }

    /// Shows slide `number`. The next or the previous slides in; a jump
    /// further (the wrap back to the first, a far dot) crossfades rather
    /// than running past the others.
    func show(_ number: Int, animated: Bool) {
        guard let layout, pages.indices.contains(number) else { return }
        let offset = layout.page(number).origin
        let animated = animated && !UIAccessibility.isReduceMotionEnabled
        if animated, abs(number - index) > 1 {
            UIView.transition(with: pager, duration: Self.crossfade, options: [.transitionCrossDissolve, .allowUserInteraction]) {
                self.pager.contentOffset = offset
            }
        } else {
            pager.setContentOffset(offset, animated: animated)
        }
        settle(on: number)
    }

    private func settle(on number: Int) {
        guard number != index else { return }
        index = number
        dots.currentPage = number
        updateAccessibility()
        schedule()
        pages[number].arrive()
    }

    /// One wait for the next slide, from now.
    private func schedule() {
        timer?.invalidate()
        timer = nil
        guard isRunning, Self.advances, pages.count > 1, !pager.isTracking else { return }
        timer = Timer.scheduledTimer(withTimeInterval: Self.advanceInterval, repeats: false) { [weak self] _ in
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
        // Only a drag picks the slide from where the pager is; the dots and
        // the timer pick it themselves.
        guard let layout, scrollView.isTracking || scrollView.isDecelerating else { return }
        settle(on: layout.pageShowing(offset: scrollView.contentOffset.x, count: pages.count))
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        schedule()
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { schedule() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        schedule()
    }
}

/// One slide: the art, the title, the line.
private final class Page: UIView {
    let title: StyledLabel
    let body: StyledLabel
    private let mark = UIImageView()
    private let scene: StateSceneView?

    init(art: StartGalleryView.Art, title: String, body: String) {
        switch art {
        case .logo:
            scene = nil
        case .scene(let name):
            // Held on its last frame until its slide arrives (`arrive`).
            scene = StateSceneView(scene: name, size: StartLayout.Metrics.art, play: .onDemand, replayLabel: Strings.Start.replay(title))
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
            addSubview(mark)
        }
        if let scene { addSubview(scene) }
        addSubview(self.title)
        addSubview(self.body)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The slide is showing now: its animation plays from the start.
    func arrive() {
        scene?.replay()
    }

    func apply(_ layout: StartLayout, number: Int) {
        mark.setLayoutFrame(layout.mark)
        scene?.setLayoutFrame(layout.art)
        title.setLayoutFrame(layout.titles[number])
        body.setLayoutFrame(layout.bodies[number])
    }
}
#endif

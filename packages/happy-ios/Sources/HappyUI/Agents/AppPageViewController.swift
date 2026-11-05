#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// An artifact that asks to run as an app (`ArtifactPageMode`): its page
/// over everything, edge to edge, presented rather than pushed. No status
/// bar, the home indicator dimmed, and the screen's edges the page's first
/// (the system still wins a second swipe, as in games). Nothing swipes it
/// away, since a swipe is the game's: the way out is the close button in
/// the corner of its window the page asked for (`ArtifactAppClose`), which
/// fades after a few seconds and comes back when a finger or the pointer
/// nears it, or the page's own `happyApp.close()`. A page with no button
/// (`none`) still has a way out it can't take away: a swipe down from the
/// window's top edge shows the button in the top-leading corner for a few
/// seconds. With a keyboard, Esc and ⌘W close it too.
final class AppPageViewController: UIViewController, UIGestureRecognizerDelegate {
    private let session: Session
    private let artifactID: String
    private let version: Int
    private let entry: String
    /// Where the page asked for the close button.
    let corner: ArtifactAppClose
    private let closeButton = AppCloseButton()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let message = UILabel()
    private var browser: BrowserViewController?
    private var loading: Task<Void, Never>?
    private var fading: Task<Void, Never>?

    /// How long the close button stays fully shown, and how faded it is after.
    static let closeShown: Duration = .seconds(3)
    static let closeFaded: CGFloat = 0.35
    /// How near a touch brings it back.
    static let closeReach: CGFloat = 64
    /// With no button: how near the window's top a swipe down must start
    /// to show it, and how far down it must go.
    static let revealEdge: CGFloat = 24
    static let revealDistance: CGFloat = 24

    init(session: Session, artifactID: String, version: Int, entry: String, close: ArtifactAppClose = .topStart, title: String) {
        self.session = session
        self.artifactID = artifactID
        self.version = version
        self.entry = entry
        corner = close
        super.init(nibName: nil, bundle: nil)
        self.title = title.isEmpty ? Strings.untitledArtifact : title
        modalPresentationStyle = .fullScreen
        modalPresentationCapturesStatusBarAppearance = true
        isModalInPresentation = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        let root = AppPageRootView()
        root.touched = { [weak self] point in self?.touched(at: point) }
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Black until the page paints: a game never flashes white.
        view.backgroundColor = .black
        view.accessibilityIdentifier = "artifact-app"
        let subject = FeedSubject(type: "artifact", id: artifactID)
        Task { [feed = session.engine.feed] in await feed.seen(subject) }
        spinner.color = .white
        spinner.hidesWhenStopped = true
        spinner.startAnimating()
        view.addSubview(spinner)
        message.font = Fonts.ui(.regular, size: 15)
        message.textColor = UIColor.white.withAlphaComponent(0.7)
        message.textAlignment = .center
        message.numberOfLines = 0
        message.isHidden = true
        view.addSubview(message)
        closeButton.accessibilityLabel = Strings.ArtifactApp.close
        closeButton.accessibilityIdentifier = "artifact-app-close"
        closeButton.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        view.addSubview(closeButton)
        if corner == .none {
            closeButton.alpha = 0
            closeButton.isHidden = true
            closeButton.accessibilityValue = "hidden"
            let reveal = UIPanGestureRecognizer(target: self, action: #selector(revealSwiped(_:)))
            reveal.cancelsTouchesInView = false
            reveal.delaysTouchesBegan = false
            reveal.delaysTouchesEnded = false
            reveal.delegate = self
            view.addGestureRecognizer(reveal)
        }
        let hover = UIHoverGestureRecognizer(target: self, action: #selector(hovered(_:)))
        hover.cancelsTouchesInView = false
        view.addGestureRecognizer(hover)
        loading = Task { [weak self] in await self?.load() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
        showClose()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed { loading?.cancel(); fading?.cancel() }
    }

    private func load() async {
        do {
            let page = try await BrowserPage.artifact(client: session.client, id: artifactID, version: version, entry: entry)
            try Task.checkCancellation()
            let browser = BrowserViewController(url: page.url, session: session, artifactID: artifactID, page: page, app: true)
            browser.appClose = AppPageScripts.Close(
                corner: corner, box: AppCloseButton.margin * 2 + AppCloseButton.size,
                rightToLeft: view.effectiveUserInterfaceLayoutDirection == .rightToLeft
            )
            // Its three seconds start with the page, not the spinner.
            browser.appLoaded = { [weak self] in self?.showClose() }
            browser.appClosed = { [weak self] in self?.close() }
            addChild(browser)
            view.insertSubview(browser.view, at: 0)
            browser.didMove(toParent: self)
            self.browser = browser
            spinner.stopAnimating()
            view.setNeedsLayout()
        } catch is CancellationError {
        } catch {
            spinner.stopAnimating()
            message.text = Strings.artifactUnavailable
            message.isHidden = false
            view.setNeedsLayout()
        }
    }

    func close() {
        guard !isBeingDismissed, presentingViewController != nil else { return }
        dismiss(animated: true)
    }

    override func accessibilityPerformEscape() -> Bool {
        close()
        return true
    }

    // MARK: Keyboard

    /// Ahead of the page, which would take Esc for itself.
    override var keyCommands: [UIKeyCommand]? {
        let escape = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(closeFromKeyboard))
        let closeWindow = UIKeyCommand(title: Strings.ArtifactApp.close, action: #selector(closeFromKeyboard), input: "w", modifierFlags: .command)
        for command in [escape, closeWindow] { command.wantsPriorityOverSystemBehavior = true }
        return [escape, closeWindow]
    }

    /// So the keys work before the page takes a touch.
    override var canBecomeFirstResponder: Bool { true }

    @objc private func closeFromKeyboard() { close() }

    // MARK: Chrome

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

    // MARK: Close button

    /// With no button: a swipe down from the window's top edge shows it.
    /// The page still gets the touches.
    @objc private func revealSwiped(_ recognizer: UIPanGestureRecognizer) {
        guard recognizer.state == .changed else { return }
        let moved = recognizer.translation(in: view)
        guard moved.y >= Self.revealDistance, moved.y > abs(moved.x) else { return }
        // Once a swipe: it lets go until the next.
        recognizer.isEnabled = false
        recognizer.isEnabled = true
        reveal()
    }

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        guard let pan = recognizer as? UIPanGestureRecognizer else { return true }
        let start = pan.location(in: view).y - pan.translation(in: view).y
        return start <= Self.revealEdge
    }

    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    /// The hidden button, shown fully for `closeShown`, then hidden again.
    private func reveal() {
        fading?.cancel()
        closeButton.isHidden = false
        closeButton.accessibilityValue = "shown"
        UIView.animate(withDuration: 0.2, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) { self.closeButton.alpha = 1 }
        fading = Task { [weak self] in
            try? await Task.sleep(for: Self.closeShown)
            guard let self, !Task.isCancelled else { return }
            self.closeButton.accessibilityValue = "hidden"
            UIView.animate(withDuration: 0.3, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
                self.closeButton.alpha = 0
            } completion: { _ in
                if self.closeButton.accessibilityValue == "hidden" { self.closeButton.isHidden = true }
            }
        }
    }

    @objc private func hovered(_ recognizer: UIHoverGestureRecognizer) {
        guard recognizer.state == .began || recognizer.state == .changed else { return }
        touched(at: recognizer.location(in: view))
    }

    /// A touch or the pointer anywhere near the button shows it again; the
    /// touch still goes to the page.
    private func touched(at point: CGPoint) {
        guard corner != .none, closeButton.frame.insetBy(dx: -Self.closeReach, dy: -Self.closeReach).contains(point) else { return }
        showClose()
    }

    /// Fully shown now, faded after `closeShown`; never faded while
    /// VoiceOver reads the screen.
    private func showClose() {
        guard corner != .none else { return }
        fading?.cancel()
        closeButton.accessibilityValue = "shown"
        if closeButton.alpha < 1 { UIView.animate(withDuration: 0.2, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) { self.closeButton.alpha = 1 } }
        fading = Task { [weak self] in
            try? await Task.sleep(for: Self.closeShown)
            guard let self, !Task.isCancelled, !UIAccessibility.isVoiceOverRunning else { return }
            UIView.animate(withDuration: 0.6, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
                self.closeButton.alpha = Self.closeFaded
            }
            self.closeButton.accessibilityValue = "faded"
        }
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        let safe = view.safeAreaInsets
        browser?.view.frame = bounds
        closeButton.frame = AppCloseButton.frame(corner, in: bounds, safe: safe, rightToLeft: view.effectiveUserInterfaceLayoutDirection == .rightToLeft)
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
        let width = max(0, bounds.width - safe.left - safe.right - 32)
        let height = message.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        message.frame = CGRect(x: safe.left + 16, y: bounds.midY - height / 2, width: width, height: height)
    }
}

extension UIViewController {
    /// Opens an artifact: one known to be an app full screen at once,
    /// anything else, or not known yet, in its viewer, pushed on
    /// `navigation` (which presents an app it finds full screen).
    func openArtifact(_ artifact: Artifact, session: Session, on navigation: UINavigationController? = nil) {
        if let app = session.client.pageModes.app(artifact.id, version: artifact.version, opensLatest: artifact.opensLatest) {
            present(AppPageViewController(session: session, artifactID: artifact.id, version: app.version, entry: app.entry, close: app.close, title: artifact.title), animated: true)
            return
        }
        (navigation ?? navigationController)?.pushViewController(ArtifactViewController(session: session, artifact: artifact), animated: true)
    }
}

/// The app's root: tells its controller where each touch lands before
/// handing it on as usual, so a finger nearing the close button shows it.
private final class AppPageRootView: UIView {
    var touched: ((CGPoint) -> Void)?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if event?.type == .touches { touched?(point) }
        return super.hitTest(point, with: event)
    }
}

/// The contract's close button: a 32pt "×" on a blurred material, 8pt in
/// from the safe area's top-leading corner, taking taps 44pt wide.
final class AppCloseButton: UIControl {
    static let size: CGFloat = 32
    static let margin: CGFloat = 8

    /// Where it sits for `corner`, `margin` inside the safe area; with no
    /// corner (`none`), where a swipe shows it: the top-leading one.
    static func frame(_ corner: ArtifactAppClose, in bounds: CGRect, safe: UIEdgeInsets, rightToLeft: Bool) -> CGRect {
        let right = (corner == .none ? false : corner.isEnd) != rightToLeft
        let x = right ? bounds.maxX - safe.right - margin - size : bounds.minX + safe.left + margin
        let y = corner.isBottom ? bounds.maxY - safe.bottom - margin - size : bounds.minY + safe.top + margin
        return CGRect(x: x, y: y, width: size, height: size)
    }
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterialDark))
    private let glyph = UIImageView(image: .icon(.ionicons("close"), size: 20))

    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityTraits = .button
        blur.isUserInteractionEnabled = false
        blur.clipsToBounds = true
        // Seen on a dark page as well as a light one.
        blur.layer.borderWidth = 1
        blur.layer.borderColor = UIColor.white.withAlphaComponent(0.18).cgColor
        addSubview(blur)
        glyph.tintColor = .white
        glyph.contentMode = .center
        glyph.isUserInteractionEnabled = false
        addSubview(glyph)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        blur.frame = bounds
        blur.layer.cornerRadius = bounds.height / 2
        glyph.frame = bounds
    }

    override var isHighlighted: Bool {
        didSet { glyph.alpha = isHighlighted ? 0.5 : 1 }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let grow = max(0, 44 - bounds.width) / 2
        return bounds.insetBy(dx: -grow, dy: -grow).contains(point)
    }
}
#endif

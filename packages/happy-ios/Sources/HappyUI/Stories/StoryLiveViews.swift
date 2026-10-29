#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import UIKit
import WebKit

/// An artifact drawn live on a story (happy-agent `API.md` "Artifact
/// frames"): the page laid out in its own CSS viewport, a CSS pixel a
/// point, and scaled whole to its box, so it looks the same on every
/// client. Its files, and its data bridge, come through the paired
/// computer as an inline page's do. Where the viewer lets it, it takes
/// touches; touching it says so, so the story holds still meanwhile.
final class StoryArtifactPageView: UIView, WKNavigationDelegate {
    /// A touch on the page began (true) or ended.
    var onTouch: ((Bool) -> Void)?
    /// The page can't be shown: deleted, a pinned version gone, or nothing to load.
    var onUnavailable: (() -> Void)?
    /// Whether the page takes touches (the viewer) or is only drawn (the editor, a card).
    var interactive = false {
        didSet { web?.isUserInteractionEnabled = interactive }
    }

    private let client: DirectAgentClient
    let artifactId: String
    let version: Int?
    private var web: WKWebView?
    private var loading: Task<Void, Never>?
    /// The CSS viewport the page lays out in.
    var viewport = CGSize(width: 360, height: 640) { didSet { if viewport != oldValue { setNeedsLayout() } } }

    init(client: DirectAgentClient, artifactId: String, version: Int?) {
        self.client = client
        self.artifactId = artifactId
        self.version = version
        super.init(frame: .zero)
        clipsToBounds = true
        backgroundColor = .clear
        accessibilityIdentifier = "story-artifact:\(artifactId)"
        let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
        press.minimumPressDuration = 0
        press.cancelsTouchesInView = false
        press.delaysTouchesBegan = false
        press.delegate = StoryArtifactTouches.shared
        addGestureRecognizer(press)
        load()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit { loading?.cancel() }

    @objc private func pressed(_ press: UILongPressGestureRecognizer) {
        switch press.state {
        case .began: onTouch?(true)
        case .ended, .cancelled, .failed: onTouch?(false)
        default: break
        }
    }

    private func load() {
        let client = client
        let artifactId = artifactId
        let version = version
        loading = Task { [weak self] in
            do {
                let found = try await client.artifactVersion(artifactId, version: version)
                guard let self, !Task.isCancelled else { return }
                // A live-URL page runs on the computer, which a phone can't reach yet.
                guard found.live == nil, let entry = found.entry else { return self.unavailable() }
                self.show(version: found.number, entry: entry.path)
            } catch {
                self?.unavailable()
            }
        }
    }

    private func unavailable() {
        accessibilityValue = "unavailable"
        onUnavailable?()
    }

    private func show(version: Int, entry: String) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(StemCellArtifactFiles(client: client, artifactId: artifactId), forURLScheme: StemCellArtifactFiles.scheme)
        configuration.allowsInlineMediaPlayback = true
        let content = configuration.userContentController
        content.addUserScript(WKUserScript(source: StemCellInlinePageView.viewportScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // A story is drawn dark, whatever the phone's scheme.
        content.addUserScript(WKUserScript(source: StemCellInlinePageView.hostScript(UITraitCollection(userInterfaceStyle: .dark)), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let web = WKWebView(frame: CGRect(origin: .zero, size: viewport), configuration: configuration)
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.isUserInteractionEnabled = interactive
        web.accessibilityIdentifier = "story-artifact-web"
        addSubview(web)
        self.web = web
        let path = entry.split(separator: "/").map { StemCellArtifactFiles.escape(String($0)) }.joined(separator: "/")
        if let url = URL(string: "\(StemCellArtifactFiles.scheme)://artifact/\(version)/\(path)") { web.load(URLRequest(url: url)) }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let web, viewport.width > 0 else { return }
        // The page at its viewport, scaled whole to this box.
        let scale = bounds.width / viewport.width
        web.transform = .identity
        web.bounds = CGRect(origin: .zero, size: viewport)
        web.center = CGPoint(x: bounds.midX, y: bounds.midY)
        web.transform = CGAffineTransform(scaleX: scale, y: scale)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.request.url?.scheme == StemCellArtifactFiles.scheme ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        accessibilityValue = "loaded"
    }
}

/// The page's own touch watcher goes alongside WebKit's.
@MainActor
final class StoryArtifactTouches: NSObject, UIGestureRecognizerDelegate {
    static let shared = StoryArtifactTouches()
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

// MARK: Overlays

/// A live window onto an artifact (`artifact` overlay): its page 360 CSS
/// pixels wide, `aspectRatio` wide over tall, scaled to `transform.scale`
/// of the canvas's width, with corners 1/27 of it. Left out of the drawing
/// when the artifact is gone.
final class StoryArtifactOverlayView: StoryOverlayView {
    let page: StoryArtifactPageView

    init(_ overlay: StoryOverlay, client: DirectAgentClient) {
        guard case .artifact(_, let artifactId, let version, _, _) = overlay else { fatalError("not an artifact overlay") }
        page = StoryArtifactPageView(client: client, artifactId: artifactId, version: version)
        super.init(overlay)
        layer.cornerCurve = .continuous
        clipsToBounds = true
        backgroundColor = UIColor(white: 0, alpha: 0.42)
        addSubview(page)
        page.onUnavailable = { [weak self] in self?.isHidden = true }
    }

    override func update(_ overlay: StoryOverlay) -> Bool {
        // Another artifact or version is another page.
        guard case .artifact(_, let artifactId, let version, _, _) = overlay, artifactId == page.artifactId, version == page.version else { return false }
        return super.update(overlay)
    }

    override func baseSize(canvas: CGSize) -> CGSize {
        guard case .artifact(_, _, _, let ratio, let t) = overlay else { return .zero }
        let window = AgentStoryLayout.windowPage(aspectRatio: ratio, scale: t.scale, canvas: canvas)
        layer.cornerRadius = window.radius
        page.viewport = window.viewport
        return window.box.size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        page.frame = bounds
    }
}

/// A round video, Telegram style (`round_video` overlay): a circle
/// `transform.scale` of the canvas's width across, the recording cropped to
/// a square, mirrored for a front camera, with a thin white rim. It plays
/// from its start with sound when its frame shows and holds its last
/// picture afterwards.
final class StoryRoundVideoOverlayView: StoryOverlayView {
    private let video = StoryPlayerView()
    private let rim = CAShapeLayer()
    private(set) var player: AVPlayer?

    init(_ overlay: StoryOverlay, media: StoriesMedia?, storyId: String?, local: URL?) {
        super.init(overlay)
        clipsToBounds = false
        video.clipsToBounds = true
        video.isUserInteractionEnabled = false
        video.backgroundColor = UIColor(white: 0.15, alpha: 1)
        addSubview(video)
        rim.fillColor = nil
        rim.strokeColor = UIColor.white.cgColor
        layer.addSublayer(rim)
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.4
        layer.shadowRadius = 7
        layer.shadowOffset = CGSize(width: 0, height: 4)
        accessibilityIdentifier = "story-round-video"
        let player: AVPlayer?
        if let local {
            player = AVPlayer(url: local)
        } else if let media, let storyId, let id = overlay.id {
            player = media.roundVideoPlayer(storyId: storyId, overlayId: id)
        } else {
            player = nil
        }
        player?.actionAtItemEnd = .pause
        self.player = player
        video.player = player
        video.playerLayer.videoGravity = .resizeAspectFill
    }

    override func update(_ overlay: StoryOverlay) -> Bool {
        guard case .roundVideo(let id, let media, _, _, _) = overlay, case .roundVideo(let oldId, let oldMedia, _, _, _) = self.overlay,
              id == oldId, media == oldMedia else { return false }
        return super.update(overlay)
    }

    override func baseSize(canvas: CGSize) -> CGSize {
        guard let t = overlay.transform else { return .zero }
        let side = AgentStoryLayout.roundVideo(scale: t.scale, canvas: canvas)
        return CGSize(width: side, height: side)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        video.frame = bounds
        video.layer.cornerRadius = bounds.width / 2
        let mirrored: Bool = if case .roundVideo(_, _, _, let mirrored, _) = overlay { mirrored == true } else { false }
        video.transform = mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
        let width = max(1.5, bounds.width / 40)
        rim.lineWidth = width
        rim.frame = bounds
        rim.path = UIBezierPath(ovalIn: bounds.insetBy(dx: width / 2, dy: width / 2)).cgPath
        layer.shadowPath = UIBezierPath(ovalIn: bounds).cgPath
    }

    func play() { player?.play() }
    func pause() { player?.pause() }
    func restart() {
        player?.seek(to: .zero)
    }
}
#endif

#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import WebKit

/// MermaidRenderer on iOS: the diagram drawn by mermaid in a web page, on
/// the theme's `surfaceHighest` with 16 around it, in a box rounded by 8
/// that scrolls inside once the diagram is taller than the box.
///
/// The page and mermaid come with the app (`Resources/Mermaid`, mermaid
/// 11.12.2 as happy-app's lockfile pins it), never from a CDN. It is loaded
/// once per view; each diagram after that is handed to the page's `render`
/// as a value, never written into the page. The page parses, lays out and
/// measures in WebKit's own process, and says how tall it is with
/// `onHeight`; the row is planned again off the main thread with that
/// height, and this view keeps its page through the reconfigure.
final class ChatMermaidView: UIView {
    /// The page's height for `diagram`, in points, as it reported it.
    var onHeight: ((_ diagram: ChatMermaid, _ height: CGFloat) -> Void)?
    private(set) var diagram: ChatMermaid?
    /// The page, once there is a diagram; tests read what it drew.
    private(set) var webView: WKWebView?
    private var loaded = false
    /// Each render's number: a report from one a newer render replaced is
    /// dropped.
    private var token = 0
    private var renderedDark: Bool?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.surfaceHighest)
        layer.cornerRadius = MarkdownLayout.Metrics.mermaidRadius
        layer.cornerCurve = .circular
        clipsToBounds = true
        isAccessibilityElement = false
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.render(force: false)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        webView?.frame = bounds
    }

    /// Nil leaves the page as it is, hidden. Another diagram, or the same
    /// one for another row, is rendered and measured again.
    func apply(_ diagram: ChatMermaid?) {
        guard diagram != self.diagram else { return }
        self.diagram = diagram
        guard diagram != nil else { return }
        if webView == nil { load() }
        render(force: true)
    }

    private func load() {
        guard let page = Self.page else { return }
        let configuration = WKWebViewConfiguration()
        // Nothing is kept on disk; the page reads only the app's files.
        configuration.websiteDataStore = Self.dataStore
        configuration.dataDetectorTypes = []
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(Messages(self), contentWorld: .page, name: "mermaid")
        let webView = WKWebView(frame: bounds, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.alwaysBounceHorizontal = false
        // A tap on the status bar scrolls the chat, not the diagram.
        webView.scrollView.scrollsToTop = false
        webView.allowsLinkPreview = false
        webView.navigationDelegate = self
        addSubview(webView)
        self.webView = webView
        loaded = false
        webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    /// Hands the diagram and the theme to the page. Again when the theme
    /// flips; `force` for a new diagram.
    private func render(force: Bool) {
        guard loaded, let webView, let diagram else { return }
        let dark = traitCollection.userInterfaceStyle == .dark
        guard force || dark != renderedDark else { return }
        renderedDark = dark
        token += 1
        let background = UIColor(Palette.surfaceHighest).resolvedColor(with: traitCollection)
        webView.callAsyncJavaScript(
            "await render(content, theme, background, token)",
            arguments: [
                "content": diagram.content,
                "theme": dark ? "dark" : "default",
                "background": Self.css(background),
                "token": token,
            ],
            in: nil,
            in: .page
        )
    }

    fileprivate func received(_ body: Any) {
        guard let body = body as? [String: Any],
              let token = (body["token"] as? NSNumber)?.intValue, token == self.token,
              let height = (body["height"] as? NSNumber)?.doubleValue,
              let diagram
        else { return }
        onHeight?(diagram, CGFloat(height))
    }

    /// `rgba(…)` for the page's background.
    private static func css(_ color: UIColor) -> String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        func channel(_ value: CGFloat) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
        return "rgba(\(channel(red)), \(channel(green)), \(channel(blue)), \(min(max(alpha, 0), 1)))"
    }

    private static let page: URL? = Bundle.module.url(forResource: "mermaid", withExtension: "html")
        ?? Bundle.module.url(forResource: "mermaid", withExtension: "html", subdirectory: "Mermaid")

    /// In memory only, and holding nothing but the app's own two files:
    /// no diagram, and nothing of any account, outlives its view.
    private static let dataStore = WKWebsiteDataStore.nonPersistent()

    /// The page's messages, without the page's controller keeping the
    /// view alive.
    private final class Messages: NSObject, WKScriptMessageHandler {
        weak var view: ChatMermaidView?

        init(_ view: ChatMermaidView) {
            self.view = view
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            view?.received(message.body)
        }
    }
}

extension ChatMermaidView: WKNavigationDelegate {
    /// The page only, never anywhere a diagram points.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.request.url == Self.page ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        render(force: true)
    }

    /// WebKit let the page's process go (memory pressure): load it again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded = false
        renderedDark = nil
        guard let page = Self.page else { return }
        webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }
}
#endif

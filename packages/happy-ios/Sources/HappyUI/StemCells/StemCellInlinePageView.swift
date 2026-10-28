#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import WebKit

/// The conversation an inline page sits in, found up the responder chain:
/// the computer its files come through, and where it says how tall it is.
@MainActor
protocol StemCellPageHosting: AnyObject {
    var pageClient: DirectAgentClient { get }
    func page(_ artifactId: String, measured height: CGFloat)
}

/// An HTML artifact shown inline in a conversation, as desktop shows one
/// whose latest version asks for `inline_expanded` (happy-agent `API.md`,
/// "Display"): the live page, its files read through the paired computer
/// (`StemCellArtifactFiles`), laid on the conversation's own surface in its
/// colour scheme, with the host's `--happy-host-*` properties set. It never
/// scrolls inside; it measures its content and the row grows to fit.
final class StemCellInlinePageView: UIView, WKNavigationDelegate {
    private var web: WKWebView?
    private(set) var page: StemCellInlinePage?
    /// The page loaded now, so a row planned again reloads nothing.
    private var loaded: (artifactId: String, version: Int, entry: String)?
    private weak var host: StemCellPageHosting?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isAccessibilityElement = true
        accessibilityIdentifier = "stem-artifact-inline"
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyScheme() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func apply(_ page: StemCellInlinePage?) {
        self.page = page
        accessibilityLabel = page.map { $0.title.isEmpty ? Strings.StemCells.untitledArtifact : $0.title }
        backgroundColor = page?.page.background.flatMap { RGBA(hex: $0) }.map { UIColor(ColorToken(light: $0, dark: $0)) } ?? .clear
        load()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        load()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        web?.frame = bounds
    }

    private func load() {
        guard let page else {
            web?.stopLoading()
            loaded = nil
            return
        }
        guard window != nil, let host = host ?? findHost() else { return }
        self.host = host
        let target = (page.artifactId, page.page.version, page.page.entry)
        if let loaded, loaded == target { return }
        // The file handler belongs to one artifact; another needs a new view.
        if loaded?.artifactId != page.artifactId { makeWeb(page.artifactId, client: host.pageClient) }
        loaded = target
        accessibilityValue = nil
        let path = page.page.entry.split(separator: "/").map { StemCellArtifactFiles.escape(String($0)) }.joined(separator: "/")
        if let url = URL(string: "\(StemCellArtifactFiles.scheme)://artifact/\(page.page.version)/\(path)") { web?.load(URLRequest(url: url)) }
    }

    private func makeWeb(_ artifactId: String, client: DirectAgentClient) {
        web?.removeFromSuperview()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(StemCellArtifactFiles(client: client, artifactId: artifactId), forURLScheme: StemCellArtifactFiles.scheme)
        configuration.userContentController.add(Heights(self), name: Self.heightMessage)
        let web = WKWebView(frame: bounds, configuration: configuration)
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        addSubview(web)
        self.web = web
        applyScheme()
    }

    /// The scheme as the view has it now: for the next document, and for the
    /// one loaded (the view may only learn its traits once on screen).
    private func applyScheme() {
        guard let web else { return }
        let content = web.configuration.userContentController
        content.removeAllUserScripts()
        content.addUserScript(WKUserScript(source: Self.viewportScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.addUserScript(WKUserScript(source: Self.hostScript(traitCollection), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.addUserScript(WKUserScript(source: Self.measureScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web.evaluateJavaScript(Self.hostScript(traitCollection))
    }

    private func findHost() -> StemCellPageHosting? {
        var responder: UIResponder? = self
        while let current = responder {
            if let host = current as? StemCellPageHosting { return host }
            responder = current.next
        }
        return nil
    }

    fileprivate func measured(_ height: CGFloat) {
        guard let page, height > 0 else { return }
        host?.page(page.artifactId, measured: height)
    }

    // MARK: Navigation

    /// The page stays on its own files: nothing it does leaves for the network.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.request.url?.scheme == StemCellArtifactFiles.scheme ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript(Self.hostScript(traitCollection))
        accessibilityValue = "loaded"
    }

    // MARK: Scripts

    static let heightMessage = "happyPageHeight"

    /// The host's properties, in the conversation's colours and scheme
    /// (`style.css`), and no inset: the row sets the page's margins.
    static func hostScript(_ traits: UITraitCollection) -> String {
        func css(_ token: ColorToken) -> String {
            var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
            UIColor(token).resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
            return "rgba(\(Int((r * 255).rounded())), \(Int((g * 255).rounded())), \(Int((b * 255).rounded())), \(a))"
        }
        let scheme = traits.userInterfaceStyle == .dark ? "dark" : "light"
        let properties: [(String, String)] = [
            ("color-scheme", scheme),
            ("text", css(Palette.text)),
            ("muted", css(Palette.stemCellsRowText)),
            ("faint", css(Palette.textSecondary)),
            ("border", css(Palette.stemCellsDivider)),
            ("surface", "transparent"),
            ("font", "-apple-system, system-ui, sans-serif"),
            ("mono", "ui-monospace, Menlo, monospace"),
            ("font-size", "16px"),
            ("page-inset", "0"),
        ]
        let sets = properties.map { "s.setProperty('--happy-host-\($0.0)', '\($0.1)');" }.joined()
        return "(() => { const s = document.documentElement.style; \(sets) s.colorScheme = '\(scheme)'; })();"
    }

    /// Lays the page out at the frame's width, a CSS pixel a point, as
    /// desktop's frame does; without it WebKit lays a page that names no
    /// viewport out 980 wide and shrinks it.
    static let viewportScript = """
    (() => {
      const meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
      (document.head || document.documentElement).appendChild(meta);
    })();
    """

    /// Reports the content's height whenever it changes: the bottom of the
    /// body's last box and the body's own padding and margin, which holds
    /// whether or not the page sizes its root to the frame.
    static let measureScript = """
    (() => {
      let last = 0;
      const height = () => {
        const body = document.body;
        if (!body) return 0;
        let bottom = 0;
        for (const child of body.children) {
          const rect = child.getBoundingClientRect();
          if (rect.width || rect.height) bottom = Math.max(bottom, rect.bottom + window.scrollY);
        }
        const style = getComputedStyle(body);
        return Math.ceil(bottom + parseFloat(style.paddingBottom || 0) + parseFloat(style.marginBottom || 0));
      };
      const report = () => {
        const h = height();
        if (h > 0 && h !== last) { last = h; window.webkit.messageHandlers.\(heightMessage).postMessage(h); }
      };
      const observer = new ResizeObserver(report);
      observer.observe(document.documentElement);
      if (document.body) {
        observer.observe(document.body);
        for (const child of document.body.children) observer.observe(child);
        new MutationObserver(() => { for (const child of document.body.children) observer.observe(child); report(); })
          .observe(document.body, { childList: true });
      }
      window.addEventListener('load', report);
      if (document.fonts) document.fonts.ready.then(report);
      report();
    })();
    """

    /// The height messages, without the content controller keeping the view.
    private final class Heights: NSObject, WKScriptMessageHandler {
        weak var view: StemCellInlinePageView?
        init(_ view: StemCellInlinePageView) { self.view = view }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let number = message.body as? NSNumber else { return }
            MainActor.assumeIsolated { view?.measured(CGFloat(number.doubleValue)) }
        }
    }
}
#endif

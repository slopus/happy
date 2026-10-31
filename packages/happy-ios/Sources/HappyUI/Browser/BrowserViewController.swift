#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import WebKit

final class BrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let originalURL: URL
    private let session: Session?
    private let agentID: String?
    private let artifactID: String?
    private var page: BrowserPage?
    private var web: WKWebView?
    private var loading: Task<Void, Never>?
    private var observations: [NSKeyValueObservation] = []
    private let toolbar = UIToolbar()
    private let progress = UIProgressView(progressViewStyle: .bar)
    private let route = UILabel()
    private let computerName: String
    private let failure = UILabel()
    private lazy var back = UIBarButtonItem(image: UIImage(systemName: "chevron.left"), style: .plain, target: self, action: #selector(goBack))
    private lazy var forward = UIBarButtonItem(image: UIImage(systemName: "chevron.right"), style: .plain, target: self, action: #selector(goForward))

    init(url: URL, session: Session? = nil, agentID: String? = nil, artifactID: String? = nil, page: BrowserPage? = nil) {
        originalURL = url; self.session = session; self.agentID = agentID; self.artifactID = artifactID; self.page = page
        computerName = session?.computerName ?? "agent connection"
        super.init(nibName: nil, bundle: nil)
        title = url.host
        navigationItem.largeTitleDisplayMode = .never
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        view.accessibilityIdentifier = "browser"
        route.font = .systemFont(ofSize: 12)
        route.textColor = .secondaryLabel
        route.textAlignment = .center
        route.accessibilityIdentifier = "browser-route"
        route.text = "via \(computerName)"
        failure.font = .systemFont(ofSize: 15)
        failure.textAlignment = .center
        failure.numberOfLines = 0
        failure.accessibilityIdentifier = "browser-error"
        back.accessibilityLabel = "Back"; forward.accessibilityLabel = "Forward"
        let reload = UIBarButtonItem(image: UIImage(systemName: "arrow.clockwise"), style: .plain, target: self, action: #selector(reloadPage))
        reload.accessibilityLabel = "Reload"
        let share = UIBarButtonItem(barButtonSystemItem: .action, target: self, action: #selector(sharePage))
        toolbar.items = [back, .flexibleSpace(), forward, .flexibleSpace(), reload, .flexibleSpace(), share]
        for child in [toolbar, progress, route, failure] { view.addSubview(child) }
        loading = Task { [weak self] in await self?.load() }
    }

    private func load() async {
        do {
            if page == nil {
                guard let session else { throw BrowserError.unavailable }
                let workspace = try await session.client.browserWorkspace(agentID: agentID, artifactID: artifactID)
                page = try await BrowserPage.workspace(client: session.client, url: originalURL, workspaceID: workspace, artifactID: artifactID)
            }
            try Task.checkCancellation()
            guard let page else { return }
            let web = WKWebView(frame: .zero, configuration: page.configuration)
            web.accessibilityIdentifier = "browser-web"
            web.navigationDelegate = self; web.uiDelegate = self
            web.allowsBackForwardNavigationGestures = true
            self.web = web
            view.insertSubview(web, at: 0)
            observations = [web.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in self?.update() }
            }, web.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in self?.update() }
            }, web.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in self?.update() }
            }]
            web.load(URLRequest(url: page.url)); update(); view.setNeedsLayout()
        } catch is CancellationError {} catch {
            failure.text = "Can’t reach \(computerName).\nCheck the agent connection, then tap Reload."
            view.setNeedsLayout()
        }
    }

    private func update() {
        back.isEnabled = web?.canGoBack == true; forward.isEnabled = web?.canGoForward == true
        progress.progress = Float(web?.estimatedProgress ?? 0)
        progress.isHidden = progress.progress >= 1
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = BrowserLayout(size: view.bounds.size, top: view.safeAreaInsets.top, bottom: view.safeAreaInsets.bottom, showsRoute: route.text != nil)
        toolbar.frame = layout.toolbar; progress.frame = layout.progress; route.frame = layout.status
        web?.frame = layout.web; failure.frame = layout.web
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || isBeingDismissed || navigationController?.isBeingDismissed == true {
            loading?.cancel(); web?.stopLoading(); web?.removeFromSuperview(); web = nil; page = nil; observations = []
        }
    }

    @objc private func goBack() { web?.goBack() }
    @objc private func goForward() { web?.goForward() }
    @objc private func reloadPage() {
        failure.text = nil
        if let web { web.reload() } else { loading?.cancel(); loading = Task { [weak self] in await self?.load() } }
    }
    private var shareURL: URL { artifactID == nil ? web?.url ?? originalURL : originalURL }
    @objc private func sharePage(_ sender: UIBarButtonItem) {
        let menu = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        menu.addAction(UIAlertAction(title: "Share Link", style: .default) { [weak self] _ in self?.presentShare(sender) })
        if originalURL.host?.hasSuffix(".invalid") != true {
            menu.addAction(UIAlertAction(title: "Open in Safari (outside proxy)", style: .default) { [weak self] _ in
                guard let self else { return }; UIApplication.shared.open(self.shareURL)
            })
        }
        menu.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        menu.popoverPresentationController?.barButtonItem = sender
        present(menu, animated: true)
    }
    private func presentShare(_ sender: UIBarButtonItem) {
        let item: Any = originalURL.host?.hasSuffix(".invalid") == true && artifactID != nil ? "<happy-artifact id=\"\(artifactID!)\"/>" : shareURL
        let controller = UIActivityViewController(activityItems: [item], applicationActivities: nil)
        controller.popoverPresentationController?.barButtonItem = sender
        present(controller, animated: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        failure.text = nil
        if let title = webView.title, !title.isEmpty { self.title = title }
        update()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { failure.text = "Can’t reach \(computerName).\nCheck the connection or page address, then tap Reload." }
        update()
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if BrowserPolicy.route(url) == .system {
            if action.navigationType == .linkActivated { await UIApplication.shared.open(url) }
            return .cancel
        }
        if action.targetFrame?.isMainFrame != false, let page,
           BrowserPolicy.Authority(url: url) != BrowserPolicy.Authority(url: page.url),
           artifactID != nil, action.navigationType == .linkActivated {
            openBrowser(url, session: session, agentID: agentID)
            return .cancel
        }
        return .allow
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil, let url = action.request.url { openBrowser(url, session: session, agentID: agentID) }
        return nil
    }
}

extension UIViewController {
    func openBrowser(_ url: URL, session: Session? = nil, agentID: String? = nil) {
        guard BrowserPolicy.route(url) != .system else { UIApplication.shared.open(url); return }
        let browser = BrowserViewController(url: url, session: session ?? browserConnection(), agentID: agentID)
        if let navigationController { navigationController.pushViewController(browser, animated: true) }
        else {
            let navigation = UINavigationController(rootViewController: browser)
            browser.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak navigation] _ in navigation?.dismiss(animated: true) })
            present(navigation, animated: true)
        }
    }

    private func browserConnection() -> Session? {
        func findContext(_ controller: UIViewController) -> AppContext? {
            if let navigation = controller as? BrowserNavigationController { return navigation.browserContext }
            for child in controller.children { if let context = findContext(child) { return context } }
            return nil
        }
        let context = (navigationController as? BrowserNavigationController)?.browserContext
            ?? viewIfLoaded?.window?.rootViewController.flatMap(findContext)
        guard let context, let id = context.account.agentConnections.activeID else { return nil }
        return Session.session(for: id, context: context)
    }
}

/// Context is resolved when a link opens, so account switches cannot retain a
/// stale computer. This is otherwise an ordinary system navigation controller.
final class BrowserNavigationController: UINavigationController {
    let browserContext: AppContext
    init(context: AppContext) { browserContext = context; super.init(nibName: nil, bundle: nil) }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}

extension UIView {
    func openBrowserLink(_ url: URL) {
        var responder: UIResponder? = self
        while let current = responder {
            if let controller = current as? UIViewController { controller.openBrowser(url); return }
            responder = current.next
        }
    }
}
#endif
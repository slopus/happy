#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit
import WebKit

/// A page from the person's computer, opened through the agent connection
/// (docs/browser-proxy.md). The page runs the full height of the screen
/// under the standard header, which holds back, forward, reload or stop and
/// share; a thin bar under the header shows loading (`BrowserProgress`),
/// and a page that doesn't open is replaced by the error page
/// (`BrowserFailureView`), whose Try Again loads the address that failed.
///
/// Embedded in another screen (an artifact), the buttons go in that
/// screen's header and its title stays.
///
/// An app (`ArtifactPageMode`, in `AppPageViewController`) has no header,
/// loading bar or pull to refresh: its page fills the view, never scrolls,
/// bounces or zooms, and runs with `AppPageScripts`.
final class BrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, TakesBackSwipe {
    private let originalURL: URL
    private let session: Session?
    private let agentID: String?
    private let artifactID: String?
    private var page: BrowserPage?
    private(set) var web: WKWebView?
    private var loading: Task<Void, Never>?
    private var observations: [NSKeyValueObservation] = []
    private let progressView = BrowserProgressView()
    let failureView = BrowserFailureView()
    private let refresh = UIRefreshControl()
    private(set) var progress = BrowserProgress()
    private var trickling: Task<Void, Never>?
    /// Why the error page shows, while it does.
    private(set) var problem: BrowserProblem?
    /// Whether that failure left the last page under it, still current.
    private var failedBeforeCommit = false
    /// The address that failed, which Try Again loads.
    private(set) var failedURL: URL?
    /// The main frame's address being loaded, for failures that don't say.
    private var pendingURL: URL?
    /// The web process stopped and the page was reloaded once for it; a
    /// second stop before another page finishes shows the error page.
    private var reloadedAfterCrash = false
    private var crashReload: WKNavigation?
    private var link: LinkState?
    private var linkWatch: Watch?
    private let isApp: Bool
    /// Where an app's close button is, as its page is told.
    var appClose = AppPageScripts.Close(corner: .topStart, box: 0, rightToLeft: false)
    /// An app's page finished loading.
    var appLoaded: (() -> Void)?
    /// An app's page asked to close (`happyApp.close()`).
    var appClosed: (() -> Void)?
    /// Every value the loading bar takes, in order (tests).
    var progressChanged: ((BrowserProgress) -> Void)?

    lazy var backItem = UIBarButtonItem(primaryAction: UIAction(image: .icon(.ionicons("chevron-back"), size: 22)) { [weak self] _ in self?.goBack() }, menu: historyMenu(forward: false))
    lazy var forwardItem = UIBarButtonItem(primaryAction: UIAction(image: .icon(.ionicons("chevron-forward"), size: 22)) { [weak self] _ in self?.goForward() }, menu: historyMenu(forward: true))
    lazy var reloadItem = UIBarButtonItem(primaryAction: UIAction(image: .icon(.ionicons("refresh"), size: 22)) { [weak self] _ in self?.reloadOrStop() })
    lazy var shareItem = UIBarButtonItem(image: .icon(.ionicons("share-outline"), size: 22), menu: UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in done(self?.shareActions() ?? []) }]))

    init(url: URL, session: Session? = nil, agentID: String? = nil, artifactID: String? = nil, page: BrowserPage? = nil, app: Bool = false) {
        originalURL = url; self.session = session; self.agentID = agentID; self.artifactID = artifactID; self.page = page
        isApp = app
        super.init(nibName: nil, bundle: nil)
        title = Self.isSynthetic(url) ? nil : url.host
        navigationItem.largeTitleDisplayMode = .never
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private var computerName: String { session?.computerName ?? Strings.agentConnection }
    /// A bundled artifact's made-up origin, which means nothing outside.
    private static func isSynthetic(_ url: URL) -> Bool { url.host?.hasSuffix(".invalid") == true }
    /// The host and any port, as the error page names a server: a dev
    /// server is told apart by its port. Nothing for a made-up origin.
    private static func address(_ url: URL) -> String? {
        guard !isSynthetic(url), let host = url.host else { return nil }
        return url.port.map { "\(host):\($0)" } ?? host
    }
    /// In another screen rather than a navigation stack of its own.
    private var isEmbedded: Bool { parent != nil && !(parent is UINavigationController) }
    private var header: UIViewController { isEmbedded ? parent ?? self : self }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        view.accessibilityIdentifier = "browser"
        failureView.isHidden = true
        failureView.retried = { [weak self] in self?.retry() }
        progressView.faded = { [weak self] in self?.setProgress { $0.hide() } }
        refresh.addAction(UIAction { [weak self] _ in self?.pulled() }, for: .valueChanged)
        backItem.accessibilityLabel = Strings.Browser.back
        backItem.accessibilityIdentifier = "browser-back"
        forwardItem.accessibilityLabel = Strings.Browser.forward
        forwardItem.accessibilityIdentifier = "browser-forward"
        reloadItem.accessibilityIdentifier = "browser-reload"
        shareItem.accessibilityLabel = Strings.Browser.share
        shareItem.accessibilityIdentifier = "browser-share"
        for child in [failureView, progressView] { view.addSubview(child) }
        progressView.isHidden = isApp
        installHeader()
        if let session {
            linkWatch = session.watchHeader { [weak self] state in self?.linkChanged(state) }
        }
        open()
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if isViewLoaded { installHeader() }
    }

    /// Back and forward, then reload and share, at the header's right in
    /// two glass groups; the system back button keeps the left.
    private func installHeader() {
        guard !isApp else { return }
        let item = header.navigationItem
        item.rightBarButtonItems = [shareItem, reloadItem, .fixedSpace(0), forwardItem, backItem]
        updateHeader()
    }

    // MARK: Loading

    /// Connects (when no page was handed in) and loads the page.
    private func open() {
        loading?.cancel()
        setProgress { $0.begin() }
        loading = Task { [weak self] in await self?.load() }
    }

    private func load() async {
        do {
            if page == nil {
                guard let session else { throw BrowserError.unavailable }
                let workspace = try await session.client.browserWorkspace(agentID: agentID, artifactID: artifactID)
                try Task.checkCancellation()
                page = try await BrowserPage.workspace(client: session.client, url: originalURL, workspaceID: workspace, artifactID: artifactID)
            }
            try Task.checkCancellation()
            guard let page else { return }
            let web = web ?? makeWeb(page)
            load(failedURL ?? page.url, in: web)
        } catch {
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            fail(BrowserProblem.opening(error, link: link), url: originalURL, beforeCommit: false)
        }
    }

    private func makeWeb(_ page: BrowserPage) -> WKWebView {
        let web = WKWebView(frame: view.bounds, configuration: page.configuration)
        web.accessibilityIdentifier = "browser-web"
        web.navigationDelegate = self; web.uiDelegate = self
        self.web = web
        if isApp { makeApp(web) } else { makePage(web) }
        view.insertSubview(web, at: 0)
        observations = [
            web.observe(\.estimatedProgress) { [weak self] web, _ in
                MainActor.assumeIsolated { self?.setProgress { $0.estimate(web.estimatedProgress) } }
            },
            web.observe(\.isLoading) { [weak self] web, _ in
                MainActor.assumeIsolated { self?.loadingChanged(web.isLoading) }
            },
            web.observe(\.canGoBack) { [weak self] _, _ in MainActor.assumeIsolated { self?.updateHeader() } },
            web.observe(\.canGoForward) { [weak self] _, _ in MainActor.assumeIsolated { self?.updateHeader() } },
            web.observe(\.title) { [weak self] _, _ in MainActor.assumeIsolated { self?.updateHeader() } },
            web.observe(\.url) { [weak self] _, _ in MainActor.assumeIsolated { self?.updateHeader() } },
        ]
        view.setNeedsLayout()
        return web
    }

    private func makePage(_ web: WKWebView) {
        web.allowsBackForwardNavigationGestures = true
        // Until the page paints, the screen's own surface shows through:
        // no white flash in dark mode.
        web.isOpaque = false
        web.backgroundColor = UIColor(Palette.surface)
        web.scrollView.backgroundColor = UIColor(Palette.surface)
        web.scrollView.refreshControl = refresh
        HeaderBar.edge(web.scrollView, in: header)
    }

    /// Nothing of the browser's: no swipe back or forward, no link
    /// previews, and a page that stays where it is under the finger.
    private func makeApp(_ web: WKWebView) {
        view.backgroundColor = .black
        let content = web.configuration.userContentController
        content.removeScriptMessageHandler(forName: AppPageScripts.modeMessage)
        content.add(AppPageScripts.Modes { [weak self] app in self?.appDeclared(app) }, name: AppPageScripts.modeMessage)
        content.removeScriptMessageHandler(forName: AppPageScripts.appMessage)
        content.add(AppPageScripts.Requests { [weak self] in self?.appClosed?() }, name: AppPageScripts.appMessage)
        AppPageScripts.install(in: content, close: appClose)
        web.allowsBackForwardNavigationGestures = false
        web.allowsLinkPreview = false
        web.isOpaque = false
        web.backgroundColor = view.backgroundColor
        web.scrollView.backgroundColor = view.backgroundColor
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.keyboardDismissMode = .none
        appDeclared(true)
    }

    /// A document in the app's frame said what it is: an app stays put;
    /// one that isn't (a link inside it) scrolls as a page would.
    private func appDeclared(_ app: Bool) {
        guard let scrollView = web?.scrollView else { return }
        scrollView.isScrollEnabled = !app
        scrollView.bounces = !app
        scrollView.alwaysBounceVertical = false
        scrollView.alwaysBounceHorizontal = false
        scrollView.pinchGestureRecognizer?.isEnabled = !app
    }

    private func load(_ url: URL, in web: WKWebView) {
        setProgress { $0.begin() }
        pendingURL = url
        web.load(URLRequest(url: url))
    }

    private func loadingChanged(_ isLoading: Bool) {
        updateHeader()
        if isLoading { setProgress { $0.begin() }; return }
        refresh.endRefreshing()
        // A failure says so in its own callback, which may come just after:
        // only a load that ended without one fills the bar.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.web?.isLoading == false, self.problem == nil else { return }
            self.setProgress { $0.finish() }
        }
    }

    private func setProgress(_ change: (inout BrowserProgress) -> Void) {
        var next = progress
        change(&next)
        guard next != progress else { return }
        progress = next
        progressView.apply(next, animated: true)
        progressChanged?(next)
        if next.phase == .loading, trickling == nil {
            trickling = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(300))
                    guard let self, self.progress.phase == .loading, !Task.isCancelled else { break }
                    self.setProgress { $0.trickle() }
                }
                self?.trickling = nil
            }
        }
    }

    // MARK: Failing

    private func fail(_ problem: BrowserProblem, url: URL?, beforeCommit: Bool) {
        self.problem = problem
        failedURL = url ?? failedURL ?? originalURL
        failedBeforeCommit = beforeCommit
        setProgress { $0.hide() }
        refresh.endRefreshing()
        failureView.show(problem, computer: computerName, host: failedURL.flatMap(Self.address))
        if failureView.isHidden {
            failureView.alpha = 0
            failureView.isHidden = false
            UIView.animate(withDuration: 0.2) { self.failureView.alpha = 1 }
        }
        updateHeader()
    }

    private func clearFailure() {
        problem = nil
        failureView.isHidden = true
        page?.refusals.clear()
        updateHeader()
    }

    /// Try Again: the address that failed, not the last one that worked.
    func retry() {
        let url = failedURL
        clearFailure()
        reloadedAfterCrash = false
        guard let web, let page else { open(); return }
        load(url ?? web.url ?? page.url, in: web)
    }

    func linkChanged(_ state: LinkState) {
        let before = link
        link = state
        // The computer is back: what failed for want of it opens by itself.
        if state == .online, before != .online, problem == .computerUnreachable || problem == .noNetwork { retry() }
    }

    // MARK: Header

    private var canGoBack: Bool {
        // A load that failed before it began leaves the last page current:
        // back first returns to it.
        if problem != nil, failedBeforeCommit, web?.url != nil { return true }
        return web?.canGoBack == true
    }

    var takesBackSwipe: Bool { problem == nil && web?.canGoBack == true }

    private func updateHeader() {
        backItem.isEnabled = canGoBack
        forwardItem.isEnabled = problem == nil && web?.canGoForward == true
        let stops = problem == nil && web?.isLoading == true
        reloadItem.image = .icon(.ionicons(stops ? "close" : "refresh"), size: 22)
        reloadItem.accessibilityLabel = stops ? Strings.Browser.stop : Strings.Browser.reload
        guard !isEmbedded else { return }
        let url = problem != nil ? failedURL : web?.url ?? originalURL
        let host = url.flatMap { Self.isSynthetic($0) ? nil : $0.host }
        let pageTitle = problem == nil ? web?.title.flatMap { $0.isEmpty ? nil : $0 } : nil
        navigationItem.title = pageTitle ?? host ?? title
        navigationItem.subtitle = pageTitle != nil && host != pageTitle ? host : nil
    }

    func goBack() {
        if problem != nil, failedBeforeCommit, web?.url != nil { clearFailure(); return }
        clearFailure()
        web?.goBack()
    }

    func goForward() {
        clearFailure()
        web?.goForward()
    }

    func reloadOrStop() {
        guard let web else { retry(); return }
        if problem != nil { retry(); return }
        if web.isLoading {
            web.stopLoading()
            refresh.endRefreshing()
            setProgress { $0.hide() }
            return
        }
        if web.url == nil { load(failedURL ?? page?.url ?? originalURL, in: web) } else { setProgress { $0.begin() }; web.reload() }
    }

    /// Pull to refresh: always loads again, never stops.
    private func pulled() {
        guard let web, problem == nil else { retry(); return }
        if web.url == nil { load(failedURL ?? page?.url ?? originalURL, in: web) } else { setProgress { $0.begin() }; web.reload() }
    }

    /// Long press on back or forward: the history that way, nearest first.
    private func historyMenu(forward: Bool) -> UIMenu {
        UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in
            guard let list = self?.web?.backForwardList else { done([]); return }
            let items = forward ? list.forwardList : list.backList.reversed()
            done(items.map { item in
                let action = UIAction(title: item.title.flatMap { $0.isEmpty ? nil : $0 } ?? item.url.host ?? item.url.absoluteString) { [weak self] _ in
                    self?.clearFailure()
                    self?.web?.go(to: item)
                }
                action.subtitle = item.url.host
                return action
            })
        }])
    }

    // MARK: Share

    /// The page as it is now: where it went, or the address that failed.
    private var currentURL: URL { (problem != nil ? failedURL : nil) ?? web?.url ?? originalURL }
    private var shareURL: URL { artifactID == nil ? currentURL : originalURL }

    func shareActions() -> [UIMenuElement] {
        var actions: [UIMenuElement] = [UIAction(title: Strings.Browser.shareLink, image: .icon(.ionicons("share-outline"), size: 20)) { [weak self] _ in self?.presentShare() }]
        guard !Self.isSynthetic(shareURL) else { return actions }
        let url = shareURL
        actions.append(UIAction(title: Strings.Browser.copyLink, image: .icon(.ionicons("copy-outline"), size: 20)) { _ in UIPasteboard.general.url = url })
        actions.append(UIAction(title: Strings.Browser.openInSafari, image: .icon(.ionicons("globe-outline"), size: 20)) { _ in UIApplication.shared.open(url) })
        return actions
    }

    private func presentShare() {
        let item: Any = Self.isSynthetic(originalURL) && artifactID != nil ? "<happy-artifact id=\"\(artifactID!)\"/>" : shareURL
        let controller = UIActivityViewController(activityItems: [item], applicationActivities: nil)
        controller.popoverPresentationController?.sourceItem = shareItem
        present(controller, animated: true)
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = BrowserLayout(size: view.bounds.size, top: view.safeAreaInsets.top)
        web?.frame = layout.web
        progressView.frame = layout.progress
        if isApp, let scrollView = web?.scrollView, !scrollView.isScrollEnabled {
            // WebKit gives the pinch back with each new page.
            scrollView.pinchGestureRecognizer?.isEnabled = false
        }
        failureView.frame = layout.failure
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || isBeingDismissed || navigationController?.isBeingDismissed == true || parent?.isMovingFromParent == true || parent?.isBeingDismissed == true {
            loading?.cancel(); trickling?.cancel(); linkWatch = nil
            web?.stopLoading(); web?.removeFromSuperview(); web = nil; page = nil; observations = []
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if navigation !== crashReload { reloadedAfterCrash = false }
        crashReload = nil
        if isApp, !webView.scrollView.isScrollEnabled { webView.scrollView.pinchGestureRecognizer?.isEnabled = false }
        if isApp { appLoaded?() }
        updateHeader()
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        // A navigation can start while WebKit still counts the last one as
        // loading, so `isLoading` never changes: the bar starts here too.
        setProgress { $0.begin() }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // A page arrived: whatever failed before it is behind it now.
        if problem != nil { clearFailure() }
        failedURL = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error, beforeCommit: true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error, beforeCommit: false)
    }

    private func failed(_ error: Error, beforeCommit: Bool) {
        let url = (error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL ?? pendingURL
        let refusal = url.flatMap { page?.refusals.last(for: $0) }
        guard let problem = BrowserProblem.navigation(error, refusal: refusal, link: link) else {
            if web?.isLoading != true { setProgress { $0.hide() } }
            return
        }
        fail(problem, url: url, beforeCommit: beforeCommit && web?.url != nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let url = webView.url ?? pendingURL ?? page?.url
        guard !reloadedAfterCrash else { fail(.crashed, url: url, beforeCommit: false); return }
        reloadedAfterCrash = true
        setProgress { $0.begin() }
        crashReload = webView.reload() ?? url.map { webView.load(URLRequest(url: $0)) } ?? nil
    }

    // The completion-handler forms, not the async ones: a load stopped while
    // its decision is pending must not leave a continuation behind.
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(policy(for: response, in: webView))
    }

    private func policy(for response: WKNavigationResponse, in webView: WKWebView) -> WKNavigationResponsePolicy {
        guard response.isForMainFrame, let http = response.response as? HTTPURLResponse else { return .allow }
        let problem = BrowserProblem.response(
            status: http.statusCode,
            proxyError: http.value(forHTTPHeaderField: "X-Happy-Proxy-Error"),
            hasBody: http.expectedContentLength != 0,
            link: link
        )
        guard let problem else { return .allow }
        fail(problem, url: http.url, beforeCommit: webView.url != nil)
        return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        decisionHandler(policy(for: action, in: webView))
    }

    private func policy(for action: WKNavigationAction, in webView: WKWebView) -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        let mainFrame = action.targetFrame?.isMainFrame != false
        if BrowserPolicy.isInPage(url) { return .allow }
        if BrowserPolicy.route(url) == .system {
            guard mainFrame, action.navigationType == .linkActivated || webView.backForwardList.currentItem == nil else { return .cancel }
            let nothingShown = webView.backForwardList.currentItem == nil
            UIApplication.shared.open(url, options: [:]) { [weak self] opened in
                if !opened { self?.cantOpen(url, nothingShown: nothingShown) }
            }
            return .cancel
        }
        if mainFrame, let page,
           BrowserPolicy.Authority(url: url) != BrowserPolicy.Authority(url: page.url),
           artifactID != nil, action.navigationType == .linkActivated {
            openBrowser(url, session: session, agentID: agentID)
            return .cancel
        }
        if mainFrame { pendingURL = url }
        return .allow
    }

    /// A link to an app nothing on the phone opens: the error page when it
    /// was all there was to show, else an alert over the page.
    private func cantOpen(_ url: URL, nothingShown: Bool) {
        let problem = BrowserProblem.unsupported(scheme: url.scheme ?? "")
        guard !nothingShown else { fail(problem, url: url, beforeCommit: false); return }
        let words = Strings.Browser.failure(problem, computer: computerName, host: nil)
        let alert = UIAlertController(title: words.title, message: words.message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default))
        present(alert, animated: true)
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
            HeaderBar.apply(to: navigation.navigationBar)
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
class BrowserNavigationController: UINavigationController {
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

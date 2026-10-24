#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import WebKit

/// An artifact opened from its card, kept minimal: a Markdown entry drawn
/// as the conversation draws Markdown; any other file entry (a page, a
/// picture, a recording, a PDF) in a web view that reads each file of the
/// version through the paired computer, never from the network. A live
/// page runs on the computer and says so; a deleted artifact says so.
final class StemCellArtifactViewController: UIViewController {
    private let session: StemCellsSession
    private let artifact: StemCellArtifact
    private let scrollView = UIScrollView()
    private let message = UILabel()
    private var document: ChatPlanView?
    private var documentPlan: ChatRowPlan?
    private var documentText: String?
    /// The width the document was last planned at, or is being.
    private var plannedWidth: CGFloat?
    private var web: WKWebView?
    private var loading: Task<Void, Never>?

    init(session: StemCellsSession, artifact: StemCellArtifact) {
        self.session = session
        self.artifact = artifact
        super.init(nibName: nil, bundle: nil)
        title = artifact.title.isEmpty ? Strings.StemCells.untitledArtifact : artifact.title
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        view.accessibilityIdentifier = "stem-artifact"
        scrollView.alwaysBounceVertical = true
        view.addSubview(scrollView)
        message.font = StemCellsFonts.ui(.regular, size: 15)
        message.textColor = UIColor(Palette.stemCellsRowText)
        message.textAlignment = .center
        message.numberOfLines = 0
        message.accessibilityIdentifier = "stem-artifact-message"
        scrollView.addSubview(message)
        loading = Task { [weak self] in await self?.load() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || isBeingDismissed || navigationController?.isBeingDismissed == true { loading?.cancel() }
    }

    private func load() async {
        let client = session.client
        let artifact = artifact
        do {
            let version = try await client.artifactVersion(artifact.id, version: artifact.opensLatest ? nil : artifact.version)
            if !version.title.isEmpty { title = version.title }
            if version.live != nil { return show(message: Strings.StemCells.artifactLive) }
            guard let entry = version.entry else { return show(message: Strings.StemCells.artifactUnavailable) }
            if entry.mimeType.hasPrefix("text/markdown") {
                let body = try await client.artifactFile(artifact.id, version: version.number, path: entry.path).body
                await show(markdown: String(decoding: body, as: UTF8.self))
            } else {
                showWeb(version: version.number, entry: entry.path)
            }
        } catch DirectAgentError.status(404, _, _) {
            show(message: Strings.StemCells.artifactDeleted)
        } catch {
            show(message: Strings.StemCells.artifactUnavailable)
        }
    }

    private func show(message text: String) {
        message.text = text
        view.setNeedsLayout()
    }

    /// The Markdown planned off the main thread, as a conversation's agent
    /// text, at the view's width; layout plans again when that changes.
    private func show(markdown text: String) async {
        documentText = text
        let width = view.bounds.width
        guard width > 0 else { view.setNeedsLayout(); return }
        plannedWidth = width
        let key = StemCellChatPlanner.Key(width: width, maxContentWidth: ContentWidth.maxWidth, environment: traitCollection.textEnvironment)
        let syntax = session.syntax
        let item = StemCellChatItem(id: "artifact:\(artifact.id)", role: .agent, pieces: [.text(text)], delivery: .sent)
        let plan = await Task.detached { StemCellChatPlanner.plan(item, key: key, copied: false, syntax: syntax) }.value
        // A later width's plan is on its way.
        guard plannedWidth == width else { return }
        documentPlan = plan
        let planView = document ?? {
            let planView = ChatPlanView()
            planView.drawsStaticContent = true
            planView.isAccessibilityElement = true
            planView.accessibilityIdentifier = "stem-artifact-document"
            scrollView.addSubview(planView)
            document = planView
            return planView
        }()
        planView.apply(plan)
        planView.accessibilityLabel = text
        view.setNeedsLayout()
    }

    private func showWeb(version: Int, entry: String) {
        let configuration = WKWebViewConfiguration()
        // Nothing an artifact stores outlives the view, and its files come
        // only through the computer.
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(StemCellArtifactFiles(client: session.client, artifactId: artifact.id), forURLScheme: StemCellArtifactFiles.scheme)
        let web = WKWebView(frame: view.bounds, configuration: configuration)
        web.navigationDelegate = StemCellArtifactNavigation.shared
        web.accessibilityIdentifier = "stem-artifact-web"
        web.isOpaque = false
        view.addSubview(web)
        self.web = web
        let path = entry.split(separator: "/").map { StemCellArtifactFiles.escape(String($0)) }.joined(separator: "/")
        if let url = URL(string: "\(StemCellArtifactFiles.scheme)://artifact/\(version)/\(path)") { web.load(URLRequest(url: url)) }
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        web?.frame = view.bounds
        let width = view.bounds.width
        if let documentText, width > 0, plannedWidth != width {
            Task { await show(markdown: documentText) }
        }
        let showsMessage = message.text != nil
        let body = showsMessage ? message.measurable : Measurable.fixed(width: width, height: documentPlan?.size.height ?? 0)
        let layout = StemCellsSurfaceBodyLayout(width: width, body: body, inset: showsMessage ? 16 : 0)
        document?.setLayoutFrame(showsMessage ? .zero : layout.body)
        message.isHidden = !showsMessage
        message.frame = showsMessage ? layout.body : .zero
        scrollView.contentSize = CGSize(width: width, height: layout.contentHeight)
    }
}

/// A version's files for the web view, which can't send the computer's
/// token itself: `happy-artifact://artifact/<number>/<path>` is answered
/// here from `GET /v0/artifacts/:id/versions/:number/files/*path`, ranges
/// and all, with the daemon's own content type and sandbox.
final class StemCellArtifactFiles: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    static let scheme = "happy-artifact"

    private let client: DirectAgentClient
    private let artifactId: String
    /// Touched only on the main thread, where WebKit calls.
    private var running: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(client: DirectAgentClient, artifactId: String) {
        self.client = client
        self.artifactId = artifactId
    }

    static func escape(_ segment: String) -> String {
        segment.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? segment
    }

    /// `/<number>/<path>`, the path's segments decoded.
    static func file(_ url: URL) -> (version: Int, path: String)? {
        let segments = url.path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        guard let first = segments.first, let version = Int(first), segments.count > 1 else { return nil }
        let path = segments.dropFirst().map { $0.removingPercentEncoding ?? String($0) }.joined(separator: "/")
        return path.isEmpty ? nil : (version, path)
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        let request = task.request
        guard let url = request.url, let (version, path) = Self.file(url) else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let range = request.value(forHTTPHeaderField: "Range").map(DirectAgentClient.bounded(range:))
        let client = client
        let artifactId = artifactId
        let box = TaskBox(task)
        running[id] = Task { @MainActor [weak self] in
            defer { self?.running[id] = nil }
            // WebKit may stop the task inside any call to it, after which
            // another call raises; each one checks first.
            func going() -> Bool { !Task.isCancelled && self?.running[id] != nil }
            func head(_ response: DirectHTTPResponse, status: Int, length: Int?) -> HTTPURLResponse {
                var headers: [String: String] = [:]
                for (key, value) in response.headers where ["content-type", "content-range", "content-length", "accept-ranges", "content-security-policy"].contains(key) {
                    headers[key] = value
                }
                if let length { headers["content-length"] = String(length); headers["content-range"] = nil }
                return HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            }
            do {
                if let range {
                    let response = try await client.artifactFile(artifactId, version: version, path: path, range: range)
                    guard going() else { return }
                    box.task.didReceive(head(response, status: response.status, length: nil))
                    guard going() else { return }
                    box.task.didReceive(response.body)
                } else {
                    // The whole file, a range at a time, as one answer.
                    try await DirectAgentClient.read({ range in
                        try await client.artifactFile(artifactId, version: version, path: path, range: range.map { "bytes=\($0.lowerBound)-\($0.upperBound)" })
                    }, each: { piece, first, total in
                        guard going() else { throw CancellationError() }
                        if let first { box.task.didReceive(head(first, status: 200, length: total)) }
                        guard going() else { throw CancellationError() }
                        box.task.didReceive(piece)
                    })
                }
                guard going() else { return }
                box.task.didFinish()
            } catch {
                guard going() else { return }
                box.task.didFailWithError(error)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        running.removeValue(forKey: ObjectIdentifier(task))?.cancel()
    }


    private final class TaskBox: @unchecked Sendable {
        let task: any WKURLSchemeTask
        init(_ task: any WKURLSchemeTask) { self.task = task }
    }
}

/// Keeps a page on its own files: nothing it does leaves for the network.
final class StemCellArtifactNavigation: NSObject, WKNavigationDelegate {
    static let shared = StemCellArtifactNavigation()

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.request.url?.scheme == StemCellArtifactFiles.scheme ? .allow : .cancel
    }
}
#endif

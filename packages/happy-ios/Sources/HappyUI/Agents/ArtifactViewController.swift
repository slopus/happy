#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Markdown uses the conversation renderer. Other entries use the shared
/// browser with an artifact-scoped file/API origin over the agent connection.
final class ArtifactViewController: UIViewController {
    private let session: Session
    private let artifact: Artifact
    private let scrollView = UIScrollView()
    private let message = UILabel()
    private var document: ChatPlanView?
    private var documentPlan: ChatRowPlan?
    private var documentText: String?
    /// The width the document was last planned at, or is being.
    private var plannedWidth: CGFloat?
    private var browser: BrowserViewController?
    private var loading: Task<Void, Never>?

    init(session: Session, artifact: Artifact) {
        self.session = session
        self.artifact = artifact
        super.init(nibName: nil, bundle: nil)
        title = artifact.title.isEmpty ? Strings.untitledArtifact : artifact.title
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        view.accessibilityIdentifier = "artifact"
        scrollView.alwaysBounceVertical = true
        view.addSubview(scrollView)
        message.font = Fonts.ui(.regular, size: 15)
        message.textColor = UIColor(Palette.rowText)
        message.textAlignment = .center
        message.numberOfLines = 0
        message.accessibilityIdentifier = "artifact-message"
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
            if let live = version.live, let url = URL(string: live.url) {
                showBrowser(BrowserViewController(url: url, session: session, artifactID: artifact.id))
                return
            }
            guard let entry = version.entry else { return show(message: Strings.artifactUnavailable) }
            if entry.mimeType.hasPrefix("text/markdown") {
                let body = try await client.artifactFile(artifact.id, version: version.number, path: entry.path).body
                await show(markdown: String(decoding: body, as: UTF8.self))
            } else {
                try await showWeb(version: version.number, entry: entry.path)
            }
        } catch AgentClientError.status(404, _, _) {
            show(message: Strings.artifactDeleted)
        } catch {
            show(message: Strings.artifactUnavailable)
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
        let key = ChatPlanner.Key(width: width, maxContentWidth: ContentWidth.maxWidth, environment: traitCollection.textEnvironment)
        let syntax = session.syntax
        let item = ChatItem(id: "artifact:\(artifact.id)", role: .agent, pieces: [.text(text)], delivery: .sent)
        let plan = await Task.detached { ChatPlanner.plan(item, key: key, copied: false, syntax: syntax) }.value
        guard plannedWidth == width else { return }
        documentPlan = plan
        let planView = document ?? {
            let planView = ChatPlanView()
            planView.drawsStaticContent = true
            planView.isAccessibilityElement = true
            planView.accessibilityIdentifier = "artifact-document"
            scrollView.addSubview(planView)
            document = planView
            return planView
        }()
        planView.apply(plan)
        planView.accessibilityLabel = text
        view.setNeedsLayout()
    }

    private func showWeb(version: Int, entry: String) async throws {
        let page = try await BrowserPage.artifact(client: session.client, id: artifact.id, version: version, entry: entry)
        try Task.checkCancellation()
        showBrowser(BrowserViewController(url: page.url, session: session, artifactID: artifact.id, page: page))
    }

    private func showBrowser(_ browser: BrowserViewController) {
        addChild(browser)
        view.addSubview(browser.view)
        browser.didMove(toParent: self)
        self.browser = browser
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        browser?.view.frame = view.bounds
        let width = view.bounds.width
        if let documentText, width > 0, plannedWidth != width {
            Task { await show(markdown: documentText) }
        }
        let showsMessage = message.text != nil
        let body = showsMessage ? message.measurable : Measurable.fixed(width: width, height: documentPlan?.size.height ?? 0)
        let layout = SurfaceBodyLayout(width: width, body: body, inset: showsMessage ? 16 : 0)
        document?.setLayoutFrame(showsMessage ? .zero : layout.body)
        message.isHidden = !showsMessage
        message.frame = showsMessage ? layout.body : .zero
        scrollView.contentSize = CGSize(width: width, height: layout.contentHeight)
    }
}
#endif
#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import HappyWire
import UIKit

/// Stories on rich tasks (`-screen storyArtifacts`): a protocol-34 daemon of
/// the harness's own serving story artifacts (API.md "Stories"), the stories
/// row open over the mockup's cards (`TaskListHarness.model`), and the cards
/// whose agents posted wearing their ring. `-mockImages <dir>` reads the
/// mockup's pictures; its `story-frame.jpg` is the white frame.
/// `-storyOpen <taskId>` opens that card's ring; `-storyTyping` then types a
/// reply, which lifts the bar onto the frame.
@MainActor
final class StoryArtifactsHarness {
    private let home: StoryArtifactsHarnessHome

    init(window: UIWindow, arguments: [String]) {
        UserDefaults.standard.set(true, forKey: StoriesHomeController.tooltipShownKey)
        UserDefaults.standard.removeObject(forKey: StoriesHomeController.putAwayKey)
        let directory = arguments.firstIndex(of: "-mockImages").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        // `-storySeen <id>`: seen already, so a ring opens past it.
        let seen = arguments.indices.filter { arguments[$0] == "-storySeen" && arguments.indices.contains($0 + 1) }.map { arguments[$0 + 1] }
        // `-storyMe <userId>`: whose phone it is (Kirill's by default).
        let me = arguments.firstIndex(of: "-storyMe").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? "kirill"
        let transport = StoryArtifactsHarnessTransport(directory: directory, seen: seen, me: me)
        let client = AgentClient(transport: transport, token: "harness")
        let session = StoriesSession(accountID: "story-artifacts-harness", client: client, images: Images(client: client), offline: nil) {
            AsyncStream { _ in }
        }
        session.people = StoryArtifactsHarnessTransport.people
        session.gate(true, me: me)
        home = StoryArtifactsHarnessHome(session: session, directory: directory)
        window.rootViewController = home
        guard let index = arguments.firstIndex(of: "-storyOpen"), arguments.indices.contains(index + 1) else { return }
        let taskId = arguments[index + 1], typing = arguments.contains("-storyTyping"), scroll = arguments.contains("-storyScroll")
        Task { [home] in
            try? await Task.sleep(for: .seconds(1.5))
            home.open(taskId)
            try? await Task.sleep(for: .seconds(1))
            guard let viewer = home.presentedViewController as? StoryViewerViewController else { return }
            // `-storyScroll`: the replies scrolled to their end.
            if scroll, let panel = Self.find(UIScrollView.self, in: viewer.currentPage) {
                panel.setContentOffset(CGPoint(x: 0, y: max(0, panel.contentSize.height - panel.bounds.height)), animated: false)
            }
            guard typing else { return }
            viewer.currentPage.feedbackField.becomeFirstResponder()
            viewer.currentPage.feedbackField.insertText("Move “Use selected” next to the table")
        }
    }
}

extension StoryArtifactsHarness {
    static func find<V: UIView>(_ type: V.Type, in view: UIView, where match: (V) -> Bool = { _ in true }) -> V? {
        if let view = view as? V, match(view) { return view }
        for subview in view.subviews { if let found = find(type, in: subview, where: match) { return found } }
        return nil
    }
}

/// Home as the app draws it with rich tasks on: the stories' band under a
/// title, and the cards in a list under it.
@MainActor
final class StoryArtifactsHarnessHome: UIViewController, UIScrollViewDelegate {
    private lazy var stories = StoriesHomeController(host: self)
    private let header = StoriesBandView()
    private let list = UIScrollView()
    private let tasks = TaskListView()
    private let model = TaskListHarness.model()
    private let session: StoriesSession
    private let directory: String?
    private var change: StoriesHomeController.Change?

    init(session: StoriesSession, directory: String?) {
        self.session = session
        self.directory = directory
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        list.contentInsetAdjustmentBehavior = .never
        list.alwaysBounceVertical = true
        list.delegate = self
        view.addSubview(list)
        tasks.ground = UIColor(Palette.groupedBackground)
        // What draws the rows first, so their marks are there as they are made.
        tasks.images = session.images
        tasks.people = session.people
        let pictures = ["steve": "steve.png", "agent": "proj-happy-agent.webp", "desktop": "proj-happy-desktop.webp", "ios": "proj-happy.webp"]
        tasks.picture = { [directory] key in directory.flatMap { dir in pictures[key].flatMap { UIImage(contentsOfFile: "\(dir)/\($0)") } } }
        tasks.apply(model)
        tasks.onResize = { [weak self] in self?.view.setNeedsLayout() }
        tasks.onOpenStory = { [weak self] card, _ in self?.open(card.taskId) }
        list.addSubview(tasks)
        view.addSubview(header)
        stories.onInsetChange = { [weak self] change in self?.moved(change) }
        stories.onRings = { [weak self] rings in
            guard let self else { return }
            tasks.rings = rings ?? [:]
        }
        stories.poster = { [model, session] author in
            var author = author
            if let agentId = author.ringAgentId, let card = model.card(holding: agentId) {
                author.name = card.name
                author.photo = card.iconSlug.map(StoriesRow.clayPhoto)
            } else if let id = author.userId, let person = session.people[id] {
                author.name = person.name
                author.photo = person.hasPhoto ? Person.photoPath(id) : nil
            }
            return author
        }
        stories.list = list
        stories.attach(session, images: session.images)
        stories.install(in: header)
    }

    /// A card's ring, as Home opens it; else the circle of the row titled `taskId`.
    func open(_ taskId: String) {
        guard let card = (model.unsectioned + model.sections.flatMap(\.cards)).first(where: { $0.taskId == taskId }) else {
            let circle = StoryArtifactsHarness.find(UIControl.self, in: view) { $0.accessibilityIdentifier == "story-circle:\(taskId)" }
            return circle?.sendActions(for: .touchUpInside) ?? ()
        }
        stories.openRing(agentId: card.agent.id, name: card.name, from: tasks)
    }

    private func moved(_ change: StoriesHomeController.Change) {
        self.change = change
        defer { self.change = nil }
        view.setNeedsLayout()
        view.layoutIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Under the status bar, where Home's navigation bar ends.
        let top = view.safeAreaInsets.top + 8
        header.frame = CGRect(x: 0, y: top, width: view.bounds.width, height: view.bounds.height - top)
        list.frame = view.bounds
        tasks.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: tasks.contentHeight)
        list.contentSize = tasks.frame.size
        let insets = UIEdgeInsets(top: top + stories.inset, left: 0, bottom: view.safeAreaInsets.bottom, right: 0)
        guard list.contentInset != insets else { return }
        list.contentInset = insets
        list.contentOffset.y = -insets.top
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { stories.listWillBeginDragging() }
    func scrollViewDidScroll(_ scrollView: UIScrollView) { stories.listDidScroll() }
    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        stories.listWillEndDragging(target: targetContentOffset)
    }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) { stories.listDidEndDragging(decelerate: decelerate) }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { stories.listDidEndDecelerating() }
}

/// The daemon: health with `storyArtifacts`, a feed of story artifacts
/// (the onboarding task's two over a white frame and a busy photo, Kirill's
/// repost of one with a round video, Steve's and Jordan's, the System
/// Health bot's seen one, named by `poster.name`), the replies to the
/// onboarding stories and the repost, and the files and pictures.
actor StoryArtifactsHarnessTransport: AgentTransport {
    private let directory: String?
    private var seen: Set<String> = ["s-health"]
    private let me: String
    private var video: Data?
    private let now = Int64(Date().timeIntervalSince1970 * 1000)
    private typealias Entry = (id: String, poster: String, minutesAgo: Int64, caption: String, media: String, round: String)
    private static let onboarding = #"{"kind":"agent","agentId":"onboarding-agent","taskId":"onboarding","botId":null}"#
    private static let entries: [Entry] = [
        ("s-steve", #"{"kind":"user","userId":"steve"}"#, 12, "Ship it", #"{"path":"busy.png"}"#, "null"),
        ("s-kirill", #"{"kind":"user","userId":"kirill"}"#, 20, "The new onboarding, with what I think of it",
         #"{"artifactId":"s-onboarding-1","version":1,"path":"white.jpg"}"#, #"{"path":"round.mp4"}"#),
        ("s-jordan", #"{"kind":"user","userId":"jordan"}"#, 45, "Tried it on my phone", #"{"path":"busy.png"}"#, "null"),
        ("s-onboarding-2", onboarding, 30, "Same flow over a busy photo: the reply bar stays readable", #"{"path":"busy.png"}"#, "null"),
        ("s-onboarding-1", onboarding, 120, "Onboarding for the Projects sidebar: Happy adds your projects and drafts one first task", #"{"path":"white.jpg"}"#, "null"),
        ("s-health", #"{"kind":"agent","agentId":"health-agent","taskId":null,"botId":"system-health","name":"System Health"}"#, 300, "All green", #"{"path":"white.jpg"}"#, "null"),
    ]
    /// Who the people are, as `GET /v0/users` has them: Jordan without a photo.
    static let people: [String: Person] = [
        "kirill": Person(name: "Kirill", thumbhash: nil, hasPhoto: true),
        "steve": Person(name: "Steve", thumbhash: nil, hasPhoto: true),
        "jordan": Person(name: "Jordan", thumbhash: nil, hasPhoto: false),
    ]

    init(directory: String?, seen: [String], me: String) {
        self.directory = directory
        self.me = me
        self.seen.formUnion(seen)
    }

    private func story(_ entry: Entry) -> String {
        let posted = now - entry.minutesAgo * 60_000
        let seenBy = seen.contains(entry.id) ? #"[{"userId":"\#(me)","seenAt":\#(now)}]"# : "[]"
        return #"{"artifactId":"\#(entry.id)","artifactVersion":1,"poster":\#(entry.poster),"replyAgentId":"\#(entry.id == "s-health" ? "health-agent" : "onboarding-agent")","audience":"team","caption":"\#(entry.caption)","media":\#(entry.media),"round":\#(entry.round),"repostOf":null,"postedAt":\#(posted),"expiresAt":\#(posted + 86_400_000),"state":"live","endedAt":null,"takenDownBy":null,"seenBy":\#(seenBy),"replies":2}"#
    }

    private var feed: String { Self.entries.map(story).joined(separator: ",") }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        func ok(_ text: String) -> HTTP1Response { HTTP1Response(status: 200, body: Data(text.utf8)) }
        switch (method, path) {
        case ("GET", "/v0/health"): return ok(#"{"ready":true,"capabilities":{"storyArtifacts":true,"taskSections":true}}"#)
        case ("GET", "/v0/stories?scope=feed"): return ok(#"{"stories":[\#(feed)],"cursor":"c1"}"#)
        case ("GET", "/v0/users/steve/photo"): return picture("steve.png")
        case ("GET", "/v0/users/kirill/photo"): return picture("kirill.png")
        case ("GET", "/v0/bots/system-health/avatar"): return picture("bot-health.webp")
        default: break
        }
        if method == "GET", path.hasPrefix("/v0/stories/s-onboarding") || path.hasPrefix("/v0/stories/s-kirill"), path.hasSuffix("/replies") {
            func reply(_ id: String, _ userId: String, _ minutesAgo: Int64, _ text: String) -> String {
                #"{"id":"\#(id)","metadata":{"userId":"\#(userId)"},"createdAt":\#(now - minutesAgo * 60_000),"content":[{"type":"text","text":"\#(text)"}]}"#
            }
            let replies = [reply("r2", "jordan", 3, "The “Use selected” button is hard to find, move it next to the table?"),
                           reply("r1", "steve", 9, "Love that it drafts the first task. Ship it"),
                           reply("r0", "steve", 15, "Can it pick the project from the open tab too?")]
            return ok(#"{"agentId":"onboarding-agent","messages":[\#(replies.joined(separator: ","))],"hasMore":false}"#)
        }
        if method == "POST", path.hasSuffix("/seen"), let id = path.split(separator: "/").dropLast().last.map(String.init) {
            seen.insert(id)
            guard let entry = Self.entries.first(where: { $0.id == id }) else { return HTTP1Response(status: 404) }
            return ok(#"{"story":\#(story(entry))}"#)
        }
        if path.contains("/files/white.jpg") {
            let data = directory.flatMap { FileManager.default.contents(atPath: "\($0)/story-frame.jpg") } ?? Self.white()
            return HTTP1Response(status: 200, body: data)
        }
        if path.contains("/files/busy.png") { return HTTP1Response(status: 200, body: Self.busy()) }
        if path.contains("/files/round.mp4") {
            if video == nil { video = await StoriesHarnessVideo.make(sound: false) }
            return HTTP1Response(status: 200, headers: ["content-type": "video/mp4"], body: video ?? Data())
        }
        return HTTP1Response(status: 404, body: Data(#"{"error":"not found","code":"not_found"}"#.utf8))
    }

    private func picture(_ file: String) -> HTTP1Response {
        guard let data = directory.flatMap({ FileManager.default.contents(atPath: "\($0)/\(file)") }) else { return HTTP1Response(status: 404) }
        return HTTP1Response(status: 200, body: data)
    }

    /// A white page with a little grey text, as a screenshot of an app is.
    private static func white() -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 600, height: 420)).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 600, height: 420))
            NSAttributedString(string: "Start onboarding", attributes: [.font: UIFont.systemFont(ofSize: 28), .foregroundColor: UIColor.gray]).draw(at: CGPoint(x: 40, y: 60))
        }.pngData() ?? Data()
    }

    /// A photo's worth of colour and edges: the worst ground for a clear field.
    private static func busy() -> Data {
        let size = CGSize(width: 1080, height: 1920)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let gradient = CGGradient(colorsSpace: nil, colors: [UIColor.systemOrange.cgColor, UIColor.systemPink.cgColor, UIColor.systemTeal.cgColor] as CFArray, locations: [0, 0.5, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            for index in 0..<160 {
                let x = (sin(Double(index) * 12.9898) * 0.5 + 0.5) * size.width, y = (sin(Double(index) * 78.233) * 0.5 + 0.5) * size.height
                let side = 40 + (sin(Double(index) * 3.7) * 0.5 + 0.5) * 220
                UIColor(hue: (sin(Double(index) * 1.3) * 0.5 + 0.5), saturation: 0.7, brightness: index % 3 == 0 ? 1 : 0.35, alpha: 0.85).setFill()
                UIBezierPath(ovalIn: CGRect(x: x - side / 2, y: y - side / 2, width: side, height: side)).fill()
            }
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: size.height - 360, width: size.width, height: 120))
        }.pngData() ?? Data()
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        HTTP1Stream(status: 503, body: AsyncThrowingStream { $0.finish() })
    }

    func reset() async {}
    func close() async {}
}
#endif

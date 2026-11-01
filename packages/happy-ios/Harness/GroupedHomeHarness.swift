#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
import CoreText
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit

private struct GroupedHomeHTTP: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}
private struct GroupedHomeSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A computer with bots, tasks, Surfaces and a project, each with nested
/// conversations. A task or bot made here (`POST /v0/tasks`, `/v0/bots`)
/// is a row of its own each time it is asked for, so one asked for twice
/// shows twice; given no name, it names itself after its first message, as
/// the daemon does.
private actor GroupedHomeTransport: AgentTransport {
    /// The cloned repo's picture, as the daemon serves it.
    let avatar: Data
    let lineCounts: Bool
    /// With `-stories`: the computer has `storyFeed`, the person's
    /// setting is on, and two stories ring "Landing page copy" (a picture,
    /// then the MP4 at `-storyVideo <path>`) and one rings "Release Bot".
    let stories: Bool
    let video: Data?
    let reposts: Bool
    private var seen: Set<String> = []
    init(avatar: Data, stories: Bool = false, seen: Bool = false, video: Data? = nil, reposts: Bool = false, lineCounts: Bool = false) {
        self.avatar = avatar
        self.lineCounts = lineCounts
        self.stories = stories
        self.video = video
        self.reposts = reposts
        if seen { self.seen = ["s1", "s2", "s3"] }
    }

    private func storyFeed() -> [[String: Any]] {
        let shot: [String: Any] = ["kind": "image", "mimeType": "image/png"]
        let clip: [String: Any] = ["kind": "video", "mimeType": "video/mp4", "size": video?.count ?? 0]
        let feed: [(String, String?, String?, String, [String: Any])] = [
            ("s1", "landing", nil, "Three headlines, side by side", shot),
            ("s2", "landing", nil, "The hero, animated", clip),
            ("s3", nil, "release", "2026.10.4 is on TestFlight", shot),
        ]
        let reply = { (id: String, user: String?, text: String) -> [String: Any] in ["id": id, "storyId": "s1", "userId": user ?? NSNull(), "text": text, "createdAt": Self.now] }
        let own = feed.enumerated().filter { video != nil || $0.element.4["kind"] as? String == "image" }.map { index, story -> [String: Any] in
            var entry: [String: Any] = ["id": story.0, "agentId": story.1.map { "\($0)-agent" } ?? "release-agent", "poster": "agent", "taskId": story.1 ?? NSNull(), "botId": story.2 ?? NSNull(),
             "caption": story.3, "media": story.4, "postedAt": Self.now - Double(10 - index) * 60_000, "expiresAt": Self.now + 86_400_000, "seen": seen.contains(story.0),
             "replyCount": 0, "replies": [], "canDelete": true]
            let earlier = story.0 == "s1" ? [reply("r1", "u2", "The second one"), reply("r2", nil, "Agreed, shorter")] : [], added = replies[story.0] ?? []
            (entry["replyCount"], entry["replies"]) = (earlier.count + added.count, Array((earlier + added).suffix(2)))
            return entry
        }
        // With -reposts: Sam's repost of the headlines and the person's own of the release, a round on each.
        let round: Any = video.map { ["mimeType": "video/mp4", "size": $0.count] as [String: Any] } ?? NSNull()
        let sources: [(String, String?, String, String?, String)] = reposts ? [("s4", "u2", "s1", "landing", "Love these"), ("s5", nil, "s3", nil, "Shipping!")] : []
        let shared = sources.map { id, user, of, task, caption -> [String: Any] in
            let agentId: String = task.map { "\($0)-agent" } ?? "release-agent"
            let taskId: Any = task ?? NSNull(), botId: Any = task == nil ? "release" : NSNull(), userId: Any = user ?? NSNull()
            var entry: [String: Any] = ["id": id, "agentId": agentId, "poster": "person", "userId": userId, "repostOf": of, "taskId": taskId, "botId": botId]
            (entry["caption"], entry["media"], entry["round"], entry["postedAt"], entry["expiresAt"]) = (caption, shot, round, Self.now - 60_000, Self.now + 86_400_000)
            (entry["seen"], entry["replyCount"], entry["replies"], entry["canDelete"]) = (seen.contains(id), 0, [Any](), user == nil)
            return entry
        }
        return (own + shared + posted).filter { !deleted.contains($0["id"] as? String ?? "") }
    }
    private var replies: [String: [[String: Any]]] = [:]
    private var deleted: Set<String> = []
    private var posted: [[String: Any]] = []

    /// Seen, replies, a repost and a delete, as the daemon answers them.
    private func storyRoute(_ method: String, _ id: String, _ action: String?, _ body: Data?) throws -> HTTP1Response {
        let sent = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let json = { (object: Any) in HTTP1Response(status: 200, body: try JSONSerialization.data(withJSONObject: object)) }
        guard let story = storyFeed().first(where: { $0["id"] as? String == id }) else { return .init(status: 404, body: Data("{}".utf8)) }
        switch (method, action) {
        case ("POST", "seen"?): seen.insert(id); return try json([:])
        case ("GET", "replies"?):
            let older = (0..<4).map { ["id": "o\($0)", "storyId": id, "userId": "u2", "text": "Earlier thought \($0 + 1)", "createdAt": Self.now - 600_000] as [String: Any] }
            return try json(["replies": (id == "s1" ? older : []) + (story["replies"] as? [[String: Any]] ?? [])])
        case ("POST", "replies"?):
            let reply: [String: Any] = ["id": "r\(replies.values.joined().count + 3)", "storyId": id, "userId": NSNull(), "text": sent["text"] as? String ?? "", "createdAt": Date().timeIntervalSince1970 * 1000]
            replies[id, default: []].append(reply)
            print("STORIES_HARNESS reply to \(id): \(sent["text"] as? String ?? "")")
            if let changed = storyFeed().first(where: { $0["id"] as? String == id }) { tell("story.changed", ["story": changed]) }
            return try json(["reply": reply])
        case ("POST", "repost"?):
            var repost = story
            (repost["id"], repost["poster"], repost["userId"], repost["repostOf"], repost["caption"]) = ("p\(posted.count)", "person", NSNull(), id, sent["caption"] as? String ?? NSNull())
            (repost["postedAt"], repost["seen"], repost["canDelete"], repost["replyCount"], repost["replies"]) = (Date().timeIntervalSince1970 * 1000, false, true, 0, [])
            let round = (sent["round"] as? [String: Any])?["data"] as? String
            repost["round"] = round.map { ["mimeType": "video/mp4", "size": Data(base64Encoded: $0)?.count ?? 0] as [String: Any] } ?? NSNull()
            print("STORIES_HARNESS repost of \(id), round bytes: \(round.flatMap { Data(base64Encoded: $0)?.count } ?? 0)")
            if let round, let data = Data(base64Encoded: round) { rounds[repost["id"] as! String] = data }
            posted.append(repost)
            tell("story.changed", ["story": repost])
            return try json(["story": repost])
        case ("DELETE", nil):
            deleted.insert(id)
            tell("story.removed", ["storyId": id])
            return try json([:])
        default: return .init(status: 404, body: Data("{}".utf8))
        }
    }
    /// Rounds posted here, by repost.
    private var rounds: [String: Data] = [:]

    private func storyMedia(_ id: String, range: String?, round: Bool = false) -> HTTP1Response {
        // A repost shows the media of the story it reposts.
        let source = storyFeed().first { $0["id"] as? String == id }?["repostOf"] as? String ?? id
        guard let video = round ? rounds[id] ?? video : video, source == "s2" || round else {
            let headlines = source == "s1"
            let picture = UIGraphicsImageRenderer(size: CGSize(width: 360, height: 640)).pngData { context in
                UIColor(hue: headlines ? 0.58 : 0.08, saturation: 0.6, brightness: 0.9, alpha: 1).setFill()
                context.fill(CGRect(x: 0, y: 0, width: 360, height: 640))
                NSAttributedString(string: headlines ? "Headlines" : "TestFlight", attributes: [.font: UIFont.systemFont(ofSize: 40, weight: .bold), .foregroundColor: UIColor.white]).draw(at: CGPoint(x: 40, y: 290))
            }
            return .init(status: 200, headers: ["Content-Type": "image/png"], body: picture)
        }
        let bounds = range?.dropFirst("bytes=".count).split(separator: "-").compactMap { Int($0) } ?? []
        let start = bounds.first ?? 0, end = min(bounds.count > 1 ? bounds[1] : video.count - 1, video.count - 1)
        return .init(status: 206, headers: ["Content-Type": "video/mp4", "Content-Range": "bytes \(start)-\(end)/\(video.count)"], body: video.subdata(in: start..<(end + 1)))
    }

    /// Tasks and bots made here, newest first, the ones still to be named
    /// by their first message, and the events stream to tell of them.
    private var made: [[String: Any]] = []
    private var madeBots: [[String: Any]] = []
    private var unnamed: Set<String> = []
    private var events: AsyncThrowingStream<Data, Error>.Continuation?
    private var sequence = 1

    private static let now = Date().timeIntervalSince1970 * 1000

    private static func agent(_ id: String, _ title: String, status: String = "idle", question: Bool = false, unread: Bool = false, line: String? = nil, subtasks: [[String: Any]] = [], parent: String? = nil, ago minutes: Double = 240) -> [String: Any] {
        var agent: [String: Any] = ["id": id, "workspaceId": "w-\(id)", "title": title, "status": status, "subtasks": subtasks, "lastActivityAt": now - minutes * 60_000]
        if question { agent["pendingQuestionId"] = "q-\(id)" }
        if unread { agent["unread"] = ["reason": "message", "since": now] }
        if let line { agent["statusLine"] = ["text": line, "updatedAt": now - 6 * 60_000] }
        if let parent { agent["parentAgentId"] = parent }
        return agent
    }

    static var bots: [[String: Any]] { [
        ["id": "happy", "name": "Happy", "systemKey": "chief_of_staff", "status": "active", "agent": agent("happy-agent", "Happy", line: "Watching the release", subtasks: [
            agent("happy-sub1", "Triage new issues", status: "working", parent: "happy-agent", ago: 7),
            agent("happy-sub2", "Weekly digest", parent: "happy-agent"),
        ], ago: 25)],
        ["id": "research", "name": "Research Assistant", "status": "active", "agent": agent("research-agent", "Research Assistant", status: "working", line: "Reading the papers", ago: 3)],
        ["id": "release", "name": "Release Bot", "status": "active", "agent": agent("release-agent", "Release Bot", question: true, line: "Ship 2026.10.4 to TestFlight?", ago: 12)],
    ] }

    static var tasks: [[String: Any]] { [
        ["id": "landing", "name": "Landing page copy", "agent": agent("landing-agent", "Landing page copy", unread: true, line: "Drafted three headlines", ago: 5)],
        ["id": "crash", "name": "Fix login crash", "agent": agent("crash-agent", "Fix login crash", status: "working", line: "Bisecting the keychain change", subtasks: [
            agent("crash-sub1", "Reproduce on iOS 26", parent: "crash-agent"),
            agent("crash-sub2", "Write the regression test", status: "working", parent: "crash-agent", ago: 2),
        ], ago: 1)],
        ["id": "report", "name": "Quarterly report", "agent": agent("report-agent", "Quarterly report", line: "Charts are in the doc", ago: 40)],
        ["id": "onboarding", "name": "Onboarding emails", "agent": agent("onboarding-agent", "Onboarding emails")],
    ] }

    static var surfaces: [[String: Any]] { [
        ["id": "groceries", "name": "Groceries", "type": "todo", "members": [["userId": NSNull(), "orderKey": "a"]]],
        ["id": "notes", "name": "Design notes", "type": "document", "members": [["userId": NSNull(), "orderKey": "b"]]],
        ["id": "calendar", "name": "Team calendar", "type": "calendar", "members": [["userId": NSNull(), "orderKey": "c"]]],
    ] }

    private func desktop() -> [String: Any] {
        [
            "cursor": "c1", "profile": ["userId": NSNull()],
            "userSettings": stories ? [["key": "stories", "value": true, "version": "1"]] : [],
            "bots": bots, "tasks": tasks,
            "taskMemberships": tasks.map { ["taskId": $0["id"]!] },
            "surfaces": Self.surfaces,
            "projects": [
                ["id": "p1", "name": "happy", "status": "active", "orderKey": "a", "avatar": ["kind": "image", "source": "user", "thumbhash": "1QcSHQRnh493V4dIh4eXh1h4kJUI"], "agents": [Self.agent("root", "Root chat")]],
                ["id": "p2", "name": "website", "status": "active", "orderKey": "b", "agents": []],
            ],
            "workspaces": [
                ["id": "w1", "projectId": "p1", "parentId": "p1", "name": "ios-grouped-home", "kind": "worktree", "status": "active", "orderKey": "a", "agents": [Self.agent("w1-agent", "Grouped home", ago: 18)]],
            ],
        ]
    }

    private var tasks: [[String: Any]] { made + Self.tasks }
    private var bots: [[String: Any]] { madeBots + Self.bots }

    private func tell(_ type: String, _ payload: [String: Any]) {
        sequence += 1
        guard let data = try? JSONSerialization.data(withJSONObject: ["type": type, "payload": payload]) else { return }
        events?.yield(Data("id: c\(sequence)\nevent: event\ndata: ".utf8) + data + Data("\n\n".utf8))
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let route = path.split(separator: "?").first.map(String.init) ?? path
        if route == "/v0/projects/p1/avatar" { return .init(status: 200, body: avatar) }
        if stories, route == "/v0/stories" { return .init(status: 200, body: try JSONSerialization.data(withJSONObject: ["stories": storyFeed()])) }
        if stories, route.hasPrefix("/v0/stories/"), route.hasSuffix("/media") || route.hasSuffix("/round") { return storyMedia(String(route.split(separator: "/")[2]), range: headers["Range"], round: route.hasSuffix("/round")) }
        if stories, route.hasPrefix("/v0/stories/") { return try storyRoute(method, String(route.split(separator: "/")[2]), route.split(separator: "/").dropFirst(3).first.map(String.init), body) }
        if stories, route == "/v0/users" { return .init(status: 200, body: Data(#"{"users":[{"id":"u2","name":"Sam Rivera"}]}"#.utf8)) }
        let sent = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        if route == "/v0/git/watch" {
            let samples: [String: (Int, Int, Bool)] = lineCounts ? [
                "w-happy-sub1": (42, 7, true), "w-research-agent": (1250, 0, true),
                "w-release-agent": (0, 18, true), "w-landing-agent": (128, 34, true),
                "w-crash-agent": (309, 324, true), "w-crash-sub1": (1, 0, true),
                "w-crash-sub2": (12345, 1234, false), "p1": (76, 9, true), "w1": (25, 4, true),
            ] : [:]
            var snapshots: [String: Any] = [:]
            for id in sent["workspaceIds"] as? [String] ?? [] {
                let counts = samples[id] ?? (0, 0, true)
                snapshots[id] = ["comparison": "ready", "insertions": counts.0, "deletions": counts.1, "countsExact": counts.2, "scannedAt": Self.now]
            }
            return .init(status: 200, body: try JSONSerialization.data(withJSONObject: ["snapshots": snapshots]))
        }
        if method == "POST", route == "/v0/tasks" || route == "/v0/bots" {
            let bot = route == "/v0/bots"
            let agentId = sent["agentId"] as? String ?? "made-\(made.count + madeBots.count)"
            let name = sent["name"] as? String ?? (bot ? "New Bot" : "New Task")
            if sent["name"] == nil { unnamed.insert(agentId) }
            var agent = Self.agent(agentId, name, ago: 0)
            agent["workspaceId"] = sent["workspaceId"] as? String ?? "w-\(agentId)"
            let made: [String: Any] = ["id": sent["id"] as? String ?? agentId, "name": name, "status": "active", "agent": agent]
            if bot {
                madeBots.insert(made, at: 0)
                tell("bot.created", ["bot": made])
                return .init(status: 201, body: try JSONSerialization.data(withJSONObject: ["bot": made]))
            }
            self.made.insert(made, at: 0)
            tell("task.created", ["task": made])
            return .init(status: 200, body: try JSONSerialization.data(withJSONObject: ["task": made, "membership": ["taskId": made["id"]!]]))
        }
        if route.hasPrefix("/v0/agents/") {
            let agentId = route.split(separator: "/")[2]
            if method == "POST", route.hasSuffix("/send") {
                // The first message names its task or bot, if it has no name.
                if unnamed.remove(String(agentId)) != nil, let text = sent["text"] as? String {
                    func owns(_ entry: [String: Any]) -> Bool { (entry["agent"] as? [String: Any])?["id"] as? String == String(agentId) }
                    if let index = made.firstIndex(where: owns) {
                        made[index]["name"] = text
                        tell("task.updated", ["taskId": made[index]["id"]!])
                    } else if let index = madeBots.firstIndex(where: owns) {
                        madeBots[index]["name"] = text
                        tell("bot.updated", ["botId": madeBots[index]["id"]!])
                    }
                }
                return .init(status: 200, body: Data("{}".utf8))
            }
            if route.hasSuffix("/messages") { return .init(status: 200, body: Data(#"{"runs":[],"hasMore":false}"#.utf8)) }
            if route.hasSuffix("/bootstrap") {
                return .init(status: 200, body: try JSONSerialization.data(withJSONObject: ["agent": ["id": String(agentId), "workspaceId": "w-\(agentId)", "status": "idle"], "pending": []]))
            }
        }
        let object: [String: Any]
        switch route {
        case "/v0/health": object = ["ready": true, "version": ["protocol": 27], "capabilities": ["sidebarOperations": true, "storyFeed": stories]]
        case "/v0/config": object = ["config": [
            "node": ["name": "Personal MacBook Pro"],
            "defaults": ["providerId": "claude", "modelId": "anthropic/opus-5", "permissionMode": "auto"],
            "models": ["anthropic/opus-5": ["name": "Opus 5", "efforts": ["medium", "high"], "defaultEffort": "medium"]],
            "providers": ["claude": ["type": "claude", "enabled": true, "models": [["id": "anthropic/opus-5", "enabled": true]]]],
        ]]
        case "/v0/bootstrap/desktop": object = desktop()
        case "/v0/bots": object = ["bots": bots]
        case "/v0/tasks": object = ["tasks": tasks, "memberships": tasks.map { ["taskId": $0["id"]!] }]
        case "/v0/surfaces": object = ["surfaces": Self.surfaces.map { ["id": $0["id"]!, "name": $0["name"]!, "type": $0["type"]!] }]
        default: return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: try JSONSerialization.data(withJSONObject: object))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true}\n\n".utf8))
        events = continuation
        return .init(status: 200, body: body)
    }
    func reset() {}
    func close() {}
}

/// Home as the person sees it, grouped (`-screen groupedHome`): the real
/// home screen over a computer serving bots, tasks and Surfaces with
/// nested conversations, and a cloned repo wearing its
/// picture.
@MainActor
final class GroupedHomeHarness {
    private var lineCounts = false
    private var account: AccountController?
    private var home: AgentHomeViewController?

    init(window: UIWindow, arguments: [String]) {
        if arguments.contains("-fontMetrics") {
            let fonts = [Fonts.ui(.medium, size: 17), Fonts.ui(.bold, size: 17), UIFont.monospacedSystemFont(ofSize: 17, weight: .medium), SidebarLineChanges.font]
            let report = fonts.map { font in
                let line = CTLineCreateWithAttributedString(NSAttributedString(string: "0123456789", attributes: [.font: font]))
                let ink = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
                return "\(font.fontName) size=\(font.pointSize) xHeight=\(font.xHeight) capHeight=\(font.capHeight) ascender=\(font.ascender) descender=\(font.descender) lineHeight=\(font.lineHeight) digits=\(ink)"
            }.joined(separator: "\n")
            try? report.write(to: URL.documentsDirectory.appendingPathComponent("font-metrics.txt"), atomically: true, encoding: .utf8)
        }
        lineCounts = arguments.contains("-lineCounts")
        if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
        if arguments.contains("-light") { window.overrideUserInterfaceStyle = .light }
        let bottom = arguments.contains("-bottom")
        let value = { (flag: String) in arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } }
        Task {
            StoryRepostController.debugRecording = value("-roundVideo").map(URL.init(fileURLWithPath:))
            await open(window: window, stories: arguments.contains("-stories"), seen: arguments.contains("-seenStories"), video: value("-storyVideo").flatMap { FileManager.default.contents(atPath: $0) }, reposts: arguments.contains("-reposts"))
            // With `-openStory <row id>` (`task:landing`), that row's icon tapped.
            if let id = value("-openStory") {
                try? await Task.sleep(for: .seconds(1.5))
                guard let list = home?.view.firstSubview(of: SidebarList.self), let view = list.view(for: id), let mark = view.frames.mark else { return }
                list.tap(view, at: CGPoint(x: mark.midX, y: mark.midY))
            }
            // With `-openTile <n>`, the stories row's nth tile tapped.
            if let tile = value("-openTile").flatMap(Int.init) {
                try? await Task.sleep(for: .seconds(1.5))
                home?.view.firstSubview(of: StoriesRowView.self)?.onOpen?(tile)
            }
            // With `-bottom`, the list's end, where the projects are.
            guard bottom else { return }
            try? await Task.sleep(for: .seconds(1.5))
            guard let list = home?.view.firstSubview(of: SidebarList.self) else { return }
            list.setContentOffsetY(max(-list.contentInsets.top, list.edge.contentSize.height + list.contentInsets.bottom - list.bounds.height))
        }
    }

    /// A repo's picture: a GitHub-like square, its initial on a gradient.
    private static func repoPicture() -> Data {
        let size = CGSize(width: 96, height: 96)
        return UIGraphicsImageRenderer(size: size).pngData { context in
            let colors = [UIColor(red: 0.42, green: 0.36, blue: 0.95, alpha: 1).cgColor, UIColor(red: 0.95, green: 0.38, blue: 0.62, alpha: 1).cgColor] as CFArray
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            let text = NSAttributedString(string: "h", attributes: [.font: UIFont.systemFont(ofSize: 60, weight: .bold), .foregroundColor: UIColor.white])
            let box = text.size()
            text.draw(at: CGPoint(x: (size.width - box.width) / 2, y: (size.height - box.height) / 2 - 4))
        }
    }

    private func open(window: UIWindow, stories: Bool, seen: Bool, video: Data?, reposts: Bool) async {
        let transport = GroupedHomeTransport(avatar: Self.repoPicture(), stories: stories, seen: seen, video: video, reposts: reposts, lineCounts: lineCounts)
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/grouped-home",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in transport },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: GroupedHomeHTTP(), connector: GroupedHomeSockets()
        )
        self.account = account
        do {
            let connection = try await account.agentConnections.add(.init(address: "grouped-home", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Personal MacBook Pro")
            let context = AppContext(account: account, variant: .development, version: "grouped-home")
            let home = AgentHomeViewController(context: context, id: connection.id)
            self.home = home
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            // Under the app's own root, whose stack delegate gives screens
            // their own pushes (new work's waits for its keyboard).
            window.rootViewController = ShellViewController(context: context, phone: navigation)
            window.layoutIfNeeded()
        } catch {
            print("GROUPED_HOME error: \(error)")
        }
    }
}

private extension UIView {
    func firstSubview<T: UIView>(of type: T.Type) -> T? {
        if let view = self as? T { return view }
        return subviews.lazy.compactMap { $0.firstSubview(of: type) }.first
    }
}
#endif

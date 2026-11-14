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
    /// Every name but Happy's runs past its row (`-longTitles`).
    let longTitles: Bool
    init(avatar: Data, lineCounts: Bool = false, longTitles: Bool = false) { self.avatar = avatar; self.lineCounts = lineCounts; self.longTitles = longTitles }

    /// `entries` with each name and title (a subtask's too) run long.
    private func lengthened(_ entries: [[String: Any]]) -> [[String: Any]] {
        guard longTitles else { return entries }
        func long(_ value: Any?) -> Any? {
            guard let text = value as? String, text != "Happy" else { return value }
            return text + " for the autumn launch and everything around it"
        }
        func agent(_ value: [String: Any]) -> [String: Any] {
            var copy = value
            copy["title"] = long(copy["title"])
            if let subtasks = copy["subtasks"] as? [[String: Any]] { copy["subtasks"] = subtasks.map(agent) }
            if let agents = copy["agents"] as? [[String: Any]] { copy["agents"] = agents.map(agent) }
            return copy
        }
        return entries.map { entry in
            var entry = agent(entry)
            entry["name"] = long(entry["name"])
            if let inner = entry["agent"] as? [String: Any] { entry["agent"] = agent(inner) }
            return entry
        }
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
            "userSettings": [],
            "bots": lengthened(bots), "tasks": lengthened(tasks),
            "taskMemberships": tasks.map { ["taskId": $0["id"]!] },
            "surfaces": Self.surfaces,
            "projects": lengthened([
                ["id": "p1", "name": "happy", "status": "active", "orderKey": "a", "avatar": ["kind": "image", "source": "user", "thumbhash": "1QcSHQRnh493V4dIh4eXh1h4kJUI"], "agents": [Self.agent("root", "Root chat")]],
                ["id": "p2", "name": "website", "status": "active", "orderKey": "b", "agents": []],
            ]),
            "workspaces": lengthened([
                ["id": "w1", "projectId": "p1", "parentId": "p1", "name": "ios-grouped-home", "kind": "worktree", "status": "active", "orderKey": "a", "agents": [Self.agent("w1-agent", "Grouped home", ago: 18)]],
            ]),
        ]
    }

    private var tasks: [[String: Any]] { made + base }
    private var bots: [[String: Any]] { madeBots + Self.bots }
    private lazy var base: [[String: Any]] = Self.tasks + (churns ? (1...24).map { n in
        ["id": "busy\(n)", "name": "Busy task number \(n) with a long title", "agent": Self.agent("busy\(n)-agent", "Busy task \(n)", status: n % 3 == 0 ? "idle" : "working", ago: Double(n))]
    } : [])
    private var counts: [String: (Int, Int)] = [:]
    var churns = false
    private var fresh = 0
    func setChurns(_ on: Bool) { churns = on }

    /// `-shareLinks`: the computer names its installation, so links copy
    /// as link.happy.page share links, and Landing page copy's reply holds
    /// three: Happy's, a task's and another server's.
    var shareLinks = false
    func setShareLinks(_ on: Bool) { shareLinks = on }
    static let instanceId = "k3x9q2m7p0a4b8c1d5e6f7g2"
    private static var shareLinksRuns: Data {
        let page = "https://link.happy.page/#1/\(instanceId)/agents"
        let reply = "Ask [](\(page)/happy-agent?as=bot) about the tone, and read [the crash](\(page)/crash-agent?as=task) first. "
            + "Theirs: https://link.happy.page/#1/m1n2b3v4c5x6z7l8k9j0h1g2/agents/t7bgxjt05aexj73frl6ul37e?as=task"
        let run: [String: Any] = ["id": "r1", "status": "completed", "startedAt": now - 60_000, "endedAt": now - 50_000, "reason": "completed", "messages": [
            ["id": "u1", "role": "user", "createdAt": now - 60_000, "metadata": [:], "content": [["type": "text", "text": "Who should I ask about the headlines?"]]],
            ["id": "m1", "role": "agent", "createdAt": now - 55_000, "metadata": [:], "content": [["type": "text", "text": reply]]],
        ]]
        return (try? JSONSerialization.data(withJSONObject: ["runs": [run], "hasMore": false])) ?? Data()
    }

    /// `-linkChips`: as `-shareLinks`, and Landing page copy's conversation
    /// links a task, a bot at work, an artifact, a task in bold, an agent
    /// this phone doesn't hold and another server's task, each read as what
    /// it names now whatever words it was written with, and a task by a
    /// bare share link; the person's message links one task, and the
    /// artifact is a Markdown brief whose links keep the words they were
    /// written with, an empty `[]` reading as the name or the placeholder.
    var linkChips = false
    func setLinkChips(_ on: Bool) { linkChips = on }
    private static var linkChipsRuns: Data {
        let page = "https://link.happy.page/#1/\(instanceId)/agents"
        let reply = "Here is where things stand.\n\n"
            + "- Task: [](\(page)/report-agent?as=task) has its charts.\n"
            + "- Bot: [a stale name](happy://agents/research-agent) is reading the papers.\n"
            + "- Artifact: [](happy://artifacts/brief) is ready.\n"
            + "- Bold: **[](\(page)/onboarding-agent?as=task)** go out Monday.\n"
            + "- Archived: [](\(page)/gone-agent?as=session)\n"
            + "- Bare: \(page)/report-agent?as=task\n"
            + "- Theirs: [](https://link.happy.page/#1/m1n2b3v4c5x6z7l8k9j0h1g2/agents/t7bgxjt05aexj73frl6ul37e?as=task)"
        let run: [String: Any] = ["id": "r1", "status": "completed", "startedAt": now - 60_000, "endedAt": now - 50_000, "reason": "completed", "messages": [
            ["id": "u1", "role": "user", "createdAt": now - 60_000, "metadata": [:], "content": [["type": "text", "text": "How is [](\(page)/crash-agent?as=task) going?"]]],
            ["id": "m1", "role": "agent", "createdAt": now - 55_000, "metadata": [:], "content": [["type": "text", "text": reply]]],
        ]]
        return (try? JSONSerialization.data(withJSONObject: ["runs": [run], "hasMore": false])) ?? Data()
    }
    static let brief = """
        # Launch brief

        Owner: [](https://link.happy.page/#1/\(instanceId)/agents/crash-agent?as=task)

        Ask [the researcher](happy://agents/research-agent) for sources, and tick off [the list](happy://\(instanceId)/surfaces/groceries).

        Before: [the old plan](https://link.happy.page/#1/\(instanceId)/agents/gone-agent?as=task), [](https://link.happy.page/#1/\(instanceId)/agents/gone-agent?as=task)

        Their plan: https://link.happy.page/#1/m1n2b3v4c5x6z7l8k9j0h1g2/agents/t7bgxjt05aexj73frl6ul37e?as=task
        """
    private static var briefFile: [String: Any] { ["path": "brief.md", "mimeType": "text/markdown", "size": brief.utf8.count] }

    /// One step of a computer whose agents work: line counts tick, a run
    /// starts or ends, an agent does something, a new task arrives on top.
    func churn(_ step: Int) {
        var random = SystemRandomNumberGenerator()
        let working = (made + base).compactMap { $0["agent"] as? [String: Any] }.filter { $0["status"] as? String == "working" }
        for agent in working.shuffled().prefix(3) {
            guard let workspace = agent["workspaceId"] as? String else { continue }
            var count = counts[workspace] ?? (Int.random(in: 1...300, using: &random), Int.random(in: 0...90, using: &random))
            count.0 += Int.random(in: 1...40, using: &random)
            if Bool.random(using: &random) { count.1 += Int.random(in: 1...9, using: &random) }
            counts[workspace] = count
            tell("git.updated", ["workspaceId": workspace, "git": ["comparison": "ready", "insertions": count.0, "deletions": count.1, "countsExact": true, "scannedAt": Date().timeIntervalSince1970 * 1000]])
        }
        switch Int.random(in: 0..<8, using: &random) {
        case 0:
            fresh += 1
            let n = fresh
            let agentId = "fresh\(n)-agent"
            let task: [String: Any] = ["id": "fresh\(n)", "name": "Fresh work \(n): Creating and Writing Artifacts", "status": "active", "agent": Self.agent(agentId, "Fresh \(n)", status: "working", ago: 0)]
            made.insert(task, at: 0)
            tell("task.created", ["task": task])
        case 1, 2:
            var all = made + base
            guard !all.isEmpty else { return }
            let index = Int.random(in: 0..<all.count, using: &random)
            guard var agent = all[index]["agent"] as? [String: Any] else { return }
            agent["status"] = agent["status"] as? String == "working" ? "idle" : "working"
            agent["lastActivityAt"] = Date().timeIntervalSince1970 * 1000
            all[index]["agent"] = agent
            if index < made.count { made[index] = all[index] } else { base[index - made.count] = all[index] }
            tell("agent.updated", ["agent": agent])
        case 3, 4:
            if made.count > 6 {
                let gone = made.remove(at: Int.random(in: 0..<made.count, using: &random))
                tell("task.updated", ["taskId": gone["id"]!])
            }
        default:
            break
        }
    }

    private func tell(_ type: String, _ payload: [String: Any]) {
        sequence += 1
        guard let data = try? JSONSerialization.data(withJSONObject: ["type": type, "payload": payload]) else { return }
        events?.yield(Data("id: c\(sequence)\nevent: event\ndata: ".utf8) + data + Data("\n\n".utf8))
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let route = path.split(separator: "?").first.map(String.init) ?? path
        if route == "/v0/projects/p1/avatar" { return .init(status: 200, body: avatar) }
        let sent = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        if route == "/v0/git/watch" {
            if churns {
                var snapshots: [String: Any] = [:]
                for id in sent["workspaceIds"] as? [String] ?? [] {
                    let count = counts[id] ?? (0, 0)
                    snapshots[id] = ["comparison": "ready", "insertions": count.0, "deletions": count.1, "countsExact": true, "scannedAt": Self.now]
                }
                return .init(status: 200, body: try JSONSerialization.data(withJSONObject: ["snapshots": snapshots]))
            }
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
        if linkChips, route.hasPrefix("/v0/artifacts/brief") {
            switch route {
            case "/v0/artifacts/brief":
                return .init(status: 200, body: try JSONSerialization.data(withJSONObject: ["artifact": ["id": "brief", "type": "markdown", "title": "Launch brief", "status": "active", "latestVersion": 1]]))
            case "/v0/artifacts/brief/versions/latest", "/v0/artifacts/brief/versions/1":
                return .init(status: 200, body: try JSONSerialization.data(withJSONObject: ["version": ["artifactId": "brief", "number": 1, "title": "Launch brief", "entry": Self.briefFile, "files": [Self.briefFile]]]))
            case "/v0/artifacts/brief/versions/1/files/brief.md":
                return .init(status: 200, body: Data(Self.brief.utf8))
            default:
                return .init(status: 404, body: Data("{}".utf8))
            }
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
            if route.hasSuffix("/messages") {
                if linkChips, agentId == "landing-agent" { return .init(status: 200, body: Self.linkChipsRuns) }
                if shareLinks, agentId == "landing-agent" { return .init(status: 200, body: Self.shareLinksRuns) }
                return .init(status: 200, body: Data(#"{"runs":[],"hasMore":false}"#.utf8))
            }
            if route.hasSuffix("/bootstrap") {
                return .init(status: 200, body: try JSONSerialization.data(withJSONObject: ["agent": ["id": String(agentId), "workspaceId": "w-\(agentId)", "status": "idle"], "pending": []]))
            }
        }
        let object: [String: Any]
        switch route {
        case "/v0/health":
            var health: [String: Any] = ["ready": true, "version": ["protocol": 27], "capabilities": ["sidebarOperations": true]]
            if shareLinks || linkChips { health["instanceId"] = Self.instanceId }
            object = health
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
    private var longTitles = false
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
        longTitles = arguments.contains("-longTitles")
        if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
        if arguments.contains("-light") { window.overrideUserInterfaceStyle = .light }
        let bottom = arguments.contains("-bottom")
        let churns = arguments.contains("-churn")
        let shareLinks = arguments.contains("-shareLinks")
        let linkChips = arguments.contains("-linkChips")
        // Every shimmer parked at one point of its loop, for a screenshot.
        if let index = arguments.firstIndex(of: "-shimmerPhase"), arguments.indices.contains(index + 1) {
            ShimmerClock.shared.frozenPhase = Double(arguments[index + 1])
        }
        if let index = arguments.firstIndex(of: "-drawDelay"), arguments.indices.contains(index + 1) {
            SidebarItemDrawing.testDrawDelay = Double(arguments[index + 1]) ?? 0
        }
        Task {
            await open(window: window, churns: churns, shareLinks: shareLinks, linkChips: linkChips)
            if churns { await churn(window: window, jumps: !arguments.contains("-noJumps"), flips: !arguments.contains("-noFlips")) }
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

    private var transport: GroupedHomeTransport?

    private func open(window: UIWindow, churns: Bool, shareLinks: Bool, linkChips: Bool = false) async {
        let transport = GroupedHomeTransport(avatar: Self.repoPicture(), lineCounts: lineCounts, longTitles: longTitles)
        await transport.setChurns(churns)
        await transport.setShareLinks(shareLinks)
        await transport.setLinkChips(linkChips)
        self.transport = transport
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
            // `-openChat <agentId>`: that conversation over home, for a run with no finger.
            let arguments = ProcessInfo.processInfo.arguments
            if let index = arguments.firstIndex(of: "-openChat"), arguments.indices.contains(index + 1) {
                try? await Task.sleep(for: .seconds(2))
                if let session = Session.session(for: connection.id, context: context) {
                    navigation.pushViewController(ChatViewController(session: session, agentId: arguments[index + 1], title: "Landing page copy", spaceId: nil, intro: nil), animated: false)
                }
            }
            // `-openArtifact <id>`: that Markdown artifact over home, the same way.
            if let index = arguments.firstIndex(of: "-openArtifact"), arguments.indices.contains(index + 1) {
                try? await Task.sleep(for: .seconds(2))
                if let session = Session.session(for: connection.id, context: context) {
                    let artifact = Artifact(id: arguments[index + 1], version: 1, type: "markdown", title: "Launch brief", followsLatest: true)
                    navigation.pushViewController(ArtifactViewController(session: session, artifact: artifact), animated: false)
                }
            }
        } catch {
            print("GROUPED_HOME error: \(error)")
        }
    }
}

extension GroupedHomeHarness {
    /// `-churn`: the computer keeps working, the list scrolls now and then,
    /// and every few seconds, after a quiet moment, each row on the list is
    /// checked: it shows its own latest drawing, at its size, with nothing
    /// else in its bitmap's view. What it finds goes to the log and to
    /// Documents/stale-rows.txt, with a picture of the screen.
    private func churn(window: UIWindow, jumps: Bool, flips: Bool) async {
        let log = URL.documentsDirectory.appendingPathComponent("stale-rows.txt")
        try? "".write(to: log, atomically: true, encoding: .utf8)
        func note(_ line: String) {
            print("STALE_ROWS \(line)")
            if let handle = try? FileHandle(forWritingTo: log) {
                handle.seekToEndOfFile(); handle.write(Data((line + "\n").utf8)); try? handle.close()
            }
        }
        try? await Task.sleep(for: .seconds(2))
        var step = 0
        var checks = 0
        var samples = 0, wrongSamples = 0, wrongRows = 0, pictured = false
        var kinds: [String: Int] = [:]
        while true {
            let burst = ContinuousClock.now + .seconds(Double.random(in: 4...9))
            while ContinuousClock.now < burst {
                step += 1
                await transport?.churn(step)
                if jumps, Int.random(in: 0..<6) == 0, let list = home?.view.firstSubview(of: SidebarList.self) {
                    let end = max(-list.contentInsets.top, list.edge.contentSize.height + list.contentInsets.bottom - list.bounds.height)
                    list.setContentOffsetY(Bool.random() ? -list.contentInsets.top : CGFloat.random(in: -list.contentInsets.top...end), animated: Bool.random())
                }
                if Int.random(in: 0..<40) == 0, let navigation = home?.navigationController, navigation.viewControllers.count == 1 {
                    // A chat opens over home, and comes back a moment later.
                    let pushed = UIViewController()
                    pushed.view.backgroundColor = .systemBackground
                    navigation.pushViewController(pushed, animated: Bool.random())
                    let away = Double.random(in: 0.2...3)
                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(away))
                        navigation.popViewController(animated: Bool.random())
                    }
                }
                if flips, Int.random(in: 0..<40) == 0 {
                    // To the background and back: iOS draws the app in both
                    // appearances for the switcher.
                    let style = window.overrideUserInterfaceStyle
                    window.overrideUserInterfaceStyle = style == .dark ? .light : .dark
                    window.layoutIfNeeded()
                    if Bool.random() { try? await Task.sleep(for: .milliseconds(Int.random(in: 1...120))) }
                    window.overrideUserInterfaceStyle = style
                    window.layoutIfNeeded()
                }
                try? await Task.sleep(for: .milliseconds(Int.random(in: 30...350)))
                // Mid-stream: rows on screen whose words or counts aren't their row's.
                if let list = home?.view.firstSubview(of: SidebarList.self) {
                    let visible = list.bounds.inset(by: UIEdgeInsets(top: list.contentInsets.top, left: 0, bottom: list.contentInsets.bottom, right: 0))
                    func reason(_ view: SidebarItemView) -> String? {
                        guard view.convert(view.box, to: list).intersects(visible), view.row.kind != .separator else { return nil }
                        let shown = view.shownDrawing.shown
                        guard shown.count == 1, let drawing = shown[0].drawing else { return "no host (\(view.shownDrawing.hidden) waiting)" }
                        let current = view.item.entry.drawing
                        if drawing.dark != current.dark { return "drawn \(drawing.dark ? "dark" : "light")" }
                        if drawing.frame != current.frame { return "frame label.y \(drawing.frame.label.minY) -> \(current.frame.label.minY)" }
                        if drawing.row.label != view.row.label || drawing.row.lineChanges != view.row.lineChanges { return "words" }
                        return nil
                    }
                    let reasons = list.mountedViews.compactMap { view in reason(view).map { (view, $0) } }
                    let off = reasons.map(\.0)
                    for (_, why) in reasons { kinds[String(why.prefix(8)), default: 0] += 1 }
                    samples += 1
                    if !off.isEmpty { wrongSamples += 1; wrongRows += off.count }
                    if off.count >= 2, !pictured {
                        pictured = true
                        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: false) }
                        try? image.pngData()?.write(to: URL.documentsDirectory.appendingPathComponent("mid-stream.png"))
                        note("pictured mid-stream: " + reasons.map { "\($0.0.row.label): \($0.1)" }.joined(separator: ", "))
                    }
                }
            }
            note("stream so far: \(wrongSamples) of \(samples) samples had rows on screen showing other words or counts than their row (\(wrongRows) rows in all: \(kinds.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")))")
            if let navigation = home?.navigationController, navigation.viewControllers.count > 1 { navigation.popToRootViewController(animated: false) }
            try? await Task.sleep(for: .seconds(2.5))
            guard let list = home?.view.firstSubview(of: SidebarList.self) else { continue }
            checks += 1
            // What is wrong now and still wrong a moment later, at rest:
            // a reveal mid-glide is not a stale row.
            func wrong(_ list: SidebarList) -> [ObjectIdentifier: String] {
                var found: [ObjectIdentifier: String] = [:]
                for view in list.mountedViews {
                    let current = view.item.entry
                    let shown = view.shownDrawing
                    var problems: [String] = []
                    if shown.shown.count != 1 { problems.append("\(shown.shown.count) hosts shown") }
                    if let host = shown.shown.first {
                        if host.drawing != current.drawing {
                            let what = host.drawing.map { "\"\($0.row.label)\" \($0.row.lineChanges.map { "+\($0.insertions)-\($0.deletions)" } ?? "") label.y \($0.frame.label.minY) dark \($0.dark)" } ?? "nothing"
                            problems.append("shows \(what); current \(current.row.lineChanges.map { "+\($0.insertions)-\($0.deletions)" } ?? "") label.y \(current.drawing.frame.label.minY) dark \(current.drawing.dark)")
                        }
                        if abs(host.size.height - current.size.height) > 0.5 { problems.append("host \(host.size.height) tall, slot \(current.size.height)") }
                        if host.bitmap == nil, view.row.kind != .separator { problems.append("no bitmap") }
                    }
                    if shown.hidden != 0 { problems.append("\(shown.hidden) hidden hosts waiting") }
                    if shown.others != 0 { problems.append("\(shown.others) leftover views") }
                    if !problems.isEmpty { found[ObjectIdentifier(view)] = "\(view.row.id) r\(view.item.revision) \"\(view.row.label)\": " + problems.joined(separator: "; ") + " | " + view.drawingDiagnostics }
                }
                // A row view still on screen that the list no longer shows.
                let mounted = Set(list.mountedViews.map(ObjectIdentifier.init))
                func strays(in view: UIView) -> [SidebarItemView] {
                    if let row = view as? SidebarItemView {
                        return !mounted.contains(ObjectIdentifier(row)) && !row.isHidden && row.alpha > 0.01 && row.layer.opacity > 0.01 ? [row] : []
                    }
                    if view.isHidden || view.alpha < 0.01 { return [] }
                    return view.subviews.flatMap(strays)
                }
                for stray in strays(in: list.list) {
                    found[ObjectIdentifier(stray)] = "STRAY \(stray.row.id) \"\(stray.row.label)\" in \(type(of: stray.superview!)) at \(stray.convert(stray.bounds, to: list)) | " + stray.drawingDiagnostics
                }
                return found
            }
            var bad: [String] = []
            let first = wrong(list)
            if !first.isEmpty {
                try? await Task.sleep(for: .seconds(1.5))
                let second = wrong(list)
                bad = first.keys.compactMap { key in first[key] == second[key] ? second[key] : nil }
                if list.isDragging || list.isDecelerating { bad = [] }
            }
            note("check \(checks) step \(step): \(list.mountedViews.count) rows, \(bad.count) wrong")
            for line in bad { note("  " + line) }
            if !bad.isEmpty || checks % 5 == 1 {
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: false) }
                try? image.pngData()?.write(to: URL.documentsDirectory.appendingPathComponent(bad.isEmpty ? "latest.png" : "stale-rows-\(checks).png"))
            }
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

#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct FeedOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct FeedNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A team computer that keeps a Feed, as API.md's Feed chapter has it:
/// Steve signed in, Ada and Bo beside him, a bot, two tasks (Ada's
/// archived), three Surfaces, artifacts (one deleted) and a week and more
/// of entries on them. The entries are references only: no title, no
/// picture, no text; the app finds each in what it syncs. Steve's task
/// is still "New Task", as it was when the entry was made, until
/// `rename()` names it on desktop. Seeing, read-all, following and
/// peeking answer as the daemon does; with `live`, a new entry arrives
/// over the stream a few seconds in. Two artifacts carry covers, a title
/// card and a square chart, which it draws and serves as their files;
/// it filters the feed by subject unless `filtering` is off, as an older
/// daemon's doesn't.
private actor FeedComputer: AgentTransport {
    static let steveHash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"
    static let adaHash = "HBkSHYSIeHiPiHh8eJd4eTN0EEQG"
    static let botHash = "HwgKPJxwd3dweHiHiHdwgAf3iA"
    static let bootstrap = #"""
    {"cursor":"cursor-1","feedUnread":4,"profile":{"userId":"steve","name":"Steve","photo":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}},"userSettings":[],
     "projects":[{"id":"p","name":"happy","status":"active","orderKey":"a","agents":[]}],
     "workspaces":[],
     "bots":[{"id":"research","name":"Research","status":"active","avatar":{"thumbhash":"HwgKPJxwd3dweHiHiHdwgAf3iA"},"agent":{"id":"research-agent","workspaceId":"r","status":"idle"}}],
     "tasks":[
       {"id":"mine","name":"New Task","ownerUserId":"steve","status":"active","agent":{"id":"mine-agent","workspaceId":"w1","status":"idle"}},
       {"id":"adas","name":"Fix the login redirect","ownerUserId":"ada","status":"archived","agent":{"id":"adas-agent","workspaceId":"w2","status":"idle"}}],
     "taskMemberships":[{"taskId":"mine"},{"taskId":"adas"}],
     "surfaces":[{"id":"groceries","name":"Groceries","type":"todo","members":[]},
                 {"id":"launch","name":"Launch notes","type":"document","members":[]},
                 {"id":"errands","name":"Errands","type":"todo","members":[]}]}
    """#
    static let renamed = "Ship the iOS feed"
    static let users = #"""
    {"users":[
      {"id":"ada","name":"Ada","photo":{"thumbhash":"HBkSHYSIeHiPiHh8eJd4eTN0EEQG"},"version":"1","updatedAt":1},
      {"id":"bo","name":"Bo","photo":null,"version":"1","updatedAt":1},
      {"id":"steve","name":"Steve","photo":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"},"version":"1","updatedAt":1}]}
    """#
    static let artifacts = #"""
    {"artifacts":[
      {"id":"roadmap","type":"html","title":"Q4 roadmap","latestVersion":3,"createdAt":1,"updatedAt":2},
      {"id":"mockups","type":"image_series","title":"Onboarding mockups","latestVersion":1,"createdAt":1,"updatedAt":1,"deleted":true},
      {"id":"revenue","type":"html","title":"Q3 revenue review","latestVersion":2,"createdAt":1,"updatedAt":3,
       "entry":{"path":"index.html","mimeType":"text/html","size":2048},
       "cover":{"path":"cover.png","mimeType":"image/png","width":1600,"height":900,"aspect":"wide"},
       "summary":"Revenue up 18% QoQ, driven by enterprise seats.","background":"#0b1f33"},
      {"id":"latency","type":"image","title":"API latency, last 30 days","latestVersion":1,"createdAt":1,"updatedAt":4,
       "entry":{"path":"chart.png","mimeType":"image/png","size":4096},
       "cover":{"path":"chart.png","mimeType":"image/png","width":1200,"height":1200,"aspect":"square"},
       "summary":null,"background":null}],
     "nextPageCursor":null}
    """#
    static let todos: [String: String] = [
        "groceries/oat": #"{"todo":{"id":"oat","surfaceId":"groceries","text":"Oat milk","status":"active","version":"1"}}"#,
        "errands/keys": #"{"todo":{"id":"keys","surfaceId":"errands","text":"Pick up the keys","status":"active","version":"1"}}"#,
    ]

    private var desktop = FeedComputer.bootstrap
    private var items: [JSONValue]
    private var clusters: [JSONValue]
    private var counter = 0
    private let live: Bool
    private let filtering: Bool
    private var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
    /// The live entry comes once, however often the stream opens again.
    private var arriving = false
    private(set) var requested: [String] = []

    init(live: Bool, filtering: Bool = true) {
        self.live = live
        self.filtering = filtering
        let now = Date().timeIntervalSince1970 * 1000
        func ago(_ minutes: Double) -> Double { (now - minutes * 60_000).rounded() }
        func item(_ n: Int, _ type: String, _ id: String, cluster: String, latest: String, todo: String? = nil, minutes: Double, created: Bool = false,
                  updates: Int = 0, actors: [JSONValue], count: Int? = nil, seen: Bool = false) -> JSONValue {
            var newest: [String: JSONValue] = ["type": .string(latest)]
            if let todo { newest["todoId"] = .string(todo) }
            let last = ago(minutes)
            return .object([
                "id": .string("item-\(n)"), "version": .string(Self.uuid(last, n)), "cursor": .string(Self.uuid(last, n)),
                "subject": .object(["type": .string(type), "id": .string(id)]), "cluster": .string(cluster),
                "created": .bool(created), "updates": .number(Double(updates)), "actors": .array(actors), "actorCount": .number(Double(count ?? actors.count)),
                "latest": .object(newest), "firstAt": .number(last - 600_000), "lastAt": .number(last),
                "seenAt": seen ? .number(last + 1000) : .null,
            ])
        }
        func person(_ id: String) -> JSONValue { .object(["userId": .string(id), "agentId": .null]) }
        func agent(_ id: String) -> JSONValue { .object(["userId": .null, "agentId": .string(id)]) }
        items = [
            item(1, "task", "mine", cluster: "task:mine", latest: "task.created", minutes: 4, updates: 3, actors: [agent("mine-agent"), person("steve")]),
            item(2, "surface", "groceries", cluster: "team", latest: "todo.created", todo: "oat", minutes: 38, updates: 4,
                 actors: [person("ada"), person("bo"), person("steve"), agent("research-agent")], count: 5),
            item(3, "artifact", "roadmap", cluster: "bot:research", latest: "artifact.updated", minutes: 190, created: true, updates: 2,
                 actors: [agent("research-agent")], seen: true),
            item(4, "bot", "research", cluster: "bot:research", latest: "bot.created", minutes: 60 * 26, updates: 1, actors: [agent("research-agent")]),
            item(5, "surface", "launch", cluster: "team", latest: "document.edited", minutes: 60 * 24 * 3, updates: 4,
                 actors: [person("ada"), person("bo")], seen: true),
            item(6, "task", "adas", cluster: "task:adas", latest: "task.created", minutes: 60 * 24 * 10, created: true,
                 actors: [person("ada"), agent("adas-agent")], seen: true),
            item(7, "artifact", "mockups", cluster: "team", latest: "artifact.created", minutes: 60 * 24 * 45, created: true,
                 actors: [person("bo")], seen: true),
            item(8, "artifact", "revenue", cluster: "bot:research", latest: "artifact.updated", minutes: 12, created: true, updates: 1,
                 actors: [agent("research-agent"), person("ada")]),
            item(9, "artifact", "latency", cluster: "team", latest: "artifact.created", minutes: 60 * 5, created: true,
                 actors: [person("bo")], seen: true),
        ].sorted { ($0["cursor"]?.stringValue ?? "") > ($1["cursor"]?.stringValue ?? "") }
        func cluster(_ id: String, _ kind: String, state: String?) -> JSONValue {
            .object(["cluster": .string(id), "kind": .string(kind), "state": state.map(JSONValue.string) ?? .null, "lastAt": .number(now)])
        }
        clusters = [
            cluster("*", "everything", state: nil),
            cluster("team", "team", state: "subscribed"),
            cluster("bot:research", "bot", state: nil),
            cluster("task:mine", "task", state: nil),
            cluster("task:adas", "task", state: "muted"),
            cluster("project:p", "project", state: nil),
        ]
    }

    /// A UUIDv7's shape from a time, so cursors and versions sort as text.
    static func uuid(_ ms: Double, _ n: Int) -> String {
        let hex = String(format: "%012llx", UInt64(ms))
        return "\(hex.prefix(8))-\(hex.suffix(4))-7000-8000-\(String(format: "%012x", n))"
    }

    private var unread: Int { items.filter { $0["seenAt"] == .null }.count }

    private func json(_ value: JSONValue, status: Int = 200) throws -> HTTP1Response {
        HTTP1Response(status: status, body: try JSONEncoder().encode(value))
    }

    /// Closes the open entries `matching` says, a new version each.
    private func close(_ matching: (JSONValue) -> Bool) -> [JSONValue] {
        var closed: [JSONValue] = []
        let now = Date().timeIntervalSince1970 * 1000
        for index in items.indices where items[index]["seenAt"] == .null && matching(items[index]) {
            guard case .object(var object) = items[index] else { continue }
            counter += 1
            object["seenAt"] = .number(now)
            object["version"] = .string(Self.uuid(now, 100 + counter))
            items[index] = .object(object)
            closed.append(items[index])
        }
        return closed
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requested.append("\(method) \(path)")
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? .null
        if path == "/v0/bootstrap/desktop" { return HTTP1Response(status: 200, body: Data(desktop.utf8)) }
        if path == "/v0/health" {
            return try json(.object(["ok": .bool(true), "capabilities": .object([
                "feed": .bool(true), "feedSubjectFilter": .bool(filtering), "artifactCovers": .bool(true),
            ])]))
        }
        if path.hasPrefix("/v0/users?ids=") { return HTTP1Response(status: 200, body: Data(Self.users.utf8)) }
        if path.hasPrefix("/v0/artifacts?") { return HTTP1Response(status: 200, body: Data(Self.artifacts.utf8)) }
        if path.hasPrefix("/v0/surfaces/todo/"), let todo = Self.todos[String(path.dropFirst("/v0/surfaces/todo/".count))] {
            return HTTP1Response(status: 200, body: Data(todo.utf8))
        }
        if path.hasPrefix("/v0/feed?") {
            let query = URLComponents(string: path)?.queryItems ?? []
            let before = query.first { $0.name == "before" }?.value
            // An older daemon reads past `subjects`.
            let subjects = filtering ? query.first { $0.name == "subjects" }?.value.map { $0.split(separator: ",").map(String.init) } : nil
            let about = items.filter { item in subjects.map { $0.contains(item["subject"]?["type"]?.stringValue ?? "") } ?? true }
            let page = about.filter { before == nil || ($0["cursor"]?.stringValue ?? "") < before! }
            var answer: [String: JSONValue] = ["items": .array(page), "unread": .number(Double(unread)), "hasMore": .bool(false)]
            if subjects != nil { answer["filteredUnread"] = .number(Double(about.filter { $0["seenAt"] == .null }.count)) }
            return try json(.object(answer))
        }
        if path == "/v0/feed/seen", method == "POST" {
            let subjects = sent["subjects"]?.arrayValue ?? []
            var closed: [JSONValue] = []
            for subject in subjects {
                let through = subject["through"]?.stringValue
                closed += close { item in
                    item["subject"]?["type"] == subject["type"] && item["subject"]?["id"] == subject["id"]
                        && through.map { (item["cursor"]?.stringValue ?? "") <= $0 } ?? true
                }
            }
            return try json(.object(["items": .array(closed), "unread": .number(Double(unread))]))
        }
        if path == "/v0/feed/read-all", method == "POST" {
            let through = sent["through"]?.stringValue
            let subjects = filtering ? sent["subjects"]?.arrayValue?.compactMap(\.stringValue) : nil
            _ = close { item in
                (through.map { (item["cursor"]?.stringValue ?? "") <= $0 } ?? true)
                    && (subjects.map { $0.contains(item["subject"]?["type"]?.stringValue ?? "") } ?? true)
            }
            return try json(.object(["unread": .number(Double(unread))]))
        }
        if path == "/v0/feed/clusters" { return try json(.object(["clusters": .array(clusters)])) }
        if path.hasPrefix("/v0/feed/subscriptions/") {
            let id = String(path.dropFirst("/v0/feed/subscriptions/".count)).removingPercentEncoding ?? ""
            guard let index = clusters.firstIndex(where: { $0["cluster"]?.stringValue == id }), case .object(var object) = clusters[index] else {
                return try json(.object(["error": .string("Not here."), "code": .string("not_found")]), status: 404)
            }
            object["state"] = .string(method == "PUT" ? "subscribed" : "muted")
            clusters[index] = .object(object)
            return try json(.object(["cluster": clusters[index]]))
        }
        if path.hasPrefix("/v0/feed/clusters/") {
            let raw = String(path.dropFirst("/v0/feed/clusters/".count).prefix { $0 != "?" })
            let id = raw.removingPercentEncoding ?? raw
            let cluster = clusters.first { $0["cluster"]?.stringValue == id } ?? .null
            let entries: [JSONValue] = items.filter { $0["cluster"]?.stringValue == id || id == "*" }.map { item in
                guard case .object(var object) = item else { return item }
                object["id"] = nil; object["version"] = nil; object["seenAt"] = nil
                return .object(object)
            }
            return try json(.object(["cluster": cluster, "entries": .array(entries)]))
        }
        if let picture = Self.picture(path) ?? Self.cover(path) { return HTTP1Response(status: 200, headers: ["content-type": "image/png"], body: picture) }
        return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
    }

    /// Faces served solid in their ThumbHash's colours: Steve blue, Ada
    /// red, the bot a gradient.
    private static func picture(_ path: String) -> Data? {
        let colors: [UIColor]
        switch path {
        case "/v0/users/steve/photo", "/v0/profile/photo": colors = [.systemBlue, .systemTeal]
        case "/v0/users/ada/photo": colors = [.systemRed, .systemOrange]
        case "/v0/bots/research/avatar": colors = [.systemIndigo, .systemPink]
        default: return nil
        }
        return UIGraphicsImageRenderer(size: CGSize(width: 120, height: 120)).pngData { context in
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors.map(\.cgColor) as CFArray, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 120, y: 120), options: [])
        }
    }

    /// The covers, drawn as an agent would make them: a title card with
    /// its headline number, and a square chart, at their own pixel sizes.
    private static func cover(_ path: String) -> Data? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        switch path {
        case "/v0/artifacts/revenue/versions/2/files/cover.png":
            let size = CGSize(width: 1600, height: 900)
            return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
                UIColor(red: 0.043, green: 0.122, blue: 0.2, alpha: 1).setFill()
                context.fill(CGRect(origin: .zero, size: size))
                func text(_ value: String, _ font: UIFont, _ color: UIColor, at point: CGPoint) {
                    NSAttributedString(string: value, attributes: [.font: font, .foregroundColor: color]).draw(at: point)
                }
                text("Q3 REVENUE REVIEW", .systemFont(ofSize: 48, weight: .semibold), UIColor(white: 1, alpha: 0.6), at: CGPoint(x: 110, y: 110))
                text("+18%", .systemFont(ofSize: 300, weight: .heavy), .white, at: CGPoint(x: 96, y: 170))
                text("quarter over quarter, led by enterprise seats", .systemFont(ofSize: 52, weight: .regular), UIColor(white: 1, alpha: 0.75), at: CGPoint(x: 110, y: 560))
                let bars: [CGFloat] = [0.42, 0.5, 0.47, 0.61, 0.66, 0.74, 0.88]
                for (index, value) in bars.enumerated() {
                    let height = 260 * value
                    let color = index == bars.count - 1 ? UIColor.systemGreen : UIColor(white: 1, alpha: 0.22)
                    color.setFill()
                    UIBezierPath(roundedRect: CGRect(x: 1010 + CGFloat(index) * 70, y: 760 - height, width: 46, height: height), cornerRadius: 10).fill()
                }
            }
        case "/v0/artifacts/latency/versions/1/files/chart.png":
            let size = CGSize(width: 1200, height: 1200)
            return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
                UIColor(red: 0.98, green: 0.97, blue: 0.94, alpha: 1).setFill()
                context.fill(CGRect(origin: .zero, size: size))
                NSAttributedString(string: "p95 latency", attributes: [.font: UIFont.systemFont(ofSize: 64, weight: .bold), .foregroundColor: UIColor.black]).draw(at: CGPoint(x: 90, y: 90))
                NSAttributedString(string: "212 ms → 148 ms", attributes: [.font: UIFont.systemFont(ofSize: 110, weight: .heavy), .foregroundColor: UIColor.systemIndigo]).draw(at: CGPoint(x: 86, y: 180))
                let line = UIBezierPath()
                let values: [CGFloat] = [0.8, 0.78, 0.82, 0.75, 0.7, 0.72, 0.6, 0.55, 0.52, 0.48, 0.5, 0.42, 0.4]
                for (index, value) in values.enumerated() {
                    let point = CGPoint(x: 100 + CGFloat(index) * 83, y: 450 + (1 - value) * 600)
                    index == 0 ? line.move(to: point) : line.addLine(to: point)
                }
                UIColor.systemIndigo.setStroke()
                line.lineWidth = 14
                line.lineJoinStyle = .round
                line.stroke()
                UIColor(white: 0, alpha: 0.15).setFill()
                context.fill(CGRect(x: 100, y: 1100, width: 1000, height: 3))
            }
        default:
            return nil
        }
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuations.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true}\n\n".utf8))
        if live, !arriving {
            arriving = true
            Task { try? await Task.sleep(for: .seconds(4)); await self.arrive() }
        }
        return HTTP1Stream(status: 200, body: body)
    }

    private func frame(_ type: String, _ payload: JSONValue, cursor: String, at now: Double) -> Data {
        let envelope: JSONValue = .object(["cursor": .string(cursor), "type": .string(type), "occurredAt": .number(now), "payload": payload])
        let data = String(data: (try? JSONEncoder().encode(envelope)) ?? Data(), encoding: .utf8) ?? "{}"
        return Data("event: \(type)\ndata: \(data)\n\n".utf8)
    }

    /// Bo adds a todo: a new entry at the top, unread, and its count.
    private func arrive() {
        let now = (Date().timeIntervalSince1970 * 1000).rounded()
        let cursor = Self.uuid(now, 50)
        let item: JSONValue = .object([
            "id": .string("item-50"), "version": .string(cursor), "cursor": .string(cursor),
            "subject": .object(["type": .string("surface"), "id": .string("errands")]), "cluster": .string("team"),
            "created": .bool(false), "updates": .number(1), "actors": .array([.object(["userId": .string("bo"), "agentId": .null])]), "actorCount": .number(1),
            "latest": .object(["type": .string("todo.created"), "todoId": .string("keys")]),
            "firstAt": .number(now), "lastAt": .number(now), "seenAt": .null,
        ])
        items.insert(item, at: 0)
        for continuation in continuations {
            continuation.yield(frame("feed.item.created", .object(["item": item]), cursor: cursor, at: now))
            continuation.yield(frame("feed.unread.updated", .object(["unread": .number(Double(unread))]), cursor: cursor, at: now))
        }
    }

    /// Steve names his task on desktop. Nothing in the Feed changes on
    /// the computer: the entry still points at the task, and the app,
    /// told the task changed, reads it again.
    func rename() {
        let now = (Date().timeIntervalSince1970 * 1000).rounded()
        counter += 1
        desktop = desktop.replacingOccurrences(of: #""name":"New Task""#, with: #""name":"\#(Self.renamed)""#)
        let payload: JSONValue = .object(["taskId": .string("mine"), "changes": .object(["name": .string(Self.renamed)])])
        continuations.forEach { $0.yield(frame("task.updated", payload, cursor: Self.uuid(now, 200 + counter), at: now)) }
    }

    func reset() async {}
    func close() async { continuations.forEach { $0.finish() }; continuations.removeAll() }
}

/// The Feed on a team computer that keeps one (`-screen agentFeed`): home,
/// with the Feed row and its count; `-open feed` pushes the Feed over it,
/// `-tab following` turns it to Following, `-live` brings a new entry in
/// over the stream a few seconds after it opens.
@MainActor
final class AgentFeedHarness {
    private var account: AccountController?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        let computer = FeedComputer(live: arguments.contains("-live"), filtering: !arguments.contains("-noSubjectFilter"))
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/agent-feed",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: FeedOffline(), connector: FeedNoSocket()
        )
        self.account = account
        do {
            let connection = try await account.agentConnections.add(.init(address: "agent-feed", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Studio Mac")
            let context = AppContext(account: account, variant: .development, version: "agent-feed")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
            if arguments.contains("-script") {
                await FeedScript(window: window, navigation: navigation, session: session, computer: computer, style: arguments.contains("-dark") ? "dark" : "light").run()
                return
            }
            guard let index = arguments.firstIndex(of: "-open"), arguments.indices.contains(index + 1), arguments[index + 1] == "feed" else { return }
            let feed = FeedViewController(session: session)
            navigation.pushViewController(feed, animated: false)
            if let tab = arguments.firstIndex(of: "-tab"), arguments.indices.contains(tab + 1), arguments[tab + 1] == "following" {
                feed.loadViewIfNeeded()
                feed.showFollowing()
            }
            if let index = arguments.firstIndex(of: "-filter"), arguments.indices.contains(index + 1), let filter = FeedFilter(rawValue: arguments[index + 1]) {
                feed.loadViewIfNeeded()
                feed.choose(filter)
            }
        } catch {
            print("AGENT_FEED error: \(error)")
        }
    }
}

/// The Feed walked through on a device where UI testing can't run: the
/// same steps as `FeedUITests`, taken through the screens' own handlers
/// (a row's select, the bar's acts), each screen drawn to
/// `Documents/feed-shots/<step>-<style>.png` and what it checked written
/// to `report-<style>.json`, for `devicectl` to copy off.
@MainActor
private final class FeedScript {
    let window: UIWindow
    let navigation: UINavigationController
    let session: Session
    private let computer: FeedComputer
    let style: String
    private var checks: [[String: Any]] = []
    private let folder: URL

    init(window: UIWindow, navigation: UINavigationController, session: Session, computer: FeedComputer, style: String) {
        self.window = window
        self.navigation = navigation
        self.session = session
        self.computer = computer
        self.style = style
        folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("feed-shots")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    private func check(_ name: String, _ passed: Bool, _ detail: String = "") {
        checks.append(["check": name, "passed": passed, "detail": detail])
        print("FEED_SCRIPT \(passed ? "PASS" : "FAIL") \(name) \(detail)")
    }

    private func until(_ seconds: Double = 10, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(100)) }
        return condition()
    }

    private func shoot(_ name: String) async {
        try? await Task.sleep(for: .milliseconds(900))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try? image.pngData()?.write(to: folder.appendingPathComponent("\(name)-\(style).png"))
    }

    /// A post's cover has its picture, somewhere on screen.
    private func coverShown(in view: UIView) -> Bool {
        (view as? FeedCoverView)?.loaded == true || view.subviews.contains { coverShown(in: $0) }
    }

    private func feedRow() -> Row? { session.home.rows.first { $0.targetKind == "feed" } }

    private func entry(_ id: String, in list: CardListView) -> CardItem? { list.items.first { $0.id == id } }

    private func title(_ id: String, in list: CardListView) -> String { entry(id, in: list)?.accessibilityLabel ?? "" }

    private func unread(_ id: String, in list: CardListView) -> Bool { entry(id, in: list)?.accessibilityValue?.hasPrefix("Unread") == true }

    func run() async {
        let started = Date()
        check("home lists the Feed", await until(20) { feedRow() != nil })
        check("the Feed row counts what is unread", await until { feedRow()?.count == 4 }, "count \(String(describing: feedRow()?.count))")
        await shoot("feed-home")

        let feed = FeedViewController(session: session)
        navigation.pushViewController(feed, animated: true)
        let list = feed.activity
        check("the entries load", await until { entry("item-2", in: list) != nil })
        check("an open entry is unread", unread("item-2", in: list), entry("item-2", in: list)?.accessibilityValue ?? "")
        check("a seen entry isn't", entry("item-3", in: list).map { $0.accessibilityValue?.hasPrefix("Unread") != true } ?? false)
        check("the entries are under their dates", list.items.filter { $0.kind == .heading }.count >= 4, list.items.filter { $0.kind == .heading }.map(\.accessibilityLabel).joined(separator: ", "))
        check("each row is named from what the app syncs", ["item-1": "New Task", "item-2": "Groceries", "item-3": "Q4 roadmap", "item-4": "Research", "item-5": "Launch notes"]
            .allSatisfy { title($0.key, in: list) == $0.value }, (1...7).map { title("item-\($0)", in: list) }.joined(separator: ", "))
        check("an archived task is named as it was", title("item-6", in: list) == "Fix the login redirect")
        check("a deleted artifact is named and opens nothing", title("item-7", in: list) == "Onboarding mockups" && entry("item-7", in: list)?.opens == false)
        check("a todo list says its newest todo", entry("item-2", in: list)?.accessibilityValue?.contains("Oat milk") == true, entry("item-2", in: list)?.accessibilityValue ?? "")
        await shoot("feed-activity")

        // A covered artifact is a post: its row, its summary, its cover at
        // the cover's shape; one without a cover stays a row.
        let post = entry("item-8", in: list)
        check("a covered artifact is a post", post?.overlays.contains { $0.kind == FeedListItems.coverKind } == true && (post?.size.height ?? 0) > 200,
              "height \(post?.size.height ?? 0)")
        let cover = post?.overlays.first { $0.kind == FeedListItems.coverKind }?.frame
        check("its cover is 16:9 across the card", cover.map { abs($0.height - ($0.width * 9 / 16)) < 1 } ?? false, "\(cover.map { "\($0)" } ?? "none")")
        check("and says its summary", post?.accessibilityValue?.contains("Revenue up 18% QoQ") == true, post?.accessibilityValue ?? "")
        let square = entry("item-9", in: list)?.overlays.first { $0.kind == FeedListItems.coverKind }?.frame
        check("a square chart is as tall as it is wide", square.map { abs($0.height - $0.width) < 1 } ?? false)
        check("an artifact without a cover stays a row", entry("item-3", in: list).map { !$0.overlays.contains { $0.kind == FeedListItems.coverKind } && $0.size.height < 100 } ?? false)
        check("the cover arrives", await until { coverShown(in: feed.view) }, "")
        await shoot("feed-covers")

        // Highlights: artifacts and tasks only, as the bar's filter picks it.
        feed.choose(.highlights)
        let highlighted: Set<String> = ["item-1", "item-3", "item-6", "item-7", "item-8", "item-9"]
        check("Highlights shows artifacts and tasks only", await until {
            let rows = Set(list.items.filter { $0.kind == .row }.map(\.id))
            return rows == highlighted
        }, list.items.filter { $0.kind == .row }.map(\.id).joined(separator: ", "))
        check("the post shows there too", entry("item-8", in: list)?.overlays.contains { $0.kind == FeedListItems.coverKind } == true)
        check("the cover arrives there too", await until { coverShown(in: feed.view) })
        list.scrollToTop(animated: false)
        await shoot("feed-highlights")
        // The square chart whole.
        list.scroll(to: "item-3", animated: false)
        check("the square's cover arrives", await until { coverShown(in: feed.view) })
        await shoot("feed-highlights-square")
        list.scrollToTop(animated: false)
        feed.choose(.all)
        check("All shows everything again", await until { entry("item-2", in: list) != nil && entry("item-5", in: list) != nil })

        // Steve names his task on desktop: that row follows, no other is touched.
        let others = Dictionary(uniqueKeysWithValues: list.items.filter { $0.kind == .row && $0.id != "item-1" }.map { ($0.id, $0.revision) })
        await computer.rename()
        check("a renamed task's row follows", await until { title("item-1", in: list) == FeedComputer.renamed }, title("item-1", in: list))
        let touched = list.items.filter { item in others[item.id].map { $0 != item.revision } ?? false }.map(\.id)
        check("and no other row is redrawn", touched.isEmpty, touched.joined(separator: ", "))
        await shoot("feed-renamed")

        check("a new entry arrives over the stream", await until(15) { unread("item-50", in: list) })
        check("it is named from its Surface", title("item-50", in: list) == "Errands", title("item-50", in: list))
        check("and says the todo added", await until { entry("item-50", in: list)?.accessibilityValue?.contains("Pick up the keys") == true }, entry("item-50", in: list)?.accessibilityValue ?? "")
        check("its count follows on home", await until { feedRow()?.count == 5 }, "count \(String(describing: feedRow()?.count))")
        list.scrollToTop(animated: false)
        await shoot("feed-live")

        list.onSelect?("item-2")
        check("opening an entry opens its subject", await until { navigation.topViewController !== feed })
        try? await Task.sleep(for: .seconds(1))
        await shoot("feed-opened")
        navigation.popViewController(animated: true)
        _ = await until { navigation.topViewController === feed }
        check("an opened entry is seen", await until { !unread("item-2", in: list) })
        check("and counted off", await until { feedRow()?.count == 4 }, "count \(String(describing: feedRow()?.count))")

        feed.readAll()
        check("Mark All Read leaves nothing unread", await until { list.items.allSatisfy { $0.accessibilityValue?.hasPrefix("Unread") != true } })
        check("and the row's count goes", await until { feedRow()?.count == nil })
        check("and the button rests", feed.navigationItem.rightBarButtonItem?.isEnabled == false)
        await shoot("feed-read")

        feed.showFollowing()
        let following = feed.following
        check("Following lists the places", await until { following.items.contains { $0.id == "task:adas" } })
        check("each named from what the app syncs", following.items.first { $0.id == "task:mine" }?.accessibilityLabel == FeedComputer.renamed
            && following.items.first { $0.id == "project:p" }?.accessibilityLabel == "happy",
              following.items.filter { $0.kind == .row }.map(\.accessibilityLabel).joined(separator: ", "))
        await shoot("feed-following")
        feed.follow("task:adas", true)
        check("following a muted place takes", await until { following.items.first { $0.id == "task:adas" }?.overlays.contains { $0.key.hasSuffix("|true|false") } == true })

        following.onSelect?("bot:research")
        check("a peek opens", await until { navigation.topViewController is FeedPeekViewController })
        if let peek = navigation.topViewController as? FeedPeekViewController {
            check("the peek shows the place's entries", await until { peek.list.items.contains { $0.id == "artifact:roadmap" } })
            check("under the place's name", peek.title == "Research", peek.title ?? "")
        }
        await shoot("feed-peek")

        let report: [String: Any] = ["style": style, "seconds": Date().timeIntervalSince(started), "checks": checks,
                                     "passed": checks.allSatisfy { $0["passed"] as? Bool == true }]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: folder.appendingPathComponent("report-\(style).json"))
        }
        print("FEED_SCRIPT DONE")
    }
}
#endif

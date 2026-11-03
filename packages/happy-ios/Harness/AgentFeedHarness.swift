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
/// Steve signed in, Ada and Bo beside him, a bot, two tasks, and a week
/// and more of entries on them, on a todo list, a document and artifacts.
/// Seeing, read-all, following and peeking answer as the daemon does;
/// with `live`, a new entry arrives over the stream a few seconds in.
private actor FeedComputer: AgentTransport {
    static let steveHash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"
    static let adaHash = "HBkSHYSIeHiPiHh8eJd4eTN0EEQG"
    static let botHash = "HwgKPJxwd3dweHiHiHdwgAf3iA"
    static let bootstrap = #"""
    {"cursor":"cursor-1","feedUnread":3,"profile":{"userId":"steve","name":"Steve","photo":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}},"userSettings":[],
     "projects":[{"id":"p","name":"happy","status":"active","orderKey":"a","agents":[]}],
     "workspaces":[],
     "bots":[{"id":"research","name":"Research","status":"active","avatar":{"thumbhash":"HwgKPJxwd3dweHiHiHdwgAf3iA"},"agent":{"id":"research-agent","workspaceId":"r","status":"idle"}}],
     "tasks":[
       {"id":"mine","name":"Ship the iOS feed","ownerUserId":"steve","agent":{"id":"mine-agent","workspaceId":"w1","status":"idle"}},
       {"id":"adas","name":"Fix the login redirect","ownerUserId":"ada","agent":{"id":"adas-agent","workspaceId":"w2","status":"idle"}}],
     "taskMemberships":[{"taskId":"mine"},{"taskId":"adas"}],
     "surfaces":[]}
    """#
    static let users = #"""
    {"users":[
      {"id":"ada","name":"Ada","photo":{"thumbhash":"HBkSHYSIeHiPiHh8eJd4eTN0EEQG"},"version":"1","updatedAt":1},
      {"id":"bo","name":"Bo","photo":null,"version":"1","updatedAt":1},
      {"id":"steve","name":"Steve","photo":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"},"version":"1","updatedAt":1}]}
    """#

    private var items: [JSONValue]
    private var clusters: [JSONValue]
    private var counter = 0
    private let live: Bool
    private var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private(set) var requested: [String] = []

    init(live: Bool) {
        self.live = live
        let now = Date().timeIntervalSince1970 * 1000
        func ago(_ minutes: Double) -> Double { (now - minutes * 60_000).rounded() }
        func item(_ n: Int, _ type: String, _ id: String, cluster: String, title: String, minutes: Double, created: Bool = false, updates: Int = 0,
                  actors: [JSONValue], count: Int? = nil, seen: Bool = false, agentId: String? = nil, surfaceType: String? = nil,
                  artifactType: String? = nil, version: Int? = nil, detail: String? = nil) -> JSONValue {
            var snapshot: [String: JSONValue] = ["title": .string(title)]
            if let agentId { snapshot["agentId"] = .string(agentId) }
            if let surfaceType { snapshot["surfaceType"] = .string(surfaceType) }
            if let artifactType { snapshot["artifactType"] = .string(artifactType) }
            if let version { snapshot["artifactVersion"] = .number(Double(version)) }
            if let detail { snapshot["detail"] = .string(detail) }
            let last = ago(minutes)
            return .object([
                "id": .string("item-\(n)"), "version": .string(Self.uuid(last, n)), "cursor": .string(Self.uuid(last, n)),
                "subject": .object(["type": .string(type), "id": .string(id)]), "cluster": .string(cluster),
                "created": .bool(created), "updates": .number(Double(updates)), "actors": .array(actors), "actorCount": .number(Double(count ?? actors.count)),
                "snapshot": .object(snapshot), "firstAt": .number(last - 600_000), "lastAt": .number(last),
                "seenAt": seen ? .number(last + 1000) : .null,
            ])
        }
        func person(_ id: String) -> JSONValue { .object(["userId": .string(id), "agentId": .null]) }
        func agent(_ id: String) -> JSONValue { .object(["userId": .null, "agentId": .string(id)]) }
        items = [
            item(1, "task", "mine", cluster: "task:mine", title: "Ship the iOS feed", minutes: 4, updates: 3, actors: [agent("mine-agent"), person("steve")], agentId: "mine-agent"),
            item(2, "surface", "groceries", cluster: "team", title: "Groceries", minutes: 38, updates: 4,
                 actors: [person("ada"), person("bo"), person("steve"), agent("research-agent")], count: 5, surfaceType: "todo", detail: "Oat milk"),
            item(3, "artifact", "roadmap", cluster: "bot:research", title: "Q4 roadmap", minutes: 190, created: true, updates: 2,
                 actors: [agent("research-agent")], seen: true, artifactType: "html", version: 3),
            item(4, "bot", "research", cluster: "bot:research", title: "Research", minutes: 60 * 26, updates: 1,
                 actors: [agent("research-agent")], agentId: "research-agent", detail: "Summarized twelve papers on retrieval"),
            item(5, "surface", "launch", cluster: "team", title: "Launch notes", minutes: 60 * 24 * 3, updates: 4,
                 actors: [person("ada"), person("bo")], seen: true, surfaceType: "document"),
            item(6, "task", "adas", cluster: "task:adas", title: "Fix the login redirect", minutes: 60 * 24 * 10, created: true,
                 actors: [person("ada"), agent("adas-agent")], seen: true, agentId: "adas-agent"),
            item(7, "artifact", "mockups", cluster: "team", title: "Onboarding mockups", minutes: 60 * 24 * 45, created: true,
                 actors: [person("bo")], seen: true, artifactType: "image_series", version: 1),
        ]
        func cluster(_ id: String, _ kind: String, _ name: String, state: String?) -> JSONValue {
            .object(["cluster": .string(id), "kind": .string(kind), "name": .string(name), "state": state.map(JSONValue.string) ?? .null, "lastAt": .number(now)])
        }
        clusters = [
            cluster("*", "everything", "Everything", state: nil),
            cluster("team", "team", "Team", state: "subscribed"),
            cluster("bot:research", "bot", "Research", state: nil),
            cluster("task:mine", "task", "Ship the iOS feed", state: nil),
            cluster("task:adas", "task", "Fix the login redirect", state: "muted"),
            cluster("project:p", "project", "happy", state: nil),
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
        if path == "/v0/bootstrap/desktop" { return HTTP1Response(status: 200, body: Data(Self.bootstrap.utf8)) }
        if path == "/v0/health" { return try json(.object(["ok": .bool(true), "capabilities": .object(["feed": .bool(true)])])) }
        if path.hasPrefix("/v0/users?ids=") { return HTTP1Response(status: 200, body: Data(Self.users.utf8)) }
        if path.hasPrefix("/v0/feed?") {
            let before = URLComponents(string: path)?.queryItems?.first { $0.name == "before" }?.value
            let page = items.filter { before == nil || ($0["cursor"]?.stringValue ?? "") < before! }
            return try json(.object(["items": .array(page), "unread": .number(Double(unread)), "hasMore": .bool(false)]))
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
            _ = close { item in through.map { (item["cursor"]?.stringValue ?? "") <= $0 } ?? true }
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
        if let picture = Self.picture(path) { return HTTP1Response(status: 200, headers: ["content-type": "image/png"], body: picture) }
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

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuations.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true}\n\n".utf8))
        if live { Task { try? await Task.sleep(for: .seconds(4)); await self.arrive() } }
        return HTTP1Stream(status: 200, body: body)
    }

    /// Bo adds a todo: a new entry at the top, unread, and its count.
    private func arrive() {
        let now = (Date().timeIntervalSince1970 * 1000).rounded()
        let cursor = Self.uuid(now, 50)
        let item: JSONValue = .object([
            "id": .string("item-50"), "version": .string(cursor), "cursor": .string(cursor),
            "subject": .object(["type": .string("surface"), "id": .string("errands")]), "cluster": .string("team"),
            "created": .bool(false), "updates": .number(1), "actors": .array([.object(["userId": .string("bo"), "agentId": .null])]), "actorCount": .number(1),
            "snapshot": .object(["title": .string("Errands"), "surfaceType": .string("todo"), "detail": .string("Pick up the keys")]),
            "firstAt": .number(now), "lastAt": .number(now), "seenAt": .null,
        ])
        items.insert(item, at: 0)
        func frame(_ type: String, _ payload: JSONValue) -> Data {
            let envelope: JSONValue = .object(["cursor": .string(cursor), "type": .string(type), "occurredAt": .number(now), "payload": payload])
            let data = String(data: (try? JSONEncoder().encode(envelope)) ?? Data(), encoding: .utf8) ?? "{}"
            return Data("event: \(type)\ndata: \(data)\n\n".utf8)
        }
        for continuation in continuations {
            continuation.yield(frame("feed.item.created", .object(["item": item])))
            continuation.yield(frame("feed.unread.updated", .object(["unread": .number(Double(unread))])))
        }
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
        let computer = FeedComputer(live: arguments.contains("-live"))
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
                await FeedScript(window: window, navigation: navigation, session: session, style: arguments.contains("-dark") ? "dark" : "light").run()
                return
            }
            guard let index = arguments.firstIndex(of: "-open"), arguments.indices.contains(index + 1), arguments[index + 1] == "feed" else { return }
            let feed = FeedViewController(session: session)
            navigation.pushViewController(feed, animated: false)
            if let tab = arguments.firstIndex(of: "-tab"), arguments.indices.contains(tab + 1), arguments[tab + 1] == "following" {
                feed.loadViewIfNeeded()
                feed.showFollowing()
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
    let style: String
    private var checks: [[String: Any]] = []
    private let folder: URL

    init(window: UIWindow, navigation: UINavigationController, session: Session, style: String) {
        self.window = window
        self.navigation = navigation
        self.session = session
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

    private func feedRow() -> Row? { session.home.rows.first { $0.targetKind == "feed" } }

    private func entry(_ id: String, in list: CardListView) -> CardItem? { list.items.first { $0.id == id } }

    private func unread(_ id: String, in list: CardListView) -> Bool { entry(id, in: list)?.accessibilityValue?.hasPrefix("Unread") == true }

    func run() async {
        let started = Date()
        check("home lists the Feed", await until(20) { feedRow() != nil })
        check("the Feed row counts what is unread", await until { feedRow()?.count == 3 }, "count \(String(describing: feedRow()?.count))")
        await shoot("feed-home")

        let feed = FeedViewController(session: session)
        navigation.pushViewController(feed, animated: true)
        let list = feed.activity
        check("the entries load", await until { entry("item-2", in: list) != nil })
        check("an open entry is unread", unread("item-2", in: list), entry("item-2", in: list)?.accessibilityValue ?? "")
        check("a seen entry isn't", entry("item-3", in: list).map { $0.accessibilityValue?.hasPrefix("Unread") != true } ?? false)
        check("the entries are under their dates", list.items.filter { $0.kind == .heading }.count >= 4, list.items.filter { $0.kind == .heading }.map(\.accessibilityLabel).joined(separator: ", "))
        await shoot("feed-activity")

        check("a new entry arrives over the stream", await until(15) { unread("item-50", in: list) })
        check("its count follows on home", await until { feedRow()?.count == 4 }, "count \(String(describing: feedRow()?.count))")
        list.scrollToTop(animated: false)
        await shoot("feed-live")

        list.onSelect?("item-2")
        check("opening an entry opens its subject", await until { navigation.topViewController !== feed })
        try? await Task.sleep(for: .seconds(1))
        await shoot("feed-opened")
        navigation.popViewController(animated: true)
        _ = await until { navigation.topViewController === feed }
        check("an opened entry is seen", await until { !unread("item-2", in: list) })
        check("and counted off", await until { feedRow()?.count == 3 }, "count \(String(describing: feedRow()?.count))")

        feed.readAll()
        check("Mark All Read leaves nothing unread", await until { list.items.allSatisfy { $0.accessibilityValue?.hasPrefix("Unread") != true } })
        check("and the row's count goes", await until { feedRow()?.count == nil })
        check("and the button rests", feed.navigationItem.rightBarButtonItem?.isEnabled == false)
        await shoot("feed-read")

        feed.showFollowing()
        let following = feed.following
        check("Following lists the places", await until { following.items.contains { $0.id == "task:adas" } })
        await shoot("feed-following")
        feed.follow("task:adas", true)
        check("following a muted place takes", await until { following.items.first { $0.id == "task:adas" }?.overlays.contains { $0.key.hasSuffix("|true|false") } == true })

        following.onSelect?("bot:research")
        check("a peek opens", await until { navigation.topViewController is FeedPeekViewController })
        if let peek = navigation.topViewController as? FeedPeekViewController {
            check("the peek shows the place's entries", await until { peek.list.items.contains { $0.id == "artifact:roadmap" } })
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

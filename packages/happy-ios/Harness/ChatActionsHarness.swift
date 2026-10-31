#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
import HappyLayout
import Network
@testable import HappyUI
import UIKit

private struct ChatActionsHTTP: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}
private struct ChatActionsSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// The daemon's side of `CONNECT /v0/artifacts/:id/proxy` then `CONNECT host:port`: both answered,
/// then the bytes go to that host from here. It logs the outer route (`E5_TUNNEL`), so a run shows which proxy a page took.
private actor ArtifactProxyFake: BrowserStream {
    private var head = Data(), answers: [Data] = [], upstream: NetworkBrowserStream?
    func write(_ data: Data) async throws {
        if let upstream { return try await upstream.write(data) }
        head += data
        while let end = head.range(of: Data("\r\n\r\n".utf8)) {
            let line = String(decoding: head[..<end.lowerBound], as: UTF8.self).split(separator: "\r\n").first ?? ""
            head = Data(head[end.upperBound...])
            let target = line.split(separator: " ").dropFirst().first.map(String.init) ?? ""
            answers.append(Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8))
            if target.hasPrefix("/") { print("E5_TUNNEL \(target)"); continue }
            let parts = target.split(separator: ":").map(String.init)
            let port = NWEndpoint.Port(parts.count > 1 ? parts[1] : "443") ?? .https
            let connection = NWConnection(host: NWEndpoint.Host(parts[0]), port: port, using: .tcp)
            connection.start(queue: DispatchQueue.global())
            upstream = NetworkBrowserStream(connection)
        }
    }
    func read(maximumBytes: Int) async throws -> Data {
        if !answers.isEmpty { return answers.removeFirst() }
        return try await upstream?.read(maximumBytes: maximumBytes) ?? Data()
    }
    func close() async { await upstream?.close() }
}

/// A protocol-34 daemon with inline actions and rich tasks on (`-off`: neither,
/// as main meets it), one task's conversation: a reply to a story, the launch
/// post's draft with its `<menu>`, and, with `-question single|multi`, a
/// question pending. `-pressed`: the menu was answered "Use this draft".
private actor ChatActionsTransport: AgentTransport {
    let off: Bool, pressed: Bool, question: String?, quoted: String, social: Bool
    let stories: StoryArtifactsHarnessTransport
    private(set) var sent: [String] = []
    init(off: Bool, pressed: Bool, question: String?, quoted: String, pictures: String?, social: Bool) {
        (self.off, self.pressed, self.question, self.quoted, self.social) = (off, pressed, question, quoted, social)
        stories = StoryArtifactsHarnessTransport(directory: pictures, seen: [], me: "kirill")
    }

    private static let now = Date().timeIntervalSince1970 * 1000
    static let menu = "\n\n<menu>\n  <button data-action=\"reply\" data-emphasis>Use this draft</button>\n  <button data-action=\"reply\">Shorter</button>\n</menu>"

    private func message(_ id: String, _ role: String, _ text: String, ago minutes: Double, extra: [String: Any] = [:]) -> [String: Any] {
        ["id": id, "role": role, "createdAt": Self.now - minutes * 60_000, "metadata": ["userId": "kirill"], "content": [["type": "text", "text": text]]].merging(extra) { $1 }
    }

    private func runs() -> [[String: Any]] {
        let filler = (0..<4).map { index in
            [message("f\(index)u", "user", "Where are we on the launch post, part \(index + 1)?", ago: 90 - Double(index) * 10),
             message("f\(index)a", "agent", "Still collecting the screenshots from the onboarding review. The wall photo has every screen, so I am cutting the frames from it one by one and checking each against the build.", ago: 89 - Double(index) * 10)]
        }.flatMap { $0 }
        var said = filler + [
            message("q", "user", "This is the one, write the launch post around it", ago: 20, extra: ["replyTo": ["kind": "story", "artifactId": quoted]]),
            message("d", "agent", "Here's the draft:\n\n> Onboarding now drafts your first task for you. Add a project and Happy has a task waiting." + Self.menu, ago: 19,
                    extra: pressed ? ["actionChoices": ["0": ["kind": "button", "index": 0]]] : [:]),
        ]
        if pressed { said.append(message("p", "user", "Use this draft", ago: 18)) }
        // Social Growth's three parts (demo scene 7): the tweet, the video to attach, a drafted quote.
        if social { said.append(message("s", "agent", "Best place to share it: [swyx's post on threads as a kanban](happy://artifacts/tweet1), live and 2 days old, and Steve knows him.\n\nAttach [Kirill's repost of the Onboarding v2 recording](happy://artifacts/s-kirill).\n\n> One thread pings back when it's done. Happy turns that into the board.\n\nRunner-ups: Jerry Liu's Slack of agents, Adib Mohsin's multiplayer remote control." + Self.menu, ago: 2)) }
        return [["id": "r", "status": "completed", "startedAt": Self.now - 100 * 60_000, "messages": said]]
    }

    func browserConnection() async throws -> any BrowserStream { ArtifactProxyFake() }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let route = path.split(separator: "?").first.map(String.init) ?? path
        // `-social`: the tweet is a live-URL page, Kirill's repost a story (`type=story` reads it).
        if social, route == "/v0/artifacts/tweet1" {
            let live = #"{"url":"https://platform.x.com/embed/Tweet.html?id=2085253030417461661&theme=dark","networkId":"n1"}"#
            return .init(status: 200, body: Data(#"{"artifact":{"id":"tweet1","type":"html","title":"swyx on X","status":"active","latestVersion":1,"live":\#(live)}}"#.utf8))
        }
        if social, route == "/v0/artifacts/s-kirill", path.hasSuffix("type=story") {
            return .init(status: 200, body: Data(#"{"artifact":{"id":"s-kirill","type":"story","title":"Story","status":"active","latestVersion":1}}"#.utf8))
        }
        if route.hasPrefix("/v0/stories") || route.hasPrefix("/v0/artifacts/") || route.hasPrefix("/v0/users/") { return try await stories.request(method: method, path: path, credential: credential, body: body, headers: headers) }
        let agent: [String: Any] = ["id": "launch-agent", "workspaceId": "w", "status": "idle"].merging(question == nil ? [:] : ["pendingQuestionId": "q1"]) { $1 }
        let object: [String: Any]
        switch (method, route) {
        case ("GET", "/v0/health"): object = ["ready": true, "version": ["protocol": 34], "capabilities": ["sidebarOperations": true, "taskSections": true, "storyArtifacts": true, "chatActions": !off]]
        case ("GET", "/v0/users"): object = ["users": StoryArtifactsHarnessTransport.people.map { ["id": $0.key, "name": $0.value.name, "photo": $0.value.hasPhoto ? ["url": "/v0/users/\($0.key)/photo"] as Any : NSNull()] }]
        case ("GET", "/v0/config"): object = ["config": [
            "defaults": ["providerId": "claude", "modelId": "anthropic/opus-5", "permissionMode": "auto"],
            "models": ["anthropic/opus-5": ["name": "Opus 5", "efforts": ["medium", "high"], "defaultEffort": "medium"]],
            "providers": ["claude": ["type": "claude", "enabled": true, "models": [["id": "anthropic/opus-5", "enabled": true]]]],
        ]]
        case ("GET", "/v0/bootstrap/desktop"): object = [
            "cursor": "c1", "profile": ["userId": "kirill"], "userSettings": off ? [] : [["key": "tasks.rich", "value": true, "version": "1"]],
            "bots": [], "surfaces": [], "projects": [], "workspaces": [], "taskSections": [], "taskArtifacts": [],
            "tasks": [["id": "launch", "name": "Launch post", "agent": agent], ["id": "onboarding", "name": "Onboarding redesign", "agent": ["id": "onboarding-agent", "workspaceId": "w2", "status": "idle"]]],
            "taskMemberships": [["taskId": "launch", "orderKey": "a"], ["taskId": "onboarding", "orderKey": "b"]],
        ]
        case ("GET", "/v0/agents/launch-agent/bootstrap"): object = ["agent": agent, "pending": []]
        case ("GET", "/v0/agents/launch-agent/messages"): object = ["runs": runs(), "hasMore": false]
        case ("GET", "/v0/agents/launch-agent/question"):
            let multi = question == "multi"
            let options: [[String: Any]] = multi ? [["label": "Warm"], ["label": "Plain"], ["label": "Playful"], ["label": "Other"]]
                : [["label": "Today", "description": "Before the team call"], ["label": "Tomorrow morning"], ["label": "Other"]]
            object = ["question": ["id": "q1", "context": "For Friday's launch post", "questions": [["id": "p1", "header": multi ? "Tone" : "When", "question": multi ? "Which tones should the post take?" : "When should it go out?", "options": options, "multiSelect": multi]]]]
        case ("POST", _):
            sent.append(String(decoding: body ?? Data(), as: UTF8.self))
            // A press comes back as the person's text message with the button's words.
            let press = (try? JSONSerialization.jsonObject(with: body ?? Data())) as? [String: Any]
            let control = ((press?["content"] as? [[String: Any]])?.first?["controlIndex"] as? Int).map { ["Use this draft", "Shorter"][$0] }
            object = control.map { ["cursor": "c2", "message": message(press?["id"] as? String ?? "p", "user", $0, ago: 0)] } ?? [:]
        default: return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: try JSONSerialization.data(withJSONObject: object))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }
    func reset() {}
    func close() {}
}

/// Inline actions in a task's conversation (`-screen chatActions`), the real
/// chat over the daemon above. `-mockImages <dir>` as `StoryArtifactsHarness`'s;
/// `-quote <storyId>` the story replied to, `-openQuote` opened;
/// `-top` scrolls to the first message, so the way back shows; `-dark` is dark mode.
@MainActor
final class ChatActionsHarness {
    private var account: AccountController?

    init(window: UIWindow, arguments: [String]) {
        window.overrideUserInterfaceStyle = arguments.contains("-dark") ? .dark : .light
        let question = arguments.firstIndex(of: "-question").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        let pictures = arguments.firstIndex(of: "-mockImages").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        let transport = ChatActionsTransport(off: arguments.contains("-off"), pressed: arguments.contains("-pressed"), question: question,
            quoted: arguments.firstIndex(of: "-quote").map { arguments[$0 + 1] } ?? "s-onboarding-2", pictures: pictures, social: arguments.contains("-social"))
        Task { await open(window: window, transport: transport, top: arguments.contains("-top"), open: arguments.contains("-openQuote"), storyLink: arguments.contains("-openStoryLink")) }
    }

    private func open(window: UIWindow, transport: ChatActionsTransport, top: Bool, open: Bool, storyLink: Bool = false) async {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/chat-actions",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in transport },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: ChatActionsHTTP(), connector: ChatActionsSockets()
        )
        self.account = account
        do {
            let connection = try await account.agentConnections.add(.init(address: "chat-actions", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Personal MacBook Pro")
            let context = AppContext(account: account, variant: .development, version: "chat-actions")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            try await Task.sleep(for: .seconds(1.5))
            navigation.pushViewController(ChatViewController(session: session, agentId: "launch-agent", title: "Launch post", spaceId: nil, intro: nil), animated: false)
            if open {
                try await Task.sleep(for: .seconds(5))
                navigation.topViewController?.view.firstSubview(of: StoryInlineView.self)?.perform(Selector(("canvasTapped")))
            }
            // `-openStoryLink`: the message's link to Kirill's repost tapped, then the viewer's "…".
            if storyLink {
                try await Task.sleep(for: .seconds(5))
                (navigation.topViewController as? ChatViewController)?.open(link: "happy://artifacts/s-kirill")
                try await Task.sleep(for: .seconds(3))
                navigation.topViewController?.presentedViewController?.perform(Selector(("moreTapped")))
            }
            guard top else { return }
            try await Task.sleep(for: .seconds(2.5))
            navigation.topViewController?.view.firstSubview(of: AgentChatUltraList.self)?.list.scrollToTop(animated: false)
        } catch {
            print("CHAT_ACTIONS error: \(error)")
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

#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct AgentChatHTTP: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct AgentChatSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// One agent, `harness`, with forty turns of a question and a few lines of
/// answer, and nothing streaming. With `slash`, it offers slash commands
/// (one with a picture), and its last turn is a `/compact`. With `story`,
/// it is Scout, and its last turn answers the reader's reply to its story;
/// with `teammate` too, Ana's reply.
private struct AgentChatComputer: AgentTransport {
    var slash = false
    var story = false
    var teammate = false

    private static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }

    private static func message(_ id: String, role: String, _ content: [JSONValue]) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(1), "metadata": .object([:]), "content": .array(content)])
    }

    private static let runs: [JSONValue] = (0..<40).map { index in
        let answer = "Answer \(index). " + String(repeating: "The cache keeps what it read and drops it when the file changes. ", count: 1 + index % 4)
        return .object([
            "id": .string("r\(index)"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
            "messages": .array([
                message("u\(index)", role: "user", [text("Question \(index): why does the cache test fail?")]),
                message("m\(index)", role: "agent", [text(answer)]),
            ]),
        ])
    }

    /// A person's reply to Scout's story, quoted, and Scout's answer: the
    /// reader's, or their teammate Ana's.
    private static func storyReply(from userId: String) -> JSONValue { .object([
        "id": .string("story-run"), "status": .string("completed"), "startedAt": .number(3_000), "endedAt": .number(4_000), "reason": .string("completed"),
        "messages": .array([
            .object(["id": .string("story"), "role": .string("user"), "createdAt": .number(1_762_000_000_000), "content": .array([text("This looks so much cleaner! Did the drop-off improve?")]), "metadata": .object(["userId": .string(userId)]),
                     "quote": .object(["kind": .string("story"), "storyId": .string("s1"), "agentId": .string("harness"), "userId": .null, "caption": .string("Shipped the new onboarding today"), "expiresAt": .number(0), "frame": .object(["mimeType": .string("image/png")])])]),
            message("story-answer", role: "agent", [text("It did: completion went from 61% to 78% in the first day.")]),
        ]),
    ]) }

    /// The story's first frame: a 9:16 sunset over hills.
    private static let frame: Data = UIGraphicsImageRenderer(size: CGSize(width: 180, height: 320)).pngData { context in
        let colors = [UIColor.systemOrange.cgColor, UIColor.systemPink.cgColor, UIColor.systemPurple.cgColor] as CFArray
        let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 0.5, 1])!
        context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: 320), options: [])
        UIColor.systemYellow.setFill()
        UIBezierPath(ovalIn: CGRect(x: 60, y: 120, width: 60, height: 60)).fill()
        UIColor(white: 0.1, alpha: 0.85).setFill()
        UIBezierPath(ovalIn: CGRect(x: -80, y: 200, width: 340, height: 260)).fill()
    }

    private static func command(_ name: String, _ description: String, kind: String?, arguments: Bool, thumbhash: String? = nil) -> JSONValue {
        var command: [String: JSONValue] = ["name": .string(name), "description": .string(description), "hasArguments": .bool(arguments)]
        if let kind { command["kind"] = .string(kind) }
        if let thumbhash { command["image"] = .object(["thumbhash": .string(thumbhash)]) }
        return .object(command)
    }

    private static let commands: [JSONValue] = [
        command("compact", "Summarize older messages to free context space.", kind: "compaction", arguments: false),
        command("code-review", "Review the current changes for bugs and risky edges.", kind: "skill", arguments: true, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI"),
        command("commit", "Write a commit message for the staged changes.", kind: "skill", arguments: true),
        command("deploy", "Ship the current build to staging.", kind: "release", arguments: true),
        command("context", "Show what is in the context window.", kind: nil, arguments: false),
    ]

    /// `/compact`'s maintenance run, done.
    private static let compaction: JSONValue = .object([
        "id": .string("compaction"), "status": .string("completed"), "startedAt": .number(3_000), "endedAt": .number(4_200), "reason": .string("compaction"),
        "messages": .array([.object([
            "id": .string("compaction"), "role": .string("service"), "createdAt": .number(3_000), "metadata": .object([:]),
            "content": .array([.object([
                "type": .string("compaction"), "trigger": .string("manual"), "status": .string("completed"),
                "tokensBefore": .number(201_000), "tokensAfter": .number(43_200), "failureReason": .null,
                "startedAt": .number(3_000), "completedAt": .number(4_200),
            ])]),
        ])]),
    ])

    /// The code-review command's picture.
    private static let picture: Data = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).pngData { context in
        let colors = [UIColor.systemIndigo.cgColor, UIColor.systemPink.cgColor] as CFArray
        let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
        context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 64, y: 64), options: [])
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/agents/harness/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(Self.runs + (slash ? [Self.compaction] : []) + (story ? [Self.storyReply(from: teammate ? "ana" : "me")] : []))])
        } else if story, path.hasSuffix("/agents/harness/messages/story/story-frame") {
            return HTTP1Response(status: 200, body: Self.frame)
        } else if path.hasSuffix("/agents/harness/bootstrap") {
            value = .object(["agent": .object(["id": .string("harness"), "workspaceId": .string("w"), "status": .string("idle"), "title": story ? .string("Scout") : .null]), "pending": .array([]),
                             "slashCommands": .array(slash ? Self.commands : [])])
        } else if story, let read = Self.people(path) {
            value = read
        } else if slash, path.hasSuffix("/slash-commands/code-review/image") {
            return HTTP1Response(status: 200, body: Self.picture)
        } else {
            throw URLError(.cannotConnectToHost)
        }
        return HTTP1Response(status: 200, body: try JSONEncoder().encode(value))
    }

    /// Enough of the computer for its people: the reader is "me", and Ana a teammate.
    private static func people(_ path: String) -> JSONValue? {
        if path.hasSuffix("/health") { return .object(["ready": .bool(true), "capabilities": .object(["sidebarOperations": .bool(true)])]) }
        if path.contains("/spaces/sidebar") { return .object(["artifactId": .string("sidebar"), "version": .number(1), "html": .string(""), "spaces": .array([])]) }
        if path.hasSuffix("/bots") { return .object(["bots": .array([])]) }
        if path.contains("/tasks?") { return .object(["tasks": .array([])]) }
        if path.hasSuffix("/profile") { return .object(["profile": .object(["userId": .string("me"), "name": .string("Kirill")])]) }
        if path.contains("/users?") { return .object(["users": .array([.object(["id": .string("ana"), "name": .string("Ana Ruiz")])])]) }
        return nil
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }

    func reset() async {}
    func close() async {}
}

/// The agents' chat for the keyboard's UI tests (`-screen agentChat`): an
/// offline computer's home with a long conversation pushed over it, and
/// the same probe the sessions' chat has (`ChatScrollProbe`).
/// `-hideKeyboardButton` and `-keyboard` work as they do there.
@MainActor
final class AgentChatHarness {
    private var account: AccountController?
    private var probe: ChatScrollProbe?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/agent-chat",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in AgentChatComputer(slash: arguments.contains("-slash"), story: arguments.contains("-story"), teammate: arguments.contains("-teammate")) },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: AgentChatHTTP(), connector: AgentChatSockets()
        )
        self.account = account
        do {
            await account.agentConnections.setForeground(false)
            let connection = try await account.agentConnections.add(.init(address: "agent-chat", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Studio Mac")
            let context = AppContext(account: account, variant: .development, version: "agent-chat")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            // `-story`: the sidebar read once, offline, for who is reading.
            if arguments.contains("-story") { _ = await session.store.externalResync(loadSidebar: true) }
            let chat = ChatViewController(session: session, agentId: "harness", title: arguments.contains("-story") ? "Scout" : "Cache", spaceId: nil, intro: nil)
            navigation.pushViewController(chat, animated: false)
            let probe = ChatScrollProbe(window: window, chat: chat)
            self.probe = probe
            if arguments.contains("-keyboard") { probe.focusComposerWhenFilled() }
            // `-draft /co`: the composer holds it, as typed.
            if let index = arguments.firstIndex(of: "-draft"), arguments.indices.contains(index + 1) {
                let draft = arguments[index + 1]
                try? await Task.sleep(for: .seconds(1))
                chat.card.setText(draft, selection: NSRange(location: (draft as NSString).length, length: 0))
                chat.agentInputCardDidChangeText(chat.card)
            }
            // `-story`: the quoted reply as drawn, in Documents/story-reply.png.
            if arguments.contains("-story") {
                try? await Task.sleep(for: .seconds(4))
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                try? image.pngData()?.write(to: URL.documentsDirectory.appendingPathComponent("story-reply.png"))
            }
        } catch {
            print("AGENT_CHAT error: \(error)")
        }
    }
}
#endif

#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
import Foundation
import HappyCore
import HappyWire
@testable import HappyUI
import UIKit

/// Private fixture transport: all records are fictional, no inference or server.
private actor StoryComputer: AgentTransport {
    private let question: Bool
    private let compact: Bool
    private let video: Bool
    /// The Home the video is at: 0 before anything starts, 3 once a subtask is done.
    private var phase = 0
    private var git: [String: JSONValue] = [:]
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private var event = 1
    init(question: Bool, compact: Bool, video: Bool) { self.question = question; self.compact = compact; self.video = video }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let route = path.components(separatedBy: "?")[0]
        if route.hasSuffix("/photo") {
            return HTTP1Response(status: 200, body: Data(base64Encoded: route.contains("steve") ? StoryData.stevePhoto : StoryData.kirillPhoto)!)
        }
        if route.hasSuffix("/image") || route.hasSuffix("/avatar") {
            let icon = [("android-push", StoryData.icon0), ("release-checklist", StoryData.icon1), ("bot-1", StoryData.icon2), ("ios-overlay", StoryData.icon3), ("landing", StoryData.icon4)]
                .first { route.contains("/\($0.0)/") }?.1 ?? StoryData.icon2
            return HTTP1Response(status: 200, body: Data(base64Encoded: icon)!)
        }
        let text: String
        switch route {
        case "/v0/health": text = "{\"ready\":true,\"ok\":true,\"version\":{\"protocol\":27},\"capabilities\":{\"feed\":true}}"
        case "/v0/bootstrap/desktop": text = video ? [StoryData.video0, StoryData.video1, StoryData.video2, StoryData.video3][phase] : StoryData.home
        case "/v0/config": text = compact ? StoryData.compact : StoryData.config
        case "/v0/users": text = StoryData.users
        case "/v0/profile": text = StoryData.profile
        case "/v0/agents/checkout/bootstrap": text = question ? StoryData.voicebootstrap : StoryData.bootstrap
        case "/v0/agents/checkout/messages": text = question ? StoryData.voicepage : StoryData.page
        case "/v0/agents/checkout/question": text = StoryData.question
        case "/v0/usage": text = StoryData.usage
        case "/v0/git/watch": text = video ? gitJSON() : StoryData.git
        case "/v0/feed": text = StoryData.feed
        case "/v0/feed/clusters": text = StoryData.clusters
        case "/v0/artifacts": text = "{\"artifacts\":[],\"nextPageCursor\":null}"
        case "/v0/artifacts/retention": text = StoryData.artifact
        default: text = "{}"
        }
        return HTTP1Response(status: 200, body: Data(text.utf8))
    }

    /// The chart artifact's page, served as the daemon would serve its file.
    func browserConnection() async throws -> any BrowserStream { StoryPage() }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"story-1\",\"resumed\":true}\n\n".utf8))
        streams.append(continuation)
        return HTTP1Stream(status: 200, body: stream)
    }
    func reset() async {}
    func close() async {}

    // MARK: Video

    private func gitJSON() -> String {
        var snapshots = (try? JSONDecoder().decode(JSONValue.self, from: Data(StoryData.git.utf8)))?["snapshots"]?.objectValue ?? [:]
        snapshots["sub-icons"] = nil
        snapshots["sub-dots"] = nil
        for (id, value) in git { snapshots[id] = value }
        let data = try! JSONEncoder().encode(JSONValue.object(["snapshots": .object(snapshots)]))
        return String(decoding: data, as: UTF8.self)
    }

    private func send(_ type: String, _ payload: JSONValue) {
        let data = try! JSONEncoder().encode(JSONValue.object(["type": .string(type), "payload": payload]))
        let frame = "id: story-\(event + 1)\ndata: \(String(decoding: data, as: UTF8.self))\n\n"
        event += 1
        for stream in streams { stream.yield(Data(frame.utf8)) }
    }

    private func move(to phase: Int) {
        self.phase = phase
        send("task.updated", .object(["taskId": .string("checkout")]))
    }

    private func lines(_ id: String, _ added: Int, _ removed: Int) {
        let state: JSONValue = .object([
            "comparison": .string("ready"), "insertions": .number(Double(added)), "deletions": .number(Double(removed)),
            "countsExact": .bool(true), "scannedAt": .number(Date().timeIntervalSince1970 * 1000),
        ])
        git[id] = state
        send("git.updated", .object(["workspaceId": .string(id), "git": state]))
    }

    /// About 16 seconds of Home getting on with things: subtasks start under
    /// the active task, one writes code, finishes, and asks to be read.
    func play() async {
        let start = ContinuousClock.now
        for step in 0..<7 {
            let time = [2.0, 3.2, 4.6, 6.0, 7.4, 8.8, 11.0][step]
            try? await Task.sleep(until: start + .milliseconds(Int(time * 1000)), clock: .continuous)
            switch step {
            case 0: move(to: 1)
            case 1: lines("sub-icons", 8, 0)
            case 2: move(to: 2); lines("sub-icons", 21, 2)
            case 3: lines("sub-icons", 34, 3); lines("sub-dots", 6, 0)
            case 4: lines("sub-icons", 47, 5)
            case 5: lines("sub-icons", 52, 9); lines("sub-dots", 14, 1)
            default: move(to: 3)
            }
        }
    }
}

/// One request to the chart artifact, answered with its page and closed.
private actor StoryPage: BrowserStream {
    private var request = Data()
    private var response: Data?
    private var waiting: CheckedContinuation<Data, Never>?

    func write(_ data: Data) async throws {
        request.append(data)
        guard response == nil, let head = String(data: request, encoding: .utf8), head.contains("\r\n\r\n") else { return }
        let target = head.split(separator: " ").dropFirst().first.map(String.init) ?? ""
        let body = Data(target.hasSuffix("/index.html") ? StoryData.chartHTML.utf8 : "".utf8)
        let status = body.isEmpty ? "404 Not Found" : "200 OK"
        var bytes = Data("HTTP/1.1 \(status)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
        bytes.append(body)
        response = bytes
        if let waiting { self.waiting = nil; waiting.resume(returning: bytes); response = Data() }
    }

    func read(maximumBytes: Int) async throws -> Data {
        if let response {
            let chunk = response.prefix(maximumBytes)
            self.response = response.dropFirst(chunk.count)
            return Data(chunk)
        }
        return await withCheckedContinuation { waiting = $0 }
    }

    func close() async {
        if let waiting { self.waiting = nil; waiting.resume(returning: Data()) }
    }
}

@MainActor
final class StoryHarness {
    private var coordinator: AppCoordinator?
    init(window: UIWindow, arguments: [String]) {
        let video = arguments.contains("-video")
        let computer = StoryComputer(question: arguments.contains("-question"), compact: arguments.contains("-compact"), video: video)
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/story-fixture",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }
        )
        Task { @MainActor in
            do {
                _ = try await controller.agentConnections.add(.init(address: "demo-personal", port: 1, deviceID: "demo-personal", deviceToken: "fictional"), name: "MacBook Pro")
                _ = try await controller.agentConnections.add(.init(address: "demo-home", port: 1, deviceID: "demo-home", deviceToken: "fictional"), name: "Smart Home Server")
                // Added last, so it is the one open.
                _ = try await controller.agentConnections.add(.init(address: "demo-team", port: 1, deviceID: "demo-team", deviceToken: "fictional"), name: "Happy Engineering Team")
            } catch { fatalError("Story fixture: \(error)") }
            let context = AppContext(account: controller, variant: .development, version: "story-fixture")
            let coordinator = AppCoordinator(window: window, context: context)
            self.coordinator = coordinator
            coordinator.start()
            window.overrideUserInterfaceStyle = .light
            if video {
                // The test starts recording at 7 s; Home has settled by then.
                try? await Task.sleep(for: .seconds(9))
                await computer.play()
                return
            }
            if arguments.contains("-noKeyboard") {
                // The new-task screen focuses its composer; keep the keyboard
                // away so the model picker has the screen's height.
                Task { @MainActor in
                    for _ in 0..<120 { window.endEditing(true); try? await Task.sleep(for: .milliseconds(250)) }
                }
            }
            try? await Task.sleep(for: .seconds(3))
            if arguments.contains("-openFeed"), let shell = window.rootViewController as? ShellViewController,
               let home = shell.stack.first, let id = controller.agentConnections.activeID,
               let session = Session.session(for: id, context: context) {
                home.navigationController?.pushViewController(FeedViewController(session: session), animated: false)
            }
            if arguments.contains("-openChat"), let shell = window.rootViewController as? ShellViewController,
               let home = shell.stack.first, let id = controller.agentConnections.activeID,
               let session = Session.session(for: id, context: context) {
                let chat = ChatViewController(session: session, agentId: "checkout", title: arguments.contains("-question") ? "Product Health" : "Onboarding Copy", spaceId: nil, intro: nil)
                // "-callFirst": the call is already on when the chat opens.
                if arguments.contains("-callFirst") {
                    CallController.shared.showFixture("listening", from: home)
                    try? await Task.sleep(for: .seconds(1.5))
                }
                home.navigationController?.pushViewController(chat, animated: false)
                if arguments.contains("-question"), !arguments.contains("-noCall"), !arguments.contains("-callFirst") {
                    try? await Task.sleep(for: .seconds(1))
                    CallController.shared.showFixture("listening", from: chat)
                }
            }
        }
    }
}
#endif

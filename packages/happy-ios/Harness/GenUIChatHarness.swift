#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct GenUIChatHTTP: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct GenUIChatSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// One agent, `harness`, whose every turn shows a `gen_ui` artifact: the
/// compiled examples in turn, each its own artifact, served with their
/// pictures as a daemon serves a version's files.
private struct GenUIChatComputer: AgentTransport {
    let count: Int
    let folder: URL

    static let examples = [
        "01-stats", "02-chart-line", "03-chart-bar", "04-chart-donut", "05-gallery-grid", "06-gallery-carousel",
        "07-list", "08-table", "09-steps", "10-choices", "11-release", "12-labels", "gen-7-02", "gen-7-05", "icons-and-colours",
    ]

    private static func message(_ id: String, role: String, _ content: [JSONValue]) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(1), "metadata": .object([:]), "content": .array(content)])
    }

    private func example(_ id: String) -> String? {
        guard id.hasPrefix("genui-"), let index = Int(id.dropFirst(6)) else { return nil }
        return Self.examples[index % Self.examples.count]
    }

    private var runs: [JSONValue] {
        (0..<count).map { index in
            let name = Self.examples[index % Self.examples.count]
            let call: JSONValue = .object([
                "type": .string("tool_call"), "id": .string("t\(index)"), "name": .string("create_artifact"), "status": .string("completed"),
                "presentation": .object([
                    "type": .string("artifact"), "artifactId": .string("genui-\(index)"), "artifactType": .string("gen_ui"),
                    "title": .string(name), "version": .number(1), "shows": .string("latest"),
                ]),
            ])
            return .object([
                "id": .string("r\(index)"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
                "messages": .array([
                    Self.message("u\(index)", role: "user", [.object(["type": .string("text"), "text": .string("Show me \(name).")])]),
                    Self.message("m\(index)", role: "agent", [.object(["type": .string("text"), "text": .string("Here it is.")]), call]),
                ]),
            ])
        }
    }

    private func file(_ path: String, _ mimeType: String) -> JSONValue {
        let size = (try? FileManager.default.attributesOfItem(atPath: folder.appendingPathComponent(path).path)[.size] as? Int) ?? 0
        return .object(["path": .string(path), "mimeType": .string(mimeType), "size": .number(Double(size)), "sha256": .string("0")])
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        if path.contains("/agents/harness/messages?") {
            return try Self.json(.object(["hasMore": .bool(false), "runs": .array(runs)]))
        }
        if path.hasSuffix("/agents/harness/bootstrap") {
            return try Self.json(.object(["agent": .object(["id": .string("harness"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([]), "slashCommands": .array([])]))
        }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 3, parts[0] == "v0", parts[1] == "artifacts", let name = example(parts[2]) else { throw URLError(.cannotConnectToHost) }
        let id = parts[2]
        if parts.count == 3 {
            return try Self.json(.object(["artifact": .object([
                "id": .string(id), "type": .string("gen_ui"), "title": .string(name), "latestVersion": .number(1), "status": .string("active"),
                "entry": file(GenUIRenderDocument.path, "application/json"),
            ])]))
        }
        if parts.count == 5, parts[3] == "versions" {
            let assets = ((try? FileManager.default.contentsOfDirectory(atPath: folder.appendingPathComponent("assets").path)) ?? []).sorted()
            return try Self.json(.object(["version": .object([
                "artifactId": .string(id), "number": .number(1), "title": .string(name), "entry": file("index.genui.json", "application/json"),
                "files": .array([file(GenUIRenderDocument.path, "application/json")] + assets.map { file("assets/\($0)", "image/jpeg") }),
            ])]))
        }
        if parts.count > 6, parts[3] == "versions", parts[5] == "files" {
            let wanted = parts[6...].joined(separator: "/").removingPercentEncoding ?? ""
            let url = wanted == GenUIRenderDocument.path ? folder.appendingPathComponent("\(name).render.json") : folder.appendingPathComponent(wanted)
            guard let data = try? Data(contentsOf: url) else { return HTTP1Response(status: 404, body: Data(#"{"error":"not found"}"#.utf8)) }
            return Self.serve(data, range: headers["Range"])
        }
        throw URLError(.cannotConnectToHost)
    }

    private static func json(_ value: JSONValue) throws -> HTTP1Response {
        HTTP1Response(status: 200, body: try JSONEncoder().encode(value))
    }

    /// The file route: the range asked for, or the whole file.
    private static func serve(_ data: Data, range: String?) -> HTTP1Response {
        let total = data.count
        guard let range, range.hasPrefix("bytes=") else { return HTTP1Response(status: 200, headers: ["content-length": "\(total)"], body: data) }
        let bounds = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2, let start = Int(bounds[0]), start < total else {
            return HTTP1Response(status: 416, headers: ["content-range": "bytes */\(total)"], body: Data())
        }
        let end = min(total - 1, Int(bounds[1]) ?? total - 1)
        return HTTP1Response(status: 206, headers: ["content-range": "bytes \(start)-\(end)/\(total)", "content-length": "\(end - start + 1)"], body: data.subdata(in: start..<(end + 1)))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }

    func reset() async {}
    func close() async {}
}

/// A conversation of Gen UI (`-screen genuiChat`, `-genuiCount N`, 50 by
/// default): every turn a call that shows a `gen_ui` artifact, drawn under
/// its card. With `HAPPY_GYM_METER=1` it runs the gym's scroll script
/// (`HAPPY_GYM_SCRIPT`) once the rows are in and prints the meter's reading
/// as `GENUI_GYM key=value…`, also written to `Documents/genui-gym.txt`.
@MainActor
final class GenUIChatHarness {
    private var account: AccountController?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        let count = arguments.firstIndex(of: "-genuiCount").flatMap { arguments.indices.contains($0 + 1) ? Int(arguments[$0 + 1]) : nil } ?? 50
        let folder = Bundle.main.resourceURL!.appendingPathComponent("GenUI")
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/genui-chat",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in GenUIChatComputer(count: count, folder: folder) },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: GenUIChatHTTP(), connector: GenUIChatSockets()
        )
        self.account = account
        do {
            await account.agentConnections.setForeground(false)
            let connection = try await account.agentConnections.add(.init(address: "genui-chat", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Studio Mac")
            let context = AppContext(account: account, variant: .development, version: "genui-chat")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            let chat = ChatViewController(session: session, agentId: "harness", title: "Gen UI", spaceId: nil, intro: nil)
            navigation.pushViewController(chat, animated: false)
            GymFrameMeter.installIfAsked(in: window)
            guard GymFrameMeter.shared != nil else { return }
            // The rows and their documents in, then the script, then its reading.
            try await Task.sleep(for: .seconds(6))
            let center = CFNotificationCenterGetDarwinNotifyCenter()
            CFNotificationCenterPostNotification(center, CFNotificationName(GymFrameMeter.runNotification as CFString), nil, nil, true)
            try await Task.sleep(for: .seconds(1))
            while let reading = Self.reading(in: window), reading.contains("scripting=1") {
                try await Task.sleep(for: .milliseconds(500))
            }
            let reading = Self.reading(in: window) ?? "no meter"
            print("GENUI_GYM \(reading)")
            let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            try? reading.write(to: documents.appendingPathComponent("genui-gym.txt"), atomically: true, encoding: .utf8)
        } catch {
            print("GENUI_CHAT error: \(error)")
        }
    }

    private static func reading(in window: UIWindow) -> String? {
        func find(_ view: UIView) -> UIView? {
            if view.accessibilityIdentifier == "gym-meter" { return view }
            for sub in view.subviews { if let found = find(sub) { return found } }
            return nil
        }
        return find(window)?.accessibilityValue
    }
}
#endif

#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import HappyWire
import UIKit
import XCTest

/// A paired computer whose person last started a session, on desktop, on
/// Codex's GPT Sol at Extra High: their settings say so under desktop's
/// keys (`ModelPreferences`). It keeps what is written to them.
private actor StartComputer: AgentTransport {
    private(set) var settings: [String: JSONValue] = [
        ModelPreferences.Key.defaultModel: .object(["modelId": .string("openai/sol")]),
        ModelPreferences.Key.effort: .string("xhigh"),
        ModelPreferences.Key.provider: .string("codex"),
        ModelPreferences.Key.memory: .array([
            .object(["providerId": .string("codex"), "modelId": .string("openai/sol"), "effort": .string("xhigh"), "serviceTier": .string("priority")]),
            .object(["providerId": .string("claude"), "modelId": .string("anthropic/opus-5"), "effort": .string("max"), "serviceTier": .null]),
        ]),
    ]
    private(set) var settingWrites: [String] = []
    private(set) var sends: [JSONValue] = []
    private var version = 0
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        try answer(method: method, path: path, body: body)
    }

    func send(method: String, path: String, credential: String, body: Data, upload: Bool, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        sent(body.count)
        return try answer(method: method, path: path, body: body)
    }

    func stream(path: String, credential: String, headers: [String: String]) -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func reset() {}
    func close() { streams.forEach { $0.finish() }; streams.removeAll() }

    private func setting(_ key: String) -> JSONValue {
        version += 1
        return .object(["key": .string(key), "value": settings[key] ?? .null, "updatedAt": .number(Double(version)), "version": .string(String(format: "%08d", version))])
    }

    private func answer(method: String, path: String, body: Data?) throws -> HTTP1Response {
        let json = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        let route = path.split(separator: "?").first.map(String.init) ?? path
        if route == "/v0/config" { return .init(status: 200, body: Data(Self.config.utf8)) }
        if route == "/v0/usage" { return try response(.object(["providers": .array([])])) }
        if route == "/v0/bootstrap/desktop" {
            return try response(.object([
                "cursor": .string("c"), "profile": .object(["userId": .null]), "projects": .array([]), "workspaces": .array([]),
                "userSettings": .array(settings.keys.sorted().map(setting)),
            ]))
        }
        if method == "PUT", route.hasPrefix("/v0/user-settings/") {
            let key = String(route.dropFirst("/v0/user-settings/".count)).removingPercentEncoding ?? ""
            settingWrites.append(key)
            settings[key] = json?["value"] ?? .null
            return try response(.object(["setting": setting(key)]))
        }
        if method == "POST", route == "/v0/tasks" {
            return try response(.object([
                "task": .object(["id": json?["id"] ?? .null, "name": .string("New Task"),
                                 "agent": .object(["id": json?["agentId"] ?? .null, "workspaceId": json?["workspaceId"] ?? .null])]),
                "membership": .object(["taskId": json?["id"] ?? .null]),
            ]))
        }
        if method == "POST", route.hasSuffix("/send") {
            if let json { sends.append(json) }
            return try response(.object([:]))
        }
        if route.hasSuffix("/messages") { return try response(.object(["runs": .array([]), "hasMore": .bool(false)])) }
        if route.hasSuffix("/bootstrap") {
            return try response(.object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])]))
        }
        return try response(.object([:]))
    }

    private func response(_ value: JSONValue) throws -> HTTP1Response {
        .init(status: 200, body: try JSONEncoder().encode(value))
    }

    /// Claude is the computer's default; Codex serves GPT Sol.
    static let config = """
    {"config": {
        "defaults": {"providerId": "claude", "modelId": "anthropic/opus-5", "effort": "high", "permissionMode": "auto"},
        "models": {
            "anthropic/opus-5": {"name": "Opus 5", "efforts": ["low", "medium", "high", "max"], "defaultEffort": "high", "serviceTiers": [], "contextWindow": 1000000},
            "anthropic/sonnet-5": {"name": "Sonnet 5", "efforts": ["low", "medium", "high"], "defaultEffort": "high", "serviceTiers": [], "contextWindow": 200000},
            "openai/sol": {"name": "GPT Sol", "efforts": ["low", "medium", "high", "xhigh"], "defaultEffort": "medium", "serviceTiers": ["priority"], "contextWindow": 400000}
        },
        "providers": {
            "claude": {"name": "Current CLI", "type": "claude", "enabled": true, "models": [{"id": "anthropic/opus-5", "enabled": true}, {"id": "anthropic/sonnet-5", "enabled": true}]},
            "codex": {"type": "codex", "enabled": true, "models": [{"id": "openai/sol", "enabled": true}]}
        }
    }}
    """
}

/// New work opens on what the person's last session started on, on any of
/// their devices, and starting one records what it started on; Settings'
/// New Sessions says what that is and whether it follows the last session.
///
/// With `HAPPY_PREVIEW_DIR` set, each screen is also kept there as a PNG,
/// and as an attachment of the test either way.
@MainActor
final class HostedNewSessionStartTests: XCTestCase {
    private var window: UIWindow?
    private var computer: StartComputer!
    private var session: Session!
    private var context: AppContext!
    private var computerID = ""

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func pair() async throws {
        let computer = StartComputer()
        self.computer = computer
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "start-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in computer })
        await account.agentConnections.setForeground(false)
        let paired = try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"start-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8)), name: "Studio Mac")
        addTeardownBlock { @MainActor in
            Session.forget(paired.id)
            try await account.agentConnections.remove(paired.id)
        }
        computerID = paired.id
        context = AppContext(account: account, variant: .preview, version: "test")
        session = try XCTUnwrap(Session.session(for: paired.id, context: context))
        await session.engine.start()
        session.models.load()
        try await wait { self.session.models.catalog != nil && !self.session.home.settings.isEmpty }
    }

    private func host(_ root: UIViewController) async throws -> UINavigationController {
        let navigation = UINavigationController(rootViewController: root)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        self.window = window
        window.layoutIfNeeded()
        return navigation
    }

    private func newWork() async throws -> (ChatViewController, AgentInputCardView) {
        let task = await session.store.newTask()
        let chat = NewWork.chat(session, task: task)
        chat.focusesOnOpen = false
        _ = try await host(chat)
        let card = try XCTUnwrap(Self.views(chat.view).compactMap { $0 as? AgentInputCardView }.first)
        try await wait { card.configuration.model != nil && card.configuration.effort != nil }
        return (chat, card)
    }

    /// The composer opens on GPT Sol at Extra High, on Codex, at its speed,
    /// not on the computer's Opus; the first message goes with them and
    /// writes what it started on back, only what changed.
    func testNewWorkOpensOnTheLastStartedSessionAndRecordsItsOwn() async throws {
        try await pair()
        let (_, card) = try await newWork()
        XCTAssertEqual(card.configuration.model?.accessibilityLabel, "Model: GPT Sol")
        XCTAssertEqual(card.configuration.effort?.accessibilityLabel, "Effort: Extra High")
        try await keep("new-session-composer")

        card.setText("Tidy the release notes", selection: NSRange(location: 22, length: 0))
        card.delegate?.agentInputCardDidPressSend(card)
        try await wait {
            let sends = await self.computer.sends
            let writes = await self.computer.settingWrites
            return !sends.isEmpty && !writes.isEmpty
        }
        let sends = await computer.sends
        let sent = try XCTUnwrap(sends.first)
        XCTAssertEqual(sent["mode"]?["providerId"], .string("codex"))
        XCTAssertEqual(sent["mode"]?["modelId"], .string("openai/sol"))
        XCTAssertEqual(sent["mode"]?["effort"], .string("xhigh"))
        XCTAssertEqual(sent["mode"]?["serviceTier"], .string("priority"))
        // The same model, account and effort again: only the memory moves,
        // GPT Sol now its most recent entry.
        try await Task.sleep(for: .milliseconds(300))
        let writes = await computer.settingWrites
        XCTAssertEqual(writes, [ModelPreferences.Key.memory])
        let held = await computer.settings
        let memory = held[ModelPreferences.Key.memory]?.arrayValue
        XCTAssertEqual(memory?.last?["modelId"], .string("openai/sol"))
    }

    /// Settings has New Sessions beside Appearance, following the last
    /// session; its page names what a new session starts on.
    func testSettingsSaysWhatNewSessionsStartOn() async throws {
        try await pair()
        let settings = SettingsViewController(context: context, computer: computerID)
        let navigation = try await host(settings)
        try await wait { settings.shownRow("new-sessions") != nil }
        XCTAssertEqual(settings.shownRow("new-sessions")?.value, "Last Session")
        XCTAssertTrue(settings.shownRowIDs.contains(["appearance", "new-sessions", "agent-voice", "data-storage"]), "\(settings.shownRowIDs)")
        try await keep("settings-new-sessions-row")

        settings.tapRow("new-sessions")
        try await wait { navigation.topViewController is SettingsPageViewController && navigation.transitionCoordinator == nil }
        let page = try XCTUnwrap(navigation.topViewController as? SettingsPageViewController)
        try await wait { page.shownRow("new-sessions-model")?.value == "GPT Sol" }
        XCTAssertEqual(page.shownRowIDs, [["new-sessions-start", "new-sessions-model", "new-sessions-effort"]])
        XCTAssertEqual(page.shownRow("new-sessions-start")?.value, "Last Session")
        XCTAssertEqual(page.shownRow("new-sessions-effort")?.value, "Extra High")
        XCTAssertNotNil(page.shownRow("new-sessions-start")?.pullDown)
        XCTAssertNotNil(page.shownRow("new-sessions-model")?.pullDown)
        try await keep("settings-new-sessions-page")

        // Default Model chosen: written to the computer, and the page follows.
        try await session.engine.updateModelPreferences { $0.start = .defaultModel }
        try await wait { page.shownRow("new-sessions-start")?.value == "Default Model" }
        try await wait {
            let held = await self.computer.settings
            return held[ModelPreferences.Key.start] == .string("default")
        }
        XCTAssertEqual(settings.shownRow("new-sessions")?.value, "Default Model")
        try await keep("settings-new-sessions-default-model")
    }

    /// The screens as they are, with nothing asserted: run on a build
    /// without New Sessions too, for before-and-after pictures.
    func testScreens() async throws {
        try await pair()
        _ = try await newWork()
        try await keep("composer")
        window?.isHidden = true
        let settings = SettingsViewController(context: context, computer: computerID)
        _ = try await host(settings)
        try await Task.sleep(for: .seconds(1))
        try await keep("settings")
    }

    // MARK: Helpers

    private static func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(views) }

    private func wait(_ timeout: Duration = .seconds(8), _ condition: @escaping () async -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { return XCTFail("timed out") }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    private func keep(_ name: String) async throws {
        guard let window else { return }
        try await Task.sleep(for: .milliseconds(400))
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
}
#endif

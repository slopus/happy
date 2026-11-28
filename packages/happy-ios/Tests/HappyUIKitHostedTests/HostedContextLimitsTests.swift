#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import HappyWire
import UIKit
import XCTest

/// A paired computer with desktop's three things to show: a conversation's
/// context measurement, accounts' plan usage, and accounts and models the
/// configuration keeps out of the pickers.
private actor LimitsComputer: AgentTransport {
    /// The bootstrap's mode: the account and model the conversation is on.
    var providerId = "claude"
    var modelId = "anthropic/opus-5"
    var context: JSONValue = .null
    var usage: JSONValue = .object(["providers": .array([])])
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []

    func set(providerId: String, modelId: String) { self.providerId = providerId; self.modelId = modelId }
    func set(context: JSONValue) { self.context = context }
    func set(usage: JSONValue) { self.usage = usage }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        try answer(method: method, path: path)
    }

    func send(method: String, path: String, credential: String, body: Data, upload: Bool, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        sent(body.count)
        return try answer(method: method, path: path)
    }

    func stream(path: String, credential: String, headers: [String: String]) -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func reset() {}
    func close() { streams.forEach { $0.finish() }; streams.removeAll() }

    private func answer(method: String, path: String) throws -> HTTP1Response {
        if path == "/v0/config" { return .init(status: 200, body: Data(Self.config.utf8)) }
        if path == "/v0/usage", method == "GET" { return try response(usage) }
        if path == "/v0/bootstrap/desktop" {
            return try response(.object(["cursor": .string("c"), "projects": .array([]), "workspaces": .array([])]))
        }
        if path.hasSuffix("/bootstrap") {
            return try response(.object([
                "agent": .object(["id": .string("limits"), "workspaceId": .string("w"), "status": .string("idle")]),
                "pending": .array([]),
                "mode": .object(["providerId": .string(providerId), "modelId": .string(modelId), "effort": .string("high"),
                                 "serviceTier": .null, "permissionMode": .string("auto")]),
                "context": context,
            ]))
        }
        if path.contains("/messages?") {
            return try response(.object(["hasMore": .bool(false), "runs": .array([.object([
                "id": .string("r1"), "status": .string("completed"), "startedAt": .number(1), "messages": .array([
                    .object(["id": .string("u1"), "role": .string("user"), "createdAt": .number(1), "metadata": .object([:]), "status": .string("accepted"), "delivery": .string("queue"), "runId": .string("r1"), "mode": .object(["providerId": .string("claude"), "modelId": .string("opus"), "effort": .string("medium"), "serviceTier": .null, "permissionMode": .string("auto")]),
                             "content": .array([.object(["type": .string("text"), "text": .string("How full is the context?")])])]),
                    .object(["id": .string("a1"), "role": .string("agent"), "createdAt": .number(2), "metadata": .object([:]),
                             "content": .array([.object(["type": .string("text"), "text": .string("The meter under the composer says.")])])]),
                ]),
            ])])]))
        }
        return try response(.object([:]))
    }

    private func response(_ value: JSONValue) throws -> HTTP1Response {
        .init(status: 200, body: try JSONEncoder().encode(value))
    }

    /// Claude with a second, hidden account and a hidden model; Codex
    /// switched off and hidden; Grok switched off but listed.
    static let config = """
    {"config": {
        "defaults": {"providerId": "claude", "modelId": "anthropic/opus-5", "effort": "high", "permissionMode": "auto"},
        "models": {
            "anthropic/opus-5": {"name": "Opus 5 1M", "efforts": ["low", "medium", "high"], "defaultEffort": "high", "serviceTiers": [], "contextWindow": 1000000, "autoCompactWindow": 400000},
            "anthropic/sonnet-5": {"name": "Sonnet 5", "efforts": ["low", "medium", "high"], "defaultEffort": "high", "serviceTiers": [], "contextWindow": 200000},
            "anthropic/haiku-5": {"name": "Haiku 5", "efforts": ["low"], "defaultEffort": "low", "serviceTiers": [], "contextWindow": 200000},
            "openai/sol": {"name": "GPT Sol", "efforts": ["medium"], "defaultEffort": "medium", "serviceTiers": [], "contextWindow": 400000},
            "xai/grok": {"name": "Grok", "efforts": ["medium"], "defaultEffort": "medium", "serviceTiers": [], "contextWindow": 256000}
        },
        "providers": {
            "claude": {"name": "Current CLI", "type": "claude", "enabled": true, "models": [
                {"id": "anthropic/opus-5", "enabled": true}, {"id": "anthropic/sonnet-5", "enabled": true},
                {"id": "anthropic/haiku-5", "enabled": true, "hidden": true}]},
            "claude-pool": {"name": "Pool member", "type": "claude", "enabled": true, "hidden": true, "models": [{"id": "anthropic/opus-5", "enabled": true}]},
            "codex": {"type": "codex", "enabled": false, "hidden": true, "models": [{"id": "openai/sol", "enabled": true}]},
            "grok": {"type": "grok", "enabled": false, "models": [{"id": "xai/grok", "enabled": true}]}
        }
    }}
    """
}

/// The agent chat's composer as desktop's: the context meter at the end of
/// the row under the card, moving live as a turn reports its context; the
/// model chip's ring and its lists' headings warning as the account runs
/// low; and the lists leaving out what the configuration hides.
///
/// With `HAPPY_PREVIEW_DIR` set, each state is kept there as a PNG, light
/// and dark.
@MainActor
final class HostedContextLimitsTests: XCTestCase {
    private var window: UIWindow?
    private var chat: ChatViewController!
    private var card: AgentInputCardView!
    private var computer: LimitsComputer!
    private var session: Session!

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func measured(_ tokens: Double, approximate: Bool = false) -> JSONValue {
        .object(["approximate": .bool(approximate), "contextTokens": .number(tokens), "contextWindow": .number(1_000_000),
                 "modelId": .string("anthropic/opus-5"), "providerId": .string("claude")])
    }

    private func open(context: JSONValue = .null, usage: JSONValue? = nil, providerId: String = "claude", modelId: String = "anthropic/opus-5") async throws {
        let computer = LimitsComputer()
        self.computer = computer
        await computer.set(context: context)
        await computer.set(providerId: providerId, modelId: modelId)
        if let usage { await computer.set(usage: usage) }
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "limits-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in computer })
        await account.agentConnections.setForeground(false)
        let paired = try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"limits-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8)), name: "Limits test")
        addTeardownBlock { @MainActor in
            Session.forget(paired.id)
            try await account.agentConnections.remove(paired.id)
        }
        let context = AppContext(account: account, variant: .preview, version: "test")
        session = try XCTUnwrap(Session.session(for: paired.id, context: context))
        chat = ChatViewController(session: session, agentId: "limits", title: "Context and limits", spaceId: nil, intro: nil)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: chat))
        self.window = window
        window.layoutIfNeeded()
        card = try XCTUnwrap(views(chat.view).compactMap { $0 as? AgentInputCardView }.first)
        try await wait { self.session.models.catalog != nil && self.card.configuration.model != nil && self.chip(.model)?.isHidden == false }
    }

    private func event(_ type: String, _ payload: [String: JSONValue]) async {
        await session.store.externalEvent(.object(["type": .string(type), "payload": .object(payload)]))
    }

    // MARK: The meter

    /// Before the first measurement the model's window shows, empty; then
    /// each `agent.context.updated` moves the bar, live, and it turns the
    /// warning colour within a fifth of the compaction point and red at it.
    /// It stands under the card, its bar ending where send does.
    func testTheMeterFollowsTheConversationsContextLive() async throws {
        try await open()
        try await wait { self.chat.gauge != nil && !self.chat.meter.isHidden }
        XCTAssertEqual(chat.gauge, AgentContextGauge(usedTokens: 0, totalTokens: 1_000_000, compactTokens: 400_000, measured: false))
        let meter = chat.meter
        XCTAssertEqual(meter.frame.minY, card.frame.maxY, accuracy: 0.5)
        XCTAssertEqual(meter.frame.maxX, card.frame.maxX - ContextMeterLayout.Metrics.trailingInset, accuracy: 0.5)
        XCTAssertEqual(meter.frame.height, ContextMeterLayout.Metrics.height)
        XCTAssertEqual(meter.accessibilityLabel, "Waiting for the first context measurement (1M token window · compacts at 400k)")
        try await keep("context-meter-unmeasured")

        await event("agent.context.updated", ["agentId": .string("limits"), "context": measured(120_000)])
        try await wait { self.chat.gauge?.usedTokens == 120_000 }
        XCTAssertEqual(chat.gauge?.tone, .ample)
        XCTAssertEqual(meter.layout.fill.width, 64 * 0.12, accuracy: 0.01)
        XCTAssertEqual(meter.accessibilityLabel, "120k of 1M context tokens used · compacts at 400k")
        try await keep("context-meter-ample")

        // Another agent's measurement moves nothing.
        await event("agent.context.updated", ["agentId": .string("other"), "context": measured(900_000)])
        await event("agent.context.updated", ["agentId": .string("limits"), "context": measured(330_000)])
        try await wait { self.chat.gauge?.usedTokens == 330_000 }
        XCTAssertEqual(chat.gauge?.tone, .compact)
        XCTAssertEqual(meter.accessibilityLabel, "330k of 1M context tokens used · compacts at 400k — compaction is close; compact now to choose the moment")
        meter.reveal(true)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertGreaterThan(meter.layout.readout.width, 0)
        XCTAssertEqual(meter.layout.track.height, ContextMeterLayout.Metrics.revealedTrackHeight)
        try await keep("context-meter-compact-revealed")
        meter.reveal(false)

        await event("agent.context.updated", ["agentId": .string("limits"), "context": measured(405_000, approximate: true)])
        try await wait { self.chat.gauge?.usedTokens == 405_000 }
        XCTAssertEqual(chat.gauge?.tone, .critical)
        XCTAssertEqual(meter.accessibilityLabel, "405k of 1M context tokens used (approximate) · compacts at 400k — the next turn compacts the conversation")
        try await keep("context-meter-critical")

        // Compacted: the fill drops back.
        await event("agent.context.updated", ["agentId": .string("limits"), "context": measured(40_000)])
        try await wait { self.chat.gauge?.usedTokens == 40_000 }
        XCTAssertEqual(chat.gauge?.tone, .ample)
    }

    /// The bootstrap's measurement shows at once, and a tap brings the
    /// numbers out and puts them away again.
    func testTheBootstrapsMeasurementAndATapOnTheBar() async throws {
        try await open(context: measured(84_000))
        try await wait { self.chat.gauge?.usedTokens == 84_000 }
        XCTAssertTrue(chat.gauge?.measured == true)
        let meter = chat.meter
        XCTAssertFalse(meter.revealed)
        // The 4pt bar takes a finger.
        let bar = meter.layout.track
        XCTAssertTrue(meter.point(inside: CGPoint(x: bar.midX, y: bar.midY + 10), with: nil))
        XCTAssertFalse(meter.point(inside: CGPoint(x: 0, y: bar.midY), with: nil), "the empty readout's room is not the meter's")
        meter.reveal(true)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(meter.revealed)
        XCTAssertEqual(views(meter).compactMap { ($0 as? UILabel)?.text }, ["8%", "84k/1M"])
        try await keep("context-meter-revealed")
    }

    // MARK: Limits

    private func reading(weekUsed: Double, sessionUsed: Double, exhausted: Bool = false) -> JSONValue {
        let resets = Date().addingTimeInterval(3 * 3600).timeIntervalSince1970 * 1000
        return .object(["providers": .array([.object([
            "providerId": .string("claude"),
            "refreshedAt": .number(Date().timeIntervalSince1970 * 1000),
            "refreshing": .bool(false),
            "usage": .object(["planName": .string("Max"), "exhausted": .bool(exhausted), "windows": .object([
                "weekly": .object(["usedPercent": .number(weekUsed), "resetsAt": .number(resets + 86_400_000)]),
                "fiveHour": .object(["usedPercent": .number(sessionUsed), "resetsAt": .number(resets)]),
            ])]),
        ])])])
    }

    /// The model chip warns as its account runs low, as desktop's closed
    /// pill: a ring before the name, read out with the window, what is
    /// left and its reset. The list's heading warns of the same window.
    /// A new reading the computer announces moves it, live.
    func testTheModelChipWarnsAsTheAccountRunsLow() async throws {
        try await open(usage: reading(weekUsed: 40, sessionUsed: 20))
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertNil(card.configuration.model?.ring, "an account with room warns of nothing")

        await computer.set(usage: reading(weekUsed: 92, sessionUsed: 20))
        await event("provider.usage.updated", ["providerId": .string("claude")])
        try await wait { self.card.configuration.model?.ring != nil }
        XCTAssertEqual(card.configuration.model?.ring, .init(left: 8, tone: .critical))
        let label = try XCTUnwrap(card.configuration.model?.accessibilityLabel)
        XCTAssertTrue(label.hasPrefix("Model: Opus 5 1M. Weekly limit · 8% left · resets "), label)
        let chip = try XCTUnwrap(chip(.model))
        let ring = try XCTUnwrap(views(chip).first { $0 is UsageRingView })
        XCTAssertFalse(ring.isHidden)
        XCTAssertEqual(ring.frame.size, CGSize(width: 12, height: 12))
        try await keep("model-chip-week-low")

        try await openPicker()
        let heading = try XCTUnwrap(lines().first { if case .heading("Claude", _, _, _, _) = $0.line { true } else { false } })
        guard case .heading(_, _, let gauges, _, let headingLabel) = heading.line else { return XCTFail() }
        XCTAssertEqual(gauges.map(\.text), ["8%"])
        XCTAssertTrue(headingLabel.contains("Weekly limit · 8% left"), headingLabel)
        try await keep("model-list-week-low")
        try await closePicker()

        // Spent: the session window holds it back.
        await computer.set(usage: reading(weekUsed: 60, sessionUsed: 100, exhausted: true))
        await event("provider.usage.updated", ["providerId": .string("claude")])
        try await wait { self.card.configuration.model?.ring?.left == 0 }
        XCTAssertTrue(try XCTUnwrap(card.configuration.model?.accessibilityLabel).contains("Session limit reached · resets "))
        try await keep("model-chip-limit-reached")
    }

    // MARK: Hidden and disabled accounts

    private func optionLabels() -> [String] {
        lines().compactMap { if case .option(_, let label, _, _, _) = $0.line { label } else { nil } }
    }

    /// The lists leave out the hidden account, the hidden model and the
    /// switched-off hidden service; a switched-off one that isn't hidden is
    /// listed, greyed, as desktop lists it.
    func testTheModelListLeavesOutWhatTheComputerHides() async throws {
        try await open()
        try await openPicker()
        let headings = lines().compactMap { if case .heading(let service, let account, _, _, _) = $0.line { "\(service)/\(account ?? "")" } else { nil } }
        XCTAssertEqual(headings, ["Claude/Current CLI", "Grok/grok"])
        XCTAssertEqual(optionLabels(), ["Opus 5 1M", "Sonnet 5", "Grok"])
        let grok = try XCTUnwrap(lines().first { if case .option(_, "Grok", _, true, _) = $0.line { true } else { false } })
        XCTAssertFalse(grok.isEnabled, "a switched-off account's model can't be picked")
        try await keep("model-list-filtered")
        // Claude has one listed account, the hidden one left out.
        let claude = try XCTUnwrap(session.models.catalog.map { ModelMenus(catalog: $0, selection: AgentWire.Mode(providerId: "claude", modelId: "anthropic/opus-5", effort: "high", serviceTier: nil, permissionMode: "auto")) }?.services.first)
        XCTAssertEqual(claude.accounts.map(\.id), ["claude"])
    }

    /// A conversation on a hidden account stays on it: the chip names its
    /// model, and the list says why it is not a choice, as desktop does.
    func testAConversationOnAHiddenAccountKeepsItNamed() async throws {
        try await open(providerId: "claude-pool")
        XCTAssertEqual(card.configuration.model?.content, .label("Opus 5 1M"))
        try await openPicker()
        let notice = lines().compactMap { if case .notice(let text, let warning) = $0.line { (text, warning) } else { nil } }.first
        XCTAssertEqual(notice?.0, Strings.hiddenAccount)
        XCTAssertEqual(notice?.1, false, "a hidden account is a quiet notice")
        XCTAssertEqual(optionLabels().filter { $0 == "Opus 5 1M" }.count, 2, "its model, named under the notice, and Claude's own")
        try await keep("model-list-hidden-selection")
    }

    /// A hidden model the conversation is already on stays in its own list.
    func testAConversationOnAHiddenModelKeepsItListed() async throws {
        try await open(modelId: "anthropic/haiku-5")
        try await openPicker()
        XCTAssertEqual(optionLabels(), ["Opus 5 1M", "Sonnet 5", "Haiku 5", "Grok"])
        XCTAssertTrue(lines().contains { if case .option(_, "Haiku 5", true, false, _) = $0.line { true } else { false } })
    }

    // MARK: Helpers

    private func chip(_ kind: AgentInputChip) -> ComposerChipButton? {
        card.map { views($0).compactMap { $0 as? ComposerChipButton }.first { $0.chip == kind } } ?? nil
    }

    private func openPicker() async throws {
        let chip = try XCTUnwrap(chip(.model))
        chip.sendActions(for: .touchUpInside)
        try await wait { !self.lines().isEmpty }
        try await Task.sleep(for: .milliseconds(400))
    }

    /// The checked line again: the same mode, so nothing changes but the list closes.
    private func closePicker() async throws {
        let checked = try XCTUnwrap(lines().first { if case .option(_, _, true, _, _) = $0.line { true } else { false } })
        checked.sendActions(for: .touchUpInside)
        try await wait { self.lines().isEmpty }
    }

    private func lines() -> [PickerLineView] {
        guard let window else { return [] }
        return views(window).compactMap { $0 as? PickerLineView }.filter { $0.window != nil }
    }

    private func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(views) }

    private func wait(_ seconds: Double = 10, _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "never reached the expected state")
    }

    private func keep(_ name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"], let window else { return }
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            try await Task.sleep(for: .milliseconds(300))
            window.layoutIfNeeded()
            let file = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(style == .dark ? "dark" : "light").png")
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            try image.pngData()?.write(to: file)
        }
        window.overrideUserInterfaceStyle = .unspecified
    }
}
#endif

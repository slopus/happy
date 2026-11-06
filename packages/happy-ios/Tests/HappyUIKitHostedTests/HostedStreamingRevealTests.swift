#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import UltraView
import XCTest

private struct RevealOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct RevealNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// One agent, `a`, with twelve finished turns; replies stream in through
/// the store's events (`Store.externalEvent`), as the daemon's would.
/// `working`: a thirteenth turn is running, its reply half written.
private actor RevealComputer: AgentTransport {
    let working: Bool

    init(working: Bool = false) { self.working = working }

    static let running: JSONValue = .object([
        "id": .string("r-live"), "status": .string("running"), "startedAt": .number(5_000),
        "messages": .array([
            message("u-live", role: "user", [text("And the flaky one?")]),
            message("m-live", role: "agent", [text(String(repeating: "The fixture's clock runs ahead of the file's modification time. ", count: 9))], status: "streaming"),
        ]),
    ])

    static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }

    static func message(_ id: String, role: String, _ content: [JSONValue], status: String? = nil) -> JSONValue {
        var message: [String: JSONValue] = ["id": .string(id), "role": .string(role), "createdAt": .number(1), "metadata": .object([:]), "content": .array(content)]
        if let status { message["status"] = .string(status) }
        return .object(message)
    }

    static let runs: [JSONValue] = (0..<12).map { index in
        let answer = "Answer \(index). " + String(repeating: "The cache keeps what it read and drops it when the file changes. ", count: 2 + index % 3)
        return .object([
            "id": .string("r\(index)"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
            "messages": .array([
                message("u\(index)", role: "user", [text("Question \(index): why does the cache test fail?")]),
                message("m\(index)", role: "agent", [text(answer)]),
            ]),
        ])
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/agents/a/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(Self.runs + (working ? [Self.running] : []))])
        } else if path.hasSuffix("/agents/a/bootstrap") {
            value = .object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string(working ? "working" : "idle")]), "pending": .array([])])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }

    func reset() {}
    func close() {}
}

/// What a streaming reply looks like on every display frame, read from the
/// presentation layers: the reply's row, where its drawing sits in it, the
/// composer, a row the reader is reading, and how many glyphs are moving.
@MainActor
private final class RevealSampler: NSObject {
    struct Frame {
        var time: CFTimeInterval
        var row: CGRect?
        /// The height the row is going to: its model.s.
        var target: CGFloat?
        /// The row's drawing's top, less the row's: its words' place in it.
        var drawingOffset: CGFloat?
        var composer: CGRect
        var reader: CGRect?
        var glyphs: Int
        var streaming: Bool
    }

    private let window: UIWindow
    private let rowView: () -> (row: UIView, drawing: UIView, overlay: CALayer)?
    private let composer: UIView
    private let reader: () -> UIView?
    private var link: CADisplayLink?
    private(set) var frames: [Frame] = []
    var streaming = false
    /// The main thread's turns, in seconds, between waits.
    private(set) var turns: [Double] = []
    private var observer: CFRunLoopObserver?

    init(window: UIWindow, composer: UIView, rowView: @escaping () -> (row: UIView, drawing: UIView, overlay: CALayer)?, reader: @escaping () -> UIView? = { nil }) {
        self.window = window
        self.composer = composer
        self.rowView = rowView
        self.reader = reader
    }

    func start() {
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
        awake = CACurrentMediaTime()
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { [weak self] _, activity in
            MainActor.assumeIsolated { self?.observe(activity) }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        self.observer = observer
    }

    private var awake: CFTimeInterval = 0

    private func observe(_ activity: CFRunLoopActivity) {
        let now = CACurrentMediaTime()
        if activity == .afterWaiting { awake = now; return }
        if streaming { turns.append(now - awake) }
    }

    func stop() {
        link?.invalidate()
        link = nil
        if let observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        observer = nil
    }

    func presented(_ view: UIView) -> CGRect {
        guard let layer = view.layer.presentation(), let root = window.layer.presentation() else {
            return view.convert(view.bounds, to: window)
        }
        return layer.convert(layer.bounds, to: root)
    }

    @objc private func tick() {
        let found = rowView()
        let row = found.map { presented($0.row) }
        let drawing = found.map { presented($0.drawing) }
        frames.append(Frame(
            time: CACurrentMediaTime(), row: row, target: found?.row.bounds.height,
            drawingOffset: zip2(row, drawing).map { $1.minY - $0.minY },
            composer: presented(composer), reader: reader().map(presented),
            glyphs: found?.overlay.sublayers?.count ?? 0, streaming: streaming
        ))
    }

    private func zip2(_ a: CGRect?, _ b: CGRect?) -> (CGRect, CGRect)? {
        guard let a, let b else { return nil }
        return (a, b)
    }
}

/// A reply streaming in, in both chats, at the rate a model sends it:
/// its words come out a character at a time (`ChatRevealDriver`), its row
/// only grows, smoothly, its words never move inside it, and the reply
/// stays on the composer while the reader is at the newest; read back in
/// the history, the reader's row stays put.
@MainActor
final class HostedStreamingRevealTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
        // HAPPY_REVEAL_OFF: the checks against the rows swapped whole, as before.
        MainActor.assumeIsolated { ChatRevealDriver.off = ProcessInfo.processInfo.environment["HAPPY_REVEAL_OFF"] != nil }
    }

    override func tearDown() {
        MainActor.assumeIsolated { ChatRevealDriver.off = false }
        super.tearDown()
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    private func find<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
        if let found = view as? View { return found }
        for subview in view.subviews { if let found = find(type, in: subview) { return found } }
        return nil
    }

    static let reply = """
    The cache test fails because the fixture's clock runs ahead of the file's modification time, so the cache keeps an entry it should have dropped.

    Three things go wrong together:

    - the fixture writes the file and stamps it in the same second;
    - the cache compares whole seconds, not nanoseconds;
    - the test reads back before the stamp moves on.

    The fix is to compare the full timestamp and to let the fixture advance its clock past the write. With both, the test passes every time, and the cache drops the entry as soon as the file changes underneath it.
    """

    /// A model's chunks: two or three words, every 35 ms.
    static func chunks(_ text: String) -> [String] {
        var chunks: [String] = []
        var current = ""
        var words = 0
        for character in text {
            current.append(character)
            if character == " " || character == "\n" {
                words += 1
                if words >= 2 + chunks.count % 2 {
                    chunks.append(current)
                    current = ""
                    words = 0
                }
            }
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }

    // MARK: The agents' chat

    private struct AgentScreen {
        var window: UIWindow
        var chat: ChatViewController
        var transcript: AgentChatUltraList
        var store: Store
    }

    private func agentChat(working: Bool = false) async throws -> AgentScreen {
        let computer = RevealComputer(working: working)
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: RevealOffline(), connector: RevealNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let pairing = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"reveal-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: pairing.id, context: context))
        let chat = ChatViewController(session: session, agentId: "a", title: "Cache", spaceId: nil, intro: nil)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: chat))
        addTeardownBlock { @MainActor in
            window.endEditing(true)
            window.isHidden = true
            hostWindow?.makeKey()
            Session.forget(pairing.id)
            try? await controller.agentConnections.remove(pairing.id)
        }
        window.layoutIfNeeded()
        let transcript = try XCTUnwrap(find(AgentChatUltraList.self, in: chat.view))
        let loaded = try await until { chat.plans.count > 12 && transcript.list.newestLoadedView != nil }
        XCTAssertTrue(loaded, "the conversation never landed: \(chat.plans.count) rows")
        try await Task.sleep(for: .milliseconds(400))
        return AgentScreen(window: window, chat: chat, transcript: transcript, store: session.store)
    }

    private func event(_ type: String, _ payload: [String: JSONValue]) -> JSONValue {
        var payload = payload
        payload["agentId"] = .string("a")
        return .object(["type": .string(type), "payload": .object(payload)])
    }

    /// Streams `reply` into run `run` as message `id`, a chunk every 35 ms,
    /// then ends the run. `tools` calls go first, folding as the run ends.
    private func stream(_ reply: String, run: String, id: String, tools: [String] = [], into store: Store, sampler: RevealSampler) async throws {
        let chunks = Self.chunks(reply)
        await store.externalEvent(event("run.started", ["run": .object(["id": .string(run), "status": .string("running"), "startedAt": .number(5_000)]), "acceptedMessageIds": .array([])]))
        if !tools.isEmpty {
            let calls: [JSONValue] = tools.enumerated().map { index, command in
                .object(["type": .string("tool_call"), "id": .string("\(id)-tool\(index)"), "name": .string("exec_command"), "status": .string("completed"),
                         "presentation": .object(["type": .string("exec_command"), "command": .string(command)])])
            }
            await store.externalEvent(event("message.created", ["runId": .string(run), "message": RevealComputer.message("\(id)-tools", role: "agent", calls, status: "completed")]))
            try await Task.sleep(for: .milliseconds(400))
        }
        var text = chunks[0]
        sampler.streaming = true
        await store.externalEvent(event("message.created", ["runId": .string(run), "message": RevealComputer.message(id, role: "agent", [RevealComputer.text(text)], status: "streaming")]))
        for chunk in chunks.dropFirst() {
            try await Task.sleep(for: .milliseconds(35))
            let offset = text.utf16.count
            text += chunk
            await store.externalEvent(event("message.delta", [
                "runId": .string(run), "messageId": .string(id), "blockIndex": .number(0),
                "offset": .number(Double(offset)), "append": .string(chunk),
            ]))
        }
        try await Task.sleep(for: .milliseconds(35))
        await store.externalEvent(event("message.updated", ["runId": .string(run), "message": RevealComputer.message(id, role: "agent", [RevealComputer.text(text)], status: "completed")]))
        // The reveal catches up with what came, then the turn ends.
        try await Task.sleep(for: .milliseconds(600))
        sampler.streaming = false
        await store.externalEvent(event("run.finished", ["run": .object([
            "id": .string(run), "status": .string("completed"), "reason": .string("completed"), "startedAt": .number(5_000), "endedAt": .number(9_000),
        ])]))
        try await Task.sleep(for: .milliseconds(1200))
    }

    private func agentRow(_ screen: AgentScreen, _ id: String) -> (row: UIView, drawing: UIView, overlay: CALayer)? {
        let list = screen.transcript.list
        guard let index = list.items.firstIndex(where: { $0.identity == "chat:row:\(id)" }),
              let view = list.loadedItemView(at: index) as? AgentChatRowView else { return nil }
        return (view, view.canvas, view.reveal.overlay)
    }

    func testAnAgentsReplyComesOutWordByWordOnTheComposer() async throws {
        let screen = try await agentChat()
        let sampler = RevealSampler(window: screen.window, composer: screen.chat.card) { [unowned self] in agentRow(screen, "live-m") }
        sampler.start()
        try await stream(Self.reply, run: "live", id: "live-m", into: screen.store, sampler: sampler)
        sampler.stop()
        assertGrowsSmoothly(sampler.frames, "agent")
        assertFollowsByTheBudget(sampler.frames, "agent", budget: ChatFollow.budget(body: ChatTextStyles.text, scale: .standard))
        let plan = try XCTUnwrap(screen.chat.plans.first { $0.id == "live-m" })
        XCTAssertEqual(try XCTUnwrap(sampler.frames.last?.row).height, plan.size.height, accuracy: 0.5, "the finished reply shows whole")
    }

    /// A reply after tool calls: as the turn ends they fold behind "View
    /// traces", and the reply neither pops nor leaves the composer.
    func testAReplyAfterToolCallsFoldsThemWithoutAJump() async throws {
        let screen = try await agentChat()
        let sampler = RevealSampler(window: screen.window, composer: screen.chat.card) { [unowned self] in agentRow(screen, "tools-m") }
        sampler.start()
        try await stream(Self.reply, run: "tools", id: "tools-m", tools: ["swift test --filter CacheTests", "git diff Sources/Cache"], into: screen.store, sampler: sampler)
        sampler.stop()
        assertGrowsSmoothly(sampler.frames, "after tools")
        assertFollowsByTheBudget(sampler.frames, "after tools", budget: ChatFollow.budget(body: ChatTextStyles.text, scale: .standard))
        XCTAssertEqual(screen.chat.plans.suffix(3).map(\.id), ["tools:trace", "tools-m", "tools:status"], "the tool calls folded behind their traces")
    }

    /// Not a check: the reply streaming for a screen recording, with the
    /// reveal (`HAPPY_REVEAL_RECORD=after`) or without (`before`).
    func testRecordAStreamingReply() async throws {
        let mode = ProcessInfo.processInfo.environment["HAPPY_REVEAL_RECORD"]
        try XCTSkipIf(mode == nil, "set HAPPY_REVEAL_RECORD to before or after to record")
        ChatRevealDriver.off = mode == "before"
        let screen = try await agentChat()
        try await Task.sleep(for: .seconds(1.5))
        let sampler = RevealSampler(window: screen.window, composer: screen.chat.card) { nil }
        try await stream(Self.reply, run: "record", id: "record-m", tools: ["swift test --filter CacheTests", "git diff Sources/Cache"], into: screen.store, sampler: sampler)
        try await Task.sleep(for: .seconds(1.5))
    }

    func testAnAgentsReplyLeavesTheReaderWhereTheyRead() async throws {
        let screen = try await agentChat()
        let list = screen.transcript.list
        screen.transcript.scroll(toDistanceFromNewest: 700)
        let there = try await until { screen.transcript.distanceFromNewest > 400 }
        XCTAssertTrue(there)
        try await Task.sleep(for: .milliseconds(300))
        let middle = screen.chat.view.bounds.midY
        var reading: String?
        for index in list.loadedIndexRange {
            guard let view = list.loadedItemView(at: index), list.items[index].identity.hasPrefix("chat:row:") else { continue }
            let frame = view.convert(view.bounds, to: screen.chat.view)
            if frame.minY <= middle, frame.maxY >= middle { reading = list.items[index].identity }
        }
        let reader = try XCTUnwrap(reading)
        let sampler = RevealSampler(window: screen.window, composer: screen.chat.card, rowView: { nil }) {
            list.items.firstIndex { $0.identity == reader }.flatMap(list.loadedItemView(at:))
        }
        sampler.start()
        try await stream(Self.reply, run: "live", id: "live-m", into: screen.store, sampler: sampler)
        sampler.stop()
        let places = sampler.frames.compactMap(\.reader?.minY)
        XCTAssertGreaterThan(places.count, 60)
        let moved = (places.max() ?? 0) - (places.min() ?? 0)
        XCTAssertLessThanOrEqual(moved, 0.5, "the reader's row moved \(moved) points while a reply streamed below")
    }

    /// The main thread while a reply streams, with the reveal and without
    /// it (each update swapping the row whole, as before). The reveal's
    /// own work each frame, its list passes for a new line included, keeps
    /// to the package's budgets: a typical frame under 1 ms, and no frame
    /// of it over half a 120 Hz frame (4.2 ms). The run loop's turns are
    /// reported for both; they also carry the machine's load.
    func testAStreamingReplyCostsTheMainThreadLittle() async throws {
        let screen = try await agentChat()
        func percentile(_ values: [Double], _ p: Double) -> Double {
            let sorted = values.sorted()
            return sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))] * 1000
        }
        func ms(_ value: Double) -> String { String(format: "%.2fms", value) }
        for (index, off) in [true, false].enumerated() {
            ChatRevealDriver.off = off
            ChatRevealDriver.ticks = []
            ChatRevealDriver.passes = []
            let id = "live-\(index)"
            let sampler = RevealSampler(window: screen.window, composer: screen.chat.card) { [unowned self] in agentRow(screen, id) }
            sampler.start()
            try await stream(Self.reply, run: "live\(index)", id: id, into: screen.store, sampler: sampler)
            sampler.stop()
            let turns = sampler.turns, ticks = ChatRevealDriver.ticks, passes = ChatRevealDriver.passes
            print("HostedStreamingRevealTests main thread \(off ? "before" : "reveal"): turns=\(turns.count) p50=\(ms(percentile(turns, 0.5))) p95=\(ms(percentile(turns, 0.95))) p99=\(ms(percentile(turns, 0.99))) max=\(ms(percentile(turns, 1))) reveal frames=\(ticks.count) p50=\(ms(percentile(ticks, 0.5))) p95=\(ms(percentile(ticks, 0.95))) max=\(ms(percentile(ticks, 1))) line passes=\(passes.count) max=\(ms(percentile(passes, 1)))")
            if off {
                XCTAssertTrue(ticks.isEmpty, "the reveal ran while off")
            } else {
                XCTAssertGreaterThan(ticks.count, 60, "the reveal ran for \(ticks.count) frames")
                XCTAssertGreaterThan(passes.count, 5, "the reply grew a line \(passes.count) times")
                XCTAssertLessThan(percentile(ticks, 0.5), 1, "a typical frame of the reveal cost the main thread over 1 ms")
                XCTAssertLessThan(percentile(ticks, 1), 4.2, "a frame of the reveal held the main thread over half a 120 Hz frame")
            }
        }
    }

    // MARK: The Happy account chat

    func testALegacyReplyComesOutWordByWordOnTheComposer() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: RevealOffline(), connector: RevealNoSocket()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 7, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let context = AppContext(account: controller, variant: .development, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        // The fixture chat whose reply starts streaming 0.8 s after it opens.
        let sessionId = FixtureScenarios.prefix + FixtureScenario.live.rawValue
        await FixtureChatWorld.shared.reset(sessionId)
        let chat = LegacyChatViewController(context: context, session: account, sessionId: sessionId)
        let navigation = UINavigationController(rootViewController: UIViewController())
        navigation.pushViewController(chat, animated: false)
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
            await controller.signOut()
        }
        window.layoutIfNeeded()
        let constructed = try await until { chat.contentInstalled }
        XCTAssertTrue(constructed)
        let list = try XCTUnwrap(find(ChatListView.self, in: chat.view))
        let dock = try XCTUnwrap(find(ChatDockView.self, in: chat.view))
        let ultra = list.ultra.list
        func reply() -> (row: UIView, drawing: UIView, overlay: CALayer)? {
            guard let index = ultra.items.firstIndex(where: { $0.identity.hasPrefix("chat:message:agent-") }),
                  let view = ultra.loadedItemView(at: index) as? ChatUltraRowView else { return nil }
            return (view, view.canvas, view.reveal.overlay)
        }
        let sampler = RevealSampler(window: window, composer: dock) { reply() }
        sampler.streaming = true
        sampler.start()
        let started = try await until(seconds: 10) { reply() != nil }
        XCTAssertTrue(started, "the fixture's reply never started")
        // About a thousand characters at about 270 a second, then the
        // reveal's second of quiet before it ends.
        try await Task.sleep(for: .milliseconds(4500))
        sampler.streaming = false
        try await Task.sleep(for: .milliseconds(1800))
        sampler.stop()
        assertGrowsSmoothly(sampler.frames, "legacy")
        let bar = list.convert(CGPoint(x: 0, y: list.contentInsets.top), to: window).y
        assertFollowsByTheBudget(sampler.frames, "legacy", budget: ChatFollow.budget(body: ChatTextStyles.markdownText, scale: .standard), top: bar)
        let plan = try XCTUnwrap(list.plans.first { $0.id.hasPrefix("agent-") })
        XCTAssertEqual(try XCTUnwrap(sampler.frames.last?.row).height, plan.size.height, accuracy: 0.5, "the finished reply shows whole")
    }

    // MARK: What every reply keeps to

    /// The row only grows, by no more in a frame than its height animation
    /// moves it; its words never move inside it; and glyphs came out.
    private func assertGrowsSmoothly(_ frames: [RevealSampler.Frame], _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let shown = frames.filter { $0.row != nil }
        XCTAssertGreaterThan(shown.count, 60, "\(label): the reply was on screen for \(shown.count) frames", file: file, line: line)
        var log: [String] = []
        var shrank: CGFloat = 0
        var jumped: CGFloat = 0
        let start = shown.first?.time ?? 0
        func around(_ index: Int) -> String {
            shown[max(0, index - 6)...min(shown.count - 1, index + 3)].map { "\(Int((($0.time - start) * 1000).rounded()))ms:\($0.row!.height)→\($0.target ?? -1)" }.joined(separator: " ")
        }
        // Each time the row's height is set anew, it animates from where it
        // shows to there over `heightDuration` on ease-in-out, whose
        // steepest is 1.72 times its mean: it may move no further than that
        // share of the growth, and not at all outside such a growth. The
        // sampler's display link runs a little apart from the frames drawn
        // (a tick late by a few milliseconds reads the next frame, and a
        // busy simulator shows one frame for two ticks), so the share is
        // checked over three frames, about 50 ms, with a frame's slack: a
        // line showing at once is still more than it allows.
        let duration = StreamingRevealMotion.heightDuration
        var growths: [(amount: CGFloat, start: Double)?] = [nil]
        for (previous, frame) in zip(shown, shown.dropFirst()) {
            var growth = growths.last!
            if let target = frame.target, let before = previous.target, abs(target - before) > 0.5 {
                growth = (target - previous.row!.height, previous.time)
            }
            growths.append(growth)
        }
        let window = 3
        for index in 1..<shown.count {
            let from = max(0, index - window)
            let step = shown[index].row!.height - shown[from].row!.height
            let dt = shown[index].time - shown[from].time
            // In steps: Xcode 26.2 can't type-check it as one expression.
            let now: Double = shown[index].time
            let recent: [(amount: CGFloat, start: Double)] = (from + 1...index).compactMap { growths[$0] }
            let amount: CGFloat = recent.filter { now <= $0.start + 0.25 }.map(\.amount).max() ?? 0
            let allowed: CGFloat = 2 + max(0, amount) * 1.75 * CGFloat(dt + 1.0 / 60) / CGFloat(duration)
            let single = shown[index].row!.height - shown[index - 1].row!.height
            if single < -0.5 { shrank = min(shrank, single); log.append("shrank \(single): \(around(index))") }
            if step > allowed { jumped = max(jumped, step - allowed); log.append("jumped \(step) in \(window) frames (allowed \(allowed)): \(around(index))") }
        }
        let grown = (shown.last?.row?.height ?? 0) - (shown.first?.row?.height ?? 0)
        print("HostedStreamingRevealTests \(label): frames=\(shown.count) grew=\(grown) maxGlyphs=\(frames.map(\.glyphs).max() ?? 0)")
        XCTAssertGreaterThan(grown, 72, "\(label): the reply grew by \(grown) points", file: file, line: line)
        XCTAssertEqual(shrank, 0, "\(label): the reply's row shrank\n\(log.joined(separator: "\n"))", file: file, line: line)
        XCTAssertEqual(jumped, 0, "\(label): the reply's row jumped\n\(log.joined(separator: "\n"))", file: file, line: line)
        let offsets = shown.compactMap(\.drawingOffset)
        XCTAssertLessThanOrEqual((offsets.map(abs).max() ?? 0), 0.5, "\(label): the reply's words moved inside its row", file: file, line: line)
        XCTAssertGreaterThan(frames.map(\.glyphs).max() ?? 0, 0, "\(label): no glyph came out", file: file, line: line)
    }

    /// While it streams, the reply's foot keeps its distance to the composer.
    /// The reply starts on the composer and the list follows it by
    /// `budget`, two lines; then its head holds still and it grows below
    /// the fold. Drawn, its head only ever rises, and never past that. In
    /// a chat shorter than the screen the rows rest on the composer until
    /// they fill it, so the head may rise further, but never past `top`,
    /// the foot of the bar.
    private func assertFollowsByTheBudget(_ frames: [RevealSampler.Frame], _ label: String, budget: CGFloat, top: CGFloat? = nil, file: StaticString = #filePath, line: UInt = #line) {
        let shown = frames.filter { $0.streaming && $0.row != nil }
        XCTAssertGreaterThan(shown.count, 60, file: file, line: line)
        guard let first = shown.first else { return }
        let tops = shown.map { $0.row!.minY }
        print("HostedStreamingRevealTests \(label): head \(tops.first ?? 0)…\(tops.min() ?? 0), composer gap at first \(first.composer.minY - first.row!.maxY)")
        XCTAssertLessThanOrEqual(abs(first.composer.minY - first.row!.maxY), 60, "\(label): the reply started off the composer", file: file, line: line)
        for (previous, next) in zip(tops, tops.dropFirst()) where next > previous + 1 {
            XCTFail("\(label): the reply's head went down from \(previous) to \(next)", file: file, line: line)
            break
        }
        let rise = tops[0] - (tops.min() ?? tops[0])
        if let top, rise > budget + 1 {
            XCTAssertGreaterThanOrEqual(tops.min() ?? 0, top - 1, "\(label): a short chat rose past the bar", file: file, line: line)
        } else {
            XCTAssertLessThanOrEqual(rise, budget + 1, "\(label): the list followed the reply past two lines", file: file, line: line)
        }
    }
}

/// The reveal's own state on every display frame: the row at the stream's
/// pace, the rows coming out, and for each watched row how far its pace
/// has come, what shows, and what its view shows.
@MainActor
private final class FocusSampler: NSObject {
    struct Row {
        /// How far the pace has come; nil while it shows whole.
        var paced: Int?
        var shown: Int?
        var length: Int?
        /// What the row's view shows of it, while it has one that reveals.
        var presented: Int?
        /// It has a view on the list.
        var loaded: Bool
    }

    struct Frame {
        var time: CFTimeInterval
        var target: String?
        var revealing: Set<String>
        var rows: [String: Row]
    }

    private let driver: ChatRevealDriver
    private let watched: [String]
    private let presenter: (String) -> ChatRevealPresenter?
    private var link: CADisplayLink?
    private(set) var frames: [Frame] = []

    init(driver: ChatRevealDriver, watched: [String], presenter: @escaping (String) -> ChatRevealPresenter?) {
        self.driver = driver
        self.watched = watched
        self.presenter = presenter
    }

    func start() {
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    @objc private func tick() {
        var rows: [String: Row] = [:]
        for identity in Set(watched).union(driver.revealing) {
            let state = driver.state(identity)
            let view = presenter(identity)
            rows[identity] = Row(paced: driver.paced(identity), shown: state?.count, length: state?.map.length,
                                 presented: view?.isActive == true ? view?.shown : nil, loaded: view != nil)
        }
        frames.append(Frame(time: CACurrentMediaTime(), target: driver.target, revealing: driver.revealing, rows: rows))
    }
}

// MARK: Only the newest row comes out, and only as it arrives

extension HostedStreamingRevealTests {
    private static func toolCall(_ id: String) -> JSONValue {
        .object(["type": .string("tool_call"), "id": .string(id), "name": .string("exec_command"), "status": .string("completed"),
                 "presentation": .object(["type": .string("exec_command"), "command": .string("swift test --filter CacheTests")])])
    }

    private func started(_ run: String, store: Store) async {
        await store.externalEvent(event("run.started", ["run": .object(["id": .string(run), "status": .string("running"), "startedAt": .number(5_000)]), "acceptedMessageIds": .array([])]))
    }

    private func created(_ id: String, run: String, _ content: [JSONValue], store: Store) async {
        await store.externalEvent(event("message.created", ["runId": .string(run), "message": RevealComputer.message(id, role: "agent", content, status: "streaming")]))
    }

    private func delta(_ id: String, run: String, block: Int = 0, offset: Int, _ append: String, store: Store) async {
        await store.externalEvent(event("message.delta", [
            "runId": .string(run), "messageId": .string(id), "blockIndex": .number(Double(block)),
            "offset": .number(Double(offset)), "append": .string(append),
        ]))
    }

    /// Streams `text` into message `id`'s first block as a model would, a
    /// chunk every 35 ms, after `text`'s first chunk made it.
    private func streamAgent(_ text: String, id: String, run: String, store: Store) async throws {
        let chunks = Self.chunks(text)
        var sent = chunks[0]
        await created(id, run: run, [RevealComputer.text(sent)], store: store)
        for chunk in chunks.dropFirst() {
            try await Task.sleep(for: .milliseconds(35))
            await delta(id, run: run, offset: sent.utf16.count, chunk, store: store)
            sent += chunk
        }
    }

    private func agentPresenter(_ screen: AgentScreen, _ identity: String) -> ChatRevealPresenter? {
        let list = screen.transcript.list
        guard let index = list.items.firstIndex(where: { $0.identity == identity }) else { return nil }
        return (list.loadedItemView(at: index) as? AgentChatRowView)?.reveal
    }

    private func agentSampler(_ screen: AgentScreen, _ watched: [String]) -> FocusSampler {
        FocusSampler(driver: screen.transcript.reveal, watched: watched) { [unowned self] in agentPresenter(screen, $0) }
    }

    /// A reply comes out, then a newer segment arrives while it still is:
    /// the first is out within 0.3 s, and only the second goes at the
    /// stream's pace.
    func testAnAgentsNewerSegmentFinishesTheOneComingOut() async throws {
        let screen = try await agentChat()
        let first = "chat:row:seg-1", second = "chat:row:seg-2"
        let sampler = agentSampler(screen, [first, second])
        sampler.start()
        await started("seg", store: screen.store)
        // Arriving in one piece, long: it comes out, quickly.
        await created("seg-1", run: "seg", [RevealComputer.text(Self.reply)], store: screen.store)
        try await Task.sleep(for: .milliseconds(150))
        try await streamAgent(Self.reply, id: "seg-2", run: "seg", store: screen.store)
        try await Task.sleep(for: .milliseconds(800))
        sampler.stop()
        assertTheNewerFinishesTheOlder(sampler.frames, older: first, newer: second, "agent")
    }

    /// One update brings three segments of the agent's words with tool calls
    /// between: none comes out. The newest is still being written, and its
    /// next words do.
    func testABurstOfAgentSegmentsShowsWhole() async throws {
        let screen = try await agentChat()
        ChatRevealDriver.starts = []
        let segments = ["chat:row:burst", "chat:row:burst/2", "chat:row:burst/4"]
        let sampler = agentSampler(screen, segments)
        sampler.start()
        await started("burst", store: screen.store)
        let last = "Both fixes are in; the suite passes every time now."
        await created("burst", run: "burst", [
            RevealComputer.text(String(Self.reply.prefix(300))), Self.toolCall("burst-t1"),
            RevealComputer.text(String(Self.reply.dropFirst(300).prefix(300))), Self.toolCall("burst-t3"),
            RevealComputer.text(last),
        ], store: screen.store)
        try await Task.sleep(for: .milliseconds(800))
        XCTAssertTrue(segments.allSatisfy { id in screen.transcript.list.items.contains { $0.identity == id } }, "the segments never landed: \(screen.chat.plans.map(\.id))")
        XCTAssertEqual(ChatRevealDriver.starts, [], "a segment of the burst came out")
        await delta("burst", run: "burst", block: 4, offset: last.utf16.count, " The cache drops the entry", store: screen.store)
        try await Task.sleep(for: .milliseconds(35))
        await delta("burst", run: "burst", block: 4, offset: last.utf16.count + 26, " as soon as the file changes.", store: screen.store)
        try await Task.sleep(for: .milliseconds(600))
        sampler.stop()
        XCTAssertEqual(ChatRevealDriver.starts, ["chat:row:burst/4"], "the newest segment's next words did not come out alone")
    }

    /// A conversation opened while the agent is half way through a reply:
    /// none of what is there comes out, and what arrives next does.
    func testOpeningAnAgentsChatMidReplyShowsItWhole() async throws {
        ChatRevealDriver.starts = []
        let screen = try await agentChat(working: true)
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertTrue(screen.chat.plans.contains { $0.id == "m-live" }, "the running turn never landed")
        XCTAssertEqual(ChatRevealDriver.starts, [], "the history came out")
        let sent = String(repeating: "The fixture's clock runs ahead of the file's modification time. ", count: 9)
        await delta("m-live", run: "r-live", offset: sent.utf16.count, "So the test", store: screen.store)
        try await Task.sleep(for: .milliseconds(35))
        await delta("m-live", run: "r-live", offset: sent.utf16.count + 11, " fails.", store: screen.store)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(ChatRevealDriver.starts, ["chat:row:m-live"], "the words that arrived after did not come out")
    }

    /// Scrolled away from a reply coming out and back: it goes on from
    /// where it was, never again from the start.
    func testAnAgentsReplyScrolledAwayAndBackGoesOn() async throws {
        let screen = try await agentChat()
        ChatRevealDriver.starts = []
        let identity = "chat:row:far-m"
        let sampler = agentSampler(screen, [identity])
        sampler.start()
        await started("far", store: screen.store)
        let streaming = Task { try await self.streamAgent(Self.reply + "\n\n" + Self.reply, id: "far-m", run: "far", store: screen.store) }
        try await Task.sleep(for: .milliseconds(800))
        screen.transcript.list.scrollTo(.init(index: 24), transition: .none)
        let away = try await until { self.agentPresenter(screen, identity) == nil }
        XCTAssertTrue(away, "the reply's row stayed on the list")
        try await Task.sleep(for: .milliseconds(400))
        screen.transcript.scrollToNewest(animated: false)
        try await streaming.value
        try await Task.sleep(for: .milliseconds(400))
        sampler.stop()
        assertGoesOnAfterTheRowCameBack(sampler.frames, identity, "agent")
        XCTAssertEqual(ChatRevealDriver.starts, [identity], "the reply came out again from the start")
    }

    /// The app goes to the background mid-reply: it shows whole, the
    /// catch-up on the way back shows whole, and what arrives after comes
    /// out again.
    func testAnAgentsCatchUpAfterTheBackgroundShowsWhole() async throws {
        let screen = try await agentChat()
        ChatRevealDriver.starts = []
        let identity = "chat:row:bg-m"
        await started("bg", store: screen.store)
        let chunks = Self.chunks(Self.reply)
        var sent = chunks[0]
        await created("bg-m", run: "bg", [RevealComputer.text(sent)], store: screen.store)
        for chunk in chunks[1..<12] {
            try await Task.sleep(for: .milliseconds(35))
            await delta("bg-m", run: "bg", offset: sent.utf16.count, chunk, store: screen.store)
            sent += chunk
        }
        try await Task.sleep(for: .milliseconds(35))
        XCTAssertTrue(screen.transcript.reveal.isRevealing(identity), "the reply wasn't coming out")
        try await assertTheCatchUpShowsWhole(screen.transcript.reveal, identity) { [self] grown in
            await delta("bg-m", run: "bg", offset: sent.utf16.count, grown, store: screen.store)
            sent += grown
        } height: {
            guard let index = screen.transcript.list.items.firstIndex(where: { $0.identity == identity }) else { return nil }
            return (screen.transcript.list.items[index] as? AgentChatRow).map { ($0.height, $0.plan.size.height) }
        }
    }

    // MARK: The Happy CLI chat

    private struct LegacyScreen {
        var sessionId: String
        var list: ChatListView
        @MainActor var adapter: ChatUltraListAdapter { list.ultra }
    }

    /// The live fixture chat, thinking, with its own reply held back.
    private func legacyChat() async throws -> LegacyScreen {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: RevealOffline(), connector: RevealNoSocket()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 7, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let context = AppContext(account: controller, variant: .development, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let sessionId = FixtureScenarios.prefix + FixtureScenario.live.rawValue
        // Twelve earlier turns, a day before the live one.
        let history: [ChatMessage] = (0..<12).flatMap { index -> [ChatMessage] in
            let at = FixtureScenarios.now - 2 * 86_400_000 + Int64(index) * 60_000
            let answer = "Answer \(index). " + String(repeating: "The cache keeps what it read and drops it when the file changes. ", count: 2 + index % 3)
            return [
                .userText(UserTextMessage(id: "user-h\(index)", createdAt: at, text: "Question \(index): why does the cache test fail?")),
                .agentText(AgentTextMessage(id: "agent-h\(index)", createdAt: at + 1_000, turn: "turn-h\(index)", text: answer)),
            ]
        }
        await FixtureChatWorld.shared.reset(sessionId, streams: false, history: history)
        let chat = LegacyChatViewController(context: context, session: account, sessionId: sessionId)
        let navigation = UINavigationController(rootViewController: UIViewController())
        navigation.pushViewController(chat, animated: false)
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
            await FixtureChatWorld.shared.reset(sessionId)
            await controller.signOut()
        }
        window.layoutIfNeeded()
        let constructed = try await until { chat.contentInstalled }
        XCTAssertTrue(constructed)
        let list = try XCTUnwrap(find(ChatListView.self, in: chat.view))
        let loaded = try await until { list.plans.count > 20 && list.ultra.list.newestLoadedView != nil }
        XCTAssertTrue(loaded, "the chat never landed: \(list.plans.count) rows")
        try await Task.sleep(for: .milliseconds(400))
        return LegacyScreen(sessionId: sessionId, list: list)
    }

    private func legacyPresenter(_ screen: LegacyScreen, _ identity: String) -> ChatRevealPresenter? {
        let list = screen.adapter.list
        guard let index = list.items.firstIndex(where: { $0.identity == identity }) else { return nil }
        return (list.loadedItemView(at: index) as? ChatUltraRowView)?.reveal
    }

    private func legacySampler(_ screen: LegacyScreen, _ watched: [String]) -> FocusSampler {
        FocusSampler(driver: screen.adapter.reveal, watched: watched) { [unowned self] in legacyPresenter(screen, $0) }
    }

    private func agentText(_ id: String, _ text: String) async -> ChatMessage {
        .agentText(AgentTextMessage(id: id, createdAt: await FixtureChatWorld.shared.now(), turn: "turn-live", text: text))
    }

    /// Grows message `id` to `text` as the CLI's fixture does: 6 to 18
    /// characters every 45 ms.
    private func streamLegacy(_ text: String, id: String, _ screen: LegacyScreen) async throws {
        let world = FixtureChatWorld.shared
        var shown = text.index(text.startIndex, offsetBy: 12)
        await world.arrive([await agentText(id, String(text[..<shown]))], sessionId: screen.sessionId)
        var step = 0
        while shown < text.endIndex {
            try await Task.sleep(for: .milliseconds(45))
            step += 1
            shown = text.index(shown, offsetBy: 6 + step * 7 % 13, limitedBy: text.endIndex) ?? text.endIndex
            await world.say(String(text[..<shown]), id: id, sessionId: screen.sessionId)
        }
    }

    func testALegacyNewerMessageFinishesTheOneComingOut() async throws {
        let screen = try await legacyChat()
        let first = "chat:message:agent-whole", second = "chat:message:agent-next"
        let sampler = legacySampler(screen, [first, second])
        sampler.start()
        // A whole message, as the CLI sends them: it comes out, quickly.
        await FixtureChatWorld.shared.arrive([await agentText("agent-whole", Self.reply)], sessionId: screen.sessionId)
        try await Task.sleep(for: .milliseconds(150))
        try await streamLegacy(Self.reply, id: "agent-next", screen)
        try await Task.sleep(for: .milliseconds(800))
        sampler.stop()
        assertTheNewerFinishesTheOlder(sampler.frames, older: first, newer: second, "legacy")
    }

    /// Three messages in one snapshot (a catch-up): none comes out. The
    /// newest goes on growing, and that comes out.
    func testABurstOfLegacyMessagesShowsWhole() async throws {
        let screen = try await legacyChat()
        ChatRevealDriver.starts = []
        let world = FixtureChatWorld.shared
        let at = await world.now()
        let tool = ChatMessage.toolCall(ToolCallMessage(id: "burst-tool", createdAt: at + 1, turn: "turn-live", tool: ToolCall(
            name: "Bash", state: .completed, input: .object(["command": .string("swift test")]), createdAt: at + 1, startedAt: at + 1
        )))
        let last = "Both fixes are in; the suite passes every time now."
        await world.arrive([
            .agentText(AgentTextMessage(id: "burst-a", createdAt: at, turn: "turn-live", text: String(Self.reply.prefix(300)))), tool,
            .agentText(AgentTextMessage(id: "burst-b", createdAt: at + 2, turn: "turn-live", text: last)),
        ], sessionId: screen.sessionId)
        try await Task.sleep(for: .milliseconds(800))
        XCTAssertTrue(screen.list.plans.contains { $0.id == "burst-b" }, "the burst never landed")
        XCTAssertEqual(ChatRevealDriver.starts, [], "a message of the burst came out")
        await world.say(last + " The cache drops", id: "burst-b", sessionId: screen.sessionId)
        try await Task.sleep(for: .milliseconds(45))
        await world.say(last + " The cache drops the entry at once.", id: "burst-b", sessionId: screen.sessionId)
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(ChatRevealDriver.starts, ["chat:message:burst-b"], "the newest message's next words did not come out alone")
    }

    /// The chat opens on its history while the session thinks: none of it
    /// comes out, the second time it opens neither.
    func testOpeningALegacyChatShowsItsHistoryWhole() async throws {
        ChatRevealDriver.starts = []
        let screen = try await legacyChat()
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(ChatRevealDriver.starts, [], "the history came out")
        // Again, with the history as the first one left it.
        await FixtureChatWorld.shared.arrive([await agentText("agent-before", Self.reply)], sessionId: screen.sessionId)
        try await Task.sleep(for: .milliseconds(800))
        ChatRevealDriver.starts = []
        let scene = try await hostedActiveScene()
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: RevealOffline(), connector: RevealNoSocket()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 7, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let again = LegacyChatViewController(context: AppContext(account: controller, variant: .development, version: "test"), session: account, sessionId: screen.sessionId)
        let navigation = UINavigationController(rootViewController: UIViewController())
        navigation.pushViewController(again, animated: false)
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            await controller.signOut()
        }
        window.layoutIfNeeded()
        let reopened = try await until { again.contentInstalled }
        XCTAssertTrue(reopened)
        let list = try XCTUnwrap(find(ChatListView.self, in: again.view))
        let landed = try await until { list.plans.contains { $0.id == "agent-before" } }
        XCTAssertTrue(landed)
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(ChatRevealDriver.starts, [], "the history came out on opening again")
    }

    func testALegacyReplyScrolledAwayAndBackGoesOn() async throws {
        let screen = try await legacyChat()
        ChatRevealDriver.starts = []
        let identity = "chat:message:agent-far"
        let sampler = legacySampler(screen, [identity])
        sampler.start()
        let streaming = Task { try await self.streamLegacy(Self.reply + "\n\n" + Self.reply, id: "agent-far", screen) }
        try await Task.sleep(for: .milliseconds(900))
        screen.list.setVisibleMinY(2400)
        let away = try await until { self.legacyPresenter(screen, identity) == nil }
        XCTAssertTrue(away, "the reply's row stayed on the list")
        try await Task.sleep(for: .milliseconds(400))
        screen.list.scrollToNewest(animated: false)
        try await streaming.value
        try await Task.sleep(for: .milliseconds(400))
        sampler.stop()
        assertGoesOnAfterTheRowCameBack(sampler.frames, identity, "legacy")
        XCTAssertEqual(ChatRevealDriver.starts, [identity], "the reply came out again from the start")
    }

    func testALegacyCatchUpAfterTheBackgroundShowsWhole() async throws {
        let screen = try await legacyChat()
        ChatRevealDriver.starts = []
        let identity = "chat:message:agent-bg"
        let world = FixtureChatWorld.shared
        var text = String(Self.reply.prefix(12))
        await world.arrive([await agentText("agent-bg", text)], sessionId: screen.sessionId)
        for _ in 0..<10 {
            try await Task.sleep(for: .milliseconds(45))
            text = String(Self.reply.prefix(text.count + 11))
            await world.say(text, id: "agent-bg", sessionId: screen.sessionId)
        }
        try await Task.sleep(for: .milliseconds(45))
        XCTAssertTrue(screen.adapter.reveal.isRevealing(identity), "the reply wasn't coming out")
        try await assertTheCatchUpShowsWhole(screen.adapter.reveal, identity) { grown in
            text += grown
            await world.say(text, id: "agent-bg", sessionId: screen.sessionId)
        } height: {
            guard let index = screen.adapter.list.items.firstIndex(where: { $0.identity == identity }) else { return nil }
            return (screen.adapter.list.items[index] as? ChatUltraRow).map { ($0.height, $0.plan.size.height) }
        }
    }

    // MARK: What each chat keeps to

    /// `older` was coming out when `newer` arrived; from the frame `newer`
    /// is on the list, `older` is out within `TextReveal.finishTime` (its
    /// drawing within the glyph wait after), never the target again, and
    /// `newer` comes out at the stream's pace, over many frames.
    private func assertTheNewerFinishesTheOlder(_ frames: [FocusSampler.Frame], older: String, newer: String, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        func done(_ row: FocusSampler.Row?, _ value: (FocusSampler.Row) -> Int?) -> Bool {
            guard let row, let count = value(row), let length = row.length else { return true }
            return count >= length
        }
        guard let arrival = frames.firstIndex(where: { $0.rows[newer]?.loaded == true || $0.revealing.contains(newer) }) else {
            return XCTFail("\(label): the newer row never landed", file: file, line: line)
        }
        let at = frames[arrival].time
        XCTAssertTrue(frames[..<arrival].contains { !done($0.rows[older], \.paced) }, "\(label): the older row wasn't coming out when the newer one came", file: file, line: line)
        XCTAssertTrue(frames[arrival].revealing.contains(older) || done(frames[arrival].rows[older], \.paced), file: file, line: line)
        let after = frames[arrival...]
        let paced = after.first { done($0.rows[older], \.paced) }.map { $0.time - at }
        let shown = after.first { done($0.rows[older], \.shown) }.map { $0.time - at }
        print("HostedStreamingRevealTests \(label): the older row was out \(paced ?? -1) s after the newer came, shown \(shown ?? -1) s")
        XCTAssertLessThanOrEqual(paced ?? .infinity, TestTime.budget(TextReveal.finishTime + 2.0 / 60), "\(label): the older row took \(paced ?? -1) s to finish", file: file, line: line)
        XCTAssertLessThanOrEqual(shown ?? .infinity, TextReveal.finishTime + 0.1 + 2.0 / 60, "\(label): the older row showed whole \(shown ?? -1) s after", file: file, line: line)
        XCTAssertFalse(after.contains { $0.target == older }, "\(label): the older row went on at the stream's pace", file: file, line: line)
        let pacing = after.filter { $0.target == newer }
        let counts = Set(pacing.compactMap { $0.rows[newer]?.paced })
        XCTAssertGreaterThan(counts.count, 20, "\(label): the newer row came out in \(counts.count) steps", file: file, line: line)
        XCTAssertTrue(after.contains { !done($0.rows[newer], \.paced) }, file: file, line: line)
    }

    /// The row went off the list while coming out and came back: what
    /// shows of it never went back, and its view showed on from there.
    private func assertGoesOnAfterTheRowCameBack(_ frames: [FocusSampler.Frame], _ identity: String, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let revealing = frames.filter { $0.revealing.contains(identity) }
        XCTAssertGreaterThan(revealing.count, 60, "\(label): the reply came out for \(revealing.count) frames", file: file, line: line)
        guard let left = frames.firstIndex(where: { $0.revealing.contains(identity) && $0.rows[identity]?.loaded == false }) else {
            return XCTFail("\(label): the row never left the list while coming out", file: file, line: line)
        }
        guard let back = frames[left...].firstIndex(where: { $0.rows[identity]?.loaded == true }) else {
            return XCTFail("\(label): the row never came back", file: file, line: line)
        }
        XCTAssertTrue(frames[back].revealing.contains(identity), "\(label): the reply was out before it came back, nothing to check", file: file, line: line)
        let before = frames[left].rows[identity]?.shown ?? 0
        let presented = frames[back].rows[identity]?.presented ?? 0
        XCTAssertGreaterThan(before, 0, file: file, line: line)
        XCTAssertGreaterThanOrEqual(presented, before, "\(label): the row came back showing \(presented) characters, \(before) before it left", file: file, line: line)
        var previous = 0
        for frame in revealing {
            let shown = frame.rows[identity]?.shown ?? 0
            XCTAssertGreaterThanOrEqual(shown, previous, "\(label): what shows went back from \(previous) to \(shown)", file: file, line: line)
            previous = shown
        }
    }

    /// With `identity` coming out, the app goes to the background: it
    /// shows whole at once, and what arrives meanwhile and on the way back
    /// (`grow`) doesn't come out; once that is in, the next words do.
    /// `height` is the row's height on the list and its plan's.
    private func assertTheCatchUpShowsWhole(_ driver: ChatRevealDriver, _ identity: String, grow: (String) async -> Void, height: () -> (CGFloat, CGFloat)?, file: StaticString = #filePath, line: UInt = #line) async throws {
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: UIApplication.shared)
        XCTAssertFalse(driver.isRevealing(identity), "the reply went on coming out in the background", file: file, line: line)
        let starts = ChatRevealDriver.starts.count
        for chunk in [" While away,", " the agent", " went on."] {
            try await Task.sleep(for: .milliseconds(45))
            await grow(chunk)
        }
        try await Task.sleep(for: .milliseconds(100))
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: UIApplication.shared)
        try await Task.sleep(for: .milliseconds(150))
        // The catch-up: under what a reconnect's size alone gives away.
        await grow(" " + String(repeating: "What came while the app was away. ", count: 6))
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(ChatRevealDriver.starts.count, starts, "the catch-up came out: \(ChatRevealDriver.starts.suffix(2))", file: file, line: line)
        if let (shown, planned) = height() {
            XCTAssertEqual(shown, planned, accuracy: 0.5, "the caught-up row isn't whole", file: file, line: line)
        } else {
            XCTFail("the row is gone", file: file, line: line)
        }
        await grow(" And then")
        try await Task.sleep(for: .milliseconds(45))
        await grow(" more came.")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(ChatRevealDriver.starts.suffix(1), [identity], "the words after the catch-up did not come out", file: file, line: line)
    }
}
#endif

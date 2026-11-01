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
private actor RevealComputer: AgentTransport {
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
            value = .object(["hasMore": .bool(false), "runs": .array(Self.runs)])
        } else if path.hasSuffix("/agents/a/bootstrap") {
            value = .object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
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

    private func agentChat() async throws -> AgentScreen {
        let computer = RevealComputer()
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
        let loaded = try await until { chat.plans.count > 12 && transcript.list.loadedItemView(at: 0) != nil }
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
        assertOnTheComposer(sampler.frames, "agent")
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
        assertOnTheComposer(sampler.frames, "after tools")
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
        list.scrollTo(.init(index: 24), transition: .none)
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
        assertOnTheComposer(sampler.frames, "legacy")
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
            let amount = (from + 1...index).compactMap { growths[$0] }.filter { shown[index].time <= $0.start + 0.25 }.map(\.amount).max() ?? 0
            let allowed = 2 + max(0, amount) * 1.75 * (dt + 1.0 / 60) / duration
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
    private func assertOnTheComposer(_ frames: [RevealSampler.Frame], _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let gaps = frames.filter { $0.streaming && $0.row != nil }.map { $0.composer.minY - $0.row!.maxY }
        XCTAssertGreaterThan(gaps.count, 60, file: file, line: line)
        let drift = (gaps.max() ?? 0) - (gaps.min() ?? 0)
        print("HostedStreamingRevealTests \(label): composer gap \(gaps.min() ?? 0)…\(gaps.max() ?? 0)")
        XCTAssertLessThanOrEqual(drift, 1, "\(label): the reply left the composer by \(drift) points", file: file, line: line)
    }
}
#endif

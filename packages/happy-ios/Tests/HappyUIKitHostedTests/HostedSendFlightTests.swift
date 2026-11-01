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

private struct FlightOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct FlightNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// One agent, `a`, with twelve turns behind it; whatever is sent is taken.
private actor FlightComputer: AgentTransport {
    static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }

    static func message(_ id: String, role: String, _ content: [JSONValue]) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(1), "metadata": .object([:]), "content": .array(content)])
    }

    static let runs: [JSONValue] = (0..<12).map { index in
        .object([
            "id": .string("r\(index)"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
            "messages": .array([
                message("u\(index)", role: "user", [text("Question \(index): why does the cache test fail?")]),
                message("m\(index)", role: "agent", [text("Answer \(index). The cache keeps what it read and drops it when the file changes.")]),
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

/// Telegram's send transition in both chats, read on every display frame
/// from what is drawn: the bubble grows out of the composer's input field
/// and the words leave the composer where they were typed, both on
/// Telegram's curves, landing exactly on the row the list laid out, which
/// shows in the same frame the copy goes; the rows above make room by the
/// new row's height, never jumping further in a frame than the curve does.
///
/// Then the time and the mark: a bubble walked from the clock to one check
/// to two keeps its frame to the point, in both chats.
///
/// With `HAPPY_FLIGHT_SLOW` set (a factor, 6 for six times), the flights
/// run that much slower, for a screen recording. With `HAPPY_PREVIEW_DIR`
/// set, each delivery state is kept there, light and dark.
@MainActor
final class HostedSendFlightTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    private func find<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
        if let found = view as? View { return found }
        for subview in view.subviews { if let found = find(type, in: subview) { return found } }
        return nil
    }

    private var slow: Float {
        ProcessInfo.processInfo.environment["HAPPY_FLIGHT_SLOW"].flatMap(Float.init) ?? 1
    }

    // MARK: Opening the chats

    private struct Screen {
        var window: UIWindow
        var view: UIView
        var list: UltraListView
        var card: AgentInputCardView
        var rowPrefix: String
        var flight: () -> ChatSendFlight?
    }

    private func legacyChat() async throws -> (Screen, AccountController) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: FlightOffline(), connector: FlightNoSocket()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 7, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let context = AppContext(account: controller, variant: .development, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let chat = LegacyChatViewController(context: context, session: account, sessionId: FixtureScenarios.prefix + FixtureScenario.long.rawValue)
        let navigation = UINavigationController(rootViewController: UIViewController())
        navigation.pushViewController(chat, animated: false)
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.layer.speed = 1
            window.endEditing(true)
            window.isHidden = true
            hostWindow?.makeKey()
            await controller.signOut()
        }
        window.layoutIfNeeded()
        let constructed = try await until { chat.contentInstalled }
        XCTAssertTrue(constructed)
        let list = try XCTUnwrap(find(ChatListView.self, in: chat.view))
        let dock = try XCTUnwrap(find(ChatDockView.self, in: chat.view))
        let card = try XCTUnwrap(find(AgentInputCardView.self, in: dock))
        let drawn = try await until { list.plans.count > 20 && list.isDisplayReady }
        XCTAssertTrue(drawn, "the fixture's rows never landed")
        try await Task.sleep(for: .milliseconds(400))
        chat.view.layoutIfNeeded()
        let screen = Screen(window: window, view: chat.view, list: list.ultra.list, card: card, rowPrefix: "chat:message:", flight: { [weak list] in list?.ultra.flight })
        return (screen, controller)
    }

    private func agentChat() async throws -> Screen {
        let computer = FlightComputer()
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: FlightOffline(), connector: FlightNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let pairing = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"flight-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: pairing.id, context: context))
        let chat = ChatViewController(session: session, agentId: "a", title: "Cache", spaceId: nil, intro: nil)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: chat))
        addTeardownBlock { @MainActor in
            window.layer.speed = 1
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
        chat.view.layoutIfNeeded()
        return Screen(window: window, view: chat.view, list: transcript.list, card: chat.card, rowPrefix: "chat:row:", flight: { [weak transcript] in transcript?.flight })
    }

    // MARK: Sampling the flight

    private struct Sample {
        var time: CFTimeInterval
        var bubble: CGRect?
        /// The copy's words' first line, where they start.
        var text: CGPoint?
        /// The row that was the newest before the send.
        var previous: CGRect?
        /// The real row, once it shows.
        var shown: Bool
    }

    private final class Sampler: NSObject {
        let sample: () -> Sample
        private var link: CADisplayLink?
        var samples: [Sample] = []
        init(_ sample: @escaping () -> Sample) { self.sample = sample }
        func start() {
            let link = CADisplayLink(target: self, selector: #selector(tick))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            link.add(to: .main, forMode: .common)
            self.link = link
        }
        func stop() { link?.invalidate(); link = nil }
        @objc private func tick() { samples.append(sample()) }
    }

    /// Where `layer` is drawn now, in `window`.
    private func presented(_ rect: CGRect, in layer: CALayer, window: UIWindow) -> CGRect {
        guard let presentation = layer.presentation(), let root = window.layer.presentation() else { return layer.convert(rect, to: window.layer) }
        return presentation.convert(rect, to: root)
    }

    private func row(_ identity: String, in list: UltraListView) -> UIView? {
        list.items.firstIndex { $0.identity == identity }.flatMap(list.loadedItemView(at:))
    }

    /// Sends what the composer holds and samples the flight to its end.
    private func flySend(_ screen: Screen, _ label: String) async throws {
        let window = screen.window
        let previousIdentity = try XCTUnwrap(screen.list.items.first { $0.identity.hasPrefix(screen.rowPrefix) }?.identity)
        let words = "Fly this into its bubble \(label)"
        screen.card.setText(words, selection: NSRange(location: (words as NSString).length, length: 0))
        try await Task.sleep(for: .milliseconds(300))
        screen.view.layoutIfNeeded()
        let composer = ChatSendFlight.source(from: screen.card, in: window)
        window.layer.speed = 1 / slow

        let sampler = Sampler { [self] in
            let flight = screen.flight()
            let previous = row(previousIdentity, in: screen.list)
            var sample = Sample(time: CACurrentMediaTime(), previous: previous.map { presented($0.bounds, in: $0.layer, window: window) }, shown: false)
            if let flight, !flight.finished, let bubble = flight.bubble, let body = flight.body,
               let plan = (flight.row as? AgentChatRowView)?.row.plan ?? (flight.row as? ChatUltraRowView)?.row.plan,
               let text = plan.flight?.text,
               // Committed: until then it is drawn where it lands.
               (bubble.layer.animation(forKey: "flight.y")?.beginTime ?? 0) > 0 {
                sample.bubble = presented(bubble.layer.presentation()?.bounds ?? bubble.bounds, in: bubble.layer, window: window)
                sample.text = presented(CGRect(origin: text.origin, size: .zero), in: body.layer, window: window).origin
            }
            return sample
        }
        sampler.start()
        screen.card.delegate?.agentInputCardDidPressSend(screen.card)
        let flight = try XCTUnwrap(screen.flight(), "\(label): the send didn't arm a flight")
        let landed = try await until(seconds: 3 * Double(slow)) { flight.container != nil }
        XCTAssertTrue(landed, "\(label): the row never came for the flight")
        let began = CACurrentMediaTime()
        let done = try await until(seconds: 3 * Double(slow)) { flight.finished }
        XCTAssertTrue(done, "\(label): the flight never ended")
        try await Task.sleep(for: .milliseconds(Int(150 * slow)))
        sampler.stop()
        window.layer.speed = 1

        let rowView = try XCTUnwrap(flight.row, "\(label): no row")
        let plan = try XCTUnwrap((rowView as? AgentChatRowView)?.row.plan ?? (rowView as? ChatUltraRowView)?.row.plan)
        let shape = try XCTUnwrap(plan.flight)
        let text = try XCTUnwrap(shape.text)
        let final = rowView.convert(shape.bubble.frame, to: window)
        let finalText = rowView.convert(text.origin, to: window)
        let field = composer.field.insetBy(dx: -(text.minX - shape.bubble.frame.minX), dy: 0)

        let flying = sampler.samples.filter { $0.bubble != nil }
        XCTAssertGreaterThan(flying.count, Int(8 * slow), "\(label): the flight took frames\n\(log(sampler.samples))")
        let first = try XCTUnwrap(flying.first), last = try XCTUnwrap(flying.last)

        // On Telegram's curves, from the composer to the row, each frame
        // where the curves put it, give or take a frame's travel.
        let vertical = ListCurve.bezier(0.19919472913616398, 0.010644531250000006, 0.27920937042459737, 0.91025390625)
        let horizontal = ListCurve.bezier(0.23, 1.0, 0.32, 1.0)
        let start = try XCTUnwrap(flying.first?.time)
        let duration = ChatSendFlight.Motion.duration * Double(slow)
        func expected(_ t: Double) -> CGRect {
            let v = CGFloat(vertical.value(at: t / duration)), h = CGFloat(horizontal.value(at: t / duration))
            return CGRect(x: field.minX + (final.minX - field.minX) * h, y: field.minY + (final.minY - field.minY) * v,
                          width: field.width + (final.width - field.width) * h, height: field.height + (final.height - field.height) * v)
        }
        // The first frame drawn is at most a frame into the curves.
        let frame = 1.0 / 60 * Double(slow)
        var worst: CGFloat = 0
        // The display link's moment and the frame's are a frame apart at
        // most: each sample falls between the curves' value a frame either side.
        let lead = try XCTUnwrap((0...4).map { Double($0) * frame / 4 }.min { lhs, rhs in
            abs(expected(lhs).maxY - first.bubble!.maxY) < abs(expected(rhs).maxY - first.bubble!.maxY)
        })
        for sample in flying {
            let t = sample.time - start + lead
            let a = expected(max(0, t - frame)), b = expected(min(duration, t + frame))
            let bubble = sample.bubble!
            for (value, low, high) in [(bubble.minX, a.minX, b.minX), (bubble.maxY, a.maxY, b.maxY), (bubble.width, a.width, b.width), (bubble.height, a.height, b.height)] {
                let off = max(0, min(low, high) - value, value - max(low, high))
                worst = max(worst, off)
            }
        }
        print("HostedSendFlightTests \(label): \(flying.count) frames, worst off-curve \(worst)pt, field \(field), final \(final)")
        XCTAssertLessThanOrEqual(worst, 1, "\(label): the bubble left Telegram's curves\n\(log(sampler.samples))")
        // It starts on the input field and its words where they were typed.
        XCTAssertEqual(first.bubble!.maxY, field.maxY, accuracy: abs(final.maxY - field.maxY) * 0.1 + 1, "\(label): the bubble starts at the field's foot")
        XCTAssertEqual(first.bubble!.minX, field.minX, accuracy: abs(final.minX - field.minX) * 0.35 + 1, "\(label): the bubble starts at the field's left edge")
        XCTAssertEqual(first.text!.y, composer.textOrigin.y, accuracy: abs(finalText.y - composer.textOrigin.y) * 0.1 + 1.5, "\(label): the words start where they were typed")
        // It ends exactly on the row the list laid out.
        XCTAssertEqual(last.bubble!.minX, final.minX, accuracy: 0.5, "\(label)")
        XCTAssertEqual(last.bubble!.minY, final.minY, accuracy: 0.5, "\(label)")
        XCTAssertEqual(last.bubble!.width, final.width, accuracy: 0.5, "\(label)")
        XCTAssertEqual(last.bubble!.height, final.height, accuracy: 0.5, "\(label)")
        XCTAssertEqual(last.text!.x, finalText.x, accuracy: 0.5, "\(label)")
        XCTAssertEqual(last.text!.y, finalText.y, accuracy: 0.5, "\(label)")
        // The row shows, the copy gone.
        let canvas = (rowView as? AgentChatRowView)?.canvas ?? (rowView as? ChatUltraRowView)?.canvas
        XCTAssertEqual(canvas?.alpha, 1, "\(label): the row stayed veiled")
        XCTAssertNil(flight.container?.window, "\(label): the copy stayed")

        // The rows above made room by the new row's height, no frame
        // further than the curve's steepest stretch moves them.
        let moved = sampler.samples.compactMap(\.previous)
        let before = try XCTUnwrap(moved.first), after = try XCTUnwrap(moved.last)
        XCTAssertEqual(before.minY - after.minY, plan.size.height, accuracy: 1, "\(label): the rows above made room for the new row\n\(log(sampler.samples))")
        let steepest = (0..<300).map { CGFloat(vertical.value(at: Double($0 + 1) / 300) - vertical.value(at: Double($0) / 300)) * 300 }.max() ?? 1
        let share = plan.size.height * steepest * CGFloat(frame * 2 / duration) + 1
        let step = zip(moved, moved.dropFirst()).map { abs($1.minY - $0.minY) }.max() ?? 0
        XCTAssertLessThanOrEqual(step, share, "\(label): a row jumped \(step)pt in a frame\n\(log(sampler.samples))")
        _ = began
    }

    private func log(_ samples: [Sample]) -> String {
        guard let start = samples.first?.time else { return "" }
        return samples.map { sample in
            let ms = Int(((sample.time - start) * 1000).rounded())
            return "\(ms)ms bubble=\(sample.bubble.map { "\($0)" } ?? "-") text=\(sample.text.map { "\($0)" } ?? "-") previous=\(sample.previous.map { "\($0.minY)" } ?? "-")"
        }.joined(separator: "\n")
    }

    private func keyboardUp(_ screen: Screen) async throws {
        XCTAssertTrue(screen.card.textView.becomeFirstResponder())
        let shown = try await until(seconds: 3) { screen.view.keyboardLayoutGuide.layoutFrame.height > 100 }
        XCTAssertTrue(shown, "no software keyboard came up: turn off the simulator's hardware keyboard")
        try await Task.sleep(for: .milliseconds(900))
    }

    // MARK: The flight

    func testTheAgentChatFliesASendInFromTheComposer() async throws {
        let screen = try await agentChat()
        try await flySend(screen, "agent")
    }

    func testTheAgentChatFliesASendInOverTheKeyboard() async throws {
        let screen = try await agentChat()
        try await keyboardUp(screen)
        try await flySend(screen, "agent keyboard")
    }

    func testTheLegacyChatFliesASendInFromTheComposer() async throws {
        let (screen, _) = try await legacyChat()
        try await flySend(screen, "legacy")
    }

    func testTheLegacyChatFliesASendInOverTheKeyboard() async throws {
        let (screen, _) = try await legacyChat()
        try await keyboardUp(screen)
        try await flySend(screen, "legacy keyboard")
    }

    /// Up in the history a send flies nothing: the list goes down to it.
    func testASendFromTheHistoryScrollsDownInstead() async throws {
        let screen = try await agentChat()
        screen.list.scrollTo(.init(index: 10), transition: .none)
        let transcript = try XCTUnwrap(find(AgentChatUltraList.self, in: screen.view))
        let there = try await until { transcript.distanceFromNewest > 200 }
        XCTAssertTrue(there)
        screen.card.setText("From the history", selection: NSRange(location: 16, length: 0))
        screen.card.delegate?.agentInputCardDidPressSend(screen.card)
        XCTAssertNil(screen.flight(), "a send from the history flew")
        let back = try await until { transcript.distanceFromNewest < 1 }
        XCTAssertTrue(back, "a send from the history stayed up there: \(transcript.distanceFromNewest)")
    }

    // MARK: The time and the mark

    private struct Walked {
        var bubble: CGRect
        var height: CGFloat
        var mark: MessageDelivery?
        var popped: Bool
    }

    /// The delivery mark the row shows now, and whether a check just popped in.
    private func mark(in view: UIView) -> (MessageDelivery?, Bool) {
        guard let mark = find(ChatDeliveryView.self, in: view) else { return (nil, false) }
        func popping(_ layer: CALayer) -> Bool {
            (layer.sublayers ?? []).contains { $0.animation(forKey: "delivery.pop") != nil || popping($0) }
        }
        return (mark.mark?.state, popping(mark.layer))
    }

    private func shot(_ window: UIWindow, _ rect: CGRect, _ name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { return }
        let area = rect.insetBy(dx: -16, dy: -12).intersection(window.bounds)
        let image = UIGraphicsImageRenderer(bounds: area).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("delivery-\(name).png"))
    }

    func testTheAgentChatsBubbleKeepsItsFrameFromTheClockToTwoChecks() async throws {
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        addTeardownBlock { @MainActor in window.layer.speed = 1; window.isHidden = true; hostWindow?.makeKey() }
        window.layer.speed = 1 / slow
        let root = try XCTUnwrap(window.rootViewController?.view)
        root.backgroundColor = .systemBackground
        let recorder = HostedFrameRecorder(window: window, name: "delivery-agent")
        recorder?.start()
        defer { recorder?.stop() }
        let transcript = AgentChatUltraList(frame: root.bounds)
        let host = WalkHost()
        transcript.host = host
        root.addSubview(transcript)
        transcript.setViewport(size: root.bounds.size, insets: UIEdgeInsets(top: 120, left: 0, bottom: 100, right: 0))
        let key = ChatPlanner.Key(width: root.bounds.width, maxContentWidth: .greatestFiniteMagnitude, environment: nil)
        let earlier = ChatItem(id: "a1", role: .agent, pieces: [.text("The cache test fails because the file changed under it.")], delivery: .sent)
        func plans(_ delivery: ChatItem.Delivery, words: String) -> [ChatRowPlan] {
            let item = ChatItem(id: "u1", role: .user, pieces: [.text(words)], delivery: delivery, time: 1_761_993_000_000)
            return [earlier, item].map { ChatPlanner.plan($0, key: key, copied: false, syntax: CodeSyntaxService()) }
        }
        for (label, words) in [("inline", "Run the tests"), ("own-line", "Run the tests again with the cache cleared, then tell me what changed in the timings")] {
            var walked: [Walked] = []
            for style in [UIUserInterfaceStyle.light, .dark] {
                window.overrideUserInterfaceStyle = style
                // Settled at the newest before the walk starts.
                transcript.apply(plans(.sending, words: words))
                try await Task.sleep(for: .milliseconds(500))
                walked = []
                for delivery in [ChatItem.Delivery.sending, .pending, .sent, .failed("refused")] {
                    let shown = plans(delivery, words: words)
                    transcript.apply(shown, animated: true)
                    let mounted = try await until { transcript.list.loadedItemView(at: 0) != nil }
                    XCTAssertTrue(mounted)
                    let view = try XCTUnwrap(transcript.list.loadedItemView(at: 0) as? AgentChatRowView)
                    XCTAssertTrue(view.row.plan === shown[1])
                    let (state, popped) = mark(in: view)
                    let bubble = view.convert(try XCTUnwrap(shown[1].flight).bubble.frame, to: window)
                    walked.append(Walked(bubble: bubble, height: shown[1].size.height, mark: state, popped: popped))
                    try await Task.sleep(for: .milliseconds(Int((delivery == .sending ? 500 : 250) * slow)))
                    try shot(window, bubble, "agent-\(label)-\(delivery == .sending ? "clock" : delivery == .pending ? "one" : delivery == .sent ? "two" : "failed")-\(style == .dark ? "dark" : "light")")
                }
                XCTAssertEqual(walked.map(\.mark), [.sending, .received, .accepted, .failed], label)
                // Clock, one check, two: one frame throughout.
                for step in walked.prefix(3) {
                    XCTAssertEqual(step.bubble, walked[0].bubble, "\(label): the bubble moved between marks")
                    XCTAssertEqual(step.height, walked[0].height, "\(label): the row's height changed between marks")
                }
                XCTAssertTrue(walked[1].popped && walked[2].popped, "\(label): a check came in without Telegram's pop")
            }
        }
    }

    func testTheLegacyChatsBubbleKeepsItsFrameFromTheClockToTwoChecks() async throws {
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        addTeardownBlock { @MainActor in window.layer.speed = 1; window.isHidden = true; hostWindow?.makeKey() }
        window.layer.speed = 1 / slow
        let root = try XCTUnwrap(window.rootViewController?.view)
        root.backgroundColor = .systemBackground
        let recorder = HostedFrameRecorder(window: window, name: "delivery-legacy")
        recorder?.start()
        defer { recorder?.stop() }
        window.layoutIfNeeded()
        let list = ChatListView(frame: root.bounds.inset(by: UIEdgeInsets(top: 100, left: 0, bottom: 100, right: 0)))
        root.addSubview(list)
        list.layoutIfNeeded()
        list.setEdgeInsets(newest: 8, oldest: 8)
        let planner = RowPlanner<ChatRowInput, ChatRowPlan> { ChatRowRenderer.plan($0, width: $1) }
        let record = SessionRecord(id: "s", seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            projectId: nil, metadataVersion: 1, metadataCipher: "cipher",
            metadata: .object(["client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1), "capabilities": .object(["messageReceipts": .bool(true)])]),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil, dataKeyCipher: "wrapped", decryptable: true)
        let session = ChatSessionState(record: record, settings: AccountSettings())
        func input(_ words: String, pending: Bool, delivery: OutboxDelivery?) -> ChatRowsInput {
            var view = ChatRowsView()
            view.width = list.bounds.width
            let agent = ChatMessage.agentText(AgentTextMessage(id: "a1", createdAt: 1_000, text: "The cache test fails because the file changed under it."))
            let user = ChatMessage.userText(UserTextMessage(id: "l1", localId: "l1", createdAt: 1_761_993_000_000, text: words, pending: pending))
            return ChatRowsInput(
                snapshot: LegacyChatSnapshot(sessionId: "s", messages: [agent, user], delivery: delivery.map { ["l1": $0] } ?? [:], isLoaded: true),
                session: session, view: view, render: .isolated()
            )
        }
        for (label, words) in [("inline", "Run the tests"), ("own-line", "Run the tests again with the cache cleared, then tell me what changed in the timings")] {
            for style in [UIUserInterfaceStyle.light, .dark] {
                window.overrideUserInterfaceStyle = style
                var applied = ChatRowsApplied()
                var walked: [Walked] = []
                let steps: [(String, Bool, OutboxDelivery?)] = [("clock", true, .sending), ("one", true, nil), ("two", false, nil), ("failed", false, .failed("offline"))]
                for (name, pending, delivery) in steps {
                    guard let derived = ChatRows.derive(input(words, pending: pending, delivery: delivery), applied: applied, planner: planner) else { continue }
                    applied = derived.state
                    if let update = derived.output.list { list.apply(update, animated: true) }
                    let identity = "chat:message:l1"
                    let ready = try await until { list.isDisplayReady && (self.row(identity, in: list.ultra.list) as? ChatUltraRowView)?.row.plan === applied.rows.plans.first }
                    XCTAssertTrue(ready, "\(label) \(name): never drawn")
                    let view = try XCTUnwrap(row(identity, in: list.ultra.list) as? ChatUltraRowView)
                    let plan = view.row.plan
                    let (state, popped) = mark(in: view)
                    let bubble = view.convert(try XCTUnwrap(plan.flight?.bubble.frame ?? plan.items.lazy.compactMap { if case .box(let box) = $0 { box.frame } else { nil } }.first), to: window)
                    walked.append(Walked(bubble: bubble, height: plan.size.height, mark: state, popped: popped))
                    try await Task.sleep(for: .milliseconds(Int((name == "clock" ? 500 : 250) * slow)))
                    try shot(window, bubble, "legacy-\(label)-\(name)-\(style == .dark ? "dark" : "light")")
                }
                XCTAssertEqual(walked.map(\.mark), [.sending, .received, .accepted, .failed], label)
                for step in walked.prefix(3) {
                    XCTAssertEqual(step.bubble, walked[0].bubble, "\(label): the bubble moved between marks")
                    XCTAssertEqual(step.height, walked[0].height, "\(label): the row's height changed between marks")
                }
                XCTAssertTrue(walked[1].popped && walked[2].popped, "\(label): a check came in without Telegram's pop")
                // Back to the start for the other appearance.
                list.apply(ChatListUpdate(ids: [], plans: [], model: ChatListLayout(width: list.bounds.width, heights: []), footer: nil, changeset: RowChangeset(), pinning: nil), animated: false)
                try await Task.sleep(for: .milliseconds(100))
            }
        }
    }
}

/// Shows each plan in its row, as the screen does.
@MainActor
private final class WalkHost: AgentChatTranscriptHost {
    func show(_ plan: ChatRowPlan, in view: ChatPlanView) { view.apply(plan) }
    func placedChunks(of plan: ChatRowPlan, in view: ChatPlanView) {}
    func transcriptScrolled() {}
    func transcriptWillBeginDragging() {}
    func transcriptDidEndDragging() {}
    func transcriptTapped(_ action: ChatRowAction) {}
    func transcriptOpened(_ url: String) {}
    func transcriptHeld(_ action: ChatRowAction, in view: UIView, frame: CGRect, at point: CGPoint) {}
}
#endif

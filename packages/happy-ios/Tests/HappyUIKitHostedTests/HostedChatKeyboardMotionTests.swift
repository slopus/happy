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

private struct MotionOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct MotionNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// One agent, `a`, with a long conversation: forty turns of a question and
/// a few lines of answer.
private actor MotionComputer: AgentTransport {
    static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }

    static func message(_ id: String, role: String, _ content: [JSONValue]) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(1), "metadata": .object([:]), "content": .array(content)])
    }

    static let runs: [JSONValue] = (0..<40).map { index in
        let answer = "Answer \(index). " + String(repeating: "The cache keeps what it read and drops it when the file changes. ", count: 1 + index % 4)
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

/// The software keyboard coming up and going down in both chats, sampled
/// on every display frame from what is drawn: the composer stays on the
/// keyboard's top, the newest row a constant distance above the composer
/// (or, read back in the history, the reader's row moves with it, as
/// Telegram's list moves its rows with the input panel), and nothing moves
/// further in one frame than the keyboard itself does.
///
/// The keyboard is the system's own, brought up by focusing the composer;
/// a simulator with a hardware keyboard connected shows none, and the test
/// fails saying so.
@MainActor
final class HostedChatKeyboardMotionTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
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

    /// A chat on screen, as the sampler reads it.
    private struct Screen {
        var window: UIWindow
        var view: UIView
        var list: UltraListView
        var composer: UIView
        var input: UITextView
        /// The prefix of a conversation row's identity.
        var rowPrefix: String
    }

    private func sampler(_ screen: Screen) -> KeyboardMotionSampler {
        let list = screen.list
        let prefix = screen.rowPrefix
        return KeyboardMotionSampler(
            window: screen.window,
            composer: { screen.composer },
            newestIdentity: { list.items.first { $0.identity.hasPrefix(prefix) }?.identity },
            row: { identity in list.items.firstIndex { $0.identity == identity }.flatMap(list.loadedItemView(at:)) }
        )
    }

    // MARK: Opening the chats

    private func legacyChat() async throws -> (Screen, AccountController) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: MotionOffline(), connector: MotionNoSocket()
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
        let drawn = try await until { list.plans.count > 20 && list.isDisplayReady && list.maximumVisibleMinY > list.bounds.height }
        XCTAssertTrue(drawn, "the fixture's rows never landed")
        try await Task.sleep(for: .milliseconds(300))
        chat.view.layoutIfNeeded()
        return (Screen(window: window, view: chat.view, list: list.ultra.list, composer: dock, input: card.textView, rowPrefix: "chat:message:"), controller)
    }

    private func agentChat() async throws -> Screen {
        let computer = MotionComputer()
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: MotionOffline(), connector: MotionNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let pairing = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"motion-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
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
        let loaded = try await until { chat.plans.count > 40 && transcript.list.loadedItemView(at: 0) != nil }
        XCTAssertTrue(loaded, "the conversation never landed: \(chat.plans.count) rows")
        try await Task.sleep(for: .milliseconds(300))
        chat.view.layoutIfNeeded()
        return Screen(window: window, view: chat.view, list: transcript.list, composer: chat.card, input: chat.card.textView, rowPrefix: "chat:row:")
    }

    // MARK: The keyboard

    private struct Motion {
        var show: KeyboardMotionSampler.Report
        var hide: KeyboardMotionSampler.Report
        var showLog: String
        var hideLog: String
    }

    /// Up, then down again, sampled. `reader` is a row followed besides the
    /// newest.
    private func keyboardUpAndDown(_ screen: Screen, reader: String? = nil) async throws -> Motion {
        let sampler = sampler(screen)
        let resting = sampler.presented(screen.composer).maxY

        sampler.start(reader: reader)
        XCTAssertTrue(screen.input.becomeFirstResponder())
        let shown = try await until(seconds: 3) { screen.view.keyboardLayoutGuide.layoutFrame.height > 100 }
        try await Task.sleep(for: .milliseconds(900))
        sampler.stop()
        XCTAssertTrue(shown && sampler.sawKeyboardHost, "no software keyboard came up: turn off the simulator's hardware keyboard (I/O › Keyboard › Connect Hardware Keyboard)")
        let up = try XCTUnwrap(sampler.frames.last)
        // Up, the composer stands on the keyboard: the card a few points
        // over it, the dock right on it.
        let gap = up.keyboardTop - up.composer.maxY
        XCTAssertTrue((0...ChatScreenLayout.Metrics.paddingBottom).contains(gap.rounded()), "the composer stands on the keyboard, \(gap) over it")
        let show = sampler.report()
        let showLog = sampler.log

        sampler.start(reader: reader)
        screen.view.endEditing(true)
        _ = try await until(seconds: 3) { screen.view.keyboardLayoutGuide.layoutFrame.height < 100 }
        try await Task.sleep(for: .milliseconds(900))
        sampler.stop()
        let hide = sampler.report()
        XCTAssertEqual(try XCTUnwrap(sampler.frames.last).composer.maxY, resting, accuracy: 0.5, "the composer is back where it rested")
        return Motion(show: show, hide: hide, showLog: showLog, hideLog: sampler.log)
    }

    /// What every motion keeps to: the composer on the keyboard, each
    /// frame's step no longer than the keyboard's.
    private func assertFollows(_ report: KeyboardMotionSampler.Report, _ label: String, log: String, file: StaticString = #filePath, line: UInt = #line) {
        print("HostedChatKeyboardMotionTests \(label): \(report)")
        XCTAssertGreaterThan(report.keyboardTravel, 100, "\(label): the keyboard moved\n\(log)", file: file, line: line)
        // After some earlier tests in the suite (HostedArtifactMediaTests'
        // markdown one), the system's keyboard leaves in a single frame,
        // its did-hide right after its will-change: there is no motion to
        // ride then, only the composer's own, which the rows still keep to.
        guard report.keyboardStep < report.keyboardTravel * 0.8 else {
            print("HostedChatKeyboardMotionTests \(label): the system keyboard moved in one frame\n\(log)")
            return
        }
        XCTAssertGreaterThan(report.frames, 8, "\(label): the keyboard animated over frames\n\(log)", file: file, line: line)
        XCTAssertLessThanOrEqual(report.composerOffKeyboard, 1, "\(label): the composer left the keyboard\n\(report)\n\(log)", file: file, line: line)
        XCTAssertLessThanOrEqual(report.composerStep, report.keyboardStep + 1, "\(label): the composer jumped\n\(report)\n\(log)", file: file, line: line)
    }

    private func assertNewestRides(_ report: KeyboardMotionSampler.Report, _ label: String, log: String, file: StaticString = #filePath, line: UInt = #line) {
        assertFollows(report, label, log: log, file: file, line: line)
        let off = report.newestOffComposer ?? .infinity
        XCTAssertLessThanOrEqual(off, 1, "\(label): the newest row left the composer\n\(report)\n\(log)", file: file, line: line)
        XCTAssertLessThanOrEqual(report.newestStep, report.keyboardStep + 1, "\(label): the newest row jumped\n\(report)\n\(log)", file: file, line: line)
    }

    private func assertReaderRides(_ report: KeyboardMotionSampler.Report, _ label: String, log: String, file: StaticString = #filePath, line: UInt = #line) {
        assertFollows(report, label, log: log, file: file, line: line)
        let off = report.readerOffComposer ?? .infinity
        XCTAssertLessThanOrEqual(off, 1, "\(label): the reader's row left the composer\n\(report)\n\(log)", file: file, line: line)
        XCTAssertLessThanOrEqual(report.readerStep, report.keyboardStep + 1, "\(label): the reader's row jumped\n\(report)\n\(log)", file: file, line: line)
    }

    /// A row in the middle of the screen, which the reader is reading.
    private func middleRow(_ screen: Screen) -> String? {
        let middle = screen.view.bounds.midY
        for index in screen.list.loadedIndexRange {
            guard let view = screen.list.loadedItemView(at: index), screen.list.items[index].identity.hasPrefix(screen.rowPrefix) else { continue }
            let frame = view.convert(view.bounds, to: screen.view)
            if frame.minY <= middle, frame.maxY >= middle { return screen.list.items[index].identity }
        }
        return nil
    }

    // MARK: The Happy account chat

    func testTheLegacyChatRidesTheKeyboardAtTheNewest() async throws {
        let (screen, _) = try await legacyChat()
        let motion = try await keyboardUpAndDown(screen)
        assertNewestRides(motion.show, "legacy show", log: motion.showLog)
        assertNewestRides(motion.hide, "legacy hide", log: motion.hideLog)
    }

    func testTheLegacyChatRidesTheKeyboardInTheHistory() async throws {
        let (screen, _) = try await legacyChat()
        let list = try XCTUnwrap(find(ChatListView.self, in: screen.view))
        list.setVisibleMinY(list.maximumVisibleMinY / 2)
        let there = try await until { list.visibleMinY > list.bounds.height && list.isDisplayReady }
        XCTAssertTrue(there)
        try await Task.sleep(for: .milliseconds(300))
        let reader = try XCTUnwrap(middleRow(screen))
        let motion = try await keyboardUpAndDown(screen, reader: reader)
        assertReaderRides(motion.show, "legacy history show", log: motion.showLog)
        assertReaderRides(motion.hide, "legacy history hide", log: motion.hideLog)
    }

    // MARK: The agents' chat

    func testTheAgentChatRidesTheKeyboardAtTheNewest() async throws {
        let screen = try await agentChat()
        let motion = try await keyboardUpAndDown(screen)
        assertNewestRides(motion.show, "agent show", log: motion.showLog)
        assertNewestRides(motion.hide, "agent hide", log: motion.hideLog)
    }

    func testTheAgentChatRidesTheKeyboardInTheHistory() async throws {
        let screen = try await agentChat()
        screen.list.scrollTo(.init(index: 30), transition: .none)
        let transcript = try XCTUnwrap(find(AgentChatUltraList.self, in: screen.view))
        let there = try await until { transcript.distanceFromNewest > screen.view.bounds.height }
        XCTAssertTrue(there)
        try await Task.sleep(for: .milliseconds(300))
        let reader = try XCTUnwrap(middleRow(screen))
        let motion = try await keyboardUpAndDown(screen, reader: reader)
        assertReaderRides(motion.show, "agent history show", log: motion.showLog)
        assertReaderRides(motion.hide, "agent history hide", log: motion.hideLog)
    }

    // MARK: The composer growing

    /// With the keyboard up, four more lines typed: the composer grows up
    /// from the keyboard, and the newest row stays the same distance above
    /// it on every frame.
    private func composerGrows(_ screen: Screen, _ label: String) async throws {
        XCTAssertTrue(screen.input.becomeFirstResponder())
        let shown = try await until(seconds: 3) { screen.view.keyboardLayoutGuide.layoutFrame.height > 100 }
        XCTAssertTrue(shown, "no software keyboard came up")
        try await Task.sleep(for: .milliseconds(900))
        let sampler = sampler(screen)
        let before = sampler.presented(screen.composer)
        sampler.start()
        for line in 1...4 {
            screen.input.insertText("\nline \(line)")
            try await Task.sleep(for: .milliseconds(300))
        }
        sampler.stop()
        let after = sampler.presented(screen.composer)
        let report = sampler.report()
        print("HostedChatKeyboardMotionTests \(label): \(report)")
        XCTAssertGreaterThan(before.minY - after.minY, 40, "\(label): the composer grew\n\(sampler.log)")
        XCTAssertEqual(after.maxY, before.maxY, accuracy: 0.5, "\(label): the composer stays on the keyboard")
        XCTAssertLessThanOrEqual(report.newestOffComposer ?? .infinity, 1, "\(label): the newest row left the composer\n\(report)\n\(sampler.log)")
    }

    func testTheLegacyChatsNewestStaysOverAGrowingComposer() async throws {
        let (screen, _) = try await legacyChat()
        try await composerGrows(screen, "legacy grows")
    }

    func testTheAgentChatsNewestStaysOverAGrowingComposer() async throws {
        let screen = try await agentChat()
        try await composerGrows(screen, "agent grows")
    }
}
#endif

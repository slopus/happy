#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

private struct NoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

/// The chat list (UltraList) in a window of a real scene, as on a phone: it
/// shows no scroll indicator, as Telegram's chat list shows none, and the
/// reader keeps their place as the keyboard and the dock change its insets
/// and as older rows join.
@MainActor
final class HostedChatListTests: XCTestCase {
    private let renderServices = RenderServices.isolated()
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    /// UIKit's vertical indicators anywhere in the list, shown or not.
    private func shownIndicators(_ list: ChatListView) -> [UIView] {
        func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }
        let views = all(list)
        for case let scroll as UIScrollView in views { scroll.flashScrollIndicators() }
        list.layoutIfNeeded()
        return all(list).filter { view in
            NSStringFromClass(type(of: view)).contains("ScrollIndicator")
                && view.bounds.height > view.bounds.width
                && !view.isHidden && view.alpha > 0
        }
    }

    private func assertNoIndicator(_ list: ChatListView, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }
        let asked = all(list).compactMap { $0 as? UIScrollView }.filter(\.showsVerticalScrollIndicator)
        XCTAssertEqual(asked.map(\.frame), [], "\(label): asked to show", file: file, line: line)
        XCTAssertEqual(shownIndicators(list).map(\.frame), [], "\(label): shown", file: file, line: line)
    }

    // MARK: The list alone

    /// Turns of a prompt and its answer, a few lines each.
    private func messages(_ count: Int) -> [ChatMessage] {
        (0..<count).map { index in
            let text = "message \(index): " + String(repeating: "words in a line ", count: 1 + index % 7)
            return index.isMultiple(of: 2)
                ? .userText(UserTextMessage(id: "m\(index)", createdAt: Int64(index), text: text))
                : .agentText(AgentTextMessage(id: "m\(index)", createdAt: Int64(index), text: text))
        }
    }

    private func input(_ messages: [ChatMessage], width: CGFloat, grows: Int) -> ChatRowsInput {
        var view = ChatRowsView()
        view.width = width
        view.requests.grows = grows
        return ChatRowsInput(
            snapshot: LegacyChatSnapshot(sessionId: "s", messages: messages, isLoaded: true, hasMoreOlder: false, olderBoundary: nil, windowEpoch: 0),
            session: ChatSessionState(record: nil, settings: AccountSettings()),
            view: view,
            render: renderServices
        )
    }

    private let planner = RowPlanner<ChatRowInput, ChatRowPlan> { ChatRowRenderer.plan($0, width: $1) }

    /// The phone's screen in the host's window: a 60-tall bar over a 70-tall
    /// composer, resting on the safe area or on the keyboard's top.
    private func screen(_ root: UIView, keyboardTop: CGFloat? = nil, composerHeight: CGFloat = 70) -> LegacyChatScreenLayout {
        LegacyChatScreenLayout(.init(
            size: root.bounds.size, safeArea: LayoutInsets(root.safeAreaInsets), keyboardTop: keyboardTop,
            accessories: [.inset(.fixed(width: 0, height: 60))], composerHeight: composerHeight
        ))
    }

    private struct ListUnderTest {
        var window: UIWindow
        var root: UIView
        var list: ChatListView
        var applied: ChatRowsApplied
        var messages: [ChatMessage]
    }

    /// A list over the whole window with the newest page of 600 messages,
    /// at the newest message.
    private func listInWindow() async throws -> ListUnderTest {
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        let root = try XCTUnwrap(window.rootViewController?.view)
        window.layoutIfNeeded()
        let layout = screen(root)
        let list = ChatListView(frame: layout.list)
        root.addSubview(list)
        list.layoutIfNeeded()
        list.setEdgeInsets(newest: layout.newestEdgeInset, oldest: layout.oldestEdgeInset)
        let all = messages(600)
        let derived = try XCTUnwrap(ChatRows.derive(input(all, width: layout.list.width, grows: 0), applied: ChatRowsApplied(), planner: planner))
        list.apply(try XCTUnwrap(derived.output.list), animated: false)
        list.layoutIfNeeded()
        let drawn = try await until { list.isDisplayReady }
        XCTAssertTrue(drawn, "the list never drew its rows")
        return ListUnderTest(window: window, root: root, list: list, applied: derived.state, messages: all)
    }

    /// The reader at `distance` from the newest message, drawn there.
    private func scroll(_ list: ChatListView, toDistance distance: CGFloat) async throws {
        list.setVisibleMinY(distance)
        let there = try await until { abs(list.visibleMinY - distance) < 0.5 && list.isDisplayReady }
        XCTAssertTrue(there, "never reached \(distance): at \(list.visibleMinY)")
    }

    private func maxDistance(_ list: ChatListView) -> CGFloat { list.maximumVisibleMinY }

    func testTheListNeverShowsAVerticalIndicator() async throws {
        let test = try await listInWindow()
        let list = test.list
        XCTAssertGreaterThan(maxDistance(list), list.bounds.height, "a few screens to scroll")
        assertNoIndicator(list, "newest")
        try await scroll(list, toDistance: maxDistance(list) / 2)
        assertNoIndicator(list, "halfway")
        try await scroll(list, toDistance: maxDistance(list))
        assertNoIndicator(list, "oldest")
    }

    func testTheKeyboardAndTheDockKeepTheReadersPlace() async throws {
        let test = try await listInWindow()
        let list = test.list
        let height = test.root.bounds.height
        try await scroll(list, toDistance: maxDistance(list) / 3)
        let place = list.visibleMinY

        // A 336-tall keyboard comes up: the conversation rides up with the
        // dock.
        let typing = screen(test.root, keyboardTop: height - 336)
        list.setEdgeInsets(newest: typing.newestEdgeInset, oldest: typing.oldestEdgeInset)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.5)

        // The composer grows to three lines.
        let grown = screen(test.root, keyboardTop: height - 336, composerHeight: 130)
        list.setEdgeInsets(newest: grown.newestEdgeInset, oldest: grown.oldestEdgeInset)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.5)

        // Down again, in steps as the keyboard's frames come.
        var keyboardTop = height - 336
        while keyboardTop < height {
            keyboardTop += 24
            let step = screen(test.root, keyboardTop: keyboardTop, composerHeight: 130)
            list.setEdgeInsets(newest: step.newestEdgeInset, oldest: step.oldestEdgeInset)
            XCTAssertEqual(list.visibleMinY, place, accuracy: 0.5)
        }
        let resting = screen(test.root, composerHeight: 130)
        list.setEdgeInsets(newest: resting.newestEdgeInset, oldest: resting.oldestEdgeInset)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.5)
        assertNoIndicator(list, "after the keyboard")
    }

    func testOlderRowsJoiningKeepTheReader() async throws {
        let test = try await listInWindow()
        let list = test.list
        // Near the oldest row, where the next page is asked for.
        try await scroll(list, toDistance: maxDistance(list) - list.bounds.height / 2)
        let place = list.visibleMinY
        let before = list.contentHeight
        let grown = try XCTUnwrap(ChatRows.derive(input(test.messages, width: list.bounds.width, grows: 1), applied: test.applied, planner: planner))
        list.apply(try XCTUnwrap(grown.output.list), animated: false)
        let paged = try await until { list.isDisplayReady && list.contentHeight > before }
        XCTAssertTrue(paged, "a page joined")
        // Older rows join past the oldest: nothing the reader sees moves.
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.5)
        assertNoIndicator(list, "after a page joined")
    }

    func testTheReaderStaysThroughKeyboardDockAndOlderPages() async throws {
        let test = try await listInWindow()
        let list = test.list
        XCTAssertNil(list.subviews.first { $0 is UICollectionView })
        list.setVisibleMinY(list.maximumVisibleMinY / 3)
        let scrolled = try await until { list.visibleMinY > list.bounds.height }
        XCTAssertTrue(scrolled)
        let place = list.visibleMinY
        let typing = screen(test.root, keyboardTop: test.root.bounds.height - 336, composerHeight: 130)
        list.setEdgeInsets(newest: typing.newestEdgeInset, oldest: typing.oldestEdgeInset)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.5)
        let resting = screen(test.root)
        list.setEdgeInsets(newest: resting.newestEdgeInset, oldest: resting.oldestEdgeInset)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.5)
        let grown = try XCTUnwrap(ChatRows.derive(input(test.messages, width: list.bounds.width, grows: 1), applied: test.applied, planner: planner))
        list.apply(try XCTUnwrap(grown.output.list), animated: false)
        let paged = try await until { list.isDisplayReady && list.contentHeight > test.applied.model.contentHeight }
        XCTAssertTrue(paged)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.5)
    }

    /// 190 points back is back in history: the reply growing at the foot
    /// goes on below the fold, and nothing the reader sees moves.
    func testAStreamBelowAReaderInHistoryMovesNothing() async throws {
        let test = try await listInWindow()
        let list = test.list
        list.setVisibleMinY(190)
        let positioned = try await until { abs(list.visibleMinY - 190) < 0.5 }
        XCTAssertTrue(positioned)
        var messages = test.messages
        guard case .agentText(var last) = messages.removeLast() else { return XCTFail("expected an agent reply") }
        last.text += "\n\nThe next streamed paragraph grows the newest reply."
        messages.append(.agentText(last))
        let streamed = try XCTUnwrap(ChatRows.derive(input(messages, width: list.bounds.width, grows: 0), applied: test.applied, planner: planner))
        let update = try XCTUnwrap(streamed.output.list)
        XCTAssertEqual(update.changeset.reconfigures.count, 1)
        let grown = update.model.contentHeight - list.contentHeight
        XCTAssertGreaterThan(grown, 0)
        list.apply(update, animated: true)
        let applied = try await until { list.isDisplayReady && abs(list.visibleMinY - 190 - grown) < 0.5 }
        XCTAssertTrue(applied, "the reader stays put: \(list.visibleMinY), expected \(190 + grown)")
    }

    func testTheListRedrawsDisplayedRowsThroughAppearanceChanges() async throws {
        let test = try await listInWindow()
        let list = test.list
        for style in [UIUserInterfaceStyle.dark, .light] {
            let revision = list.ultra.list.items.last?.revision
            list.overrideUserInterfaceStyle = style
            list.setNeedsLayout()
            list.layoutIfNeeded()
            let drawn = try await until { list.isDisplayReady && list.ultra.list.items.last?.revision != revision }
            XCTAssertTrue(drawn, "unchanged rows must redraw after appearance changes")
        }
    }

    // MARK: The chat screen

    private func signedIn() async throws -> AccountController {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 1, count: 32)))
        return controller
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    private func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        for child in view.subviews {
            if let match = child as? T { return match }
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }

    /// The long fixture chat under the navigation bar: no indicator, the
    /// dock on the software keyboard, and after the keyboard is dismissed
    /// the dock on the safe area again with the reader where they were.
    func testTheChatScreenShowsNoIndicatorAndKeepsTheReaderThroughTheKeyboard() async throws {
        let controller = try await signedIn()
        let account = try XCTUnwrap(controller.session)
        let context = AppContext(account: controller, variant: .development, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let chat = LegacyChatViewController(context: context, session: account, sessionId: FixtureScenarios.prefix + FixtureScenario.long.rawValue)
        let navigation = UINavigationController(rootViewController: UIViewController())
        navigation.pushViewController(chat, animated: false)
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        let constructed = try await until { chat.contentInstalled }
        XCTAssertTrue(constructed)
        let list = try XCTUnwrap(subview(ChatListView.self, in: chat.view))
        let dock = try XCTUnwrap(subview(ChatDockView.self, in: chat.view))
        let filled = try await until { list.plans.count > 20 && list.isDisplayReady && maxDistance(list) > list.bounds.height }
        XCTAssertTrue(filled, "the fixture's rows never landed")
        chat.view.layoutIfNeeded()
        assertNoIndicator(list, "resting")

        // The software keyboard, where this simulator shows one.
        let card = try XCTUnwrap(subview(AgentInputCardView.self, in: chat.view))
        XCTAssertTrue(card.textView.becomeFirstResponder())
        let keyboardShown = try await until(seconds: 3) { chat.view.keyboardLayoutGuide.layoutFrame.height > 100 }
        try await Task.sleep(for: .milliseconds(600))
        chat.view.layoutIfNeeded()
        if keyboardShown {
            XCTAssertEqual(dock.frame.maxY, chat.view.keyboardLayoutGuide.layoutFrame.minY, accuracy: 0.5)
        } else {
            print("HostedChatListTests: no software keyboard shown (hardware keyboard); the resting dock checked only")
        }

        // Back in the history, then the keyboard goes.
        try await scroll(list, toDistance: maxDistance(list) / 2)

        let place = list.visibleMinY
        assertNoIndicator(list, "halfway")
        chat.view.endEditing(true)
        _ = try await until(seconds: 3) { chat.view.keyboardLayoutGuide.layoutFrame.height < 100 }
        try await Task.sleep(for: .milliseconds(600))
        chat.view.layoutIfNeeded()
        XCTAssertEqual(dock.frame.maxY, chat.view.bounds.height - chat.view.safeAreaInsets.bottom, accuracy: 0.5)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.5, "the reader stays where they were")
        assertNoIndicator(list, "keyboard dismissed")
        await controller.signOut()
    }
}
#endif

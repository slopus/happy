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

/// The chat list in a window of a real scene, as on a phone: it shows no
/// scroll indicator, as Telegram's chat list shows none, and the reader
/// keeps their place as the keyboard and the dock change its insets and as
/// older rows join.
@MainActor
final class HostedChatListTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    /// UIKit's vertical indicators in the list, shown or not.
    private func shownIndicators(_ list: ChatListView) -> [UIView] {
        let collection = list.collectionView
        collection.flashScrollIndicators()
        collection.layoutIfNeeded()
        return collection.subviews.filter { view in
            NSStringFromClass(type(of: view)).contains("ScrollIndicator")
                && view.bounds.height > view.bounds.width
                && !view.isHidden && view.alpha > 0
        }
    }

    private func assertNoIndicator(_ list: ChatListView, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(list.collectionView.showsVerticalScrollIndicator, "\(label): asked to show", file: file, line: line)
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
            snapshot: ChatSnapshot(sessionId: "s", messages: messages, isLoaded: true, hasMoreOlder: false, olderBoundary: nil, windowEpoch: 0),
            session: ChatSessionState(record: nil, settings: AccountSettings()),
            view: view,
            render: .isolated()
        )
    }

    private let planner = RowPlanner<ChatRowInput, ChatRowPlan> { ChatRowRenderer.plan($0, width: $1) }

    /// The phone's screen in the host's window: a 60-tall bar over a 70-tall
    /// composer, resting on the safe area or on the keyboard's top.
    private func screen(_ root: UIView, keyboardTop: CGFloat? = nil, composerHeight: CGFloat = 70) -> ChatScreenLayout {
        ChatScreenLayout(.init(
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
        return ListUnderTest(window: window, root: root, list: list, applied: derived.state, messages: all)
    }

    private func scroll(_ list: ChatListView, toDistance distance: CGFloat) {
        list.collectionView.contentOffset.y = distance - list.collectionView.contentInset.top
        list.layoutIfNeeded()
    }

    private func maxDistance(_ list: ChatListView) -> CGFloat {
        let collection = list.collectionView
        return max(0, collection.contentSize.height + collection.contentInset.top + collection.contentInset.bottom - list.bounds.height)
    }

    func testTheListNeverShowsAVerticalIndicator() async throws {
        let test = try await listInWindow()
        let list = test.list
        XCTAssertGreaterThan(maxDistance(list), list.bounds.height, "a few screens to scroll")
        assertNoIndicator(list, "newest")
        scroll(list, toDistance: maxDistance(list) / 2)
        assertNoIndicator(list, "halfway")
        scroll(list, toDistance: maxDistance(list))
        assertNoIndicator(list, "oldest")
    }

    func testTheKeyboardAndTheDockKeepTheReadersPlace() async throws {
        let test = try await listInWindow()
        let list = test.list
        let height = test.root.bounds.height
        scroll(list, toDistance: maxDistance(list) / 3)
        let place = list.visibleMinY

        // A 336-tall keyboard comes up: the conversation rides up with the
        // dock.
        let typing = screen(test.root, keyboardTop: height - 336)
        list.setEdgeInsets(newest: typing.newestEdgeInset, oldest: typing.oldestEdgeInset)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.001)

        // The composer grows to three lines.
        let grown = screen(test.root, keyboardTop: height - 336, composerHeight: 130)
        list.setEdgeInsets(newest: grown.newestEdgeInset, oldest: grown.oldestEdgeInset)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.001)

        // Down again, in steps as the keyboard's frames come.
        var keyboardTop = height - 336
        while keyboardTop < height {
            keyboardTop += 24
            let step = screen(test.root, keyboardTop: keyboardTop, composerHeight: 130)
            list.setEdgeInsets(newest: step.newestEdgeInset, oldest: step.oldestEdgeInset)
            XCTAssertEqual(list.visibleMinY, place, accuracy: 0.001)
        }
        let resting = screen(test.root, composerHeight: 130)
        list.setEdgeInsets(newest: resting.newestEdgeInset, oldest: resting.oldestEdgeInset)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.001)
        assertNoIndicator(list, "after the keyboard")
    }

    func testOlderRowsJoiningKeepTheReader() async throws {
        let test = try await listInWindow()
        let list = test.list
        // Near the oldest row, where the next page is asked for.
        scroll(list, toDistance: maxDistance(list) - list.bounds.height / 2)
        let place = list.visibleMinY
        let before = list.collectionView.contentSize.height
        let grown = try XCTUnwrap(ChatRows.derive(input(test.messages, width: list.bounds.width, grows: 1), applied: test.applied, planner: planner))
        list.apply(try XCTUnwrap(grown.output.list), animated: false)
        list.layoutIfNeeded()
        XCTAssertGreaterThan(list.collectionView.contentSize.height, before, "a page joined")
        // Older rows join past the oldest: nothing the reader sees moves.
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.5)
        assertNoIndicator(list, "after a page joined")
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
        let chat = ChatViewController(context: context, session: account, sessionId: FixtureScenarios.prefix + FixtureScenario.long.rawValue)
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
        let filled = try await until { list.collectionView.numberOfItems(inSection: 0) > 20 && maxDistance(list) > list.bounds.height }
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
        scroll(list, toDistance: maxDistance(list) / 2)
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

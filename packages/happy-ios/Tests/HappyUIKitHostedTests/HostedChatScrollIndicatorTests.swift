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

/// UIKit's own vertical scroll indicator over the chat list, read back from
/// the flipped collection view and held against `ChatScrollIndicatorLayout`:
/// the reader at the newest message, in the middle and at the oldest; the
/// keyboard and the dock changing the insets; older rows joining; and the
/// chat screen itself with the software keyboard up and dismissed. Hosted,
/// so the list is in a window of a real scene, as on a phone.
@MainActor
final class HostedChatScrollIndicatorTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    // MARK: Reading the indicator

    /// UIKit's vertical indicator, flashed so it is laid out, as it shows on
    /// screen in `view`'s coordinates.
    private func indicatorFrame(_ list: ChatListView, in view: UIView) -> CGRect? {
        let collection = list.collectionView
        collection.flashScrollIndicators()
        collection.layoutIfNeeded()
        let vertical = collection.subviews
            .filter { NSStringFromClass(type(of: $0)).contains("ScrollIndicator") }
            .first { $0.bounds.height > $0.bounds.width }
        return vertical.map { view.convert($0.bounds, from: $0) }
    }

    /// Where the indicator must be for the list as it is now.
    private func expected(_ list: ChatListView, _ insets: ChatIndicatorInsets) -> ChatScrollIndicatorLayout {
        let collection = list.collectionView
        return ChatScrollIndicatorLayout(.init(
            viewport: list.bounds.size, contentHeight: collection.contentSize.height,
            newestInset: collection.contentInset.top, oldestInset: collection.contentInset.bottom,
            indicatorInsets: insets, distanceFromNewest: list.visibleMinY, scale: list.traitCollection.displayScale
        ))
    }

    /// The model rounds as UIKit does; this is floating point only.
    private let accuracy: CGFloat = 0.01

    private func assertIndicator(_ list: ChatListView, _ insets: ChatIndicatorInsets, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let layout = expected(list, insets)
        guard let actual = indicatorFrame(list, in: list) else {
            XCTFail("\(label): no vertical indicator", file: file, line: line)
            return
        }
        print("HostedChatScrollIndicatorTests \(label): list \(list.bounds.size) distance \(list.visibleMinY) insets \(insets) indicator \(actual) expected \(layout.frame)")
        XCTAssertEqual(actual.minX, layout.frame.minX, accuracy: accuracy, "\(label): side", file: file, line: line)
        XCTAssertEqual(actual.minY, layout.frame.minY, accuracy: accuracy, "\(label): top", file: file, line: line)
        XCTAssertEqual(actual.height, layout.frame.height, accuracy: accuracy, "\(label): length", file: file, line: line)
    }

    /// The collection view's indicator insets are the screen's, flipped:
    /// its top is the screen's bottom.
    private func assertIndicatorInsets(_ list: ChatListView, _ insets: ChatIndicatorInsets, file: StaticString = #filePath, line: UInt = #line) {
        let actual = list.collectionView.verticalScrollIndicatorInsets
        XCTAssertEqual(actual.top, insets.newest, accuracy: accuracy, "newest", file: file, line: line)
        XCTAssertEqual(actual.bottom, insets.oldest, accuracy: accuracy, "oldest", file: file, line: line)
        XCTAssertEqual(actual.right, insets.side, accuracy: accuracy, "side", file: file, line: line)
        XCTAssertEqual(actual.left, 0, file: file, line: line)
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
        list.setEdgeInsets(newest: layout.newestEdgeInset, oldest: layout.oldestEdgeInset, indicator: layout.indicatorInsets)
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

    func testTheIndicatorFollowsTheReaderFromTheNewestToTheOldest() async throws {
        let test = try await listInWindow()
        let list = test.list
        let insets = screen(test.root).indicatorInsets
        XCTAssertGreaterThan(maxDistance(list), list.bounds.height, "a few screens to scroll")
        // The safe area is counted once, by the screen's insets.
        XCTAssertFalse(list.collectionView.automaticallyAdjustsScrollIndicatorInsets)

        XCTAssertEqual(list.visibleMinY, 0)
        assertIndicator(list, insets, "newest")
        // Flipped: at the newest message the indicator rests on the dock.
        let resting = try XCTUnwrap(indicatorFrame(list, in: list))
        XCTAssertEqual(resting.maxY, list.bounds.height - insets.newest - ChatScrollIndicatorLayout.Style.standard.endInset, accuracy: accuracy)

        scroll(list, toDistance: maxDistance(list) / 2)
        assertIndicator(list, insets, "halfway")
        scroll(list, toDistance: maxDistance(list))
        assertIndicator(list, insets, "oldest")
        // Under the header at the oldest end.
        let top = try XCTUnwrap(indicatorFrame(list, in: list))
        XCTAssertEqual(top.minY, insets.oldest + ChatScrollIndicatorLayout.Style.standard.endInset, accuracy: accuracy)
    }

    func testTheKeyboardAndTheDockMoveTheTrackAndKeepTheReadersPlace() async throws {
        let test = try await listInWindow()
        let list = test.list
        let height = test.root.bounds.height
        scroll(list, toDistance: maxDistance(list) / 3)
        let place = list.visibleMinY

        // A 336-tall keyboard comes up: the conversation rides up with the
        // dock, and the track ends above the dock.
        let typing = screen(test.root, keyboardTop: height - 336)
        list.setEdgeInsets(newest: typing.newestEdgeInset, oldest: typing.oldestEdgeInset, indicator: typing.indicatorInsets)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.001)
        assertIndicatorInsets(list, typing.indicatorInsets)
        assertIndicator(list, typing.indicatorInsets, "keyboard up")

        // The composer grows to three lines.
        let grown = screen(test.root, keyboardTop: height - 336, composerHeight: 130)
        list.setEdgeInsets(newest: grown.newestEdgeInset, oldest: grown.oldestEdgeInset, indicator: grown.indicatorInsets)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.001)
        assertIndicator(list, grown.indicatorInsets, "dock grown")

        // Down again, in steps as the keyboard's frames come.
        var keyboardTop = height - 336
        while keyboardTop < height {
            keyboardTop += 24
            let step = screen(test.root, keyboardTop: keyboardTop, composerHeight: 130)
            list.setEdgeInsets(newest: step.newestEdgeInset, oldest: step.oldestEdgeInset, indicator: step.indicatorInsets)
            XCTAssertEqual(list.visibleMinY, place, accuracy: 0.001)
            assertIndicator(list, step.indicatorInsets, "keyboard at \(keyboardTop)")
        }
        let resting = screen(test.root, composerHeight: 130)
        list.setEdgeInsets(newest: resting.newestEdgeInset, oldest: resting.oldestEdgeInset, indicator: resting.indicatorInsets)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.001)
        assertIndicator(list, resting.indicatorInsets, "keyboard down")
    }

    func testOlderRowsJoiningRedrawTheIndicatorWhereTheLayoutSaysAndKeepTheReader() async throws {
        let test = try await listInWindow()
        let list = test.list
        let insets = screen(test.root).indicatorInsets
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
        assertIndicator(list, insets, "after a page joined")
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

    /// The screen's indicator insets as the screen shows them: the dock and
    /// keyboard below, the bar above, read off the views.
    private func shownInsets(_ chat: UIViewController, dock: UIView) -> ChatIndicatorInsets {
        ChatIndicatorInsets(newest: chat.view.bounds.height - dock.frame.minY, oldest: chat.view.safeAreaInsets.top, side: chat.view.safeAreaInsets.right)
    }

    /// The long fixture chat under the navigation bar: its indicator clears
    /// the bar and the dock, then the software keyboard, and after the
    /// keyboard is dismissed it rests on the dock again with the reader
    /// where they were.
    func testTheChatScreensIndicatorClearsTheBarTheDockAndTheKeyboard() async throws {
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
        let list = try XCTUnwrap(subview(ChatListView.self, in: chat.view))
        let dock = try XCTUnwrap(subview(ChatDockView.self, in: chat.view))
        let filled = try await until { list.collectionView.numberOfItems(inSection: 0) > 20 && maxDistance(list) > list.bounds.height }
        XCTAssertTrue(filled, "the fixture's rows never landed")
        chat.view.layoutIfNeeded()

        var insets = shownInsets(chat, dock: dock)
        XCTAssertGreaterThan(insets.oldest, 0)
        assertIndicatorInsets(list, insets)
        assertIndicator(list, insets, "resting")

        // The software keyboard, where this simulator shows one.
        let card = try XCTUnwrap(subview(AgentInputCardView.self, in: chat.view))
        XCTAssertTrue(card.textView.becomeFirstResponder())
        let keyboardShown = try await until(seconds: 3) { chat.view.keyboardLayoutGuide.layoutFrame.height > 100 }
        try await Task.sleep(for: .milliseconds(600))
        chat.view.layoutIfNeeded()
        if keyboardShown {
            XCTAssertEqual(dock.frame.maxY, chat.view.keyboardLayoutGuide.layoutFrame.minY, accuracy: 0.5)
            insets = shownInsets(chat, dock: dock)
            XCTAssertGreaterThan(insets.newest, chat.view.keyboardLayoutGuide.layoutFrame.height)
            assertIndicator(list, insets, "keyboard up")
        } else {
            print("HostedChatScrollIndicatorTests: no software keyboard shown (hardware keyboard); resting insets checked only")
        }

        // Back in the history, then the keyboard goes.
        scroll(list, toDistance: maxDistance(list) / 2)
        let place = list.visibleMinY
        assertIndicator(list, insets, "halfway")
        chat.view.endEditing(true)
        _ = try await until(seconds: 3) { chat.view.keyboardLayoutGuide.layoutFrame.height < 100 }
        try await Task.sleep(for: .milliseconds(600))
        chat.view.layoutIfNeeded()
        insets = shownInsets(chat, dock: dock)
        XCTAssertEqual(dock.frame.maxY, chat.view.bounds.height - chat.view.safeAreaInsets.bottom, accuracy: 0.5)
        XCTAssertEqual(list.visibleMinY, place, accuracy: 0.5, "the reader stays where they were")
        assertIndicator(list, insets, "keyboard dismissed")
        await controller.signOut()
    }
}
#endif

#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
import HappyStore
@testable import HappyUI
import HappyWire
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

/// A message's screen at the person's text size: its plan, made off main
/// at a size, has its text at RN's multiplier, measured where it is drawn;
/// and the screen in a window plans again at a new size, its title with
/// it. Where the reader's place lands is checked on Linux
/// (`MessageDetailReadingPlace`).
@MainActor
final class MessageDetailTextSizeTests: XCTestCase {
    private let categories: [UIContentSizeCategory] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func environment(_ category: UIContentSizeCategory) -> TextEnvironment {
        TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: 3)
    }

    private func multiplier(_ category: UIContentSizeCategory) -> CGFloat {
        TextScale(TextSizeCategory(category)).multiplier
    }

    private func messages() -> [(name: String, message: ChatMessage)] {
        func tool(_ id: String, _ name: String, _ input: [String: JSONValue], state: ToolCall.State = .completed, result: JSONValue? = nil) -> ChatMessage {
            .toolCall(ToolCallMessage(id: id, createdAt: 0, tool: ToolCall(name: name, state: state, input: .object(input), createdAt: 0, result: result)))
        }
        let long = (0..<40).map { "Paragraph \($0) of a long answer, with **bold** and `code`, wrapping onto more than one line." }.joined(separator: "\n\n")
        return [
            ("agent", .agentText(AgentTextMessage(id: "a1", createdAt: 0, text: long))),
            ("user", .userText(UserTextMessage(id: "u1", createdAt: 0, text: "Why does the build fail on the simulator?"))),
            ("bash", tool("t1", "Bash", ["command": .string("swift build")], result: .string("Compiling\nBuild complete"))),
            ("edit", tool("t2", "Edit", ["file_path": .string("Sources/App.swift"), "old_string": .string("let a = 1"), "new_string": .string("let a = 2")])),
            ("multiEdit", tool("t3", "MultiEdit", [
                "file_path": .string("Sources/App.swift"),
                "edits": .array([
                    .object(["old_string": .string("let a = 1"), "new_string": .string("let a = 2")]),
                    .object(["old_string": .string("let b = 1"), "new_string": .string("let b = 2"), "replace_all": .bool(true)]),
                ]),
            ])),
            ("error", tool("t4", "Bash", ["command": .string("make")], state: .error, result: .string("make: *** No rule to make target"))),
            ("generic", tool("t5", "SomeTool", ["query": .string("dynamic type")], result: .string("Found 3 results"))),
        ]
    }

    private func plan(_ message: ChatMessage, text: ChatRowText) -> ChatRowPlan {
        let input = MessageDetailInput(
            message: message, root: nil, showLineNumbers: false, devMode: true,
            diffExpanded: [:], maxContentWidth: .greatestFiniteMagnitude, focusFile: nil, text: text, render: .isolated()
        )
        return MessageDetailRenderer.plan(input, width: 393)
    }

    private func texts(_ plan: ChatRowPlan) -> [(layout: ChatTextLayout, frame: CGRect)] {
        plan.items.flatMap { item -> [(layout: ChatTextLayout, frame: CGRect)] in
            switch item {
            case .text(let layout, let frame): [(layout, frame)]
            case .scroller(let content, _, _, _): texts(content)
            default: []
            }
        }
    }

    private func diffs(_ plan: ChatRowPlan) -> [TextEnvironment?] {
        plan.items.compactMap { item in
            if case .diff(let chunk, _, _, _, _, _) = item { return chunk.text }
            return nil
        }
    }

    private func fonts(_ string: NSAttributedString) -> [CGFloat] {
        var sizes: [CGFloat] = []
        string.enumerateAttribute(.font, in: NSRange(location: 0, length: string.length)) { value, _, _ in
            if let font = value as? UIFont { sizes.append(font.pointSize) }
        }
        return sizes
    }

    /// The designed size's fonts, its boxes on the screen's pixels: none
    /// taller, none a point shorter.
    func testAtTheDesignedSizeTheScreenIsAsItWasToThePixel() {
        for (name, message) in messages() {
            let before = plan(message, text: .designed)
            let after = plan(message, text: ChatRowText(environment: environment(.large), words: .english))
            XCTAssertEqual(after.size.width, before.size.width, name)
            XCTAssertLessThanOrEqual(after.size.height, before.size.height + 0.001, name)
            XCTAssertEqual(texts(after).count, texts(before).count, name)
            for (text, was) in zip(texts(after), texts(before)) {
                XCTAssertLessThanOrEqual(text.layout.size.height, was.layout.size.height, name)
                XCTAssertGreaterThan(text.layout.size.height, was.layout.size.height - 1, name)
                XCTAssertEqual((text.layout.size.height * 3).rounded(), text.layout.size.height * 3, accuracy: 0.0001, name)
            }
            XCTAssertEqual(texts(after).map { fonts($0.layout.string) }, texts(before).map { fonts($0.layout.string) }, name)
        }
    }

    /// Every text is its designed text at RN's multiplier, drawn in the
    /// frame it was measured for; the diffs are planned at the same size;
    /// a larger size is a taller screen.
    func testEveryTextIsAtTheTextSizeAndFitsWhereItIsDrawn() {
        let designed = messages().map { plan($0.message, text: .designed) }
        for category in categories {
            let scale = multiplier(category)
            let environment = environment(category)
            for (index, (name, message)) in messages().enumerated() {
                let shown = plan(message, text: ChatRowText(environment: environment, words: .english))
                let at = "\(name) at \(category.rawValue)"
                let now = texts(shown)
                let was = texts(designed[index])
                XCTAssertEqual(now.count, was.count, at)
                for (text, before) in zip(now, was) {
                    let words = text.layout.string.string
                    XCTAssertEqual(words, before.layout.string.string, at)
                    let sizes = fonts(text.layout.string)
                    let expected = fonts(before.layout.string).map { $0 * scale }
                    XCTAssertEqual(sizes.count, expected.count, "\(words), \(at)")
                    for (size, expected) in zip(sizes, expected) {
                        XCTAssertEqual(size, expected, accuracy: 0.0001, "\(words), \(at)")
                    }
                    XCTAssertLessThanOrEqual(text.layout.size.height, text.frame.height + 0.001, "\(words), \(at)")
                    XCTAssertLessThanOrEqual(text.layout.size.width, text.frame.width + 0.5, "\(words), \(at)")
                }
                for item in shown.items {
                    guard case .text(_, let frame) = item else { continue }
                    XCTAssertLessThanOrEqual(frame.maxY, shown.size.height + 0.001, at)
                }
                XCTAssertEqual(diffs(shown).count, diffs(designed[index]).count, at)
                XCTAssertTrue(diffs(shown).allSatisfy { $0 == environment }, at)
                if category > .large {
                    XCTAssertGreaterThan(shown.size.height, designed[index].size.height, at)
                }
            }
        }
    }

    /// The words are the input's, title's included.
    func testTheScreenSaysItsWordsInItsLanguage() async {
        let russian = ChatWords(catalog: await TranslationCatalog.load("ru"))
        let generic = messages().first { $0.name == "generic" }!.message
        for words in [ChatWords.english, russian] {
            let strings = texts(plan(generic, text: ChatRowText(environment: nil, words: words))).map { $0.layout.string.string }
            // A style may draw its words in capitals.
            func says(_ word: String) -> Bool { strings.contains(word) || strings.contains(word.uppercased()) }
            XCTAssertTrue(says(words.fullInputParams), "\(strings), \(words.language)")
            XCTAssertTrue(says(words.fullOutput), "\(strings), \(words.language)")
            XCTAssertTrue(says(words.fullRawJson), "\(strings), \(words.language)")
        }
        XCTAssertNotEqual(russian.fullOutput, ChatWords.english.fullOutput)
    }

    // MARK: The screen

    #if DEBUG
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

    private func until(_ seconds: Double = 20, _ condition: () -> Bool) async throws -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    private func find<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
        if let found = view as? View { return found }
        for subview in view.subviews {
            if let found = find(type, in: subview) { return found }
        }
        return nil
    }

    private func shownFonts(_ canvas: MessageDetailCanvas) -> [CGFloat] {
        canvas.plan.map { texts($0).flatMap { fonts($0.layout.string) } } ?? []
    }

    /// A fixture answer's screen in a window: the whole screen follows the
    /// text size, and a new size plans it again there, the title with it.
    func testANewTextSizePlansTheScreenAgain() async throws {
        let sessionId = FixtureScenarios.prefix + FixtureScenario.markdown.rawValue
        let answer = try XCTUnwrap(FixtureScenarios.messages(.markdown, sessionId: sessionId).first {
            if case .agentText(let message) = $0 { return !message.isThinking }
            return false
        })
        let account = try await signedIn()
        let session = try XCTUnwrap(account.session)
        let context = AppContext(account: account, variant: .development, version: "test")
        let screen = MessageDetailViewController(context: context, session: session, sessionId: sessionId, messageId: answer.id)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.traitOverrides.preferredContentSizeCategory = .large
        window.traitOverrides.displayScale = 3
        window.rootViewController = UINavigationController(rootViewController: screen)
        window.isHidden = false
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        XCTAssertEqual(screen.view.traitCollection.textEnvironment, environment(.large))
        let canvas = try XCTUnwrap(find(MessageDetailCanvas.self, in: screen.view))
        let title = try XCTUnwrap(screen.navigationItem.titleView as? NavigationTitleView)
        XCTAssertEqual(title.title, ChatWords.english.message)

        let shown = try await until { canvas.plan?.id == answer.id }
        XCTAssertTrue(shown, "the answer was never shown")
        let designed = shownFonts(canvas)
        let smallest = try XCTUnwrap(designed.min())
        let height = canvas.frame.height
        let category = UIContentSizeCategory.accessibilityExtraExtraExtraLarge
        let scale = multiplier(category)
        XCTAssertGreaterThan(smallest * scale, try XCTUnwrap(designed.max()))

        window.traitOverrides.preferredContentSizeCategory = category
        window.updateTraitsIfNeeded()
        let replanned = try await until {
            let fonts = self.shownFonts(canvas)
            return !fonts.isEmpty && fonts.allSatisfy { $0 >= smallest * scale - 0.001 }
        }
        XCTAssertTrue(replanned, "the screen is at the new size: \(shownFonts(canvas))")
        XCTAssertGreaterThan(canvas.frame.height, height)
        let scroll = try XCTUnwrap(find(UIScrollView.self, in: screen.view))
        XCTAssertEqual(scroll.contentSize, canvas.frame.size)
        // The bar holds its title view's own size to XXL; the screen hands
        // it its own.
        XCTAssertEqual(title.titleLabel.renderedStyle.size, TextStyles.headerTitle.scaled(TextScale(TextSizeCategory(category))).size, accuracy: 0.0001,
                       "the title at \(title.traitCollection.preferredContentSizeCategory.rawValue), the screen at \(screen.traitCollection.preferredContentSizeCategory.rawValue)")
        await account.signOut()
    }
    #endif
}
#endif

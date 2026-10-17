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

/// The chat's rows at the person's text size: every kind of row planned
/// off main at a size, its text at RN's multiplier and measured where it
/// is drawn, its glyphs and paddings as designed; the cell drawing the
/// plan as planned under traits at that size; the placeholder made again
/// at a new size; and the chat screen itself planning its rows again when
/// the size changes. The layouts' numbers are checked on Linux
/// (ChatTextSizeLayoutTests); these need TextKit and UIKit.
@MainActor
final class ChatRowsTextSizeTests: XCTestCase {
    private let categories: [UIContentSizeCategory] = [
        .extraSmall, .large, .extraExtraExtraLarge, .accessibilityMedium, .accessibilityExtraExtraExtraLarge,
    ]
    private let width: CGFloat = 393

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func environment(_ category: UIContentSizeCategory, scale: CGFloat = 3) -> TextEnvironment {
        TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: scale)
    }

    private func text(_ category: UIContentSizeCategory, scale: CGFloat = 3) -> ChatRowText {
        ChatRowText(environment: environment(category, scale: scale), words: .english)
    }

    private func multiplier(_ category: UIContentSizeCategory) -> CGFloat {
        TextScale(TextSizeCategory(category)).multiplier
    }

    // MARK: Rows

    private static let markdown = """
        # A heading

        Some **bold**, some *italic* and `inline code`, in a paragraph long enough to wrap at every width.

        - one
        - two

        ```swift
        let answer = 42
        ```

        | Name | Value |
        |------|-------|
        | a    | 1     |
        """

    private func json(_ object: [String: JSONValue]) -> JSONValue { .object(object) }

    /// A row of every kind the chat draws text in.
    private func rows(_ text: ChatRowText) -> [(name: String, input: ChatRowInput)] {
        var style = ChatRowStyle(render: .isolated())
        style.text = text
        var compact = style
        compact.compactTools = true
        func row(_ name: String, _ message: ChatMessage, style: ChatRowStyle = style, _ change: (inout ChatRowInput) -> Void = { _ in }) -> (String, ChatRowInput) {
            var input = ChatRowInput(item: .message(message), style: style)
            change(&input)
            return (name, input)
        }
        func tool(_ id: String, _ call: ToolCall) -> ChatMessage {
            .toolCall(ToolCallMessage(id: id, createdAt: 0, tool: call))
        }
        let bash = ToolCall(name: "Bash", state: .running, input: json(["command": .string("ls -la")]), createdAt: 0, startedAt: 0)
        let done = ToolCall(name: "Bash", state: .completed, input: json(["command": .string("swift build")]), createdAt: 0, startedAt: 0, completedAt: 3000, result: .string("Build complete"))
        let edit = ToolCall(
            name: "Edit", state: .completed,
            input: json(["file_path": .string("Sources/App.swift"), "old_string": .string("let a = 1"), "new_string": .string("let a = 2")]),
            createdAt: 0
        )
        let asking = ToolCall(
            name: "Bash", state: .running, input: json(["command": .string("rm -rf build")]), createdAt: 0,
            permission: ToolPermission(id: "p1", status: .pending)
        )
        let question = ToolCall(
            name: "AskUserQuestion", state: .running,
            input: json(["questions": .array([json([
                "question": .string("Which build should run first?"),
                "header": .string("Build"),
                "options": .array([
                    json(["label": .string("Debug"), "description": .string("Faster, with assertions")]),
                    json(["label": .string("Release")]),
                ]),
            ])])]),
            createdAt: 0
        )
        let todos = ToolCall(
            name: "TodoWrite", state: .completed,
            input: json(["todos": .array([
                json(["content": .string("Port the rows"), "status": .string("completed")]),
                json(["content": .string("Write the tests"), "status": .string("in_progress")]),
            ])]),
            createdAt: 0
        )
        let group = ChatWorkGroup(id: "g1", turnUserMessageId: nil, messages: [tool("g1-t", done)], startedAt: 0, completedAt: 12_000)
        return [
            row("user", .userText(UserTextMessage(id: "u1", createdAt: 0, text: "Could you look at why the build fails on the simulator but not on a device?"))),
            row("sending", .userText(UserTextMessage(id: "u2", createdAt: 0, text: "And then run the tests"))) {
                $0.userStatus = UserMessageStatus(line: .sending, dimmed: true)
            },
            row("markdown", .agentText(AgentTextMessage(id: "a1", createdAt: 0, text: Self.markdown))),
            row("event", .agentEvent(AgentEventMessage(id: "e1", createdAt: 0, event: .modeSwitch(mode: "plan")))),
            row("running", tool("t1", bash)),
            row("completed", tool("t2", done)) { $0.expanded = true },
            row("compact", tool("t3", done), style: compact),
            row("edit", tool("t4", edit)) { $0.expanded = true },
            row("permission", tool("t5", asking)),
            row("question", tool("t6", question)) { input in
                input.question = InlineQuestionForm.askUserQuestion(question).map { ChatQuestionState(form: $0) }
            },
            row("todos", tool("t7", todos)),
            ("work", ChatRowInput(item: .workHeader(group, placement: .leading), style: style)),
        ]
    }

    // MARK: What a plan draws

    private struct Drawn {
        var texts: [(layout: ChatTextLayout, frame: CGRect)] = []
        var icons: [CGSize] = []
        var elapsed: [(frame: CGRect, text: TextEnvironment?)] = []
        var diffs: [TextEnvironment?] = []
        var headerNames: [NSAttributedString] = []
    }

    /// Everything `plan` draws, sideways strips' content included.
    private func drawn(_ plan: ChatRowPlan) -> Drawn {
        var drawn = Drawn()
        func walk(_ plan: ChatRowPlan) {
            for item in plan.items {
                switch item {
                case .text(let layout, let frame): drawn.texts.append((layout, frame))
                case .icon(_, _, let frame, _): drawn.icons.append(frame.size)
                case .elapsed(_, let frame, let text): drawn.elapsed.append((frame, text))
                case .diff(let chunk, _, _, _, _, _): drawn.diffs.append(chunk.text)
                case .diffHeader(let header, _, _): drawn.headerNames.append(header.fileName)
                case .scroller(let content, _, _, _): walk(content)
                default: break
                }
            }
        }
        walk(plan)
        return drawn
    }

    private func fonts(_ string: NSAttributedString) -> [UIFont] {
        var fonts: [UIFont] = []
        string.enumerateAttribute(.font, in: NSRange(location: 0, length: string.length)) { value, _, _ in
            if let font = value as? UIFont { fonts.append(font) }
        }
        return fonts
    }

    // MARK: Plans

    /// RN's multiplier at the designed size is 1: planned in an
    /// environment there, every row has the fonts and glyphs it had without
    /// one. Its text boxes end on the screen's pixels, not the next point,
    /// so no box is taller and none is a point shorter.
    func testAtTheDesignedSizeEveryRowIsAsItWasToThePixel() {
        for scale: CGFloat in [2, 3] {
            for (designed, large) in zip(rows(.designed), rows(text(.large, scale: scale))) {
                let before = ChatRowRenderer.plan(designed.input, width: width)
                let after = ChatRowRenderer.plan(large.input, width: width)
                let at = "\(large.name) @\(scale)x"
                XCTAssertEqual(after.size.width, before.size.width, at)
                XCTAssertLessThanOrEqual(after.size.height, before.size.height + 0.001, at)
                let was = drawn(before)
                let now = drawn(after)
                XCTAssertEqual(now.texts.count, was.texts.count, at)
                for (text, before) in zip(now.texts, was.texts) {
                    XCTAssertLessThanOrEqual(text.layout.size.height, before.layout.size.height, at)
                    XCTAssertGreaterThan(text.layout.size.height, before.layout.size.height - 1, at)
                }
                XCTAssertEqual(now.texts.map { fonts($0.layout.string) }, was.texts.map { fonts($0.layout.string) }, at)
                XCTAssertEqual(now.icons, was.icons, at)
            }
        }
        let footer = ChatRowRenderer.footer(controlledByUser: true, width: width, in: environment(.large))
        XCTAssertEqual(footer.size.width, ChatRowRenderer.footer(controlledByUser: true, width: width, in: nil).size.width)
    }

    /// Every text box ends on its screen's next pixel, as RN ceils a Text's
    /// box: within a pixel of TextKit's own, where whole points would add
    /// up to a point.
    func testEveryTextBoxEndsOnTheScreensPixels() {
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            for scale: CGFloat in [2, 3] {
                for row in rows(text(category, scale: scale)) {
                    let at = "\(row.name) at \(category.rawValue) @\(scale)x"
                    for text in drawn(ChatRowRenderer.plan(row.input, width: width)).texts {
                        let size = text.layout.size
                        XCTAssertEqual((size.height * scale).rounded(), size.height * scale, accuracy: 0.0001, at)
                        XCTAssertEqual((size.width * scale).rounded(), size.width * scale, accuracy: 0.0001, at)
                        // The same text with no screen is rounded to points.
                        let points = NSMutableAttributedString(attributedString: text.layout.string)
                        points.removeAttribute(.chatDisplayScale, range: NSRange(location: 0, length: points.length))
                        let whole = ChatTextLayout(points, width: text.layout.width, maxLines: text.layout.maxLines).size
                        XCTAssertEqual(whole.height, whole.height.rounded(), at)
                        XCTAssertLessThanOrEqual(size.height, whole.height, at)
                        XCTAssertGreaterThan(size.height, whole.height - 1, at)
                    }
                }
            }
        }
    }

    /// At every size, every row's text is its designed text at RN's
    /// multiplier, unrounded and uncapped, and is drawn in the frame it was
    /// measured for, all of it inside the row; the glyphs keep their size.
    /// The status line keeps RN's 14 at every size.
    func testEveryRowsTextIsAtTheTextSizeAndFitsWhereItIsDrawn() {
        let designed = rows(.designed).map { (drawn(ChatRowRenderer.plan($0.input, width: width)), ChatRowRenderer.plan($0.input, width: width).size) }
        for category in categories {
            let scale = multiplier(category)
            let environment = environment(category)
            for (index, row) in rows(text(category)).enumerated() {
                let plan = ChatRowRenderer.plan(row.input, width: width)
                let now = drawn(plan)
                let was = designed[index].0
                let at = "\(row.name) at \(category.rawValue)"
                XCTAssertEqual(now.texts.count, was.texts.count, at)
                for (text, before) in zip(now.texts, was.texts) {
                    let words = text.layout.string.string
                    XCTAssertEqual(words, before.layout.string.string, at)
                    let sizes = fonts(text.layout.string).map(\.pointSize)
                    let expected = fonts(before.layout.string).map { $0.pointSize * scale }
                    XCTAssertEqual(sizes.count, expected.count, "\(words), \(at)")
                    for (size, expected) in zip(sizes, expected) {
                        XCTAssertEqual(size, expected, accuracy: 0.0001, "\(words), \(at)")
                    }
                    XCTAssertEqual(fonts(text.layout.string).map(\.familyName), fonts(before.layout.string).map(\.familyName), "\(words), \(at)")
                    if words == ChatWords.english.sending {
                        XCTAssertEqual(text.frame.height, 14, at)
                        continue
                    }
                    XCTAssertLessThanOrEqual(text.layout.size.height, text.frame.height + 0.001, "\(words), \(at)")
                    XCTAssertLessThanOrEqual(text.layout.size.width, text.frame.width + 0.5, "\(words), \(at)")
                }
                for item in plan.items {
                    guard case .text(_, let frame) = item else { continue }
                    XCTAssertLessThanOrEqual(frame.maxY, plan.size.height + 0.001, at)
                    XCTAssertLessThanOrEqual(frame.maxX, width + 0.001, at)
                }
                XCTAssertEqual(now.icons, was.icons, "the glyphs keep their size, \(at)")
                XCTAssertEqual(now.elapsed.count, was.elapsed.count, at)
                for elapsed in now.elapsed {
                    XCTAssertEqual(elapsed.text, environment, at)
                    XCTAssertEqual(elapsed.frame.size, ChatRowRenderer.elapsedSize(in: environment), at)
                }
                XCTAssertEqual(now.diffs.count, was.diffs.count, at)
                XCTAssertTrue(now.diffs.allSatisfy { $0 == environment }, "the diffs are planned at the rows' size, \(at)")
                for (name, before) in zip(now.headerNames, was.headerNames) {
                    XCTAssertEqual(fonts(name).first?.pointSize ?? 0, (fonts(before).first?.pointSize ?? 0) * scale, accuracy: 0.0001, at)
                }
                // Taller text grows a row past its minimum: not at every size
                // (the todos row holds its 64 at XXXL), but by the largest.
                if category > .large, !now.texts.isEmpty {
                    XCTAssertGreaterThanOrEqual(plan.size.height, designed[index].1.height, "\(at) grows")
                }
                if category == .accessibilityExtraExtraExtraLarge, !now.texts.isEmpty {
                    XCTAssertGreaterThan(plan.size.height, designed[index].1.height, "\(at) grows")
                }
            }
        }
    }

    /// A larger size is never a shorter row.
    func testTheRowsGrowWithTheTextSize() {
        let ordered: [UIContentSizeCategory] = [
            .extraSmall, .small, .medium, .large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge,
            .accessibilityMedium, .accessibilityLarge, .accessibilityExtraLarge, .accessibilityExtraExtraLarge, .accessibilityExtraExtraExtraLarge,
        ]
        let heights = ordered.map { category in rows(text(category)).map { ChatRowRenderer.plan($0.input, width: width).size.height } }
        let names = rows(.designed).map(\.name)
        for (smaller, larger) in zip(heights, heights.dropFirst()) {
            for (index, name) in names.enumerated() {
                XCTAssertLessThanOrEqual(smaller[index], larger[index], name)
            }
        }
        let footers = ordered.map { ChatRowRenderer.footer(controlledByUser: true, width: width, in: environment($0)).size.height }
        XCTAssertEqual(footers, footers.sorted())
        XCTAssertGreaterThan(footers.last ?? 0, footers[3])
    }

    // MARK: Cells

    /// The cell draws the plan as planned under traits at its size: each
    /// text where it was measured (on the screen's pixels), the timer at
    /// the row's font in the room measured for it.
    func testTheCellDrawsItsPlanAsPlanned() throws {
        for category in [UIContentSizeCategory.large, .accessibilityMedium, .accessibilityExtraExtraExtraLarge] {
            let environment = environment(category)
            for row in rows(text(category)) {
                let plan = ChatRowRenderer.plan(row.input, width: width)
                let cell = ChatRowCell(frame: CGRect(origin: .zero, size: plan.size))
                // As the list's traits are.
                cell.traitOverrides.followsTextSize = true
                cell.traitOverrides.preferredContentSizeCategory = category
                cell.traitOverrides.displayScale = 3
                cell.updateTraitsIfNeeded()
                cell.apply(plan)
                cell.layoutIfNeeded()
                let at = "\(row.name) at \(category.rawValue)"
                let canvas = try XCTUnwrap(cell.contentView.subviews.first as? ChatPlanView, at)
                XCTAssertEqual(canvas.frame.size, plan.size, at)
                let shown = canvas.subviews.filter { !$0.isHidden }
                let texts = shown.compactMap { $0 as? ChatTextView }
                let planned: [(ChatTextLayout, CGRect)] = plan.items.compactMap {
                    if case .text(let layout, let frame) = $0 { return (layout, frame) }
                    return nil
                }
                XCTAssertEqual(texts.count, planned.count, at)
                for (view, (layout, frame)) in zip(texts, planned) {
                    XCTAssertTrue(view.layout === layout, at)
                    assertSameFrame(view.frame, PixelGrid.snap(frame, scale: 3), at)
                }
                for label in shown.compactMap({ $0 as? ChatElapsedLabel }) {
                    XCTAssertEqual(label.environment, environment, at)
                    XCTAssertEqual(label.font, ChatTextStyles.toolElapsed.font(in: environment), at)
                    XCTAssertFalse(label.adjustsFontForContentSizeCategory, at)
                    label.text = "000.0s"
                    let size = label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
                    XCTAssertEqual(size.width, label.frame.width, accuracy: 1, at)
                    label.since = nil
                }
            }
        }
    }

    // MARK: The placeholder

    private func placeholderFonts(_ view: ChatPlaceholderView) -> [CGFloat] {
        view.subviews.compactMap { $0 as? ChatTextView }.filter { !$0.isHidden }.flatMap { view in
            view.layout.map { fonts($0.string).map(\.pointSize) } ?? []
        }
    }

    /// Lays the placeholder out and waits for the plan it asks for, made
    /// off the main thread.
    private func measured(_ placeholder: ChatPlaceholderView) async {
        placeholder.updateTraitsIfNeeded()
        placeholder.layoutIfNeeded()
        await placeholder.measure.measured()
        placeholder.layoutIfNeeded()
    }

    /// EmptyMessages is measured off main at its traits' size, and again
    /// when they change, without being shown again.
    func testThePlaceholderIsMadeAgainAtANewSize() async {
        let placeholder = ChatPlaceholderView(frame: CGRect(x: 0, y: 0, width: 393, height: 700))
        placeholder.traitOverrides.followsTextSize = true
        placeholder.traitOverrides.preferredContentSizeCategory = .large
        placeholder.traitOverrides.displayScale = 3
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.addSubview(placeholder)
        window.isHidden = false
        defer { window.isHidden = true }
        placeholder.updateTraitsIfNeeded()
        let state = ChatEmptyState(metadata: .object(["host": .string("mac"), "path": .string("/p")]), createdAt: 0, now: 60_000)
        placeholder.show(.empty(state, .noMessages))
        await measured(placeholder)
        let designed = placeholderFonts(placeholder)
        // The host, the path, "No messages yet" and the date.
        XCTAssertEqual(designed, [18, 14, 20, 16])

        placeholder.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        await measured(placeholder)
        let scale = multiplier(.accessibilityExtraExtraExtraLarge)
        let grown = placeholderFonts(placeholder)
        XCTAssertEqual(grown.count, designed.count)
        for (size, before) in zip(grown, designed) {
            XCTAssertEqual(size, before * scale, accuracy: 0.0001)
        }
        for view in placeholder.subviews.compactMap({ $0 as? ChatTextView }) where !view.isHidden {
            guard let layout = view.layout else { continue }
            XCTAssertLessThanOrEqual(layout.size.height, view.frame.height + 0.5, layout.string.string)
            // Ceiled to the screen's pixels.
            XCTAssertEqual((layout.size.height * 3).rounded(), layout.size.height * 3, accuracy: 0.0001)
        }
        XCTAssertEqual(placeholder.content, .empty(state, .noMessages))

        // Without the trait, the designed size.
        placeholder.traitOverrides.followsTextSize = false
        await measured(placeholder)
        XCTAssertEqual(placeholderFonts(placeholder), designed)
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

    private func cells(_ list: ChatListView) -> [ChatRowCell] {
        list.collectionView.visibleCells.compactMap { $0 as? ChatRowCell }.filter { $0.plan != nil }
    }

    /// Every font the cells on screen draw.
    private func shownFonts(_ list: ChatListView) -> [CGFloat] {
        cells(list).flatMap { cell in
            cell.plan.map { drawn($0).texts.flatMap { fonts($0.layout.string).map(\.pointSize) } } ?? []
        }
    }

    /// The fixture chat in a window: only its list follows the text size,
    /// and a new size plans every row on screen again at it, each cell as
    /// tall as its new plan.
    func testANewTextSizePlansTheChatsRowsAgain() async throws {
        let account = try await signedIn()
        let session = try XCTUnwrap(account.session)
        let context = AppContext(account: account, variant: .development, version: "test")
        let chat = ChatViewController(context: context, session: session, sessionId: FixtureScenarios.prefix + FixtureScenario.markdown.rawValue)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.traitOverrides.preferredContentSizeCategory = .large
        window.traitOverrides.displayScale = 3
        window.rootViewController = UINavigationController(rootViewController: chat)
        window.isHidden = false
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        let constructed = try await until { chat.contentInstalled }
        XCTAssertTrue(constructed)
        let list = try XCTUnwrap(find(ChatListView.self, in: chat.view))
        XCTAssertEqual(list.traitCollection.textEnvironment, environment(.large))
        XCTAssertNil(chat.view.traitCollection.textEnvironment, "the rest of the screen keeps its own size")

        let shown = try await until { !self.cells(list).isEmpty }
        XCTAssertTrue(shown, "no rows")
        let designed = shownFonts(list)
        let smallest = try XCTUnwrap(designed.min())
        let scale = multiplier(.accessibilityExtraExtraExtraLarge)
        XCTAssertGreaterThan(smallest * scale, try XCTUnwrap(designed.max()), "a font left at the designed size is told apart")

        window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        window.updateTraitsIfNeeded()
        XCTAssertEqual(list.traitCollection.textEnvironment, environment(.accessibilityExtraExtraExtraLarge))
        let replanned = try await until {
            let fonts = self.shownFonts(list)
            return !fonts.isEmpty && fonts.allSatisfy { $0 >= smallest * scale - 0.001 }
        }
        XCTAssertTrue(replanned, "the rows on screen are at the new size: \(shownFonts(list))")
        list.layoutIfNeeded()
        for cell in cells(list) {
            let plan = try XCTUnwrap(cell.plan)
            XCTAssertEqual(cell.bounds.height, plan.size.height, accuracy: 0.5, plan.id)
        }
        await account.signOut()
    }
    #endif
}
#endif

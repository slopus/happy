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

/// The chat's header, the CLI warning and the bars over the composer at the
/// person's text size: each planned off main at a size, its text at RN's
/// multiplier, laid out for the frame it is drawn in and on the screen's
/// pixels; the views drawing their plans, with no height until one is in;
/// the capsule keeping its 44 and cutting what spills; and the fixture
/// chat laying its dock out again at a new size. The layouts' numbers are
/// checked on Linux (ChatChromeTextSizeLayoutTests); these need TextKit.
@MainActor
final class ChatChromeTextSizeTests: XCTestCase {
    private let categories: [UIContentSizeCategory] = [
        .extraSmall, .large, .extraExtraExtraLarge, .accessibilityMedium, .accessibilityExtraExtraExtraLarge,
    ]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func environment(_ category: UIContentSizeCategory) -> TextEnvironment {
        TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: 3)
    }

    private func offMain<Result: Sendable>(_ work: @escaping @Sendable () -> Result) async -> Result {
        await Task.detached { work() }.value
    }

    private func fonts(_ layout: ChatTextLayout) -> [UIFont] {
        var fonts: [UIFont] = []
        layout.string.enumerateAttribute(.font, in: NSRange(location: 0, length: layout.string.length)) { value, _, _ in
            if let font = value as? UIFont { fonts.append(font) }
        }
        return fonts
    }

    /// `layout` drawn in `frame`: in `style` at the text size, as tall as
    /// the frame, no wider, where the frame is (laid out at its width or
    /// starting at its left), on a 3x screen's pixels.
    private func assertDrawn(
        _ layout: ChatTextLayout?, in frame: CGRect?, _ style: ChatTextStyle, _ category: UIContentSizeCategory,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        guard let layout, let frame else { return XCTFail("nothing drawn", file: file, line: line) }
        let size = style.scaled(TextScale(TextSizeCategory(category))).size
        XCTAssertFalse(fonts(layout).isEmpty, file: file, line: line)
        for font in fonts(layout) {
            XCTAssertEqual(font.pointSize, size, accuracy: 0.001, "\(layout.string.string)", file: file, line: line)
        }
        XCTAssertEqual(layout.size.height, frame.height, accuracy: 0.001, "\(layout.string.string)", file: file, line: line)
        XCTAssertLessThanOrEqual(layout.size.width, frame.width + 0.001, "\(layout.string.string)", file: file, line: line)
        // Laid out at the frame's own width, or starting at its left.
        XCTAssertTrue(abs(layout.width - frame.width) < 0.001 || layout.leading < 0.5, "\(layout.string.string) sits in its frame", file: file, line: line)
        let pixels = layout.size.height * 3
        XCTAssertEqual(pixels, pixels.rounded(), accuracy: 0.001, "\(layout.string.string) ends on a pixel", file: file, line: line)
    }

    // MARK: Plans

    private let hint = ChatInactiveHintModel(notice: "This session is inactive.", terminalNotice: nil, action: .resume("Resume Session"))
    private let commands = ChatInactiveHintModel(
        notice: "This session is inactive.", terminalNotice: "To resume it from the terminal:", action: .command("cd ~/happy\nhappy --resume fixture")
    )
    private let goal = ChatGoalBarModel(label: "Current goal", text: "Ship the native chat screen", actionCount: 3)
    private let banner = ChatQuestionBannerModel(title: "Platform", subtitle: "Which devices should the build support?", dismiss: nil)
    private let unsupported = ChatQuestionBannerModel(title: "Approve the deploy", subtitle: "This build can't answer it.", dismiss: "Dismiss")
    private let rig = ChatRigActivityModel(labels: ["2 agents +1 queued", "1 processes", "4 tasks"])

    func testEveryBarsTextIsAtTheTextSizeAndFitsWhereItIsDrawn() async {
        for category in categories {
            let text = environment(category)
            let (hint, commands, goal, banner, unsupported, rig) = (hint, commands, goal, banner, unsupported, rig)
            let resume = await offMain { ChatDockBarMeasure.inactiveHint(ChatDockBarInput(model: hint, width: 377, text: text)) }
            assertDrawn(resume.notice, in: resume.layout.notice, ChatTextStyles.inactiveHint, category)
            assertDrawn(resume.buttonLabel, in: resume.layout.buttonLabel, ChatTextStyles.resumeButton, category)
            XCTAssertEqual(resume.layout.button?.height, 44, "Resume keeps its 44")
            let block = await offMain { ChatDockBarMeasure.inactiveHint(ChatDockBarInput(model: commands, width: 377, text: text)) }
            assertDrawn(block.terminalNotice, in: block.layout.terminalNotice, ChatTextStyles.inactiveHint, category)
            assertDrawn(block.command, in: block.layout.commandText, ChatTextStyles.resumeCommand, category)
            XCTAssertGreaterThanOrEqual(block.layout.command?.height ?? 0, 48)

            let bar = await offMain { ChatDockBarMeasure.goalBar(ChatDockBarInput(model: goal, width: 377, text: text)) }
            assertDrawn(bar.label, in: bar.layout.label, ChatTextStyles.goalLabel, category)
            assertDrawn(bar.text, in: bar.layout.text, ChatTextStyles.goalText, category)
            XCTAssertEqual(bar.layout.actions.map(\.size), Array(repeating: CGSize(width: 30, height: 30), count: 3))

            for model in [banner, unsupported] {
                let card = await offMain { ChatDockBarMeasure.questionBanner(ChatDockBarInput(model: model, width: 377, text: text)) }
                assertDrawn(card.title, in: card.layout.title, ChatTextStyles.bannerTitle, category)
                assertDrawn(card.subtitle, in: card.layout.subtitle, ChatTextStyles.bannerSubtitle, category)
                XCTAssertEqual(card.layout.icon.size, CGSize(width: 20, height: 20))
                if model.dismiss == nil {
                    XCTAssertNil(card.dismiss)
                    XCTAssertEqual(card.layout.trailing.size, CGSize(width: 18, height: 18))
                } else {
                    assertDrawn(card.dismiss, in: card.layout.trailing, ChatTextStyles.bannerDismiss, category)
                }
            }

            let counts = await offMain { ChatDockBarMeasure.rigActivity(ChatDockBarInput(model: rig, width: 393, text: text)) }
            XCTAssertEqual(counts.labels.count, 3)
            for (layout, frame) in zip(counts.labels, counts.layout.labels) {
                assertDrawn(layout, in: frame, ChatTextStyles.rigActivity, category)
            }
            XCTAssertEqual(counts.layout.icons.map(\.size), Array(repeating: CGSize(width: 12, height: 12), count: 3))
        }
    }

    func testTheBarsGrowWithTheTextSize() async {
        var heights: [[CGFloat]] = []
        for category in categories {
            let text = environment(category)
            let (hint, commands, goal, banner, rig) = (hint, commands, goal, banner, rig)
            heights.append(await offMain {
                [
                    ChatDockBarMeasure.inactiveHint(ChatDockBarInput(model: hint, width: 377, text: text)).layout.size.height,
                    ChatDockBarMeasure.inactiveHint(ChatDockBarInput(model: commands, width: 377, text: text)).layout.size.height,
                    ChatDockBarMeasure.goalBar(ChatDockBarInput(model: goal, width: 377, text: text)).layout.size.height,
                    ChatDockBarMeasure.questionBanner(ChatDockBarInput(model: banner, width: 377, text: text)).layout.size.height,
                    ChatDockBarMeasure.rigActivity(ChatDockBarInput(model: rig, width: 393, text: text)).layout.size.height,
                ]
            })
        }
        for bar in 0..<5 {
            let column = heights.map { $0[bar] }
            // From the default up every bar grows; below it, a minimum (the
            // goal's 30, the rig glyph's 12) may hold it.
            XCTAssertLessThanOrEqual(column[0], column[1], "bar \(bar): \(column)")
            for (smaller, larger) in zip(column.dropFirst(), column.dropFirst(2)) {
                XCTAssertLessThan(smaller, larger, "bar \(bar): \(column)")
            }
        }
    }

    func testTheHeaderAndTheWarningAreAtTheTextSize() async throws {
        let model = ChatHeaderTitleModel(heading: "Fix the login", subtitle: "main", changes: GitLineChanges(approximate: true, insertions: 12, deletions: 3))
        for category in categories {
            let text = environment(category)
            let capsule = await offMain { ChatHeaderMeasure.title(ChatHeaderTitleInput(model: model, width: 245, text: text)) }
            XCTAssertEqual(capsule.layout.size.height, 44, "the capsule keeps its 44")
            assertDrawn(capsule.title, in: capsule.layout.title, ChatTextStyles.headerTitle, category)
            assertDrawn(capsule.subtitle, in: capsule.layout.subtitle, ChatTextStyles.headerSubtitle, category)
            let changes = try XCTUnwrap(capsule.changes)
            assertDrawn(changes.approximate, in: changes.layout.approximate, ChatTextStyle(TextStyles.gitApproximate), category)
            assertDrawn(changes.added, in: changes.layout.added, ChatTextStyle(TextStyles.gitLineCount), category)
            assertDrawn(changes.removed, in: changes.layout.removed, ChatTextStyle(TextStyles.gitLineCount), category)
            XCTAssertEqual(capsule.layout.changes?.size, changes.layout.size)

            let plain = await offMain { ChatHeaderMeasure.plain(ChatPlainHeaderInput(model: model, width: 600, text: text)) }
            let layout = ChatPlainHeaderLayout(
                bar: CGRect(x: 0, y: 0, width: 632, height: 50), size: CGSize(width: 632, height: 50), maxWidth: 800,
                title: .fixed(plain.title.size), subtitle: plain.subtitle.map { .fixed($0.size) }, changes: plain.changes?.layout.size
            )
            assertDrawn(plain.title, in: layout.title, ChatTextStyles.headerTitle, category)
            assertDrawn(plain.subtitle, in: layout.subtitle, ChatTextStyles.headerPlainSubtitle, category)

            let label = await offMain { ChatHeaderMeasure.cliWarning(ChatCliWarningInput(label: "CLI Update Required", width: 393, text: text)) }
            let pill = CliWarningPillLayout(width: 393, top: 103, label: .fixed(label.size))
            assertDrawn(label, in: pill.label, ChatTextStyles.cliWarning, category)
            XCTAssertEqual(pill.icon.size, CGSize(width: 14, height: 14))
        }
        // At AX-XXXL the title and its row are taller than the capsule.
        let text = environment(.accessibilityExtraExtraExtraLarge)
        let largest = await offMain { ChatHeaderMeasure.title(ChatHeaderTitleInput(model: model, width: 245, text: text)) }
        XCTAssertLessThan(largest.layout.title.minY, 0)
    }

    /// Centred text measured at a wider width sits in its middle; drawn in
    /// a frame hugging it, it is laid out again at the frame's width. Text
    /// set from the left keeps the wider layout.
    func testCentredTextHuggingItsFrameIsLaidOutAtItsOwnWidth() {
        let centred = MeasuredText(ChatTextStyles.emptyTitle.string("No messages yet", color: Palette.text, alignment: .center, in: environment(.large)))
        let wide = centred.layout(width: 300)
        XCTAssertGreaterThan(wide.leading, 10)
        let hugging = centred.layout(for: CGRect(origin: .zero, size: wide.size))
        XCTAssertEqual(hugging.width, wide.size.width)
        XCTAssertLessThan(hugging.leading, 0.5)
        XCTAssertEqual(hugging.size, wide.size)

        let left = MeasuredText(ChatTextStyles.emptyTitle.string("No messages yet", color: Palette.text, in: environment(.large)))
        let measured = left.layout(width: 300)
        XCTAssertEqual(measured.leading, 0)
        XCTAssertIdentical(left.layout(for: CGRect(origin: .zero, size: measured.size)), measured)
    }

    // MARK: Views

    private func traits(_ view: UIView, _ category: UIContentSizeCategory) {
        view.traitOverrides.preferredContentSizeCategory = category
        view.traitOverrides.displayScale = 3
        view.traitOverrides.followsTextSize = true
        view.updateTraitsIfNeeded()
    }

    /// The fixture chat that has a goal and RigActivityBar's counts.
    private var live: SessionRecord {
        FixtureScenarios.record(sessionId: FixtureScenarios.prefix + FixtureScenario.live.rawValue)
    }

    /// A bar has no height until its plan is in, then its plan's; it draws
    /// the plan's text where the plan puts it; gone, it forgets the plan.
    func testABarTakesItsPlansHeightOnceItIsIn() async throws {
        let bar = ChatGoalBarView()
        traits(bar, .accessibilityMedium)
        var asked = 0
        bar.onNeedsLayout = { asked += 1 }
        let goal = try XCTUnwrap(VisibleAgentGoal(live))
        bar.show(goal, inFlight: nil)
        XCTAssertEqual(bar.barMeasurable.height(fitting: 377), 0, "nothing until its plan is in")
        await bar.measure.measured()
        XCTAssertGreaterThanOrEqual(asked, 1, "the dock is told")
        let plan = try XCTUnwrap(bar.measure.plan)
        XCTAssertEqual(bar.measure.applied?.input.text, environment(.accessibilityMedium))
        XCTAssertEqual(bar.barMeasurable.height(fitting: 377), plan.layout.size.height)
        XCTAssertGreaterThan(plan.layout.size.height, 65, "taller than at the designed size")

        bar.frame = CGRect(origin: .zero, size: plan.layout.size)
        bar.layoutIfNeeded()
        let texts = bar.subviews.compactMap { $0 as? ChatTextView }.filter { !$0.isHidden }
        XCTAssertEqual(texts.count, 2)
        let label = try XCTUnwrap(texts.first { $0.layout === plan.label })
        let text = try XCTUnwrap(texts.first { $0.layout === plan.text })
        assertSameFrame(label.frame, PixelGrid.snap(plan.layout.label, scale: 3))
        assertSameFrame(text.frame, PixelGrid.snap(plan.layout.text, scale: 3))

        bar.isHidden = true
        XCTAssertNil(bar.measure.plan)
        bar.isHidden = false
        XCTAssertEqual(bar.barMeasurable.height(fitting: 377), 0, "a bar that comes back shows nothing old")
        await bar.measure.measured()
        XCTAssertEqual(bar.barMeasurable.height(fitting: 377), plan.layout.size.height)
    }

    func testAnotherSizeMeasuresTheBarAgain() async throws {
        let dock = UIView(frame: CGRect(x: 0, y: 0, width: 393, height: 200))
        let bar = ChatRigActivityView()
        dock.addSubview(bar)
        traits(bar, .large)
        bar.show(RigActivityIndicator.indicators(live.metadata))
        _ = bar.barMeasurable.height(fitting: 393)
        await bar.measure.measured()
        let designed = try XCTUnwrap(bar.measure.plan).layout.size.height
        dock.layoutIfNeeded()
        traits(bar, .accessibilityExtraExtraExtraLarge)
        XCTAssertTrue(dock.layer.needsLayout(), "a new size lays the dock out again")
        _ = bar.barMeasurable.height(fitting: 393)
        await bar.measure.measured()
        XCTAssertGreaterThan(try XCTUnwrap(bar.measure.plan).layout.size.height, designed)
        XCTAssertEqual(bar.measure.applied?.input.text, environment(.accessibilityExtraExtraExtraLarge))
    }

    /// The capsule asks the bar for its plan's size, keeps its 44, and
    /// cuts the text that runs past it at AX-XXXL.
    func testTheCapsuleAsksForItsPlannedSizeAndCutsWhatSpills() async throws {
        let title = ChatHeaderTitleView()
        traits(title, .accessibilityExtraExtraExtraLarge)
        title.maxWidth = 245
        title.update(title: "Fix the login", subtitle: "main", changes: SessionDetails.LineChanges(insertions: 12, deletions: 3, approximate: false))
        // A point until its plan is in: the bar never takes a title view
        // that is zero wide when it goes on.
        XCTAssertEqual(title.intrinsicContentSize.width, 1, "nothing until its plan is in")
        await title.measure.measured()
        let plan = try XCTUnwrap(title.measure.plan)
        XCTAssertEqual(title.intrinsicContentSize, plan.layout.size)
        XCTAssertEqual(plan.layout.size.height, 44)
        title.frame = CGRect(origin: .zero, size: plan.layout.size)
        title.layoutIfNeeded()
        let texts = allViews(title).compactMap { $0 as? ChatTextView }.filter { !$0.isHidden && $0.layout != nil }
        let drawn = try XCTUnwrap(texts.first { $0.layout === plan.title })
        XCTAssertLessThan(drawn.frame.minY, 0, "the title runs past the capsule's top")
        let clip = try XCTUnwrap(drawn.superview)
        XCTAssertTrue(clip.clipsToBounds, "and is cut there")
        XCTAssertEqual(clip.bounds.height, 44)
        // Handed less room than it asked for, it is planned again at that.
        title.frame = CGRect(x: 0, y: 0, width: 180, height: 44)
        title.layoutIfNeeded()
        await title.measure.measured()
        XCTAssertEqual(title.measure.applied?.input.width, 180)
        XCTAssertEqual(title.intrinsicContentSize, plan.layout.size, "it still asks for its own size")
    }

    private func allViews(_ view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap(allViews)
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

    /// The fixture chat with a goal and rig counts: its header and bars
    /// follow the text size while the screen itself doesn't, and a new
    /// size measures them again and lays the dock out with their new
    /// heights.
    func testANewTextSizeLaysTheDockOutAgain() async throws {
        let account = try await signedIn()
        let session = try XCTUnwrap(account.session)
        let context = AppContext(account: account, variant: .development, version: "test")
        let chat = ChatViewController(context: context, session: session, sessionId: FixtureScenarios.prefix + FixtureScenario.live.rawValue)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.traitOverrides.preferredContentSizeCategory = .large
        window.traitOverrides.displayScale = 3
        window.rootViewController = UINavigationController(rootViewController: chat)
        window.isHidden = false
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        let constructed = try await until { chat.contentInstalled && chat.navigationItem.titleView != nil }
        XCTAssertTrue(constructed)
        let goal = try XCTUnwrap(find(ChatGoalBarView.self, in: chat.view))
        let rig = try XCTUnwrap(find(ChatRigActivityView.self, in: chat.view))
        let dock = try XCTUnwrap(find(ChatDockView.self, in: chat.view))
        let title = try XCTUnwrap(chat.navigationItem.titleView as? ChatHeaderTitleView)
        XCTAssertNil(chat.view.traitCollection.textEnvironment)
        XCTAssertEqual(goal.traitCollection.textEnvironment, environment(.large))
        XCTAssertEqual(title.text, environment(.large))

        /// What isn't yet at `category`, or nil once all is.
        func unsettled(_ category: UIContentSizeCategory) -> String? {
            chat.view.layoutIfNeeded()
            let text = environment(category)
            var behind: [String] = []
            if goal.measure.applied?.input.text != text { behind.append("goal plan \(String(describing: goal.measure.applied?.input.text))") }
            if rig.measure.applied?.input.text != text { behind.append("rig plan \(String(describing: rig.measure.applied?.input.text))") }
            if title.measure.applied?.input.text != text { behind.append("title plan \(String(describing: title.measure.applied?.input.text))") }
            if let plan = goal.measure.plan, abs(goal.bounds.height - plan.layout.size.height) >= 0.5 {
                behind.append("goal \(goal.bounds.height) of \(plan.layout.size.height)")
            }
            if let plan = rig.measure.plan, abs(rig.bounds.height - plan.layout.size.height) >= 0.5 {
                behind.append("rig \(rig.bounds.height) of \(plan.layout.size.height)")
            }
            return behind.isEmpty ? nil : behind.joined(separator: "; ")
        }
        let shown = try await until { unsettled(.large) == nil }
        XCTAssertTrue(shown, "the bars are in at the default size: \(unsettled(.large) ?? "")")
        let designed = dock.bounds.height

        window.traitOverrides.preferredContentSizeCategory = .accessibilityMedium
        window.updateTraitsIfNeeded()
        let grown = try await until { unsettled(.accessibilityMedium) == nil }
        XCTAssertTrue(grown, "the bars are measured again at the new size: \(unsettled(.accessibilityMedium) ?? "")")
        // The bar holds the title view's own size to XXL; the header is
        // handed the screen's.
        XCTAssertEqual(title.text, environment(.accessibilityMedium), "the screen at \(chat.traitCollection.preferredContentSizeCategory.rawValue)")
        XCTAssertGreaterThan(dock.bounds.height, designed, "and the dock takes their new heights")
        XCTAssertEqual(title.measure.plan?.layout.size.height, 44)
        await account.signOut()
    }
    #endif
}
#endif

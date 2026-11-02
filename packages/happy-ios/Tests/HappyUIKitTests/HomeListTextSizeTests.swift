#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
import HappyStore
@testable import HappyUI
import UIKit
import UltraView
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

/// Home's list at the person's text size: the notices' height worked out
/// off the main thread from one environment, against the header drawing
/// at that size (the rows' plans are `HomeRowPlanTextSizeTests`'s); and
/// the list itself, on
/// UltraList in a window, taking a new size without going blank or moving
/// the row at its top, and refusing any environment or header it did not
/// last ask for.
@MainActor
final class HomeListTextSizeTests: XCTestCase {
    private let categories: [UIContentSizeCategory] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge]
    private let scales: [CGFloat] = [2, 3]
    private let widths: [CGFloat] = [320, 393, 430]

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    /// A flat session at the largest text size on a 3x screen, summed in
    /// `FlatSessionRowLayout.height`'s own order so the two are the same
    /// number: 10 × 2 + the title's 236, the project's 215 and the
    /// workspace's 193 pixels, and the 1 between, or the 18 row without a
    /// workspace.
    static let largestWithWorkspace: CGFloat = largest(workspaceRow: 193.0 / 3)
    static let largestWithoutWorkspace: CGFloat = largest(workspaceRow: 18)
    /// No workspace, but line counts: their 11 × 3.571 at Plex's 1.3 em,
    /// 51.07, is 154 pixels.
    static let largestWithOnlyChanges: CGFloat = largest(workspaceRow: 154.0 / 3)

    private static func largest(workspaceRow: CGFloat) -> CGFloat {
        let padding: CGFloat = 10 * 2
        let title: CGFloat = 236.0 / 3
        let project: CGFloat = 215.0 / 3
        return padding + (title + project + 1 + workspaceRow)
    }

    private func text(_ category: UIContentSizeCategory, _ scale: CGFloat) -> TextEnvironment {
        TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: scale)
    }

    /// A cell's own height, drawn at `category` on a screen of `scale`, as
    /// the list draws it.
    private func height(_ view: UIView, width: CGFloat, scale: CGFloat, category: UIContentSizeCategory) -> CGFloat {
        follow(view, scale: scale, category: category)
        view.frame = CGRect(x: 0, y: 0, width: width, height: 100)
        view.layoutIfNeeded()
        return view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    }

    private func follow(_ view: UIView, scale: CGFloat, category: UIContentSizeCategory) {
        view.traitOverrides.followsTextSize = true
        view.traitOverrides.displayScale = scale
        view.traitOverrides.preferredContentSizeCategory = category
        view.updateTraitsIfNeeded()
    }

    // MARK: Heights against the views

    func testTheNoticesMatchTheHeaderViewAtEveryTextSize() async {
        let cases = [
            HomeBanners(offlineTitle: "All computers are offline"),
            HomeBanners(nativeUpdate: true),
            HomeBanners(whatsNew: true),
            HomeBanners(offlineTitle: "MacBook Pro is offline", whatsNew: true),
            HomeBanners(migration: true),
            HomeBanners(offlineTitle: "MacBook Pro is offline", migration: true, whatsNew: true),
        ]
        for category in categories {
            for scale in scales {
                let environment = await HomeTextEnvironment.make(text(category, scale))
                for width in widths {
                    for banners in cases {
                        let view = HomeListHeaderView()
                        view.content = banners
                        XCTAssertEqual(
                            HomeRowMeasurer.headerHeight(banners, width: width, maxWidth: ContentWidth.maxWidth, environment: environment),
                            height(view, width: width, scale: scale, category: category),
                            "\(banners) at \(width) @\(scale)x, \(category.rawValue)"
                        )
                    }
                }
            }
        }
    }

    /// Made off the main thread from the text size and the screen alone:
    /// the same two make the same value, and its lines are the styles'
    /// lines at that size, each up to the screen's next pixel.
    func testTheEnvironmentIsTheTextSizeAndScreenAlone() async {
        let largest = text(.accessibilityExtraExtraExtraLarge, 3)
        let environment = await HomeTextEnvironment.make(largest)
        let again = await HomeTextEnvironment.make(largest)
        let twoX = await HomeTextEnvironment.make(text(.accessibilityExtraExtraExtraLarge, 2))
        let large = await HomeTextEnvironment.make(text(.large, 3))
        XCTAssertEqual(environment, again)
        XCTAssertNotEqual(environment, twoX)
        XCTAssertNotEqual(environment, large)
        XCTAssertEqual(environment.text, largest)
        // 22, 20 and 18 × 3.571, up to a third: 236, 215 and 193 pixels.
        XCTAssertEqual(environment.rows.sessionLines.title, 236.0 / 3)
        XCTAssertEqual(environment.rows.sessionLines.project, 215.0 / 3)
        XCTAssertEqual(environment.rows.sessionLines.workspace, 193.0 / 3)
        XCTAssertEqual(environment.rows.sessionLines.changes, 154.0 / 3)
        XCTAssertEqual(Self.sessionHeight(workspace: true, changes: false, environment), Self.largestWithWorkspace)
        XCTAssertEqual(Self.sessionHeight(workspace: true, changes: true, environment), Self.largestWithWorkspace)
        XCTAssertEqual(Self.sessionHeight(workspace: false, changes: true, environment), Self.largestWithOnlyChanges)
        // The glyphs and the hairline keep their size.
        XCTAssertEqual(environment.rows.branchIcon, large.rows.branchIcon)
        XCTAssertEqual(environment.rows.machineIcon, large.rows.machineIcon)
        XCTAssertEqual(environment.chevron, large.chevron)
        // The designed lines, but the counts' 14.3, which no style fixes,
        // up to a third.
        let designed = FlatSessionRowLayout.Lines.designed
        XCTAssertEqual(large.rows.sessionLines, .init(title: designed.title, project: designed.project, workspace: designed.workspace, changes: 43.0 / 3))
        let largeTwoX = await HomeTextEnvironment.make(text(.large, 2))
        XCTAssertEqual(largeTwoX.rows.sessionLines.changes, 14.5)
    }

    // MARK: The list

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

    /// The flat list: `count` sessions, the toggle, a day and two archived
    /// rows; every computer offline when `offline`, for the plaque.
    private func model(sessions count: Int, offline: Bool = false) -> HomeListModel {
        var ids: [HomeListRow.ID] = []
        var rows: [HomeListRow] = []
        for index in 0..<count {
            let row = HomeRowMeasurerTests.session("s\(index)", workspace: index.isMultiple(of: 2) ? "fix-login" : nil)
            ids.append(.session(row.id))
            rows.append(.flat(.session(row)))
        }
        ids += [.archiveToggle, .day(0)]
        rows += [.flat(.archiveToggle(hidden: false)), .flat(.dayHeader(.today))]
        for index in 0..<2 {
            var row = HomeRowMeasurerTests.session("a\(index)", workspace: nil)
            row.archived = true
            row.faded = true
            ids.append(.session(row.id))
            rows.append(.flat(.session(row)))
        }
        let machines = offline
            ? [MachineChoice(id: "m", name: "MacBook Pro", machineIds: ["m"], happyMachine: nil, rigMachine: nil, online: false, activeAt: 0)]
            : nil
        return HomeListModel(ids: ids, rows: rows, avatarStyle: .gradient, avatarMonochrome: false, grouped: false, offline: machines)
    }

    @MainActor
    private struct Shown {
        let window: UIWindow
        let list: SessionListViewController
        let rows: UltraListView
        let account: AccountController

        /// The screen's pixels per point, which the list's geometry is
        /// compared on (`assertSamePixel`).
        var scale: CGFloat { window.traitCollection.displayScale }

        /// The row shown for `id`, if the list has one.
        func index(_ id: HomeListRow.ID) -> Int? {
            rows.items.firstIndex { $0.identity == id.ultraIdentity }
        }

        /// Its settled frame on screen, once it is loaded.
        func frame(_ id: HomeListRow.ID) -> CGRect? {
            index(id).flatMap { rows.settledFrame(at: $0) }
        }

        /// The rows the list has, banner aside, each with its planned height.
        var planned: [(identity: String, height: CGFloat)] {
            rows.items.compactMap { $0 as? HomeUltraRow }.filter { $0.identity != "home:banner" }.map { ($0.identity, $0.plan.size.height) }
        }

        /// Where the list is, for a failure's message.
        var geometry: String {
            "loaded \(rows.loadedIndexRange), content \(rows.settledContentHeight), insets \(rows.viewportInsets.top)/\(rows.viewportInsets.bottom)"
        }
    }

    /// The list as home shows it, in a window at `category`, under home's
    /// header and over its dock. Synchronous, so nothing it asked for has
    /// landed when it returns.
    private func show(_ model: HomeListModel, category: UIContentSizeCategory, account: AccountController) throws -> Shown {
        let session = try XCTUnwrap(account.session)
        let context = AppContext(account: account, variant: .development, version: "test")
        let list = SessionListViewController(context: context, session: session)
        // The rows and the offline plaque, without the move to Happy Agent
        // this test account would be offered.
        list.offersMigration = false
        list.apply(model, changeset: RowChangeset(), animated: false)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.traitOverrides.preferredContentSizeCategory = category
        window.traitOverrides.displayScale = 3
        window.rootViewController = list
        window.isHidden = false
        list.contentInsets = HomeContentInsets(safeArea: LayoutInsets(top: 59, bottom: 34), dock: HomeDockLayout.Metrics.contentInset)
        window.updateTraitsIfNeeded()
        list.view.layoutIfNeeded()
        let rows = try XCTUnwrap((list.view as? HomeUltraListView)?.list)
        return Shown(window: window, list: list, rows: rows, account: account)
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    /// Once the environment asked for last is in, the notices measured
    /// with it, and the rows prepared at it and on screen.
    private func landed(_ shown: Shown, _ model: HomeListModel) async throws {
        await shown.list.textEnvironmentTask?.value
        await shown.list.headerTask?.value
        let environment = shown.list.textEnvironment
        let drawn = try await until {
            shown.list.view.layoutIfNeeded()
            return shown.planned.count == model.rows.count && !shown.rows.loadedIndexRange.isEmpty
                && shown.rows.loadedItemViews.allSatisfy(\.isDisplayReady)
        }
        XCTAssertTrue(drawn, "the rows never drew at \(String(describing: environment?.text)): \(shown.geometry)")
    }

    private func change(_ shown: Shown, to category: UIContentSizeCategory) {
        shown.window.traitOverrides.preferredContentSizeCategory = category
        shown.window.updateTraitsIfNeeded()
        shown.list.updateTraitsIfNeeded()
    }

    /// A session's row in a card from `environment`'s lines alone.
    static func sessionHeight(workspace: Bool, changes: Bool, _ environment: HomeTextEnvironment) -> CGFloat {
        FlatSessionRowLayout.height(
            lines: environment.rows.sessionLines,
            workspace: workspace,
            changes: changes,
            branchIcon: environment.rows.branchIcon.height,
            avatarSize: HomeCardLayout.Metrics.sessionAvatar
        )
    }

    /// Each loaded row is as tall as it was planned, and each session's
    /// plan is as tall as its lines at the environment shown.
    private func assertRowsAreTheirPlans(_ shown: Shown, _ model: HomeListModel, _ message: String, line: UInt = #line) throws {
        let environment = try XCTUnwrap(shown.list.textEnvironment, message, line: line)
        XCTAssertFalse(shown.rows.loadedIndexRange.isEmpty, message, line: line)
        for index in shown.rows.loadedIndexRange {
            guard let row = shown.rows.items[index] as? HomeUltraRow, let frame = shown.rows.settledFrame(at: index) else { continue }
            assertSamePixel(frame.height, row.plan.size.height, scale: shown.scale, "\(row.identity), \(message)", line: line)
        }
        for (id, item) in zip(model.ids, model.rows) {
            guard case .flat(.session(let session)) = item,
                  let index = shown.index(id), let row = shown.rows.items[index] as? HomeUltraRow else { continue }
            let expected = Self.sessionHeight(workspace: session.workspaceName != nil, changes: session.changes != nil, environment)
            assertSamePixel(row.plan.size.height, expected, scale: shown.scale,
                            "\(row.identity) against its lines, \(message)", line: line)
        }
    }

    /// The first show waits one hop for its environment, with no rows,
    /// then shows every row at the person's text size.
    func testTheListShowsItsRowsAtTheTextSizeOnceItsEnvironmentIsIn() async throws {
        let model = self.model(sessions: 6)
        let account = try await signedIn()
        let shown = try show(model, category: .accessibilityExtraExtraExtraLarge, account: account)
        defer { shown.window.isHidden = true }
        XCTAssertNil(shown.list.textEnvironment)
        XCTAssertTrue(shown.planned.isEmpty)

        try await landed(shown, model)
        XCTAssertEqual(shown.list.textEnvironment?.text, text(.accessibilityExtraExtraExtraLarge, 3))
        XCTAssertEqual(shown.planned.count, model.rows.count)
        try assertRowsAreTheirPlans(shown, model, "largest")
        assertSamePixel(try XCTUnwrap(shown.frame(model.ids[0])).height, Self.largestWithWorkspace, scale: shown.scale)
        assertSamePixel(try XCTUnwrap(shown.frame(model.ids[1])).height, Self.largestWithoutWorkspace, scale: shown.scale)
        await shown.account.signOut()
    }

    /// A new text size scrolled halfway down: the rows stay on screen
    /// while it is worked out, then take their new heights with the row at
    /// the top of the list where it was.
    func testANewTextSizeKeepsTheRowsAndTheRowAtTheTop() async throws {
        let model = self.model(sessions: 60)
        let account = try await signedIn()
        let shown = try show(model, category: .large, account: account)
        defer { shown.window.isHidden = true }
        try await landed(shown, model)
        // The row at the top: the first one showing below the header,
        // its start 10 under it.
        let anchor = model.ids[20]
        let index = try XCTUnwrap(shown.index(anchor))
        shown.rows.scrollTo(.init(index: index, identity: anchor.ultraIdentity, pointOffset: -10), transition: .none)
        let scrolled = try await until { shown.frame(anchor) != nil }
        XCTAssertTrue(scrolled, shown.geometry)
        let before = try XCTUnwrap(shown.frame(anchor))
        XCTAssertEqual(before.minY, shown.rows.viewportInsets.top - 10, accuracy: 0.5)

        change(shown, to: .accessibilityExtraExtraExtraLarge)
        // Asked for, not in: the rows are where they were.
        XCTAssertEqual(shown.list.textEnvironment?.text, text(.large, 3))
        XCTAssertEqual(shown.planned.count, model.rows.count)
        XCTAssertEqual(shown.frame(anchor), before)

        await shown.list.textEnvironmentTask?.value
        let grown = try await until { (shown.frame(anchor)?.height ?? 0) > before.height + 1 }
        XCTAssertTrue(grown, "the row never took its new height: \(shown.geometry)")
        try await landed(shown, model)
        XCTAssertEqual(shown.list.textEnvironment?.text, text(.accessibilityExtraExtraExtraLarge, 3))
        XCTAssertEqual(shown.planned.count, model.rows.count)
        assertSamePixel(try XCTUnwrap(shown.frame(anchor)).minY, before.minY, scale: shown.scale,
                        "the row at the top stays where it was: \(shown.geometry)")
        try assertRowsAreTheirPlans(shown, model, "after the change")
        await shown.account.signOut()
    }

    /// Every row takes a new size's plan, not only the ones on screen:
    /// scrolled from the top to the end after the size landed, every row
    /// loaded is at its plan for the new size.
    func testANewTextSizeReachesEveryRowTheListHas() async throws {
        let model = self.model(sessions: 60)
        let account = try await signedIn()
        let shown = try show(model, category: .large, account: account)
        defer { shown.window.isHidden = true }
        try await landed(shown, model)
        let large = Dictionary(uniqueKeysWithValues: shown.planned.map { ($0.identity, $0.height) })

        change(shown, to: .accessibilityExtraExtraExtraLarge)
        try await landed(shown, model)
        let replanned = try await until { shown.planned.allSatisfy { !$0.identity.hasPrefix("session:") || $0.height > large[$0.identity] ?? .infinity } }
        XCTAssertTrue(replanned, shown.geometry)
        let largest = shown.planned
        XCTAssertEqual(largest.count, model.rows.count)
        for row in largest where row.identity.hasPrefix("session:") {
            XCTAssertGreaterThan(row.height, large[row.identity] ?? .infinity, "\(row.identity) kept its old plan")
        }
        let last = try XCTUnwrap(model.ids.last)
        let index = try XCTUnwrap(shown.index(last))
        shown.rows.scrollTo(.init(index: index, identity: last.ultraIdentity), transition: .none)
        let reached = try await until { shown.frame(last) != nil && shown.rows.loadedItemViews.allSatisfy(\.isDisplayReady) }
        XCTAssertTrue(reached, "scrolled to the last row: \(shown.geometry)")
        try assertRowsAreTheirPlans(shown, model, "at the end")
        await shown.account.signOut()
    }

    /// A session reconfigured in place that gains its workspace line takes
    /// the taller row, the row under it moving down with it.
    func testASessionGainingItsWorkspaceLineGrowsInPlace() async throws {
        let before = self.model(sessions: 4)
        let account = try await signedIn()
        let shown = try show(before, category: .accessibilityExtraExtraExtraLarge, account: account)
        defer { shown.window.isHidden = true }
        try await landed(shown, before)
        assertSamePixel(try XCTUnwrap(shown.frame(before.ids[1])).height, Self.largestWithoutWorkspace, scale: shown.scale)

        var after = before
        guard case .flat(.session(var row)) = after.rows[1] else { return XCTFail("row 1 is a session") }
        row.workspaceName = "fix-login"
        after.rows[1] = .flat(.session(row))
        shown.list.apply(after, changeset: RowChangeset(reconfigures: [1]), animated: false)
        let grown = try await until { abs((shown.frame(before.ids[1])?.height ?? 0) - Self.largestWithWorkspace) < 0.5 }
        XCTAssertTrue(grown, shown.geometry)
        assertSamePixel(try XCTUnwrap(shown.frame(before.ids[2])).minY, try XCTUnwrap(shown.frame(before.ids[1])).maxY, scale: shown.scale)
        try assertRowsAreTheirPlans(shown, after, "after the reconfigure")
        await shown.account.signOut()
    }

    /// Only the environment for the size last asked for lands: one for a
    /// size asked away is refused and changes nothing, and a size asked
    /// for and asked away again before it lands moves nothing.
    func testOnlyTheSizeLastAskedForLands() async throws {
        let account = try await signedIn()
        let model = self.model(sessions: 6)
        let shown = try show(model, category: .large, account: account)
        defer { shown.window.isHidden = true }
        try await landed(shown, model)

        change(shown, to: .extraExtraExtraLarge)
        change(shown, to: .accessibilityExtraExtraExtraLarge)
        try await landed(shown, model)
        XCTAssertEqual(shown.list.textEnvironment?.text, text(.accessibilityExtraExtraExtraLarge, 3))
        let heights = shown.planned.map(\.height)
        #if DEBUG
        let applies = shown.list.textEnvironmentApplies
        #endif

        // A late environment for a size asked away.
        shown.list.land(await HomeTextEnvironment.make(text(.extraExtraExtraLarge, 3)))
        XCTAssertEqual(shown.list.textEnvironment?.text, text(.accessibilityExtraExtraExtraLarge, 3))
        #if DEBUG
        XCTAssertEqual(shown.list.textEnvironmentApplies, applies)
        #endif

        // Asked for and asked away before it lands.
        change(shown, to: .large)
        change(shown, to: .accessibilityExtraExtraExtraLarge)
        try await landed(shown, model)
        XCTAssertEqual(shown.list.textEnvironment?.text, text(.accessibilityExtraExtraExtraLarge, 3))
        #if DEBUG
        XCTAssertEqual(shown.list.textEnvironmentApplies, applies, "nothing moved")
        #endif
        XCTAssertEqual(shown.planned.map(\.height), heights)
        await shown.account.signOut()
    }

    /// The plaque's height is measured off the main thread for its words,
    /// the list's width, how wide a group may grow and the environment;
    /// a height for anything else is refused and the banner row stays.
    func testOnlyAHeaderMeasuredForWhatIsShownLands() async throws {
        let account = try await signedIn()
        let model = self.model(sessions: 4, offline: true)
        let shown = try show(model, category: .large, account: account)
        defer { shown.window.isHidden = true }
        try await landed(shown, model)
        func banner() -> CGFloat? { (shown.rows.items.first { $0.identity == "home:banner" } as? HomeUltraRow)?.plan.size.height }
        let height = try XCTUnwrap(banner(), "no banner row")
        let key = try XCTUnwrap(shown.list.headerRequested)
        XCTAssertEqual(key.environment, shown.list.textEnvironment)
        XCTAssertEqual(key.width, 393)
        let header = HomeListHeaderView()
        header.content = key.banners
        assertSamePixel(height, header.sizeThatFits(CGSize(width: 393, height: CGFloat.greatestFiniteMagnitude)).height, scale: shown.scale)

        var stale = [key, key, key, key]
        stale[0].width += 1
        stale[1].maxWidth = 320
        stale[2].banners = HomeBanners(offlineTitle: "Another computer is offline")
        stale[3].environment = await HomeTextEnvironment.make(text(.extraSmall, 3))
        for other in stale {
            shown.list.landHeader(other, height: height + 40)
            XCTAssertEqual(banner(), height)
        }
        shown.list.landHeader(key, height: height + 40)
        let taken = try await until { banner() == height + 40 }
        XCTAssertTrue(taken)

        // A new text size measures it again, at that size.
        change(shown, to: .accessibilityExtraExtraExtraLarge)
        try await landed(shown, model)
        await shown.list.headerTask?.value
        let larger = try await until { (banner() ?? 0) > height + 40 }
        XCTAssertTrue(larger, "the banner kept \(banner() ?? 0)")
        XCTAssertEqual(shown.list.headerRequested?.environment.text, text(.accessibilityExtraExtraExtraLarge, 3))
        await shown.account.signOut()
    }
}
#endif

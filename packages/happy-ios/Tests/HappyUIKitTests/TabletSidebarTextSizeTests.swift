#if canImport(UIKit)
import Foundation
@testable import HappyCore
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

/// The sidebar's grouped list at the person's text size, in a window: its
/// bots as tall as their cells draw at that size, taking the new lines and
/// heights when it changes, and the notices over them measured off the
/// main thread as home's are, landing only for what was last asked for.
@MainActor
final class TabletSidebarTextSizeTests: XCTestCase {
    private let width: CGFloat = 320

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func text(_ category: UIContentSizeCategory) -> TextEnvironment {
        TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: 3)
    }

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

    /// "Bots" over three bots, one with a workspace and one with line
    /// counts as well; every computer offline, for the plaque.
    private func list() -> TabletGroupedList {
        let bots = [
            HomeRowMeasurerTests.session("b0", workspace: nil),
            HomeRowMeasurerTests.session("b1", workspace: "fix-login"),
            HomeRowMeasurerTests.session("b2", workspace: "fix-login", changes: HomeRowMeasurerTests.changes),
        ]
        let offline = [MachineChoice(id: "m", name: "MacBook Pro", machineIds: ["m"], happyMachine: nil, rigMachine: nil, online: false, activeAt: 0)]
        return TabletGroupedList(
            ids: [.botsHeader] + bots.map { .bot($0.id) },
            rows: [.botsHeader] + bots.map { .bot($0) },
            avatarStyle: .gradient,
            avatarMonochrome: false,
            offline: offline
        )
    }

    /// The derivation's heights for `list` at `text`, from `state`.
    private func derive(_ list: TabletGroupedList, _ text: TextEnvironment, from state: TabletSidebarViewState? = nil) throws -> (output: TabletSidebarViewUpdate, state: TabletSidebarViewState) {
        let wake = ClockWake()
        defer { wake.cancel() }
        var applied = state ?? TabletSidebarViewState()
        applied.feeds.grouped = list
        return try XCTUnwrap(TabletGroupedHeights.derive(TabletSidebarViewInput(width: width, text: text), applied: applied, wake: wake))
    }

    @MainActor
    private struct Shown {
        let window: UIWindow
        let grouped: TabletGroupedListViewController
        let table: UITableView
        let account: AccountController
    }

    private func show(_ list: TabletGroupedList, category: UIContentSizeCategory, account: AccountController) throws -> (Shown, TabletSidebarViewState) {
        let session = try XCTUnwrap(account.session)
        let context = AppContext(account: account, variant: .development, version: "test")
        let grouped = TabletGroupedListViewController(context: context, session: session)
        let derived = try derive(list, text(category))
        grouped.apply(list, changeset: RowChangeset(), headings: derived.output.headings, moved: [], animated: false)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 900))
        window.traitOverrides.preferredContentSizeCategory = category
        window.traitOverrides.displayScale = 3
        window.rootViewController = grouped
        window.isHidden = false
        window.updateTraitsIfNeeded()
        grouped.view.layoutIfNeeded()
        let table = try XCTUnwrap(grouped.view as? UITableView)
        return (Shown(window: window, grouped: grouped, table: table, account: account), derived.state)
    }

    private func assertBotsAreTheirCells(_ shown: Shown, lines: FlatSessionRowLayout.Lines, _ message: String, line: UInt = #line) throws {
        shown.table.layoutIfNeeded()
        for row in 1...3 {
            let path = IndexPath(row: row, section: 0)
            let cell = try XCTUnwrap(shown.table.cellForRow(at: path) as? SessionRowCell, message, line: line)
            XCTAssertEqual(cell.lines, lines, "row \(row), \(message)", line: line)
            assertSamePixel(
                shown.table.rectForRow(at: path).height,
                cell.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height,
                scale: 3,
                "row \(row), \(message)",
                line: line
            )
        }
    }

    func testTheBotsFollowTheTextSize() async throws {
        let account = try await signedIn()
        let list = list()
        let (shown, state) = try show(list, category: .large, account: account)
        defer { shown.window.isHidden = true }
        let large = TabletGroupedHeights.metrics(text(.large))
        try assertBotsAreTheirCells(shown, lines: large.sessionLines, "large")
        XCTAssertEqual(shown.table.rectForRow(at: IndexPath(row: 1, section: 0)).height, 81)

        // A new size: the heights come from the derivation, and every bot
        // takes the new lines.
        shown.window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        shown.window.updateTraitsIfNeeded()
        let larger = try derive(list, text(.accessibilityExtraExtraExtraLarge), from: state)
        XCTAssertNil(larger.output.rows)
        XCTAssertEqual(larger.output.moved, Set(list.ids))
        XCTAssertEqual(shown.grouped.applyHeadings(larger.output.headings, moved: larger.output.moved), 4)
        let largest = TabletGroupedHeights.metrics(text(.accessibilityExtraExtraExtraLarge))
        try assertBotsAreTheirCells(shown, lines: largest.sessionLines, "largest")
        XCTAssertGreaterThan(shown.table.rectForRow(at: IndexPath(row: 2, section: 0)).height, shown.table.rectForRow(at: IndexPath(row: 1, section: 0)).height)
        await account.signOut()
    }

    func testOnlyAHeaderMeasuredForWhatIsShownLands() async throws {
        let account = try await signedIn()
        let (shown, _) = try show(list(), category: .large, account: account)
        defer { shown.window.isHidden = true }
        await shown.grouped.headerTask?.value
        shown.table.layoutIfNeeded()
        let header = try XCTUnwrap(shown.table.tableHeaderView)
        let key = try XCTUnwrap(shown.grouped.headerRequested)
        XCTAssertEqual(key.text, text(.large))
        XCTAssertEqual(key.width, width)
        XCTAssertEqual(key.banners.offlineTitle, Strings.Troubleshoot.bannerTitleOne(name: "MacBook Pro"))
        let height = header.frame.height
        // The view draws what was measured off the main thread.
        XCTAssertEqual(height, header.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height)

        var stale = [key, key, key, key]
        stale[0].width += 1
        stale[1].maxWidth = 100
        stale[2].banners = HomeBanners(offlineTitle: "Another computer is offline")
        stale[3].text = text(.extraSmall)
        for other in stale {
            shown.grouped.landHeader(other, height: height + 40)
            XCTAssertEqual(shown.table.tableHeaderView?.frame.height, height)
        }
        shown.grouped.landHeader(key, height: height + 40)
        XCTAssertEqual(shown.table.tableHeaderView?.frame.height, height + 40)

        // A new text size measures it again, at that size.
        shown.window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        shown.window.updateTraitsIfNeeded()
        shown.grouped.updateTraitsIfNeeded()
        await shown.grouped.headerTask?.value
        shown.table.layoutIfNeeded()
        let larger = try XCTUnwrap(shown.table.tableHeaderView)
        XCTAssertEqual(shown.grouped.headerRequested?.text, text(.accessibilityExtraExtraExtraLarge))
        XCTAssertGreaterThan(larger.frame.height, height)
        XCTAssertEqual(larger.frame.height, larger.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height)
        await account.signOut()
    }
}
#endif

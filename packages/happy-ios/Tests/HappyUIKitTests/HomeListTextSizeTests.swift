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

/// Home's list at the person's text size: every row's height and the
/// notices' worked out off the main thread from one environment, against
/// the cells and the header drawing at that size; and the list itself in a
/// window, taking a new size without going blank or moving the row at its
/// top, and refusing any environment or header it did not last ask for.
@MainActor
final class HomeListTextSizeTests: XCTestCase {
    private let categories: [UIContentSizeCategory] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge]
    private let scales: [CGFloat] = [2, 3]
    private let widths: [CGFloat] = [320, 393, 430]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
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

    private func oneLine(_ label: UIView) -> CGFloat {
        label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)).height
    }

    // MARK: Heights against the cells

    func testEveryRowMatchesItsCellAtEveryTextSize() async {
        for category in categories {
            for scale in scales {
                let environment = await HomeTextEnvironment.make(text(category, scale))
                for width in widths {
                    let at = "\(width) @\(scale)x, \(category.rawValue)"
                    func check(_ cell: UITableViewCell, _ kind: HomeRowKind, line: UInt = #line) {
                        XCTAssertEqual(
                            HomeRowMeasurer.height(kind, width: width, environment: environment),
                            height(cell, width: width, scale: scale, category: category),
                            "\(kind) at \(at)",
                            line: line
                        )
                    }

                    for workspace in [nil, "fix-login"] {
                        for changes in [nil, HomeRowMeasurerTests.changes] {
                            let cell = SessionRowCell(style: .default, reuseIdentifier: nil)
                            // As the list configures it.
                            cell.lines = environment.rows.sessionLines
                            cell.configure(HomeRowMeasurerTests.session(workspace: workspace, changes: changes), style: .gradient, monochrome: false)
                            check(cell, .flatSession(workspace: workspace != nil, changes: changes != nil))
                            // The lines worked out off main are the lines
                            // the labels draw.
                            let lines = environment.rows.sessionLines
                            XCTAssertEqual(oneLine(cell.titleLabel), lines.title, "title, \(at)")
                            XCTAssertEqual(oneLine(cell.projectLabel), lines.project, "project, \(at)")
                            if workspace != nil {
                                XCTAssertEqual(oneLine(cell.workspaceLabel), lines.workspace, "workspace, \(at)")
                            }
                            if changes != nil {
                                for part in [cell.changes.approximate, cell.changes.added, cell.changes.removed] {
                                    XCTAssertFalse(part.isHidden, at)
                                    XCTAssertEqual(oneLine(part), lines.changes, "\(part.string), \(at)")
                                    XCTAssertEqual(part.renderedStyle.size, 11 * TextScale(TextSizeCategory(category)).multiplier, at)
                                }
                            }
                            XCTAssertEqual(cell.changes.isHidden, changes == nil, at)
                            XCTAssertEqual(cell.projectLabel.renderedStyle.size, 15 * TextScale(TextSizeCategory(category)).multiplier, at)
                        }
                    }

                    let day = SessionDayHeaderCell(style: .default, reuseIdentifier: nil)
                    day.configure(.today)
                    check(day, .dayHeader(label: Strings.SessionHistory.today))

                    for banded in [true, false] {
                        let toggle = ArchiveToggleCell(style: .default, reuseIdentifier: nil)
                        toggle.banded = banded
                        toggle.configure(hidden: true)
                        check(toggle, .archiveToggle(label: Strings.Sidebar.showArchived, banded: banded))
                    }

                    let machine = ProjectMachineHeaderCell(style: .default, reuseIdentifier: nil)
                    machine.configure(name: "MacBook Pro")
                    check(machine, .machineHeader(name: "MacBook Pro"))

                    let section = ProjectSectionCell(style: .default, reuseIdentifier: nil)
                    section.configure(Strings.Home.projects)
                    check(section, .section(label: Strings.Home.projects))

                    // RN's fixed `height`s: 52 + 8, 48, 48 at every size.
                    check(ProjectCardCell(style: .default, reuseIdentifier: nil), .projectCard)
                    check(WorktreeCell(style: .default, reuseIdentifier: nil), .worktree)
                    check(ProjectChatCell(style: .default, reuseIdentifier: nil), .chat)
                    XCTAssertEqual(HomeRowMeasurer.height(.projectCard, width: width, environment: environment), 60, at)
                    XCTAssertEqual(HomeRowMeasurer.height(.worktree, width: width, environment: environment), 48, at)
                    XCTAssertEqual(HomeRowMeasurer.height(.chat, width: width, environment: environment), 48, at)
                }
            }
        }
    }

    func testTheNoticesMatchTheHeaderViewAtEveryTextSize() async {
        let cases = [
            HomeBanners(offlineTitle: "All computers are offline"),
            HomeBanners(nativeUpdate: true),
            HomeBanners(whatsNew: true),
            HomeBanners(offlineTitle: "MacBook Pro is offline", whatsNew: true),
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
        XCTAssertEqual(HomeRowMeasurer.height(.flatSession(workspace: true, changes: false), width: 393, environment: environment), Self.largestWithWorkspace)
        XCTAssertEqual(HomeRowMeasurer.height(.flatSession(workspace: true, changes: true), width: 393, environment: environment), Self.largestWithWorkspace)
        XCTAssertEqual(HomeRowMeasurer.height(.flatSession(workspace: false, changes: true), width: 393, environment: environment), Self.largestWithOnlyChanges)
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
        let table: UITableView
        let account: AccountController

        /// The screen's pixels per point, which the table's geometry is
        /// compared on (`assertSamePixel`).
        var scale: CGFloat { window.traitCollection.displayScale }

        /// Where the table is, for a failure's message.
        func geometry(_ anchor: IndexPath? = nil) -> String {
            var parts = [
                "offset \(table.contentOffset.y)",
                "content \(table.contentSize.height)",
                "header \(table.tableHeaderView?.frame.height ?? 0)",
                "insets \(table.adjustedContentInset.top)/\(table.adjustedContentInset.bottom)",
            ]
            if let anchor { parts.append("anchor \(anchor.row) \(table.rectForRow(at: anchor))") }
            return parts.joined(separator: ", ")
        }
    }

    /// The list as home shows it, in a window at `category`, under home's
    /// header and over its dock. Synchronous, so nothing it asked for has
    /// landed when it returns.
    private func show(_ model: HomeListModel, category: UIContentSizeCategory, account: AccountController) throws -> Shown {
        let session = try XCTUnwrap(account.session)
        let context = AppContext(account: account, variant: .development, version: "test")
        let list = SessionListViewController(context: context, session: session)
        list.apply(model, changeset: RowChangeset(), animated: false)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.traitOverrides.preferredContentSizeCategory = category
        window.traitOverrides.displayScale = 3
        window.rootViewController = list
        window.isHidden = false
        list.contentInsets = HomeContentInsets(safeArea: LayoutInsets(top: 59, bottom: 34), dock: HomeDockLayout.Metrics.contentInset)
        window.updateTraitsIfNeeded()
        list.view.layoutIfNeeded()
        let table = try XCTUnwrap(list.view as? UITableView)
        return Shown(window: window, list: list, table: table, account: account)
    }

    /// Once the environment asked for last is in, and the notices measured
    /// with it: landing asks for the header again, and it lands after.
    /// (On a fresh simulator What's new is unread, so there is a header.)
    private func landed(_ shown: Shown) async {
        await shown.list.textEnvironmentTask?.value
        await shown.list.headerTask?.value
        shown.table.layoutIfNeeded()
    }

    private func change(_ shown: Shown, to category: UIContentSizeCategory) {
        shown.window.traitOverrides.preferredContentSizeCategory = category
        shown.window.updateTraitsIfNeeded()
        shown.list.updateTraitsIfNeeded()
    }

    /// Each shown row is as tall as its cell draws itself.
    private func assertRowsAreTheirCells(_ shown: Shown, _ message: String, line: UInt = #line) {
        let width = shown.table.bounds.width
        let paths = shown.table.indexPathsForVisibleRows ?? []
        XCTAssertFalse(paths.isEmpty, message, line: line)
        for path in paths {
            guard let cell = shown.table.cellForRow(at: path) else {
                XCTFail("no cell at \(path.row), \(message)", line: line)
                continue
            }
            assertSamePixel(
                shown.table.rectForRow(at: path).height,
                cell.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height,
                scale: shown.scale,
                "row \(path.row), \(message)",
                line: line
            )
        }
    }

    /// The table's content is the header and every row's own height, on
    /// screen or not: no row is the table's estimate.
    private func assertContentIsEveryRow(_ shown: Shown, _ message: String, line: UInt = #line) {
        let table = shown.table
        var height = table.tableHeaderView?.frame.height ?? 0
        for row in 0..<table.numberOfRows(inSection: 0) {
            height += shown.list.tableView(table, heightForRowAt: IndexPath(row: row, section: 0))
        }
        assertSamePixel(table.contentSize.height, height, scale: shown.scale, "the content, \(message): \(shown.geometry())", line: line)
    }

    /// The first show waits one hop for its environment, with no rows,
    /// then shows every row at the person's text size, as tall as its cell
    /// draws it.
    func testTheListShowsItsRowsAtTheTextSizeOnceItsEnvironmentIsIn() async throws {
        let model = self.model(sessions: 6)
        let account = try await signedIn()
        let shown = try show(model, category: .accessibilityExtraExtraExtraLarge, account: account)
        defer { shown.window.isHidden = true }
        XCTAssertNil(shown.list.textEnvironment)
        XCTAssertEqual(shown.table.numberOfRows(inSection: 0), 0)

        await landed(shown)
        XCTAssertEqual(shown.list.textEnvironment?.text, text(.accessibilityExtraExtraExtraLarge, 3))
        XCTAssertEqual(shown.table.numberOfRows(inSection: 0), model.rows.count)
        assertRowsAreTheirCells(shown, "largest")
        let first = try XCTUnwrap(shown.table.cellForRow(at: IndexPath(row: 0, section: 0)) as? SessionRowCell)
        XCTAssertEqual(first.projectLabel.renderedStyle.size, 15 * TextScale(.accessibilityExtraExtraExtraLarge).multiplier)
        XCTAssertEqual(first.lines, shown.list.textEnvironment?.rows.sessionLines)
        assertSamePixel(shown.table.rectForRow(at: IndexPath(row: 0, section: 0)).height, Self.largestWithWorkspace, scale: shown.scale)
        assertSamePixel(shown.table.rectForRow(at: IndexPath(row: 1, section: 0)).height, Self.largestWithoutWorkspace, scale: shown.scale)
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
        await landed(shown)
        assertContentIsEveryRow(shown, "large")
        let table = shown.table
        let inset = table.adjustedContentInset.top
        XCTAssertGreaterThan(inset, 0)
        table.contentOffset.y = 1500
        table.layoutIfNeeded()
        let top = table.contentOffset.y + inset
        let anchor = try XCTUnwrap((table.indexPathsForVisibleRows ?? []).first { table.rectForRow(at: $0).maxY > top })
        XCTAssertGreaterThan(anchor.row, 0)
        let onScreen = table.rectForRow(at: anchor).minY - top
        let before = table.rectForRow(at: anchor).height

        change(shown, to: .accessibilityExtraExtraExtraLarge)
        // Asked for, not in: the rows and the offset are as they were.
        XCTAssertEqual(shown.list.textEnvironment?.text, text(.large, 3))
        XCTAssertEqual(table.numberOfRows(inSection: 0), model.rows.count)
        XCTAssertEqual(table.contentOffset.y, 1500)

        await landed(shown)
        XCTAssertEqual(shown.list.textEnvironment?.text, text(.accessibilityExtraExtraExtraLarge, 3))
        XCTAssertEqual(table.numberOfRows(inSection: 0), model.rows.count)
        XCTAssertGreaterThan(table.rectForRow(at: anchor).height, before)
        XCTAssertNotEqual(table.contentOffset.y, 1500, "the rows above grew")
        assertContentIsEveryRow(shown, "after the change")
        assertSamePixel(
            table.rectForRow(at: anchor).minY - (table.contentOffset.y + inset),
            onScreen,
            scale: shown.scale,
            "the row at the top stays where it was: \(shown.geometry(anchor))"
        )
        assertRowsAreTheirCells(shown, "after the change")
        await shown.account.signOut()
    }

    /// Every session row takes a new size's lines, not only the cells on
    /// screen: a cell the table made ahead for a row below (cell
    /// prefetching) is reconfigured with them. Scrolled down a screen at a
    /// time from where the size landed to the end, every session cell
    /// shown has the new lines and every row is as tall as its cell.
    func testANewTextSizeReachesEveryCellTheListHas() async throws {
        let model = self.model(sessions: 60)
        let account = try await signedIn()
        let shown = try show(model, category: .large, account: account)
        defer { shown.window.isHidden = true }
        await landed(shown)
        let table = shown.table
        let inset = table.adjustedContentInset
        // Scrolled down a little, in steps, with the run loop let go
        // between them, so the table can make cells ahead of the scroll.
        for step in 1...4 {
            table.contentOffset.y = -inset.top + CGFloat(step) * 40
            table.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(50))
        }

        change(shown, to: .accessibilityExtraExtraExtraLarge)
        await landed(shown)
        let environment = try XCTUnwrap(shown.list.textEnvironment)
        XCTAssertEqual(environment.text, text(.accessibilityExtraExtraExtraLarge, 3))
        let sessions = model.rows.indices.compactMap { index -> IndexPath? in
            if case .flat(.session) = model.rows[index] { return IndexPath(row: index, section: 0) }
            return nil
        }
        XCTAssertEqual(sessions.count, 62)
        let last = try XCTUnwrap(sessions.last).row
        XCTAssertEqual(shown.list.textEnvironmentReconfigured, sessions, "every session row, on screen or not")
        assertContentIsEveryRow(shown, "after the change")

        let page = table.bounds.height - inset.top - inset.bottom
        XCTAssertGreaterThan(page, 0)
        var seen = Set<Int>()
        // A screen a step, until the last session row has been shown or the
        // list moves no further; the end is read again at every step, from
        // the table as it is then. 62 rows at the largest size are well
        // under 100 screens.
        for _ in 0..<100 {
            let y = table.contentOffset.y
            for path in table.indexPathsForVisibleRows ?? [] {
                guard let cell = table.cellForRow(at: path) as? SessionRowCell else { continue }
                seen.insert(path.row)
                XCTAssertEqual(cell.lines, environment.rows.sessionLines, "row \(path.row), \(shown.geometry())")
            }
            assertRowsAreTheirCells(shown, shown.geometry())
            if seen.contains(last) { break }
            let bottom = table.contentSize.height + inset.bottom - table.bounds.height
            table.contentOffset.y = min(y + page, bottom)
            table.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(50))
            if table.contentOffset.y == y { break }
        }
        XCTAssertTrue(seen.contains(last), "scrolled to the last row: \(shown.geometry(IndexPath(row: last, section: 0)))")
        await shown.account.signOut()
    }

    /// A session reconfigured in place that gains its workspace line takes
    /// the taller row, without the rows around it moving index.
    func testASessionGainingItsWorkspaceLineGrowsInPlace() async throws {
        let before = self.model(sessions: 4)
        let account = try await signedIn()
        let shown = try show(before, category: .accessibilityExtraExtraExtraLarge, account: account)
        defer { shown.window.isHidden = true }
        await landed(shown)
        let path = IndexPath(row: 1, section: 0)
        assertSamePixel(shown.table.rectForRow(at: path).height, Self.largestWithoutWorkspace, scale: shown.scale)

        var after = before
        guard case .flat(.session(var row)) = after.rows[1] else { return XCTFail("row 1 is a session") }
        row.workspaceName = "fix-login"
        after.rows[1] = .flat(.session(row))
        shown.list.apply(after, changeset: RowChangeset(reconfigures: [1]), animated: false)
        shown.table.layoutIfNeeded()
        assertSamePixel(shown.table.rectForRow(at: path).height, Self.largestWithWorkspace, scale: shown.scale)
        assertSamePixel(shown.table.rectForRow(at: IndexPath(row: 2, section: 0)).minY, shown.table.rectForRow(at: path).maxY, scale: shown.scale)
        assertRowsAreTheirCells(shown, "after the reconfigure")
        await shown.account.signOut()
    }

    /// Only the environment for the size last asked for lands: one for a
    /// size asked away is refused and changes nothing, and a size asked
    /// for and asked away again before it lands moves nothing.
    func testOnlyTheSizeLastAskedForLands() async throws {
        let account = try await signedIn()
        let shown = try show(model(sessions: 6), category: .large, account: account)
        defer { shown.window.isHidden = true }
        await landed(shown)

        change(shown, to: .extraExtraExtraLarge)
        change(shown, to: .accessibilityExtraExtraExtraLarge)
        await landed(shown)
        XCTAssertEqual(shown.list.textEnvironment?.text, text(.accessibilityExtraExtraExtraLarge, 3))
        let heights = (0..<shown.table.numberOfRows(inSection: 0)).map { shown.table.rectForRow(at: IndexPath(row: $0, section: 0)).height }
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
        await landed(shown)
        XCTAssertEqual(shown.list.textEnvironment?.text, text(.accessibilityExtraExtraExtraLarge, 3))
        #if DEBUG
        XCTAssertEqual(shown.list.textEnvironmentApplies, applies, "nothing moved")
        #endif
        let after = (0..<shown.table.numberOfRows(inSection: 0)).map { shown.table.rectForRow(at: IndexPath(row: $0, section: 0)).height }
        XCTAssertEqual(after, heights)
        await shown.account.signOut()
    }

    /// The plaque's height is measured off the main thread for its words,
    /// the list's width, how wide a group may grow and the environment;
    /// a height for anything else is refused and the header stays.
    func testOnlyAHeaderMeasuredForWhatIsShownLands() async throws {
        let account = try await signedIn()
        let shown = try show(model(sessions: 4, offline: true), category: .large, account: account)
        defer { shown.window.isHidden = true }
        await landed(shown)
        await shown.list.headerTask?.value
        let header = try XCTUnwrap(shown.table.tableHeaderView)
        let key = try XCTUnwrap(shown.list.headerRequested)
        XCTAssertEqual(key.environment, shown.list.textEnvironment)
        XCTAssertEqual(key.width, 393)
        let height = header.frame.height
        XCTAssertEqual(height, header.sizeThatFits(CGSize(width: 393, height: CGFloat.greatestFiniteMagnitude)).height)

        var stale = [key, key, key, key]
        stale[0].width += 1
        stale[1].maxWidth = 320
        stale[2].banners = HomeBanners(offlineTitle: "Another computer is offline")
        stale[3].environment = await HomeTextEnvironment.make(text(.extraSmall, 3))
        for other in stale {
            shown.list.landHeader(other, height: height + 40)
            XCTAssertEqual(shown.table.tableHeaderView?.frame.height, height)
        }
        shown.list.landHeader(key, height: height + 40)
        XCTAssertEqual(shown.table.tableHeaderView?.frame.height, height + 40)

        // A new text size measures it again, at that size.
        change(shown, to: .accessibilityExtraExtraExtraLarge)
        await landed(shown)
        await shown.list.headerTask?.value
        shown.table.layoutIfNeeded()
        let larger = try XCTUnwrap(shown.table.tableHeaderView)
        XCTAssertEqual(shown.list.headerRequested?.environment.text, text(.accessibilityExtraExtraExtraLarge, 3))
        XCTAssertGreaterThan(larger.frame.height, height)
        XCTAssertEqual(larger.frame.height, larger.sizeThatFits(CGSize(width: 393, height: CGFloat.greatestFiniteMagnitude)).height)
        await shown.account.signOut()
    }
}
#endif

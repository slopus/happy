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

/// The sidebar's grouped list at the person's text size, on UltraList in a
/// window: its bots as tall as home's rows at that size, taking the new
/// heights when it changes with nothing applied, and the notices over them
/// measured off the main thread as home's are, landing only for what was
/// last asked for.
@MainActor
final class TabletSidebarTextSizeTests: XCTestCase {
    private let width: CGFloat = 320

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
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

    @MainActor
    private struct Shown {
        let window: UIWindow
        let grouped: TabletGroupedListViewController
        let rows: UltraListView
        let account: AccountController

        /// The planned height of `id`'s row, once the list has it.
        func height(_ id: TabletGroupedRow.ID) -> CGFloat? {
            (rows.items.first { $0.identity == id.ultraBridgeID.ultraIdentity } as? HomeUltraRow)?.plan.size.height
        }

        var banner: CGFloat? { (rows.items.first { $0.identity == "home:banner" } as? HomeUltraRow)?.plan.size.height }
    }

    private func show(_ list: TabletGroupedList, category: UIContentSizeCategory, account: AccountController) throws -> Shown {
        let session = try XCTUnwrap(account.session)
        let context = AppContext(account: account, variant: .development, version: "test")
        let grouped = TabletGroupedListViewController(context: context, session: session)
        grouped.apply(list, changeset: RowChangeset(), animated: false)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 900))
        window.traitOverrides.preferredContentSizeCategory = category
        window.traitOverrides.displayScale = 3
        window.rootViewController = grouped
        window.isHidden = false
        window.updateTraitsIfNeeded()
        grouped.view.layoutIfNeeded()
        let rows = try XCTUnwrap((grouped.view as? HomeUltraListView)?.list)
        return Shown(window: window, grouped: grouped, rows: rows, account: account)
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    /// Each bot's row is as tall as home's session rows at the size shown.
    private func assertBotsAreTheirRows(_ shown: Shown, _ list: TabletGroupedList, text: TextEnvironment, _ message: String, line: UInt = #line) async throws {
        let environment = await HomeTextEnvironment.make(text)
        for (id, row) in zip(list.ids, list.rows) {
            guard case .bot(let session) = row else { continue }
            let expected = FlatSessionRowLayout.height(
                lines: environment.rows.sessionLines,
                workspace: session.workspaceName != nil,
                changes: session.changes != nil,
                branchIcon: environment.rows.branchIcon.height
            )
            let landed = try await until { shown.height(id).map { abs($0 - expected) < 0.5 } ?? false }
            XCTAssertTrue(landed, "\(id) is \(shown.height(id) ?? 0), not \(expected), \(message)", line: line)
        }
    }

    func testTheBotsFollowTheTextSize() async throws {
        let account = try await signedIn()
        let list = list()
        let shown = try show(list, category: .large, account: account)
        defer { shown.window.isHidden = true }
        try await assertBotsAreTheirRows(shown, list, text: text(.large), "large")
        XCTAssertEqual(shown.height(list.ids[1]), 81)

        // A new size: every bot takes its new height, with no new rows.
        shown.window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        shown.window.updateTraitsIfNeeded()
        try await assertBotsAreTheirRows(shown, list, text: text(.accessibilityExtraExtraExtraLarge), "largest")
        XCTAssertGreaterThan(try XCTUnwrap(shown.height(list.ids[2])), try XCTUnwrap(shown.height(list.ids[1])))
        await account.signOut()
    }

    func testOnlyAHeaderMeasuredForWhatIsShownLands() async throws {
        let account = try await signedIn()
        let shown = try show(list(), category: .large, account: account)
        defer { shown.window.isHidden = true }
        await shown.grouped.headerTask?.value
        let shownBanner = try await until { shown.banner != nil }
        XCTAssertTrue(shownBanner, "no banner row")
        let height = try XCTUnwrap(shown.banner)
        let key = try XCTUnwrap(shown.grouped.headerRequested)
        XCTAssertEqual(key.text, text(.large))
        XCTAssertEqual(key.width, width)
        XCTAssertEqual(key.banners.offlineTitle, Strings.Troubleshoot.bannerTitleOne(name: "MacBook Pro"))

        var stale = [key, key, key, key]
        stale[0].width += 1
        stale[1].maxWidth = 100
        stale[2].banners = HomeBanners(offlineTitle: "Another computer is offline")
        stale[3].text = text(.extraSmall)
        for other in stale {
            shown.grouped.landHeader(other, height: height + 40)
            XCTAssertEqual(shown.banner, height)
        }
        shown.grouped.landHeader(key, height: height + 40)
        let taken = try await until { shown.banner == height + 40 }
        XCTAssertTrue(taken)

        // A new text size measures it again, at that size.
        shown.window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        shown.window.updateTraitsIfNeeded()
        shown.grouped.updateTraitsIfNeeded()
        await shown.grouped.headerTask?.value
        let larger = try await until { (shown.banner ?? 0) > height + 40 }
        XCTAssertTrue(larger, "the banner kept \(shown.banner ?? 0)")
        XCTAssertEqual(shown.grouped.headerRequested?.text, text(.accessibilityExtraExtraExtraLarge))
        await account.signOut()
    }
}
#endif

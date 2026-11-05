#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A daemon with an artifact catalog: one page of artifacts changed at
/// different times, some with a cover (wide or square) whose file it
/// serves. It can be told to fail, as a computer that has gone away does.
actor ArtifactCatalogDaemon: AgentTransport {
    struct Item {
        var id: String
        var type: String
        var title: String
        var updatedAt: Date
        var picture: Data?
        /// `wide` or `square`: the picture is the cover, of that shape.
        var aspect: String? = nil
    }

    var items: [Item]
    var failing = false
    private(set) var catalogReads = 0
    private(set) var fileReads: [String] = []

    init(items: [Item]) { self.items = items }

    func set(items: [Item]) { self.items = items }
    func set(failing: Bool) { self.failing = failing }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        if failing { throw URLError(.cannotConnectToHost) }
        if path.hasPrefix("/v0/artifacts?") {
            catalogReads += 1
            let list = items.map(object).joined(separator: ",")
            return HTTP1Response(status: 200, body: Data(#"{"artifacts":[\#(list)],"nextPageCursor":null,"cursor":"c1"}"#.utf8))
        }
        if path.hasPrefix("/v0/artifacts/"), path.contains("/files/") {
            fileReads.append(path)
            guard let item = items.first(where: { path.hasPrefix("/v0/artifacts/\($0.id)/") }), let data = item.picture else { return HTTP1Response(status: 404, body: Data("{}".utf8)) }
            return ArtifactDaemon.serve(.init(path: "picture.png", mimeType: "image/png", data: data), range: headers["Range"])
        }
        return HTTP1Response(status: 200, body: Data("{}".utf8))
    }

    func browserConnection() async throws -> any BrowserStream { throw URLError(.unsupportedURL) }
    func close() async {}

    private func object(_ item: Item) -> String {
        let ms = Int(item.updatedAt.timeIntervalSince1970 * 1000)
        let mime = item.type == "html" ? "text/html" : item.picture != nil ? "image/png" : "text/markdown"
        let path = item.type == "html" ? "index.html" : item.picture != nil ? "picture.png" : "README.md"
        let size = item.type == "html" ? 100 : item.picture?.count ?? 100
        let cover = item.aspect.map { aspect in
            let side = aspect == "wide" ? #""width":1600,"height":900"# : #""width":1200,"height":1200"#
            return ##","cover":{"path":"picture.png","mimeType":"image/png",\##(side),"aspect":"\##(aspect)"},"background":"#0b1f33""##
        } ?? ""
        return #"{"id":"\#(item.id)","type":"\#(item.type)","title":"\#(item.title)","status":"active","latestVersion":2,"entry":{"path":"\#(path)","mimeType":"\#(mime)","size":\#(size),"sha256":"0"},"fileCount":1,"live":null,"createdAt":\#(ms),"updatedAt":\#(ms)\#(cover)}"#
    }
}

/// The Artifacts screen home's fixed row opens: home's grouped cards split
/// by date, a picture's thumbnail, the bar's search, a pull's refresh, the
/// list kept for when the computer is away, and a row opening the viewer.
/// Pictures, light and dark, go to `.context/evidence/artifacts`.
@MainActor
final class HostedArtifactsListTests: XCTestCase {
    private var teardown: [() -> Void] = []

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    override func tearDown() async throws {
        for step in teardown { step() }
        teardown = []
    }

    static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/artifacts")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func capture(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "-ipad" : ""
        let file = "\(name)\(device)-\(window.traitCollection.userInterfaceStyle == .dark ? "dark" : "light")"
        let attachment = XCTAttachment(image: image)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(file).png"))
        }
    }

    private func wait(_ what: String, timeout: Duration = .seconds(10), _ done: () -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !done() {
            guard ContinuousClock.now < deadline else {
                XCTFail("timed out waiting for \(what)")
                throw CancellationError()
            }
            try await Task.sleep(for: .milliseconds(30))
        }
    }

    private static func days(_ count: Double, hours: Double = 0) -> Date {
        let midnight = Calendar.current.startOfDay(for: Date())
        return midnight.addingTimeInterval(-count * 86_400 + hours * 3600)
    }

    private static func fixture() -> [ArtifactCatalogDaemon.Item] {
        let picture = HostedArtifactMediaTests.png(CGSize(width: 320, height: 180), .systemTeal)
        let square = HostedArtifactMediaTests.png(CGSize(width: 240, height: 240), .systemOrange)
        // Today's ahead of now on the clock is still today.
        let today = min(Date(), days(0, hours: 9))
        return [
            .init(id: "a1", type: "markdown", title: "Q3 roadmap", updatedAt: today, picture: nil),
            .init(id: "a2", type: "image", title: "Team offsite photo", updatedAt: today.addingTimeInterval(-60), picture: picture, aspect: "wide"),
            .init(id: "a3", type: "html", title: "Pricing page prototype", updatedAt: days(1, hours: 16), picture: square, aspect: "square"),
            .init(id: "a4", type: "markdown", title: "Interview notes with the design partner, the longer write-up that wraps", updatedAt: days(3, hours: 11), picture: nil),
            .init(id: "a5", type: "video", title: "Onboarding walkthrough", updatedAt: days(12, hours: 10), picture: nil),
            .init(id: "a6", type: "document", title: "Signed contract", updatedAt: days(70), picture: nil),
            .init(id: "a7", type: "markdown", title: "Launch checklist", updatedAt: days(420), picture: nil),
        ]
    }

    private struct Opened {
        let window: UIWindow
        let navigation: UINavigationController
        let screen: ArtifactsViewController
        let session: Session
    }

    private func open(_ daemon: ArtifactCatalogDaemon, style: UIUserInterfaceStyle = .light) async throws -> Opened {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "artifacts-test", credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in daemon })
        await account.agentConnections.setForeground(false)
        let connection = try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"artifacts-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"native-secret"}"#.utf8)), name: "Studio Mac")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        let screen = ArtifactsViewController(session: session)
        let navigation = UINavigationController(rootViewController: UIViewController())
        HeaderBar.apply(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        window.overrideUserInterfaceStyle = style
        navigation.pushViewController(screen, animated: false)
        teardown.append {
            window.isHidden = true
            Session.forget(connection.id)
            Task { try? await account.agentConnections.remove(connection.id) }
        }
        return Opened(window: window, navigation: navigation, screen: screen, session: session)
    }

    private func rows(_ screen: ArtifactsViewController) -> [String] {
        screen.list.items.filter { $0.kind == .row }.map(\.id)
    }

    private func headings(_ screen: ArtifactsViewController) -> [String] {
        screen.list.items.filter { $0.kind == .heading }.map(\.accessibilityLabel)
    }

    func testTheCatalogInDateGroupsWithAThumbnailLightAndDark() async throws {
        let daemon = ArtifactCatalogDaemon(items: Self.fixture())
        let opened = try await open(daemon)
        let screen = opened.screen
        try await wait("the catalog") { rows(screen).count == 7 }
        XCTAssertEqual(rows(screen), ["a1", "a2", "a3", "a4", "a5", "a6", "a7"])

        let now = Date()
        let calendar = Calendar.current
        let words = Strings.Artifacts.DateWords.current
        let older = [Self.days(70), Self.days(420)].map { words.bucket(DateBucket.of($0, now: now, calendar: calendar), now: now, calendar: calendar) }
        XCTAssertEqual(headings(screen), ["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days"] + older)
        XCTAssertNotEqual(older[0], older[1], "a month last year names its year")

        // Every row is in its card, on the list's width; on an iPad the
        // cards hold to the readable column.
        let width = screen.list.contentWidth
        let column = CardColumn(width: width, maxWidth: .greatestFiniteMagnitude)
        XCTAssertEqual(column.x, 16)
        if UIDevice.current.userInterfaceIdiom == .pad { XCTAssertEqual(width, 800); XCTAssertEqual(column.width, 768) }
        for item in screen.list.items where item.kind == .row {
            XCTAssertEqual(item.size.width, width)
            XCTAssertEqual(item.card, CGRect(x: column.x, y: 0, width: column.width, height: item.size.height))
        }
        let places = screen.list.items.filter { $0.kind == .row }.map(\.place)
        XCTAssertEqual(places[0], CardPlace(first: true, last: false))
        XCTAssertEqual(places[1], CardPlace(first: false, last: true))
        XCTAssertEqual(places[2], .alone)
        XCTAssertEqual(Set(screen.list.items.filter { $0.kind == .row }.map(\.size.height)), [60], "a long title stays on one line: every row is one height")

        // Covers land in the rows' 16:9 slots: a wide one fills it, a
        // square stands whole in the middle.
        func cover(_ id: String) -> FeedCoverView? {
            guard let path = screen.artifacts[id]?.coverPath else { return nil }
            return screen.list.rowView(id)?.overlay(ArtifactListItems.coverKey(path)) as? FeedCoverView
        }
        try await wait("the covers") { cover("a2")?.loaded == true && cover("a3")?.loaded == true }
        let slot = try XCTUnwrap(screen.list.items.first { $0.id == "a2" }?.overlays.first?.frame)
        XCTAssertEqual(slot.size, ArtifactListMetrics.slot)
        XCTAssertEqual(cover("a2")?.frame.size, ArtifactListMetrics.slot)
        let square = try XCTUnwrap(screen.list.items.first { $0.id == "a3" }?.overlays.first?.frame)
        XCTAssertEqual(square, CGRect(x: slot.midX - 20, y: slot.minY, width: 40, height: 40))
        let files = await daemon.fileReads
        XCTAssertEqual(files.count, 2, "each read once: \(files)")
        XCTAssertNil(cover("a1"), "a document shows its kind's glyph")
        XCTAssertTrue(screen.list.items.first { $0.id == "a1" }?.overlays.isEmpty == true)

        try await Task.sleep(for: .milliseconds(300))
        capture(opened.window, "artifacts")

        opened.window.overrideUserInterfaceStyle = .dark
        try await wait("the dark drawing") { screen.list.items.first?.drawing.dark == true }
        try await Task.sleep(for: .milliseconds(300))
        capture(opened.window, "artifacts")
    }

    func testSearchFiltersByTitleAndKind() async throws {
        let opened = try await open(ArtifactCatalogDaemon(items: Self.fixture()))
        let screen = opened.screen
        try await wait("the catalog") { rows(screen).count == 7 }
        let search = try XCTUnwrap(screen.navigationItem.searchController)

        search.searchBar.text = "roadmap"
        screen.updateSearchResults(for: search)
        try await wait("one match") { rows(screen) == ["a1"] }
        XCTAssertEqual(headings(screen), ["Today"])

        search.searchBar.text = "web page"
        screen.updateSearchResults(for: search)
        try await wait("the web page") { rows(screen) == ["a3"] }

        search.searchBar.text = "nothing like this"
        screen.updateSearchResults(for: search)
        try await wait("no matches") { screen.list.items.map(\.accessibilityLabel) == [Strings.Artifacts.noMatches] }
        capture(opened.window, "artifacts-no-matches")

        search.searchBar.text = ""
        screen.updateSearchResults(for: search)
        try await wait("everything again") { rows(screen).count == 7 }
    }

    func testAPullReadsTheCatalogAgainAndARowOpensTheViewer() async throws {
        let daemon = ArtifactCatalogDaemon(items: Self.fixture())
        let opened = try await open(daemon)
        let screen = opened.screen
        try await wait("the catalog") { rows(screen).count == 7 }

        var items = Self.fixture()
        items.insert(.init(id: "new", type: "markdown", title: "Fresh report", updatedAt: Date(), picture: nil), at: 0)
        await daemon.set(items: items)
        screen.list.refreshing = true
        screen.list.onRefresh?()
        try await wait("the new artifact") { rows(screen).first == "new" }
        try await wait("the spinner to go") { !screen.list.refreshing }

        screen.list.onSelect?("a3")
        try await wait("the viewer") { opened.navigation.topViewController is ArtifactViewController }
        XCTAssertEqual(opened.navigation.topViewController?.title, "Pricing page prototype")
    }

    /// With the computer gone, the list opens on what it showed last.
    func testTheListIsKeptForWhenTheComputerIsAway() async throws {
        let daemon = ArtifactCatalogDaemon(items: Self.fixture())
        let opened = try await open(daemon)
        try await wait("the catalog") { rows(opened.screen).count == 7 }
        // Written behind the screen: give it a moment.
        try await Task.sleep(for: .milliseconds(300))
        await daemon.set(failing: true)

        let again = ArtifactsViewController(session: opened.session)
        opened.navigation.popViewController(animated: false)
        opened.navigation.pushViewController(again, animated: false)
        try await wait("the kept catalog") { rows(again).count == 7 }
        XCTAssertEqual(rows(again), rows(opened.screen))
    }

    func testAComputerWithNoArtifactsSaysSo() async throws {
        let opened = try await open(ArtifactCatalogDaemon(items: []), style: .dark)
        try await wait("the empty note") { opened.screen.list.items.map(\.accessibilityLabel) == [Strings.Artifacts.empty] }
        capture(opened.window, "artifacts-empty")
    }
}
#endif

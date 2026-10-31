#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct PlaceholderOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct PlaceholderNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A computer whose person has a name and no photo, and that answers
/// nothing else.
private struct PlaceholderDaemon: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        switch (method, path) {
        case ("GET", "/v0/profile"):
            return HTTP1Response(status: 200, body: Data(#"{"profile":{"email":null,"name":"Alex Rivera","photo":null,"userId":null,"updatedAt":1,"version":"0199a000-0000-7000-8000-000000000001"}}"#.utf8))
        default:
            return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
        }
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
    func reset() async {}
    func close() async {}
}

/// Accounts and agent connections without a picture of their own wear the
/// placeholder their ID picks, and every kind is drawn alike: a legacy
/// account, one made for a computer and an agent connection differ only in
/// their name and picture, in the switcher's menu, Settings' accounts card,
/// Settings' agent picture and the Profile page. Pictures go to the
/// repository's `.context/evidence/placeholders`.
@MainActor
final class HostedAccountPlaceholderTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/placeholders")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func capture(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let file = "\(name)-\(window.traitCollection.userInterfaceStyle == .dark ? "dark" : "light")"
        let attachment = XCTAttachment(image: image)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(file).png"))
        }
    }

    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "timed out", file: file, line: line)
    }

    /// One of each kind, none with a picture: an account made for a
    /// computer, a legacy one (active), and an agent connection.
    private func accounts() async throws -> (AccountController, AppContext, computerID: String) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in PlaceholderDaemon() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: PlaceholderOffline(), connector: PlaceholderNoSocket()
        )
        try await controller.signIn(Credentials(token: "made", secret: Data(repeating: 41, count: 32)), origin: .madeForComputer)
        try await controller.signIn(Credentials(token: "legacy", secret: Data(repeating: 42, count: 32)))
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"placeholder-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let kinds = controller.accounts.map { $0.isAgentConnection ? "agent" : $0.isLegacy ? "legacy" : "made" }
        XCTAssertEqual(kinds.sorted(), ["agent", "legacy", "made"], "the fixture is not one of each kind")
        return (controller, AppContext(account: controller, variant: .preview, version: "test"), computer.id)
    }

    private func host(_ root: UIViewController) async throws -> (UINavigationController, UIWindow) {
        let navigation = UINavigationController(rootViewController: root)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        window.overrideUserInterfaceStyle = .light
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        return (navigation, window)
    }

    private static func pixels(_ image: UIImage) -> Data? {
        image.pngData()
    }

    // MARK: The switcher's menu

    /// UIKit draws a menu row from its inputs: a symbol and a bitmap, or an
    /// item with a subtitle and one without, are laid out differently. So
    /// every account's item has the same inputs but its name and picture.
    func testTheMenuDrawsALegacyAComputersAndAnAgentAccountAlike() async throws {
        let (controller, context, _) = try await accounts()
        let accounts = controller.accounts
        let host = UIViewController()
        let switcher = AccountSwitcher(context: context, controller: host)
        try await until { switcher.loadedPictureIDs.isSuperset(of: accounts.map(\.id)) }

        let actions = switcher.menuElements().flatMap { ($0 as? UIMenu)?.children ?? [$0] }.compactMap { $0 as? UIAction }
        let rows = accounts.compactMap { account in actions.first { $0.accessibilityIdentifier == "account-\(account.id)" } }
        XCTAssertEqual(rows.count, 3, "an account is missing from the menu")
        let first = try XCTUnwrap(rows.first)
        let firstImage = try XCTUnwrap(first.image)
        for row in rows {
            let image = try XCTUnwrap(row.image, "\(row.title) has no picture")
            XCTAssertFalse(row.title.isEmpty)
            XCTAssertNil(row.subtitle, "\(row.title) has a subtitle")
            XCTAssertEqual(row.attributes, first.attributes, row.title)
            XCTAssertFalse(image.isSymbolImage, "\(row.title) wears a symbol")
            XCTAssertNil(image.symbolConfiguration, row.title)
            XCTAssertEqual(image.size, CGSize(width: AccountSwitcher.menuPicture, height: AccountSwitcher.menuPicture), row.title)
            XCTAssertEqual(image.scale, firstImage.scale, row.title)
            XCTAssertEqual(image.renderingMode, .alwaysOriginal, row.title)
            XCTAssertEqual(image.cgImage?.width, firstImage.cgImage?.width, row.title)
            XCTAssertEqual(image.cgImage?.alphaInfo, firstImage.cgImage?.alphaInfo, row.title)
        }
        XCTAssertEqual(rows.filter { $0.state == .on }.count, 1, "not exactly one tick")
        // Each its own placeholder, not the empty circle still.
        let pending = AvatarPlaceholderImages.pending(side: AccountSwitcher.menuPicture).pngData()
        let drawn = rows.compactMap { $0.image.flatMap(Self.pixels) }
        XCTAssertFalse(drawn.contains { $0 == pending }, "a picture is still the empty circle")
        let seeds = accounts.map { ProfilePictures.placeholderSeed($0, context: context) }
        XCTAssertEqual(Set(seeds.map(AvatarPlaceholder.index)).count, 3, "the fixture's three seeds share a picture")
        XCTAssertEqual(Set(drawn).count, 3, "two accounts wear the same picture")
        // An agent connection is picked by its computer, an account by its ID.
        let agent = try XCTUnwrap(accounts.first(where: \.isAgentConnection))
        XCTAssertEqual(ProfilePictures.placeholderSeed(agent, context: context), "agent:placeholder-test")
        let legacy = try XCTUnwrap(accounts.first(where: \.isLegacy))
        XCTAssertEqual(ProfilePictures.placeholderSeed(legacy, context: context), legacy.id)
        withExtendedLifetime(switcher) {}
    }

    // MARK: Settings

    func testSettingsDrawsEveryAccountAlikeAndTheAgentWearsItsPlaceholder() async throws {
        let (controller, context, computerID) = try await accounts()
        let settings = SettingsViewController(context: context, computer: computerID)
        let (_, window) = try await host(settings)
        let ids = controller.accounts.map { "account:\($0.id)" }
        try await until {
            ids.allSatisfy { settings.shownRow($0)?.image != nil } && settings.agentButton.picture != nil
                && settings.shownRow("profile")?.image != nil
        }
        let rows = ids.compactMap { settings.shownRow($0) }
        XCTAssertEqual(rows.count, 3)
        for row in rows {
            XCTAssertTrue(row.avatar, "\(row.title) is not drawn as an account")
            XCTAssertNil(row.icon, "\(row.title) keeps a glyph to fall back on")
            XCTAssertTrue(row.value == nil || row.value == "✓", "\(row.title) has a line of its own: \(row.value ?? "")")
            XCTAssertEqual(row.image?.size, rows[0].image?.size, row.title)
        }
        XCTAssertEqual(rows.filter { $0.value == "✓" }.count, 1)
        // The big picture is the one the card shows for it.
        XCTAssertTrue(settings.agentButton.picture === settings.shownRow("account:\(computerID)")?.image)
        settings.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(300))
        capture(window, "settings-agent")
        window.overrideUserInterfaceStyle = .dark
        try await Task.sleep(for: .milliseconds(300))
        capture(window, "settings-agent")
        withExtendedLifetime(controller) {}
    }

    // MARK: Profile

    /// The person without a photo wears their placeholder on the Profile
    /// page and its Settings row, and no "Remove Photo".
    func testTheProfilePageWearsThePersonsPlaceholder() async throws {
        let (controller, context, computerID) = try await accounts()
        let session = try XCTUnwrap(Session.session(for: computerID, context: context))
        let page = ProfileViewController(source: session.profile)
        let (_, window) = try await host(page)
        try await until { page.nameField.text == "Alex Rivera" && page.shownAvatar != nil }
        XCTAssertNil(page.shownPhoto, "a photo shows where there is none")
        XCTAssertTrue(page.shownAvatar === session.profile.placeholder)
        XCTAssertEqual(session.profile.placeholderSeed, "person:agent:placeholder-test")
        let expected = await AvatarPlaceholderImages.image(seed: session.profile.placeholderSeed, side: ProfileLayout.Metrics.avatar)
        XCTAssertTrue(page.shownAvatar === expected)
        XCTAssertEqual(page.shownRowIDs, [["profile-name"]], "Remove Photo without a photo")
        try await Task.sleep(for: .milliseconds(300))
        capture(window, "profile")
        window.overrideUserInterfaceStyle = .dark
        try await Task.sleep(for: .milliseconds(300))
        capture(window, "profile")
        withExtendedLifetime(controller) {}
    }
}
#endif

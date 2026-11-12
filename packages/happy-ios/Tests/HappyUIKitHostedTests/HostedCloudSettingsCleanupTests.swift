#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct CleanupTransport: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        if path == "/v0/surfaces" {
            return HTTP1Response(status: 200, body: Data(#"{"surfaces":[{"id":"policy","type":"vault","name":"Instructions","access":"write","policyVault":true}]}"#.utf8))
        }
        return HTTP1Response(status: 404)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.notConnectedToInternet) }
    func reset() async {}
    func close() async {}
}

@MainActor
final class HostedCloudSettingsCleanupTests: XCTestCase {
    private func rig(server: String?) async throws -> (AppContext, String) {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "cleanup-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in CleanupTransport() })
        await account.agentConnections.setForeground(false)
        let connection: AgentConnection
        if let server {
            connection = try await account.agentConnections.addServer(AgentOrigin(server),
                signIn: ServerSignInRecord(method: HappyCloud.method(server: server), grant: OAuthGrant(clientId: "test"), userId: "me"),
                access: OAuthAccess(token: "test", expiresAt: nil), name: "Settings test")
        } else {
            let credentials = try JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"cleanup-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8))
            connection = try await account.agentConnections.add(credentials, name: "Paired test")
        }
        addTeardownBlock { @MainActor in
            Session.forget(connection.id)
            try? await account.agentConnections.remove(connection.id)
        }
        return (AppContext(account: account, variant: .preview, version: "test"), connection.id)
    }

    private func host(_ controller: UIViewController) async throws -> UINavigationController {
        let navigation = UINavigationController(rootViewController: controller)
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in window.isHidden = true; previous?.makeKey() }
        window.layoutIfNeeded()
        return navigation
    }

    private func until(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition())
    }

    private func checkProjects(server: String?, offered: Bool) async throws {
        let (context, id) = try await rig(server: server)
        let settings = SettingsViewController(context: context, computer: id)
        let navigation = try await host(settings)
        settings.tapRow("appearance")
        try await until { navigation.topViewController is SettingsPageViewController && navigation.transitionCoordinator == nil }
        let appearance = try XCTUnwrap(navigation.topViewController as? SettingsPageViewController)
        XCTAssertEqual(appearance.shownRowIDs.joined().contains("hide-projects"), offered)

        navigation.popToRootViewController(animated: false)
        let search = try XCTUnwrap(settings.navigationItem.searchController)
        settings.willPresentSearchController(search)
        search.searchBar.text = "Hide projects"
        settings.updateSearchResults(for: search)
        XCTAssertEqual(settings.shownRowIDs.joined().contains("hide-projects"), offered)
        settings.willDismissSearchController(search)

        let home = HomeViewController(context: context, computer: id)
        navigation.setViewControllers([home], animated: false)
        home.loadViewIfNeeded()
        home.beginSearch()
        home.search("Hide projects")
        let results = try XCTUnwrap(home.view.subviews.compactMap { $0 as? HomeSearchResultsView }.first)
        XCTAssertEqual(results.list.shownRows.contains { $0.id == "search:settings:hide-projects" }, offered)
    }

    func testCloudHasNoProjectVisibilitySettingOrSearchResult() async throws {
        try await checkProjects(server: HappyCloud.server(named: "settings-test"), offered: false)
    }

    func testSelfHostedKeepsProjectVisibility() async throws {
        try await checkProjects(server: "https://self-hosted.example", offered: true)
    }

    func testPairedAgentKeepsProjectVisibility() async throws {
        try await checkProjects(server: nil, offered: true)
    }

    /// A Happy Cloud server signs in through the Cloud account: its page has
    /// no Server row and no Sign In Again; a self-hosted server keeps both.
    func testOnlySelfHostedServersShowTheServerAndSignInAgain() async throws {
        for (server, shown) in [(HappyCloud.server(named: "settings-test"), false), ("https://self-hosted.example", true)] {
            let (context, id) = try await rig(server: server)
            let settings = SettingsViewController(context: context, computer: id)
            _ = try await host(settings)
            XCTAssertEqual(settings.shownRow("server") != nil, shown, "\(server): \(settings.shownRowIDs)")
            XCTAssertEqual(settings.shownRow("server-sign-in") != nil, shown, "\(server): \(settings.shownRowIDs)")
            XCTAssertNotNil(settings.shownRow("disconnect"), "\(server) can't be signed out of")
        }
    }

    /// Privacy is a card of its own, and its page holds this phone's
    /// Analytics switch with the words on what it shares.
    func testPrivacyIsACardOfItsOwnWithAnalyticsOnItsPage() async throws {
        let (context, id) = try await rig(server: HappyCloud.server(named: "settings-test"))
        let settings = SettingsViewController(context: context, computer: id)
        let navigation = try await host(settings)
        XCTAssertTrue(settings.shownRowIDs.contains([SettingsIndex.privacySettings.id]), "\(settings.shownRowIDs)")
        XCTAssertNil(settings.shownRow(SettingsIndex.analytics.id))
        XCTAssertEqual(settings.shownRow(SettingsIndex.privacySettings.id)?.title, Strings.SettingsAccount.privacy)
        settings.tapRow(SettingsIndex.privacySettings.id)
        try await until { navigation.topViewController is SettingsPageViewController && navigation.transitionCoordinator == nil }
        let page = try XCTUnwrap(navigation.topViewController as? SettingsPageViewController)
        XCTAssertEqual(page.title, Strings.SettingsAccount.privacy)
        XCTAssertEqual(page.shownRowIDs, [[SettingsIndex.analytics.id]])
        XCTAssertEqual(page.shownFooters, [Strings.SettingsAccount.privacyDescription])
    }

    /// The AI providers row and its page read Inference, desktop's word;
    /// its id stays `providers`, which links and search keep.
    func testTheProvidersRowReadsInference() async throws {
        let (context, id) = try await rig(server: HappyCloud.server(named: "settings-test"))
        let settings = SettingsViewController(context: context, computer: id)
        let navigation = try await host(settings)
        XCTAssertEqual(settings.shownRow(SettingsIndex.providers.id)?.title, "Inference", "\(settings.shownRowIDs)")
        settings.tapRow(SettingsIndex.providers.id)
        try await until { navigation.topViewController is ProvidersViewController && navigation.transitionCoordinator == nil }
        XCTAssertEqual(navigation.topViewController?.title, "Inference")
    }

    /// Desktop's sidebar, group for group: the unheaded first group
    /// (Appearance, Profile, Voice, Data and Storage), then Agents (the
    /// Agents row, then Inference and Compute on Cloud only); the phone's
    /// own cards where they were.
    func testSettingsAreGroupedAsDesktopsSidebar() async throws {
        for (server, agentsGroup) in [(HappyCloud.server(named: "settings-test"), true), ("https://self-hosted.example", false), (nil, false)] {
            let (context, id) = try await rig(server: server)
            let settings = SettingsViewController(context: context, computer: id)
            let navigation = try await host(settings)
            let cards = settings.shownRowIDs
            if let window = navigation.view.window, let scroll = settings.view.subviews.compactMap({ $0 as? UIScrollView }).first {
                // The groups, for a person to look at: the page scrolled to its first group.
                scroll.setContentOffset(CGPoint(x: 0, y: 330 - scroll.adjustedContentInset.top), animated: false)
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                let shot = XCTAttachment(image: image)
                shot.name = "settings-groups-\(agentsGroup ? "cloud" : server == nil ? "paired" : "self-hosted")"
                shot.lifetime = .keepAlways
                add(shot)
            }
            let first = try XCTUnwrap(cards.firstIndex { $0.contains(SettingsIndex.appearance.id) }, "\(server ?? "paired"): \(cards)")
            XCTAssertEqual(cards[first], [SettingsIndex.appearance.id, SettingsIndex.profile.id, SettingsIndex.agentVoice.id, SettingsIndex.dataStorage.id])
            XCTAssertEqual(cards[first + 1], [SettingsIndex.supportBoba.id])
            XCTAssertEqual(cards[first + 2].first, SettingsIndex.agents.id)
            XCTAssertEqual(cards[first + 2].contains(SettingsIndex.providers.id), agentsGroup, "\(cards)")
            XCTAssertEqual(settings.shownHeaders, ["AGENTS"])
            XCTAssertEqual(cards[first + 3], [SettingsIndex.privacySettings.id])
            XCTAssertEqual(cards.last, ["disconnect"])
        }
    }

    func testLocalSearchKeepsThePolicyVaultLock() async throws {
        let (context, id) = try await rig(server: HappyCloud.server(named: "settings-test"))
        let home = HomeViewController(context: context, computer: id)
        _ = try await host(home)
        home.beginSearch()
        home.search("Instructions")
        let results = try XCTUnwrap(home.view.subviews.compactMap { $0 as? HomeSearchResultsView }.first)
        try await until { results.list.shownRows.contains { $0.label == "Instructions" } }
        XCTAssertEqual(results.list.shownRows.first { $0.label == "Instructions" }?.mark, .glyph(Rows.lockGlyph))
    }
}
#endif
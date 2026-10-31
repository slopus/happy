#if canImport(UIKit)
import Foundation
import HappyCore
import HappyCrypto
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

private struct Unreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// One Settings for both kinds of profile: a computer's page and a Happy
/// account's in the same order and the same cards, Support us on both,
/// Voice and Backup & Restore in settings' cards, and no connected
/// services or Manage Accounts left. Pictures go to the repository's
/// `.context/evidence/settings-unified`.
@MainActor
final class HostedSettingsUnifiedTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/settings-unified")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    /// The window light, then dark, each kept as `name`.
    private func capture(_ window: UIWindow, _ name: String) async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(300))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let file = "\(name)-\(style == .dark ? "dark" : "light")"
            let attachment = XCTAttachment(image: image)
            attachment.name = file
            attachment.lifetime = .keepAlways
            add(attachment)
            if let folder = Self.evidence, let data = image.pngData() {
                try? data.write(to: folder.appendingPathComponent("\(file).png"))
            }
        }
        window.overrideUserInterfaceStyle = .light
    }

    /// A signed-in Happy account, with `computers` agent connections.
    private func rig(computers: Int = 0) async throws -> (account: AccountController, context: AppContext, computers: [String]) {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        try await account.signIn(Credentials(token: "t", secret: Data(repeating: 1, count: 32)))
        await account.agentConnections.setForeground(false)
        var ids: [String] = []
        for index in 0..<computers {
            let computer = try await account.agentConnections.add(
                JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"unified-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
                name: "Mac \(index + 1)"
            )
            ids.append(computer.id)
            addTeardownBlock { @MainActor in
                Session.forget(computer.id)
                try? await account.agentConnections.remove(computer.id)
            }
        }
        return (account, AppContext(account: account, variant: .preview, version: "test"), ids)
    }

    private func host(_ controller: UIViewController) async throws -> (UINavigationController, UIWindow) {
        let navigation = UINavigationController(rootViewController: controller)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.rootViewController?.presentedViewController?.dismiss(animated: false)
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        return (navigation, window)
    }

    private func until(_ seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            if Date() > deadline { return false }
            try await Task.sleep(for: .milliseconds(20))
        }
        return true
    }

    /// The rows connected services and Manage Accounts had.
    private static let removed = ["claude", "github", "connected-accounts", "manage-accounts", "status"]

    // MARK: Both pages

    func testAHappyAccountsPageHasTheSharedOrder() async throws {
        let (account, context, _) = try await rig()
        let id = try XCTUnwrap(account.session?.keys.anonID)
        let settings = SettingsViewController(context: context, computer: nil)
        let (navigation, window) = try await host(settings)
        let shown = try await until { settings.shownRow("account") != nil }
        XCTAssertTrue(shown, "the account's page never showed: \(settings.shownRowIDs)")

        XCTAssertEqual(settings.shownRowIDs, [
            ["account:\(id)", SettingsIndex.connectAgent.id],
            ["account", "backup-restore"],
            ["appearance", "language", "voice", "agents"],
            ["scan-terminal", "enter-terminal"],
            ["support-us"],
            SettingsIndex.aboutRows.map(\.id),
            ["sign-out"],
        ])
        // What home's search knows is what the page shows, in its order.
        XCTAssertEqual(SettingsIndex.happyAccount.map(\.id), Array(settings.shownRowIDs.dropFirst().dropLast().joined()))
        for gone in Self.removed { XCTAssertNil(settings.shownRow(gone), "\(gone) is still on the page") }
        // Signing it out is its row's hold too, as Manage Accounts did.
        XCTAssertEqual(settings.shownRow("account:\(id)")?.menu.map(\.title), [Strings.signOut])
        XCTAssertEqual(settings.shownRow("voice")?.title, Strings.Voice.title)
        XCTAssertFalse(AccountSwitcher(context: context, controller: settings).menuElements().contains { menu in
            (menu as? UIMenu)?.children.contains { ($0 as? UIAction)?.identifier.rawValue == "account-manage" || ($0 as? UIAction)?.title == "Manage Accounts" } == true
        }, "the switcher still offers Manage Accounts")

        try await capture(window, "settings-happy-account")
        settings.view.layoutIfNeeded()
        let scroll = try XCTUnwrap(settings.view.subviews.compactMap { $0 as? UIScrollView }.first)
        scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)), animated: false)
        try await capture(window, "settings-happy-account-bottom")
        withExtendedLifetime(navigation) {}
    }

    func testAComputersPageHasTheSameOrder() async throws {
        let (account, context, computers) = try await rig(computers: 1)
        let computer = try XCTUnwrap(computers.first)
        let happy = try XCTUnwrap(account.session?.keys.anonID)
        let settings = SettingsViewController(context: context, computer: computer)
        let (navigation, window) = try await host(settings)
        let shown = try await until { settings.shownRow("profile") != nil }
        XCTAssertTrue(shown, "the computer's page never showed: \(settings.shownRowIDs)")

        XCTAssertEqual(settings.shownRowIDs, [
            ["account:\(computer)", "account:\(happy)", SettingsIndex.connectAgent.id],
            ["profile"],
            ["appearance"],
            ["support-us"],
            SettingsIndex.aboutRows.map(\.id),
            ["disconnect"],
        ])
        // Voice runs on a Happy account's server and sessions; a computer
        // has neither, so its page has no Voice that would do nothing.
        XCTAssertNil(settings.shownRow("voice"))
        for gone in Self.removed { XCTAssertNil(settings.shownRow(gone), "\(gone) is still on the page") }
        XCTAssertEqual(settings.shownRow("account:\(computer)")?.menu.map(\.title), [Strings.disconnect])
        XCTAssertTrue(SettingsIndex.computer.contains(SettingsIndex.supportUs))

        try await capture(window, "settings-computer")
        withExtendedLifetime((navigation, account)) {}
    }

    func testSupportUsOpensFromBothKindsOfPage() async throws {
        let (account, context, computers) = try await rig(computers: 1)
        for computer in [nil, computers.first] {
            let settings = SettingsViewController(context: context, computer: computer)
            let (navigation, window) = try await host(settings)
            _ = try await until { settings.shownRow("support-us") != nil }
            settings.tapRow("support-us")
            let opened = try await until { navigation.topViewController is SupportUsViewController && navigation.transitionCoordinator == nil }
            XCTAssertTrue(opened, "\(computer ?? "Happy account"): Support us didn't open")
            window.isHidden = true
        }
        withExtendedLifetime(account) {}
    }

    // MARK: Support us

    func testSupportUsIsHonestAndItsLinksOpen() async throws {
        var opened: [URL] = []
        let page = SupportUsViewController(openURL: { opened.append($0); return true })
        let (_, window) = try await host(page)
        _ = try await until { !page.shownRowIDs.isEmpty }

        XCTAssertTrue(opened.isEmpty, "opening Support us must never open a purchase flow or store")
        XCTAssertEqual(page.title, Strings.SupportUs.title)
        XCTAssertEqual(page.shownRowIDs, [
            ["support-summary"],
            ["subscribe", "restore-purchases"],
            ["manage-subscriptions"],
            ["support-github", "support-privacy", "support-terms"],
        ])
        XCTAssertEqual(page.shownFooters, [Strings.SupportUs.unavailable, Strings.SupportUs.statusUnavailable, Strings.SupportUs.manageFooter])
        for id in ["subscribe", "restore-purchases"] {
            let row = try XCTUnwrap(page.shownRow(id))
            XCTAssertNil(row.action, "\(id) does something")
            XCTAssertTrue(row.dimmed)
            XCTAssertEqual(row.value, Strings.SupportUs.notAvailable)
            XCTAssertNotNil(row.hint)
            page.tapRow(id)
        }
        XCTAssertNil(page.presentedViewController, "unconfigured restore must not claim success or no purchases")
        XCTAssertTrue(opened.isEmpty)

        page.tapRow("manage-subscriptions")
        _ = try await until { opened.count == 1 }
        XCTAssertEqual(opened, [SupportUsViewController.manageSubscriptionsURL])
        page.tapRow("support-github")
        _ = try await until { opened.count == 2 }
        XCTAssertEqual(opened, [SupportUsViewController.manageSubscriptionsURL, Strings.Links.github])

        try await capture(window, "support-us")
    }

    func testALinkThatWontOpenSaysSo() async throws {
        let page = SupportUsViewController(openURL: { _ in false })
        _ = try await host(page)
        page.tapRow("support-terms")
        let told = try await until { (page.presentedViewController as? UIAlertController)?.message == Strings.SupportUs.linkFailed }
        XCTAssertTrue(told)
    }

    // MARK: Voice

    /// Voice's values are the account's synced settings, where
    /// `VoiceContext` reads them when the microphone is pressed.
    func testTheVoicePageKeepsItsValues() async throws {
        let (account, context, _) = try await rig()
        let session = try XCTUnwrap(account.session)
        var latest = SettingsSnapshot()
        let observation = session.store.observeSettings { latest = $0 }
        let settings = SettingsViewController(context: context, computer: nil)
        let (navigation, window) = try await host(settings)
        _ = try await until { settings.shownRow("voice") != nil }
        settings.tapRow("voice")
        let opened = try await until { navigation.topViewController is VoiceSettingsViewController && navigation.transitionCoordinator == nil }
        XCTAssertTrue(opened, "Voice didn't open: \(navigation.viewControllers)")
        let voice = try XCTUnwrap(navigation.topViewController as? VoiceSettingsViewController)
        _ = try await until { voice.shownRow("voice-usage-retry")?.action != nil }
        XCTAssertEqual(voice.shownRowIDs, [["voice-usage-retry"], ["voice-upgrade"], ["voice-language"], ["voice-agent-id", "voice-direct"]])
        XCTAssertEqual(voice.shownFooters.count, 4)

        // A switch is kept.
        XCTAssertEqual(voice.shownRow("voice-direct")?.isOn, false)
        voice.shownRow("voice-direct")?.toggled?(true)
        let kept = try await until { AccountSettings(latest).bool("voiceBypassToken") }
        XCTAssertTrue(kept, "Direct Connection didn't reach the account's settings")
        XCTAssertEqual(voice.shownRow("voice-direct")?.isOn, true)

        // A language is kept, and shows on the page it came back to.
        voice.tapRow("voice-language")
        let languages = try await until { navigation.topViewController is VoiceLanguageViewController && navigation.transitionCoordinator == nil }
        XCTAssertTrue(languages)
        let list = try XCTUnwrap(navigation.topViewController as? VoiceLanguageViewController)
        XCTAssertEqual(list.shownRowIDs.first?.count, VoiceLanguage.all.count)
        list.tapRow("voice-language:de-DE")
        let back = try await until { navigation.topViewController === voice && navigation.transitionCoordinator == nil }
        XCTAssertTrue(back)
        let chosen = try await until { AccountSettings(latest).string("voiceAssistantLanguage") == "de-DE" && voice.shownRow("voice-language")?.value == "Deutsch" }
        XCTAssertTrue(chosen, "the language wasn't kept: \(String(describing: voice.shownRow("voice-language")?.value))")

        // A page opened afresh reads them back.
        let again = VoiceSettingsViewController(context: context, session: session)
        again.loadsUsage = false
        navigation.pushViewController(again, animated: false)
        let reread = try await until { again.shownRow("voice-direct")?.isOn == true && again.shownRow("voice-language")?.value == "Deutsch" }
        XCTAssertTrue(reread)
        navigation.popViewController(animated: false)

        try await capture(window, "voice")
        withExtendedLifetime(observation) {}
    }

    // MARK: Account, Backup & Restore

    func testBackupShowsTheKeyAndRestoreIsReachable() async throws {
        let (account, context, _) = try await rig()
        let session = try XCTUnwrap(account.session)
        let settings = SettingsViewController(context: context, computer: nil)
        let (navigation, window) = try await host(settings)
        _ = try await until { settings.shownRow("backup-restore") != nil }
        settings.tapRow("backup-restore")
        let opened = try await until { navigation.topViewController is BackupSettingsViewController && navigation.transitionCoordinator == nil }
        XCTAssertTrue(opened)
        let backup = try XCTUnwrap(navigation.topViewController as? BackupSettingsViewController)
        XCTAssertTrue(backup.isLegacy)
        XCTAssertEqual(backup.shownRowIDs, [["secret-key"], ["link-device"], ["restore"]])
        XCTAssertEqual(backup.shownFooters, [Strings.SettingsAccount.backupDescription, Strings.BackupRestore.linkFooter, Strings.BackupRestore.restoreFooter])
        XCTAssertFalse(backup.shownRowIDs.joined().contains("secret-key-text"), "the key shows before it is asked for")
        try await capture(window, "backup-restore")

        backup.tapRow("secret-key")
        XCTAssertEqual(backup.shownRowIDs.first, ["secret-key", "secret-key-text", "copy-secret-key"])
        XCTAssertEqual(backup.shownRow("secret-key-text")?.title, SecretKeyBackup.format(secret: session.keys.secret))
        XCTAssertEqual(backup.shownRow("secret-key")?.title, Strings.BackupRestore.hideKey)
        try await capture(window, "backup-restore-revealed")
        backup.tapRow("secret-key")
        XCTAssertEqual(backup.shownRowIDs.first, ["secret-key"])

        // Restore, as Add's other ways have it, over this account.
        backup.tapRow("restore")
        let restore = try await until { ((backup.presentedViewController as? UINavigationController)?.viewControllers.first is RestoreQRViewController) }
        XCTAssertTrue(restore, "Restore didn't open: \(String(describing: backup.presentedViewController))")
        context.account.cancelAddingAccount()
        backup.presentedViewController?.dismiss(animated: false)
        withExtendedLifetime(navigation) {}
    }

    func testTheAccountPageHasWhatTheOldOneDid() async throws {
        let (account, context, _) = try await rig()
        let session = try XCTUnwrap(account.session)
        let page = AccountSettingsViewController(context: context, session: session)
        page.loadsPush = false
        let (_, window) = try await host(page)
        _ = try await until { !page.shownRowIDs.isEmpty }
        XCTAssertEqual(page.shownRowIDs, [
            ["analytics-id", "public-id", "server"],
            ["analytics"],
            ["push-permission", "push-request", "push-reregister"],
            ["push-none"],
        ])
        XCTAssertEqual(page.shownRow("analytics-id")?.value, session.keys.anonID)
        XCTAssertEqual(page.shownRow("server")?.value, Strings.BackupRestore.defaultServer)
        try await capture(window, "account")
    }

    // MARK: Search

    /// A row on a page of its own is found from Settings, and opens there.
    func testSearchFindsTheAccountsPages() async throws {
        let (_, context, _) = try await rig()
        let settings = SettingsViewController(context: context, computer: nil)
        let (navigation, _) = try await host(settings)
        _ = try await until { settings.shownRow("backup-restore") != nil }
        let search = try XCTUnwrap(settings.navigationItem.searchController)
        settings.willPresentSearchController(search)
        for (query, id) in [("secret", "secret-key"), ("voice", "voice"), ("manage subscriptions", "manage-subscriptions"), ("link new", "link-device")] {
            search.searchBar.text = query
            settings.updateSearchResults(for: search)
            XCTAssertTrue(settings.shownRowIDs.joined().contains(id), "\(query): \(settings.shownRowIDs)")
        }
        search.searchBar.text = "github"
        settings.updateSearchResults(for: search)
        XCTAssertEqual(settings.shownRowIDs.joined().filter { $0.contains("github") }, ["github-repo"], "GitHub is found twice, or as a connection")
        search.searchBar.text = "secret"
        settings.updateSearchResults(for: search)
        settings.tapRow("secret-key")
        let opened = try await until { navigation.topViewController is BackupSettingsViewController && navigation.transitionCoordinator == nil }
        XCTAssertTrue(opened, "the found row didn't open its page: \(navigation.viewControllers)")
        let backup = try XCTUnwrap(navigation.topViewController as? BackupSettingsViewController)
        XCTAssertFalse(backup.shownRowIDs.joined().contains("secret-key-text"), "a search showed the key by itself")
    }

    /// Back steps aside while the bar's search is open, so on a wide phone
    /// the field closes straight into its button in one motion, and comes
    /// back with the title as it closes; leaving mid-search still works.
    func testBackStepsAsideWhileSearching() async throws {
        let (account, context, _) = try await rig()
        let root = UIViewController()
        let (navigation, window) = try await host(root)
        let settings = SettingsViewController(context: context, computer: nil)
        navigation.pushViewController(settings, animated: false)
        window.layoutIfNeeded()
        _ = try await until { settings.shownRow("account") != nil }
        try await Task.sleep(for: .milliseconds(500))
        let search = try XCTUnwrap(settings.navigationItem.searchController)
        XCTAssertFalse(settings.navigationItem.hidesBackButton)
        search.isActive = true
        let opened = try await until { settings.navigationItem.hidesBackButton && search.isActive }
        XCTAssertTrue(opened, "Back is still beside the field: active \(search.isActive) hidden \(settings.navigationItem.hidesBackButton)")
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(settings.title, Strings.Settings.title, "the page lost its title")
        let edge = try XCTUnwrap(navigation.interactivePopGestureRecognizer)
        XCTAssertEqual(edge.delegate?.gestureRecognizerShouldBegin?(edge), true, "the edge swipe can't go back while searching")
        search.isActive = false
        let closed = try await until { !settings.navigationItem.hidesBackButton && navigation.transitionCoordinator == nil }
        XCTAssertTrue(closed, "Back didn't come back")
        XCTAssertEqual(settings.shownRowIDs.first?.last, SettingsIndex.connectAgent.id)

        // Gone mid-search: back where it came from, the search with it.
        search.isActive = true
        _ = try await until { settings.navigationItem.hidesBackButton }
        try await Task.sleep(for: .milliseconds(500))
        navigation.popViewController(animated: true)
        let left = try await until { navigation.topViewController === root && navigation.transitionCoordinator == nil }
        XCTAssertTrue(left, "\(navigation.viewControllers)")
        XCTAssertFalse(search.isActive)
        withExtendedLifetime(account) {}
    }
}
#endif

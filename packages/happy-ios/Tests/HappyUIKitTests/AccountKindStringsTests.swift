#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// Happy Agent and Happy CLI, as the screens name the two kinds of
/// account, in English and in another language.
@MainActor
final class AccountKindStringsTests: XCTestCase {
    override func tearDown() {
        AppLocalization.use(nil)
        super.tearDown()
    }

    func testTheKindsAreNamedByTheirProducts() {
        AppLocalization.use(nil)
        let base = ServerConfig.defaultServerURL
        let legacy = AccountSummary(id: "aaaaaaaaaaaaaaaa", serverURL: base, isActive: true, usesSharedItem: true)
        var made = AccountSummary(id: "bbbbbbbbbbbbbbbb", serverURL: base, isActive: false, usesSharedItem: false)
        made.origin = .madeForComputer
        var agent = AccountSummary(id: "cccccccccccccccc", serverURL: base, isActive: false, usesSharedItem: false)
        agent.isAgentConnection = true
        XCTAssertEqual([legacy, made, agent].map(\.kindName), ["Happy CLI", "Happy CLI", "Happy Agent"])
        XCTAssertEqual([legacy, made].map(\.shownName), ["Happy CLI", "Happy CLI"], "an account with no name goes by its kind")
        made.computerName = "Steve’s MacBook"
        XCTAssertEqual(made.shownName, "Steve’s MacBook")

        XCTAssertEqual(Strings.AccountKind.subtitle(Strings.AccountKind.cli, "@steve"), "Happy CLI · @steve")
        XCTAssertEqual(Strings.AccountKind.subtitle(Strings.AccountKind.agent, "Connected"), "Happy Agent · Connected")
        XCTAssertEqual(Strings.AccountKind.subtitle(Strings.AccountKind.cli, nil), "Happy CLI")
        XCTAssertEqual(Strings.AccountKind.spoken("Studio Mac", Strings.AccountKind.agent), "Studio Mac, Happy Agent")
        XCTAssertEqual(Strings.AccountKind.spoken("Happy CLI", Strings.AccountKind.cli), "Happy CLI")

        XCTAssertEqual(Strings.addHappyAccount, "Add Happy CLI account")
        XCTAssertEqual(Strings.disconnectTitle, "Disconnect Happy Agent?")
        XCTAssertEqual(Strings.signOutTitle, "Sign out of Happy CLI?")
        XCTAssertEqual(Strings.AccountKind.connectAgent, "Connect Happy Agent")
        XCTAssertEqual(Strings.AccountKind.restoreCLIAccount, "Restore Happy CLI account")
        XCTAssertEqual(Strings.AccountKind.cliServer, "Happy CLI server")
        XCTAssertEqual(Strings.BackupRestore.restore, "Restore a Happy CLI Account")
        XCTAssertEqual(Strings.Scan.deviceNeedsAccount, "This code asks for a Happy CLI account. Add one on this phone first.")
        XCTAssertEqual(Strings.Start.enterLinkMessage, "Paste the link from Happy CLI on your computer or from Happy Agent.")
        XCTAssertEqual(Strings.AccountKind.agentUnreachable("Studio Mac"), "Can’t reach Studio Mac.\nCheck the Happy Agent connection, then reload.")
        // The scanner's other ways in name the kind they add.
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) })
        let context = AppContext(account: account, variant: .preview, version: "test")
        let titles = AccountAdding.otherWays(context: context, from: UIViewController()).map(\.title)
        XCTAssertEqual(titles, ["Connect to Happy Cloud", Strings.Start.enterLink, "Restore Happy CLI account", "Happy CLI server"])
        let production = AppContext(account: account, variant: .production, version: "test")
        XCTAssertEqual(AccountAdding.otherWays(context: production, from: UIViewController()).map(\.title), [Strings.Start.enterLink, "Restore Happy CLI account", "Happy CLI server"])
    }

    func testAnotherLanguageSaysTheWordsAroundTheNames() async {
        for code in ["ru", "ja", "zh-Hant"] {
            let catalog = await TranslationCatalog.load(code)
            AppLocalization.use(catalog)
            XCTAssertEqual(Strings.addHappyAccount, catalog("native.accountKind.addCLIAccount"), code)
            XCTAssertEqual(Strings.signOutTitle, catalog("native.accountKind.signOutCLITitle"), code)
            XCTAssertEqual(Strings.Scan.accountNotShareable, catalog("native.accountKind.accountNotShareable"), code)
            XCTAssertEqual(Strings.AccountKind.agentUnreachable("Studio Mac"), catalog("native.accountKind.agentUnreachable", ["name": "Studio Mac"]), code)
            XCTAssertNotEqual(Strings.addHappyAccount, "Add Happy CLI account", code)
            XCTAssertTrue(Strings.addHappyAccount.contains("Happy CLI"), code)
            XCTAssertTrue(Strings.disconnectTitle.contains("Happy Agent"), code)
            // The names themselves are never translated.
            XCTAssertEqual(Strings.legacyAccount, "Happy CLI", code)
            XCTAssertEqual(Strings.agentConnection, "Happy Agent", code)
        }
        XCTAssertEqual(Strings.signOutTitle, "登出 Happy CLI？")
    }
}
#endif

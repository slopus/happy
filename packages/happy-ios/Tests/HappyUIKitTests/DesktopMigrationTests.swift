#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The Happy CLI home's migration card.
@MainActor
final class DesktopMigrationTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    /// The card leads the notices and stands in for What's new, one
    /// announcement at a time; the store update still shows.
    func testTheCardLeadsAndTakesWhatsNewsPlace() {
        let header = HomeListHeaderView()
        header.content = HomeBanners(offlineTitle: "MacBook is offline", whatsNew: true, migration: .desktop)
        XCTAssertEqual(header.content.notices.map(\.title), [Strings.DesktopMigration.desktopTitle, "MacBook is offline"])
        let cards = header.subviews.compactMap { $0 as? ItemGroupView }.flatMap { $0.card.subviews.compactMap { $0 as? DesktopCardView } }
        XCTAssertEqual(cards.count, 1)
        header.content = HomeBanners(nativeUpdate: true, migration: .agentConnection)
        XCTAssertEqual(header.content.notices.map(\.title), [Strings.DesktopMigration.agentConnectionTitle, "App Update Available"])
    }

    /// PostHog's `direct-connection-migration-note` decides whether the
    /// card shows at all: off (or unknown) hides it, on shows the path's.
    func testTheFlagGatesTheCard() throws {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) })
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "desktop-migration-flag-test"))
        defaults.removePersistentDomain(forName: "desktop-migration-flag-test")
        XCTAssertNil(DesktopMigrationCard.path(account, serverAgent: false, flag: false, defaults: defaults))
        XCTAssertNil(DesktopMigrationCard.path(account, serverAgent: true, flag: false, defaults: defaults))
        XCTAssertEqual(DesktopMigrationCard.path(account, serverAgent: false, flag: true, defaults: defaults), .desktop)
        XCTAssertEqual(DesktopMigrationCard.path(account, serverAgent: true, flag: true, defaults: defaults), .agentConnection)
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        XCTAssertFalse(MigrationNoteFlag().isOn(settings, optedOut: false))
        settings.migrationNoteFlag = true
        XCTAssertTrue(MigrationNoteFlag().isOn(settings, optedOut: false))
    }

    /// VoiceOver reads the card as one button that opens the screen, with
    /// Close among its actions.
    func testVoiceOverOpensAndClosesTheCard() throws {
        let card = DesktopCardView(icon: .monitor, title: "Happy now on desktop", body: "Please migrate!")
        var opened = 0, closed = 0
        card.onOpen = { opened += 1 }
        card.onClose = { closed += 1 }
        XCTAssertTrue(card.isAccessibilityElement)
        XCTAssertEqual(card.accessibilityLabel, "Happy now on desktop")
        XCTAssertEqual(card.accessibilityValue, "Please migrate!")
        XCTAssertTrue(card.accessibilityTraits.contains(.button))
        XCTAssertTrue(card.accessibilityActivate())
        XCTAssertEqual(opened, 1)
        let close = try XCTUnwrap(card.accessibilityCustomActions?.first)
        XCTAssertEqual(close.name, Strings.DesktopMigration.close)
        XCTAssertTrue(close.actionHandler?(close) ?? false)
        XCTAssertEqual(closed, 1)
    }
}
#endif

#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The screens' strings in the language they speak (AppLocalization), and
/// English, exactly as before, while that is English.
@MainActor
final class LocalizedStringsTests: XCTestCase {
    override func tearDown() {
        AppLocalization.use(nil)
        super.tearDown()
    }

    func testEnglishIsTheScreensOwnWords() {
        AppLocalization.use(nil)
        XCTAssertEqual(Strings.Common.cancel, "Cancel")
        XCTAssertEqual(Strings.SessionHistory.daysAgo(1), "1 day ago")
        XCTAssertEqual(Strings.Troubleshoot.bannerTitleOne(name: "mini"), "mini is offline")
    }

    func testAnotherLanguageReadsItsCatalog() async {
        let japanese = await TranslationCatalog.load("ja")
        let russian = await TranslationCatalog.load("ru")
        AppLocalization.use(japanese)
        XCTAssertEqual(Strings.Common.cancel, japanese("common.cancel"))
        XCTAssertEqual(Strings.SettingsLanguage.title, "言語")
        AppLocalization.use(russian)
        XCTAssertEqual(Strings.SessionHistory.daysAgo(3), russian("sessionHistory.daysAgo", ["count": 3]))
        XCTAssertEqual(Strings.Items.copiedToClipboard(label: "ID"), russian("items.copiedToClipboard", ["label": "ID"]))
        // Home's notices take their words here, on the main thread.
        XCTAssertEqual(Strings.Home.whatsNew, "Что нового")
        XCTAssertEqual(HomeBanners(whatsNew: true).notices.map(\.subtitle), [russian("updateBanner.seeLatest")])
    }

    /// The header's connection status, Appearance's bubble colours and avatar
    /// styles, and the word in the `<unknown>` of a chat with no computer
    /// read the key happy-app's `t()` call reads (HomeHeaderTitle.tsx,
    /// appearance.tsx, ProjectHomeList.tsx), whose catalogs have words of
    /// their own.
    func testStatusColoursAndStylesFollowTheLanguage() async {
        let statuses: [(RealtimeStatus, String)] = [
            (.connected, "connected"), (.connecting, "connecting"), (.disconnected, "disconnected"), (.error, "error"),
        ]
        let colours = ["blue", "green", "purple", "rose", "sand", "gray"]
        let styles = ["pixelated", "gradient", "brutalist"]
        AppLocalization.use(nil)
        for (status, key) in statuses { XCTAssertEqual(Strings.Home.connectionStatus(status), TranslationCatalog.english("status.\(key)")) }
        for colour in colours {
            XCTAssertEqual(Strings.SettingsAppearance.bubbleColorName(colour), TranslationCatalog.english("settingsAppearance.userMessageBubbleColorOptions.\(colour)"))
        }
        for style in styles {
            XCTAssertEqual(Strings.SettingsAppearance.avatarStyleName(style), TranslationCatalog.english("settingsAppearance.avatarStyleOptions.\(style)"))
        }
        XCTAssertEqual(Strings.Home.unknownMachine, "unknown")
        for code in ["ru", "ja"] {
            let catalog = await TranslationCatalog.load(code)
            AppLocalization.use(catalog)
            for (status, key) in statuses {
                XCTAssertEqual(Strings.Home.connectionStatus(status), catalog("status.\(key)"), code)
                XCTAssertNotEqual(Strings.Home.connectionStatus(status), key, code)
            }
            for colour in colours {
                let words = catalog("settingsAppearance.userMessageBubbleColorOptions.\(colour)")
                XCTAssertEqual(Strings.SettingsAppearance.bubbleColorName(colour), words, code)
                XCTAssertNotEqual(words, colour.capitalized, code)
            }
            for style in styles {
                let words = catalog("settingsAppearance.avatarStyleOptions.\(style)")
                XCTAssertEqual(Strings.SettingsAppearance.avatarStyleName(style), words, code)
                XCTAssertNotEqual(words, style.capitalized, code)
            }
            XCTAssertEqual(Strings.Home.unknownMachine, catalog("status.unknown"), code)
            XCTAssertNotEqual(Strings.Home.unknownMachine, "unknown", code)
        }
    }

    /// Words happy-app spells out in its components are English there, so
    /// they are English here whatever the language.
    func testSpelledOutWordsStayEnglish() async {
        AppLocalization.use(await TranslationCatalog.load("ru"))
        XCTAssertEqual(Strings.Push.title, "Push Notifications")
        XCTAssertEqual(Strings.Push.registeredTokens(2), "Registered Tokens (2)")
        XCTAssertEqual(Strings.Agents.clearOverrides, "Clear Overrides")
        XCTAssertEqual(Strings.Home.dockPlaceholder, "Plan, ask, build…")
        XCTAssertEqual(Strings.Home.createWorkspaceIn("happy"), "Create workspace in happy")
        XCTAssertEqual(Strings.SettingsTitles.connectClaude, "Connect to Claude")
    }
}
#endif

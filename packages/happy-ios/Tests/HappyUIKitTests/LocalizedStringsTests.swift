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
}
#endif

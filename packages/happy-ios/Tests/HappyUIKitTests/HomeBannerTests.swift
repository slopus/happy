#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class HomeBannerTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func titles(_ header: HomeListHeaderView) -> [String] {
        header.subviews.compactMap { $0 as? ItemGroupView }.flatMap { group in
            group.card.subviews.compactMap { ($0 as? ItemRowView)?.titleLabel.string }
        }
    }

    func testTheStoreUpdateTakesWhatsNewsPlace() {
        let header = HomeListHeaderView()
        XCTAssertTrue(header.isEmpty)
        header.showsWhatsNew = true
        XCTAssertEqual(titles(header), ["What's new"])
        header.showsNativeUpdate = true
        XCTAssertEqual(titles(header), ["App Update Available"], "UpdateBanner shows one notice")
        header.offlineTitle = "MacBook is offline"
        XCTAssertEqual(titles(header), ["MacBook is offline", "App Update Available"])
    }

    /// The header draws the words its height was measured with, taken when
    /// the notices were decided, not read again when it draws.
    func testTheHeaderDrawsTheWordsItWasMeasuredWith() async {
        defer { AppLocalization.use(nil) }
        let english = HomeBanners(offlineTitle: "MacBook is offline", nativeUpdate: true)
        AppLocalization.use(await TranslationCatalog.load("ru"))
        let header = HomeListHeaderView()
        header.content = english
        XCTAssertEqual(titles(header), ["MacBook is offline", "App Update Available"])
        header.content = HomeBanners(whatsNew: true)
        XCTAssertEqual(titles(header), ["Что нового"])
    }
}
#endif

#if canImport(UIKit)
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
}
#endif

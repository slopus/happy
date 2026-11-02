import XCTest
@testable import HappyLayout

final class InstallDesktopLayoutTests: XCTestCase {
    private let phone = CGSize(width: 393, height: 852)
    /// Under the bar: 59 status bar and 44 bar.
    private let safe = LayoutInsets(top: 103, left: 0, bottom: 34, right: 0)

    private func layout(size: CGSize? = nil, button: CGSize = CGSize(width: 150, height: 56)) -> InstallDesktopLayout {
        InstallDesktopLayout(
            size: size ?? phone,
            safeArea: safe,
            title: .fixed(width: 300, height: 30),
            link: .fixed(width: 130, height: 20),
            description: .fixed(width: 290, height: 22),
            button: button
        )
    }

    /// Glyph, title, the line, the site, then Scan: download before scanning.
    func testTheSiteComesBeforeScan() {
        let layout = layout()
        XCTAssertEqual(layout.icon.size, CGSize(width: 56, height: 56))
        XCTAssertEqual(layout.title.minY, layout.icon.maxY + 20)
        XCTAssertEqual(layout.description.minY, layout.title.maxY + 8)
        XCTAssertEqual(layout.link.minY, layout.description.maxY + 4)
        XCTAssertEqual(layout.button.minY, layout.link.maxY + 20)
        for frame in [layout.icon, layout.title, layout.description, layout.link, layout.button] {
            XCTAssertEqual(frame.midX, 196.5, accuracy: 0.001)
        }
    }

    /// The site is a 40 tall target: 14 in, a 16 globe, 6, its label.
    func testTheSiteIsATarget() {
        let layout = layout()
        XCTAssertEqual(layout.link.size, CGSize(width: 14 + 16 + 6 + 130 + 14, height: 40))
        XCTAssertEqual(layout.linkIcon, CGRect(x: 14, y: 12, width: 16, height: 16))
        XCTAssertEqual(layout.linkLabel, CGRect(x: 36, y: 10, width: 130, height: 20))
    }

    func testCentredAboveTheBottomMargin() {
        let layout = layout()
        let height: CGFloat = 56 + 20 + 30 + 8 + 22 + 4 + 40 + 20 + 56
        let available: CGFloat = 852 - 103 - 34 - 32
        XCTAssertEqual(layout.icon.minY, 103 + (available - height) / 2, accuracy: 0.001)
        XCTAssertEqual(layout.button.width, 200)
        XCTAssertEqual(layout.contentHeight, 852)
    }

    func testTooTallItStartsAtTheTopAndScrolls() {
        let layout = layout(size: CGSize(width: 393, height: 300))
        XCTAssertEqual(layout.icon.minY, 103)
        XCTAssertEqual(layout.contentHeight, layout.button.maxY + 32 + 34)
    }
}

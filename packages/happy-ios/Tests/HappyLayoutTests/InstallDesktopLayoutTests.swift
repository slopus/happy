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

    /// Scan QR code is where Start was: 48 above the bottom inset, at least 200 wide.
    func testScanIsAtTheBottomWhereStartWas() {
        let layout = layout()
        XCTAssertEqual(layout.button, CGRect(x: 96.5, y: 852 - 34 - 48 - 56, width: 200, height: 56))
        XCTAssertEqual(layout.contentHeight, 852)
    }

    /// The art, title, the line, then the site, centred between the bar and Scan.
    func testTheWordsAreCentredAboveScan() {
        let layout = layout()
        XCTAssertEqual(layout.art.size, CGSize(width: 96, height: 96))
        XCTAssertEqual(layout.title.minY, layout.art.maxY + 24)
        XCTAssertEqual(layout.description.minY, layout.title.maxY + 8)
        XCTAssertEqual(layout.link.minY, layout.description.maxY + 4)
        XCTAssertEqual(layout.art.minY - 103, layout.button.minY - layout.link.maxY, accuracy: 0.001)
        for frame in [layout.art, layout.title, layout.description, layout.link, layout.button] {
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

    func testTooTallItKeepsSixteenAroundTheWordsAndScrolls() {
        let layout = layout(size: CGSize(width: 393, height: 300))
        XCTAssertEqual(layout.art.minY, 103 + 16)
        XCTAssertEqual(layout.button.minY, layout.link.maxY + 16)
        XCTAssertEqual(layout.contentHeight, layout.button.maxY + 48 + 34)
    }
}

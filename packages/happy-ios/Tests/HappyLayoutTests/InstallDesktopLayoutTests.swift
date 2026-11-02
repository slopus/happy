import XCTest
@testable import HappyLayout

final class InstallDesktopLayoutTests: XCTestCase {
    private let phone = CGSize(width: 393, height: 852)
    /// The window's: the bar is this screen's own and sits over the first screen's top row.
    private let safe = LayoutInsets(top: 59, left: 0, bottom: 34, right: 0)

    /// The first screen for the same window: four slides, two title lines and two body lines at the tallest.
    private func start(size: CGSize) -> StartLayout {
        let slides = [(1, 2), (2, 1), (1, 1), (2, 2)].map { lines in
            StartLayout.Slide(
                title: Measurable { CGSize(width: $0, height: CGFloat(lines.0) * 34) },
                body: Measurable { CGSize(width: $0, height: CGFloat(lines.1) * 24) }
            )
        }
        return StartLayout(size: size, safeArea: safe, button: CGSize(width: 120, height: 56), slides: slides, dots: CGSize(width: 120, height: 26))
    }

    private func layout(size: CGSize? = nil, description: CGFloat = 42) -> (InstallDesktopLayout, StartLayout) {
        let size = size ?? phone
        let start = start(size: size)
        let layout = InstallDesktopLayout(
            size: size,
            safeArea: safe,
            start: start,
            title: .fixed(width: 300, height: 26),
            link: .fixed(width: 210, height: 20),
            description: .fixed(width: 290, height: description),
            button: CGSize(width: 150, height: 56)
        )
        return (layout, start)
    }

    /// Scan QR code is where Start was: 48 above the bottom inset, at least 200 wide.
    func testScanIsWhereStartWas() {
        let (layout, start) = layout()
        XCTAssertEqual(layout.button, CGRect(x: 96.5, y: 852 - 34 - 48 - 56, width: 200, height: 56))
        XCTAssertEqual(layout.button.minY, start.button.minY)
        XCTAssertEqual(layout.contentHeight, 852)
    }

    /// The art is the slides' square at the slides' place; the words follow it as a slide's do.
    func testTheArtIsWhereTheSlidesArtIs() {
        let (layout, start) = layout()
        XCTAssertEqual(layout.art, start.art.offsetBy(dx: start.gallery.minX, dy: start.gallery.minY))
        XCTAssertEqual(layout.title.minY, layout.art.maxY + 24)
        XCTAssertEqual(layout.description.minY, layout.title.maxY + 8)
        XCTAssertEqual(layout.link.minY, layout.description.maxY + 4)
        for frame in [layout.art, layout.title, layout.description, layout.link, layout.button] {
            XCTAssertEqual(frame.midX, 196.5, accuracy: 0.001)
        }
    }

    /// Words taller than the slides and dots move the art up, centred as the first screen centres.
    func testTallerWordsAreCentredAgain() {
        let (layout, start) = layout(description: 200)
        XCTAssertLessThan(layout.art.minY, start.gallery.minY)
        XCTAssertEqual(layout.art.minY - (59 + 52), layout.button.minY - layout.link.maxY, accuracy: 0.001)
    }

    /// The site is a 40 tall target: 14 either side of its label, no glyph.
    func testTheSiteIsATarget() {
        let (layout, _) = layout()
        XCTAssertEqual(layout.link.size, CGSize(width: 14 + 210 + 14, height: 40))
        XCTAssertEqual(layout.linkLabel, CGRect(x: 14, y: 10, width: 210, height: 20))
    }

    /// A short window: still the slides' place, which now scrolls with 16 around it.
    func testTooTallItScrollsAsTheFirstScreenDoes() {
        let (layout, start) = layout(size: CGSize(width: 393, height: 300))
        XCTAssertEqual(layout.art.minY, 59 + 52 + 16)
        XCTAssertEqual(layout.art.minY, start.gallery.minY)
        XCTAssertEqual(layout.button.minY, layout.art.minY + start.gallery.height + 16, accuracy: 0.001)
        XCTAssertEqual(layout.contentHeight, layout.button.maxY + 48 + 34)
    }
}

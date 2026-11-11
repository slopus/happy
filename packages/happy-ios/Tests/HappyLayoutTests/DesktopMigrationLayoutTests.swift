import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The Happy CLI home's migration card and the screen it opens.
final class DesktopMigrationLayoutTests: XCTestCase {
    // MARK: The card

    /// The icon in an Item's 29 slot level with the title's first line, the
    /// words beside it, stopping short of the × target in the corner.
    func testTheCard() {
        let layout = DesktopCardLayout(width: 361, title: .fixed(width: 200, height: 22), body: .fixed(width: 250, height: 40))
        assertFrame(layout.icon, rect(16, 12.5, 29, 29))
        assertFrame(layout.close, rect(313, 4, 44, 44))
        assertFrame(layout.title, rect(57, 16, 256, 22))
        assertFrame(layout.body, rect(57, 40, 256, 40))
        assertSize(layout.size, CGSize(width: 361, height: 96))
    }

    /// Home measures the card as the card lays itself out, in its group.
    func testHomeMeasuresTheCardAsItIs() {
        let banner = HomeBannerHeights.Banner(title: .fixed(width: 200, height: 22), subtitle: .fixed(width: 250, height: 40), desktopCard: true)
        XCTAssertEqual(HomeBannerHeights.banner(banner, width: 393, maxWidth: nil, chevron: CGSize(width: 8, height: 13)), 4 + 96 + 16)
    }

    // MARK: The screen

    /// An iPhone 17 Pro, its bar in the safe area.
    private let size = CGSize(width: 402, height: 874)
    private let safe = LayoutInsets(top: 116, left: 0, bottom: 34, right: 0)

    private func screen(body: CGFloat = 72, link: Bool = false, update: Bool = false) -> MigrationScreenLayout {
        MigrationScreenLayout(
            size: size,
            safeArea: safe,
            title: .fixed(width: 300, height: 34),
            body: .fixed(width: 340, height: body),
            steps: [
                .init(number: .fixed(width: 8, height: 16), text: .fixed(width: 200, height: 24), link: link ? .fixed(width: 210, height: 20) : nil, detail: update ? .fixed(width: 250, height: 20) : nil),
                .init(number: .fixed(width: 8, height: 16), text: .fixed(width: 200, height: 24)),
                .init(number: .fixed(width: 8, height: 16), text: .fixed(width: 220, height: 24), detail: .fixed(width: 300, height: 60)),
            ],
            button: CGSize(width: 150, height: 52),
            learnMore: .fixed(width: 80, height: 20)
        )
    }

    /// The picture, the words and the three steps from the top, 22 apart,
    /// the last one's detail where a link's words would be; Scan QR code
    /// (at least 200 wide) and Learn more at the foot.
    func testItFitsAnIPhone() {
        let layout = screen()
        assertFrame(layout.art, rect(165, 116, 72, 72))
        assertFrame(layout.title, rect(51, 204, 300, 34))
        assertFrame(layout.body, rect(31, 246, 340, 72))
        XCTAssertEqual(layout.steps.map(\.number), [rect(24, 339, 22, 22), rect(24, 385, 22, 22), rect(24, 431, 22, 22)])
        XCTAssertEqual(layout.steps.map(\.numberLabel), [rect(7, 3, 8, 16), rect(7, 3, 8, 16), rect(7, 3, 8, 16)])
        XCTAssertEqual(layout.steps.map(\.text), [rect(58, 338, 320, 24), rect(58, 384, 320, 24), rect(58, 430, 320, 24)])
        XCTAssertEqual(layout.steps.map { $0.link == nil }, [true, true, true])
        XCTAssertEqual(layout.steps.map(\.detail), [nil, nil, rect(58, 464, 320, 60)])
        assertFrame(layout.button, rect(61, 744, 280, 52))
        assertFrame(layout.learnMore.target, rect(147, 800, 108, 40))
        assertFrame(layout.learnMore.label, rect(14, 10, 80, 20))
        XCTAssertEqual(layout.learnMore.target.maxY, 874 - 34)
        XCTAssertEqual(layout.contentHeight, 874)
    }

    /// A step's site under its words, a 40 tall target whose words line up
    /// with the step's; the next step 22 under the site's words.
    func testAStepsSite() {
        let layout = screen(link: true)
        assertFrame(layout.steps[0].text, rect(58, 338, 320, 24))
        assertFrame(layout.steps[0].link?.target, rect(44, 362, 238, 40))
        assertFrame(layout.steps[0].link?.label, rect(14, 10, 210, 20))
        assertFrame(layout.steps[1].text, rect(58, 414, 320, 24))
    }

    /// Step 1 on the desktop path: "Make sure Happy Desktop is up to
    /// date." where the site's words would be, the site 4 under it.
    func testADetailAndASiteUnderOneStep() {
        let layout = screen(link: true, update: true)
        assertFrame(layout.steps[0].text, rect(58, 338, 320, 24))
        assertFrame(layout.steps[0].detail, rect(58, 372, 320, 20))
        assertFrame(layout.steps[0].link?.target, rect(44, 386, 238, 40))
        assertFrame(layout.steps[0].link?.label, rect(14, 10, 210, 20))
        assertFrame(layout.steps[1].text, rect(58, 438, 320, 24))
    }

    /// Words taller than the window push the button 20 under the last
    /// step's detail, and the screen scrolls to Learn more's foot.
    func testTooTallItScrolls() throws {
        let layout = screen(body: 400)
        let last = try XCTUnwrap(layout.steps[2].detail)
        XCTAssertEqual(layout.button.minY, last.maxY + 20)
        XCTAssertEqual(layout.contentHeight, layout.learnMore.target.maxY + 34)
        XCTAssertGreaterThan(layout.contentHeight, 874)
    }
}

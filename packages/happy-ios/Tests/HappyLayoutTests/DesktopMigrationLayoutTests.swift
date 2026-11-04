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

    // MARK: The picture

    /// Symmetric about the middle: phone and computer in as far as the wider
    /// caption needs, each row under its heading, the server's badge on its
    /// patch of card, and an open arrowhead at each line's end.
    func testTheDiagram() {
        let layout = ConnectionDiagramLayout(
            width: 300,
            phone: .fixed(width: 40, height: 18),
            computer: .fixed(width: 60, height: 18),
            current: .init(heading: .fixed(width: 120, height: 18), middle: .fixed(width: 80, height: 18), detail: .fixed(width: 180, height: 18)),
            after: .init(heading: .fixed(width: 100, height: 18), middle: .fixed(width: 40, height: 18), detail: .fixed(width: 200, height: 18))
        )
        let current = layout.current
        assertFrame(current.heading, rect(90, 12, 120, 18))
        assertFrame(current.phone, rect(28, 36, 28, 28))
        assertFrame(current.middle, rect(136, 36, 28, 28))
        assertFrame(current.computer, rect(244, 36, 28, 28))
        XCTAssertEqual(current.captions, [rect(22, 66, 40, 18), rect(110, 66, 80, 18), rect(228, 66, 60, 18)])
        assertFrame(current.detail, rect(60, 84, 180, 18))
        assertFrame(current.badge, rect(153, 51, 14, 14))
        assertFrame(current.badgeGround, rect(152, 50, 16, 16))
        XCTAssertEqual(current.lines, [
            [CGPoint(x: 64, y: 50), CGPoint(x: 128, y: 50)],
            [CGPoint(x: 172, y: 50), CGPoint(x: 236, y: 50)],
        ])
        XCTAssertEqual(current.arrowheads, [
            [CGPoint(x: 124, y: 46), CGPoint(x: 128, y: 50), CGPoint(x: 124, y: 54)],
            [CGPoint(x: 232, y: 46), CGPoint(x: 236, y: 50), CGPoint(x: 232, y: 54)],
        ])
        let after = layout.after
        assertFrame(after.heading, rect(100, 114, 100, 18))
        assertFrame(after.middle, rect(136, 138, 28, 28))
        assertFrame(after.detail, rect(50, 186, 200, 18))
        XCTAssertNil(after.badge)
        XCTAssertNil(after.badgeGround)
        assertSize(layout.size, CGSize(width: 300, height: 216))
    }

    // MARK: The section that opens

    /// Closed, only the title and chevron in their 40 tall target, centred;
    /// open, the paragraphs under it, placed either way.
    func testTheSectionOpensInPlace() {
        func layout(expanded: Bool) -> DisclosureSectionLayout {
            DisclosureSectionLayout(
                width: 354,
                title: .fixed(width: 220, height: 22),
                paragraphs: [.fixed(width: 300, height: 48), .fixed(width: 300, height: 24)],
                expanded: expanded
            )
        }
        let closed = layout(expanded: false)
        assertFrame(closed.header, rect(43.5, 0, 267, 40))
        assertFrame(closed.title, rect(14, 9, 220, 22))
        assertFrame(closed.chevron, rect(240, 13.5, 13, 13))
        XCTAssertEqual(closed.paragraphs, [rect(0, 44, 354, 48), rect(0, 100, 354, 24)])
        assertSize(closed.size, CGSize(width: 354, height: 40))
        let open = layout(expanded: true)
        XCTAssertEqual(open.paragraphs, closed.paragraphs)
        assertSize(open.size, CGSize(width: 354, height: 124))
    }

    // MARK: The screen

    /// An iPhone 17 Pro, its bar in the safe area.
    private let size = CGSize(width: 402, height: 874)
    private let safe = LayoutInsets(top: 116, left: 0, bottom: 34, right: 0)

    private func screen(body: CGFloat = 72, diagram: Bool = true, link: Bool = false, section: CGFloat = 40) -> MigrationScreenLayout {
        MigrationScreenLayout(
            size: size,
            safeArea: safe,
            title: .fixed(width: 300, height: 34),
            body: .fixed(width: 340, height: body),
            diagram: diagram ? .fixed(width: 354, height: 216) : nil,
            steps: [
                .init(number: .fixed(width: 8, height: 16), text: .fixed(width: 200, height: 24), link: link ? .fixed(width: 210, height: 20) : nil),
                .init(number: .fixed(width: 8, height: 16), text: .fixed(width: 200, height: 24)),
            ],
            section: .fixed(width: 354, height: section),
            sectionHeader: .fixed(width: 354, height: 40),
            button: CGSize(width: 150, height: 52),
            learnMore: .fixed(width: 80, height: 20)
        )
    }

    /// The picture, the words and the steps from the top; Scan QR code (at
    /// least 200 wide), Learn more and the closed section at the foot.
    func testItFitsAnIPhone() {
        let layout = screen()
        assertFrame(layout.art, rect(165, 116, 72, 72))
        assertFrame(layout.title, rect(51, 204, 300, 34))
        assertFrame(layout.body, rect(31, 246, 340, 72))
        assertFrame(layout.diagram, rect(24, 338, 354, 216))
        XCTAssertEqual(layout.steps.map(\.number), [rect(24, 575, 22, 22), rect(24, 611, 22, 22)])
        XCTAssertEqual(layout.steps.map(\.numberLabel), [rect(7, 3, 8, 16), rect(7, 3, 8, 16)])
        XCTAssertEqual(layout.steps.map(\.text), [rect(58, 574, 320, 24), rect(58, 610, 320, 24)])
        XCTAssertEqual(layout.steps.map { $0.link == nil }, [true, true])
        assertFrame(layout.button, rect(101, 696, 200, 52))
        assertFrame(layout.learnMore.target, rect(147, 752, 108, 40))
        assertFrame(layout.learnMore.label, rect(14, 10, 80, 20))
        assertFrame(layout.section, rect(24, 800, 354, 40))
        XCTAssertEqual(layout.section.maxY, 874 - 34)
        XCTAssertEqual(layout.contentHeight, 874)
    }

    /// Opened, the section grows under the window, which scrolls; the
    /// button stays where it was.
    func testTheOpenSectionScrolls() {
        let closed = screen(), open = screen(section: 124)
        XCTAssertEqual(open.button, closed.button)
        assertFrame(open.section, rect(24, 800, 354, 124))
        XCTAssertEqual(open.contentHeight, 924 + 34)
    }

    /// Without the picture, a step's site under its words, a 40 tall target
    /// whose words line up with the step's.
    func testAStepsSiteAndNoPicture() {
        let layout = screen(diagram: false, link: true)
        XCTAssertNil(layout.diagram)
        assertFrame(layout.steps[0].text, rect(58, 338, 320, 24))
        assertFrame(layout.steps[0].link?.target, rect(44, 362, 238, 40))
        assertFrame(layout.steps[0].link?.label, rect(14, 10, 210, 20))
        assertFrame(layout.steps[1].text, rect(58, 414, 320, 24))
    }

    /// Words taller than the window push the button 20 under the last step,
    /// and the screen scrolls to the closed section's foot.
    func testTooTallItScrolls() {
        let layout = screen(body: 400)
        let last = layout.steps[1].text
        XCTAssertEqual(layout.button.minY, last.maxY + 20)
        XCTAssertEqual(layout.contentHeight, layout.section.maxY + 34)
        XCTAssertGreaterThan(layout.contentHeight, 874)
    }
}

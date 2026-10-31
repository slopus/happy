import CoreGraphics
import HappyLayout
import XCTest

/// The composer's "+" menu, measured as Telegram's attachment menu.
final class AttachMenuLayoutTests: XCTestCase {
    private func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }

    // MARK: The sheet

    func testTheSheetOnAnIPhone17ProRestsAQuarterDownAndExpandsUnderTheStatusBar() {
        let sheet = AttachMenuSheetLayout(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 62, bottom: 34), regular: false)
        XCTAssertEqual(sheet.style, .sheet)
        // 10 under the status bar expanded; 874 × 0.2488 = 217 lower at rest.
        XCTAssertEqual(sheet.expandedTop, 72)
        XCTAssertEqual(sheet.restTop, 289)
        XCTAssertEqual(sheet.travel, 217)
        XCTAssertTrue(sheet.canCollapse)
        XCTAssertEqual(sheet.content, CGSize(width: 402, height: 802))
        XCTAssertEqual(sheet.cornerRadius, 38)
        XCTAssertEqual(sheet.sides, .zero)

        // At rest: down to the screen's foot, drawn 5 in from each side.
        let rest = sheet.placement(top: 289)
        XCTAssertEqual(rest.clip, rect(0, 289, 402, 585))
        XCTAssertEqual(rest.scale, 1 - 10.0 / 402, accuracy: 0.000001)
        XCTAssertEqual(rest.content, rect(0, 0, 402, 802))
        XCTAssertEqual(rest.hidden, 217)
        XCTAssertEqual(rest.barBottom, 874)

        // Expanded: the whole width, nothing below the screen.
        let expanded = sheet.placement(top: 72)
        XCTAssertEqual(expanded.clip, rect(0, 72, 402, 802))
        XCTAssertEqual(expanded.scale, 1)
        XCTAssertEqual(expanded.hidden, 0)

        // Halfway, half the inset.
        XCTAssertEqual(sheet.placement(top: 72 + 108.5).scale, 1 - 5.0 / 402, accuracy: 0.000001)

        // Pulled down 100 past rest: the clip moves, its size doesn't, and the bar goes with it.
        let pulled = sheet.placement(top: 289, drop: 100)
        XCTAssertEqual(pulled.clip, rect(0, 389, 402, 585))
        XCTAssertEqual(pulled.barBottom, 974)
        // Never above the expanded top.
        XCTAssertEqual(sheet.placement(top: 10).clip, rect(0, 72, 402, 802))

        XCTAssertEqual(sheet.grabber(clipWidth: 402), rect(183, 5, 36, 5))
    }

    func testANarrowPhoneRestsHigher() {
        let sheet = AttachMenuSheetLayout(size: CGSize(width: 320, height: 568), safeArea: LayoutInsets(top: 20), regular: false)
        XCTAssertEqual(sheet.expandedTop, 30)
        // 568 × 0.15 = 85.
        XCTAssertEqual(sheet.restTop, 115)
    }

    func testAPhoneTurnedSidewaysFillsTheScreenSquareCornered() {
        let sheet = AttachMenuSheetLayout(size: CGSize(width: 874, height: 402), safeArea: LayoutInsets(left: 62, bottom: 21, right: 62), regular: false)
        XCTAssertEqual(sheet.style, .fullScreen)
        XCTAssertEqual(sheet.expandedTop, 0)
        XCTAssertEqual(sheet.restTop, 0)
        XCTAssertFalse(sheet.canCollapse)
        XCTAssertEqual(sheet.cornerRadius, 0)
        XCTAssertEqual(sheet.sides, LayoutInsets(left: 62, right: 62))
        XCTAssertNil(sheet.grabber(clipWidth: 874))
        let placement = sheet.placement(top: 0)
        XCTAssertEqual(placement.clip, rect(0, 0, 874, 402))
        XCTAssertEqual(placement.scale, 1)
    }

    func testAnIPadShowsACardOverThePlus() {
        let size = CGSize(width: 1024, height: 1366)
        let safe = LayoutInsets(top: 24, bottom: 20)
        // The "+" at the composer's bottom left: the card ends on it, kept 16 in.
        let sheet = AttachMenuSheetLayout(size: size, safeArea: safe, regular: true, source: rect(40, 1250, 44, 44))
        XCTAssertEqual(sheet.style, .card)
        XCTAssertEqual(sheet.card, rect(16, 580, 390, 670))
        XCTAssertFalse(sheet.canCollapse)
        XCTAssertEqual(sheet.content, CGSize(width: 390, height: 670))
        let placement = sheet.placement(top: 0)
        XCTAssertEqual(placement.clip, rect(16, 580, 390, 670))
        XCTAssertEqual(placement.scale, 1)
        XCTAssertEqual(placement.hidden, 0)
        XCTAssertEqual(placement.barBottom, 1250)
        // Coming in from below the screen.
        XCTAssertEqual(sheet.placement(top: 0, drop: 1366).clip, rect(16, 1946, 390, 670))

        // Without the "+": 28 from the right, 54 over the bottom.
        let free = AttachMenuSheetLayout(size: size, safeArea: safe, regular: true)
        XCTAssertEqual(free.card, rect(606, 622, 390, 670))

        // A short window keeps the card on screen.
        let short = AttachMenuSheetLayout(size: CGSize(width: 1024, height: 600), safeArea: safe, regular: true)
        XCTAssertEqual(short.card, rect(606, 40, 390, 524))
    }

    // MARK: Dragging

    func testADragFollowsTheFingerBetweenRestAndExpandedThenDrops() {
        // From rest: up toward expanded, down past rest.
        XCTAssertEqual(AttachMenuMotion.drag(expanded: false, canCollapse: true, travel: 217, translation: -50).offset, 167)
        XCTAssertEqual(AttachMenuMotion.drag(expanded: false, canCollapse: true, travel: 217, translation: -300).offset, 0)
        let down = AttachMenuMotion.drag(expanded: false, canCollapse: true, travel: 217, translation: 40)
        XCTAssertEqual(down.offset, 217)
        XCTAssertEqual(down.drop, 40)
        // From expanded: down to rest, then past it.
        XCTAssertEqual(AttachMenuMotion.drag(expanded: true, canCollapse: true, travel: 217, translation: 100).offset, 100)
        let past = AttachMenuMotion.drag(expanded: true, canCollapse: true, travel: 217, translation: 300)
        XCTAssertEqual(past.offset, 217)
        XCTAssertEqual(past.drop, 83)
        XCTAssertEqual(AttachMenuMotion.drag(expanded: true, canCollapse: true, travel: 217, translation: -20).offset, 0)
        // A sheet that can't rest lower only drops.
        let fixed = AttachMenuMotion.drag(expanded: true, canCollapse: false, travel: 0, translation: 50)
        XCTAssertEqual(fixed.offset, 0)
        XCTAssertEqual(fixed.drop, 50)
        XCTAssertEqual(AttachMenuMotion.drag(expanded: true, canCollapse: false, travel: 0, translation: -10).drop, 0)
    }

    func testWhereADragSettles() {
        func settle(expanded: Bool, offset: CGFloat, drop: CGFloat = 0, velocity: CGFloat = 0, scrolled: Bool = false, canCollapse: Bool = true) -> AttachMenuMotion.Settle {
            AttachMenuMotion.settle(expanded: expanded, canCollapse: canCollapse, travel: 217, offset: offset, drop: drop, velocity: velocity, scrolled: scrolled)
        }
        // 60 past rest goes; less stays; any drop flicked down goes.
        XCTAssertEqual(settle(expanded: false, offset: 217, drop: 61), .dismiss)
        XCTAssertEqual(settle(expanded: false, offset: 217, drop: 59), .stay)
        XCTAssertEqual(settle(expanded: false, offset: 217, drop: 10, velocity: 301), .dismiss)
        // Expanded at the top, a hard flick goes, unless the grid took it.
        XCTAssertEqual(settle(expanded: true, offset: 0, velocity: 1801), .dismiss)
        XCTAssertEqual(settle(expanded: true, offset: 0, velocity: 1801, scrolled: true), .stay)
        // Expanded: past half way down, or flicked, rests again.
        XCTAssertEqual(settle(expanded: true, offset: 120), .collapse)
        XCTAssertEqual(settle(expanded: true, offset: 100), .stay)
        XCTAssertEqual(settle(expanded: true, offset: 100, velocity: 301), .collapse)
        // At rest: past half way up, or flicked up, expands.
        XCTAssertEqual(settle(expanded: false, offset: 100), .expand)
        XCTAssertEqual(settle(expanded: false, offset: 200, velocity: -301), .expand)
        XCTAssertEqual(settle(expanded: false, offset: 200), .stay)
        // A sheet that can't rest lower needs 180.
        XCTAssertEqual(settle(expanded: true, offset: 0, drop: 100, canCollapse: false), .stay)
        XCTAssertEqual(settle(expanded: true, offset: 0, drop: 181, canCollapse: false), .dismiss)
    }

    // MARK: The bar

    func testTheTabBarIsA160GlassCapsule22OffTheBottom() {
        let bar = AttachMenuBarLayout(minX: 0, width: 402, bottom: 874, titles: [CGSize(width: 40, height: 12), CGSize(width: 28, height: 12)], selected: 0, picking: false, addTitle: CGSize(width: 60, height: 21), pixel: 0.5)
        XCTAssertEqual(bar.capsule, rect(121, 790, 160, 62))
        XCTAssertEqual(bar.cornerRadius, 31)
        // Two 72 tabs 82 apart, 3 in; the icon 9 and a pixel down, the
        // name 15 and two pixels under the icon's middle.
        XCTAssertEqual(bar.tabs[0].frame, rect(3, 0, 72, 62))
        XCTAssertEqual(bar.tabs[0].icon, rect(24, 9.5, 30, 30))
        XCTAssertEqual(bar.tabs[0].title, rect(19, 34.5, 40, 12))
        XCTAssertEqual(bar.tabs[1].frame, rect(85, 0, 72, 62))
        XCTAssertEqual(bar.tabs[1].icon, rect(106, 9.5, 30, 30))
        XCTAssertEqual(bar.tabs[1].title, rect(107, 34.5, 28, 12))
        // The pill behind the chosen tab, 3 in from the capsule's top and bottom.
        XCTAssertEqual(bar.selection, rect(3, 3, 72, 56))
        let files = AttachMenuBarLayout(minX: 0, width: 402, bottom: 874, titles: [CGSize(width: 40, height: 12), CGSize(width: 28, height: 12)], selected: 1, picking: false, addTitle: .zero, pixel: 0.5)
        XCTAssertEqual(files.selection, rect(85, 3, 72, 56))
    }

    func testPickingTurnsTheBarIntoAddN() {
        let bar = AttachMenuBarLayout(minX: 0, width: 402, bottom: 874, titles: [CGSize(width: 40, height: 12), CGSize(width: 28, height: 12)], selected: 0, picking: true, addTitle: CGSize(width: 60, height: 21), pixel: 0.5)
        XCTAssertEqual(bar.capsule, rect(28, 800, 346, 52))
        XCTAssertEqual(bar.cornerRadius, 26)
        XCTAssertEqual(bar.add, rect(143, 15, 60, 21))
    }

    func testTheIPadCardsBarSitsInTheCard() {
        let bar = AttachMenuBarLayout(minX: 16, width: 390, bottom: 1250, titles: [CGSize(width: 40, height: 12), CGSize(width: 28, height: 12)], selected: 0, picking: false, addTitle: .zero, pixel: 0.5)
        XCTAssertEqual(bar.capsule, rect(131, 1166, 160, 62))
    }

    // MARK: The grid

    func testTheCameraIsTwoCellsTallAtTheTopLeftAndPicturesFlowAroundIt() {
        let grid = AttachMenuGridLayout(width: 402, wide: false, pixel: 0.5, count: 10, camera: true, top: 0)
        XCTAssertEqual(grid.columns, 3)
        XCTAssertEqual(grid.cell, CGSize(width: 133, height: 133))
        XCTAssertEqual(grid.camera, rect(0, 0, 133, 267))
        XCTAssertEqual(grid.frame(at: 0), rect(134, 0, 133, 133))
        // The last column takes what the rounding left.
        XCTAssertEqual(grid.frame(at: 1), rect(269, 0, 133, 133))
        XCTAssertEqual(grid.frame(at: 2), rect(134, 134, 133, 133))
        XCTAssertEqual(grid.frame(at: 3), rect(269, 134, 133, 133))
        // Under the camera, whole rows.
        XCTAssertEqual(grid.frame(at: 4), rect(0, 268, 133, 133))
        XCTAssertEqual(grid.frame(at: 9), rect(269, 402, 133, 133))
        XCTAssertEqual(grid.contentHeight, 535)
        XCTAssertEqual(grid.visible(minY: 0, maxY: 100), 0..<2)
        XCTAssertEqual(grid.visible(minY: 140, maxY: 300), 2..<7)
        XCTAssertEqual(grid.visible(minY: 0, maxY: 10000), 0..<10)
        XCTAssertEqual(grid.visible(minY: 600, maxY: 900), 10..<10)
        // One picture still leaves the camera its two rows.
        XCTAssertEqual(AttachMenuGridLayout(width: 402, wide: false, pixel: 0.5, count: 1, camera: true, top: 0).contentHeight, 267)
    }

    func testWithoutACameraTheGridIsPlain() {
        let grid = AttachMenuGridLayout(width: 402, wide: false, pixel: 0.5, count: 5, camera: false, top: 64)
        XCTAssertNil(grid.camera)
        XCTAssertEqual(grid.frame(at: 0), rect(0, 64, 133, 133))
        XCTAssertEqual(grid.frame(at: 3), rect(0, 198, 133, 133))
        XCTAssertEqual(grid.contentHeight, 64 + 267)
        XCTAssertEqual(grid.visible(minY: 0, maxY: 100), 0..<3)
    }

    func testSidewaysTheGridHasFiveColumnsClearOfTheNotch() {
        let grid = AttachMenuGridLayout(width: 874, left: 62, right: 62, wide: true, pixel: 0.5, count: 12, camera: true, top: 0)
        XCTAssertEqual(grid.columns, 5)
        XCTAssertEqual(grid.cell, CGSize(width: 149, height: 149))
        XCTAssertEqual(grid.camera, rect(62, 0, 149, 299))
        XCTAssertEqual(grid.frame(at: 0), rect(212, 0, 149, 149))
        XCTAssertEqual(grid.frame(at: 3), rect(663, 0, 149, 149))
        XCTAssertEqual(grid.frame(at: 4), rect(212, 150, 149, 149))
        XCTAssertEqual(grid.frame(at: 8), rect(62, 300, 149, 149))
    }

    // MARK: The page

    func testTheGalleryHeaderAndLimitedNote() {
        let layout = AttachMenuContentLayout(.init(
            width: 402, height: 802, title: CGSize(width: 64.5, height: 20.3), wide: false, pixel: 0.5, count: 10, camera: true,
            note: .fixed(width: 240, height: 36), noteButton: CGSize(width: 64, height: 18), hidden: 217
        ))
        // The close circle as every sheet's; the title centred on it.
        XCTAssertEqual(layout.close, rect(342, 16, 44, 44))
        XCTAssertEqual(layout.title, rect(168, 27, 65, 21))
        XCTAssertEqual(layout.page, rect(0, 68, 402, 734))
        // The resting sheet's 217 below the screen and the bar's 92 stay clear.
        XCTAssertEqual(layout.bottomInset, 309)
        XCTAssertEqual(layout.visibleHeight, 425)
        // Telegram's manage note: text 16 in, MANAGE 10 in, both 5 above the middle.
        XCTAssertEqual(layout.note, rect(0, 0, 402, 64))
        XCTAssertEqual(layout.noteText, rect(16, 9, 240, 36))
        XCTAssertEqual(layout.noteButton, rect(302, 13, 90, 28))
        // The grid starts under the note.
        XCTAssertEqual(layout.grid.camera, rect(0, 64, 133, 267))
    }

    func testFullAccessHasNoNote() {
        let layout = AttachMenuContentLayout(.init(width: 402, height: 802, title: CGSize(width: 65, height: 21), wide: false, pixel: 0.5, count: 3, camera: false))
        XCTAssertNil(layout.note)
        XCTAssertEqual(layout.grid.frame(at: 0), rect(0, 0, 133, 133))
        XCTAssertEqual(layout.bottomInset, 92)
    }

    func testSidewaysTheCloseStaysClearOfTheNotch() {
        let layout = AttachMenuContentLayout(.init(width: 874, height: 402, sides: LayoutInsets(left: 62, right: 62), title: CGSize(width: 65, height: 21), wide: true, pixel: 0.5, count: 3, camera: true))
        XCTAssertEqual(layout.close, rect(752, 16, 44, 44))
        XCTAssertEqual(layout.grid.camera?.minX, 62)
    }

    // MARK: No access

    func testWithoutAccessThePhotosButtonSitsUnderTheExplanation() {
        let layout = AttachMenuPlaceholderLayout(
            width: 402, height: 425, upright: true,
            title: .fixed(width: 280, height: 21), text: .fixed(width: 330, height: 60),
            primary: CGSize(width: 200, height: 21), settings: CGSize(width: 190, height: 21), camera: CGSize(width: 110, height: 21)
        )
        XCTAssertEqual(layout.image, rect(153, 25, 96, 96))
        XCTAssertEqual(layout.title, rect(61, 133, 280, 21))
        XCTAssertEqual(layout.text, rect(36, 166, 330, 60))
        // Photos (the system's picker) 20 under the words, Telegram's 248 × 52.
        XCTAssertEqual(layout.primary, rect(77, 246, 248, 52))
        XCTAssertEqual(layout.settings, rect(98, 311, 206, 44))
        XCTAssertEqual(layout.camera, rect(138, 355, 126, 44))
        XCTAssertEqual(layout.contentHeight, 425)
        XCTAssertGreaterThan(layout.primary.minY, layout.text.maxY)
        XCTAssertEqual(layout.primary.midX, 201)
    }

    func testWithoutAccessTooTallItScrollsFromTheTop() {
        let layout = AttachMenuPlaceholderLayout(
            width: 402, height: 200, upright: true,
            title: .fixed(width: 280, height: 21), text: .fixed(width: 330, height: 60),
            primary: CGSize(width: 200, height: 21), settings: CGSize(width: 190, height: 21), camera: nil
        )
        XCTAssertEqual(layout.image?.minY, 0)
        XCTAssertNil(layout.camera)
        XCTAssertEqual(layout.contentHeight, 330)
    }

    func testWithoutAccessLargeTextGrowsTheButtonAndDropsThePictureSideways() {
        let layout = AttachMenuPlaceholderLayout(
            width: 874, height: 300, upright: false,
            title: .fixed(width: 400, height: 40), text: .fixed(width: 700, height: 90),
            primary: CGSize(width: 320, height: 41), settings: CGSize(width: 300, height: 41), camera: nil
        )
        XCTAssertNil(layout.image)
        XCTAssertEqual(layout.primary, rect(261, 162, 352, 69))
        XCTAssertEqual(layout.settings, rect(279, 244, 316, 57))
    }

    // MARK: Files

    func testTheFilesTabIsOneGroupOfRows() {
        let layout = AttachMenuFilesLayout(width: 402, titles: [.fixed(width: 150, height: 22), .fixed(width: 190, height: 22)], pixel: 0.5)
        XCTAssertEqual(layout.group, rect(16, 8, 370, 104))
        XCTAssertEqual(layout.rows[0].frame, rect(0, 0, 370, 52))
        XCTAssertEqual(layout.rows[0].icon, rect(16, 14, 24, 24))
        XCTAssertEqual(layout.rows[0].title, rect(54, 15, 300, 22))
        XCTAssertNil(layout.rows[0].separator)
        XCTAssertEqual(layout.rows[1].frame, rect(0, 52, 370, 52))
        XCTAssertEqual(layout.rows[1].separator, rect(54, 52, 316, 0.5))
        XCTAssertEqual(layout.contentHeight, 204)
    }

    func testFilesRowsGrowWithLargeText() {
        let layout = AttachMenuFilesLayout(width: 402, titles: [.fixed(width: 300, height: 66)], pixel: 0.5)
        XCTAssertEqual(layout.rows[0].frame, rect(0, 0, 370, 94))
        XCTAssertEqual(layout.rows[0].icon, rect(16, 35, 24, 24))
        XCTAssertEqual(layout.rows[0].title, rect(54, 14, 300, 66))
    }
}

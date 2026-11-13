import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
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

    // MARK: The panel

    private let titles = [CGSize(width: 40, height: 12), CGSize(width: 28, height: 12)]

    func testTheTabBarIsA160GlassCapsule22OffTheBottom() {
        let panel = AttachMenuPanelLayout(.init(minX: 0, width: 402, bottom: 874, titles: titles, selected: 0, picking: false, pixel: 1.0 / 3))
        XCTAssertEqual(panel.tabBar, rect(121, 790, 160, 62))
        XCTAssertEqual(panel.glass, panel.tabBar)
        XCTAssertEqual(panel.glassRadius, 31)
        XCTAssertEqual(panel.tabsOffset, 0)
        // Two 72 tabs 82 apart, 3 in; the glyph 9 and a pixel down.
        XCTAssertEqual(panel.tabs[0].frame, rect(3, 0, 72, 62))
        XCTAssertEqual(panel.tabs[1].frame, rect(85, 0, 72, 62))
        XCTAssertEqual(panel.tabs[0].icon.minY, 9 + 1.0 / 3, accuracy: 0.0001)
        // The lens behind the chosen tab, 3 in from the bar's top and bottom.
        XCTAssertEqual(panel.lens, rect(3, 3, 72, 56))
        let files = AttachMenuPanelLayout(.init(minX: 0, width: 402, bottom: 874, titles: titles, selected: 1, picking: false, pixel: 1.0 / 3))
        XCTAssertEqual(files.lens, rect(85, 3, 72, 56))
    }

    /// Each tab's glyph and name share the tab's centre line, and the name
    /// starts 15 and two pixels under the glyph's middle: under it, not
    /// over it.
    func testEachTabsGlyphAndNameAreCentredOnTheTabAndStacked() {
        for scale: CGFloat in [2, 3] {
            let pixel = 1 / scale
            let measured = [CGSize(width: 37.67, height: 11.93), CGSize(width: 23.33, height: 11.93), CGSize(width: 71.9, height: 11.93)]
            let panel = AttachMenuPanelLayout(.init(minX: 0, width: 402, bottom: 874, titles: measured, selected: 0, picking: false, pixel: pixel))
            for tab in panel.tabs {
                XCTAssertEqual(tab.icon.midX, tab.frame.midX, accuracy: pixel / 2 + 0.0001, "glyph \(tab)")
                XCTAssertEqual(tab.title.midX, tab.frame.midX, accuracy: pixel / 2 + 0.0001, "name \(tab)")
                XCTAssertEqual(tab.icon.size, CGSize(width: 30, height: 30))
                XCTAssertEqual(tab.title.minY, tab.icon.midY + 15 + 2 * pixel, accuracy: 0.0001)
                XCTAssertGreaterThan(tab.title.minY, tab.icon.maxY)
                XCTAssertLessThanOrEqual(tab.title.maxY, tab.frame.maxY - 8)
                // Whole pixels, so neither blurs.
                XCTAssertEqual((tab.icon.minX * scale).rounded(), tab.icon.minX * scale, accuracy: 0.0001)
                XCTAssertEqual((tab.title.minX * scale).rounded(), tab.title.minX * scale, accuracy: 0.0001)
            }
        }
    }

    func testPickingTurnsTheBarIntoTheCaption() {
        let count = CGSize(width: 10, height: 20.3)
        let panel = AttachMenuPanelLayout(.init(minX: 0, width: 402, bottom: 874, titles: titles, selected: 0, picking: true, textHeight: 21, placeholder: CGSize(width: 110, height: 21), empty: true, count: count, pixel: 1.0 / 3))
        // 28 in from the sides and the bottom, 40 tall, corners 20.
        XCTAssertEqual(panel.glass, rect(28, 806, 346, 40))
        XCTAssertEqual(panel.glassRadius, 20)
        // The tabs rise 11 as they fade.
        XCTAssertEqual(panel.tabsOffset, -11)
        // The confirm at the far end: a 52 × 34 capsule for "2" (30 to
        // the count, 12 after it) 3 in, touched 8 before it and the
        // field's height down.
        XCTAssertEqual(panel.confirmBackground, rect(291, 3, 52, 34))
        XCTAssertEqual(panel.confirmBackground.maxX, panel.glass.width - 3)
        XCTAssertEqual(panel.confirm, rect(283, 0, 63, 40))
        XCTAssertEqual(panel.confirmIcon, rect(8, 7, 20, 20))
        XCTAssertEqual(panel.confirmLabel.minX, 30)
        XCTAssertEqual(panel.confirmLabel.width, 10)
        XCTAssertEqual(panel.text.minY, 28.0 / 3, accuracy: 0.0001)
        XCTAssertEqual(panel.text.width, 267)
        XCTAssertLessThanOrEqual(panel.text.maxX, panel.confirm.minX, "the text runs under the confirm")
        // Unfocused and empty, the placeholder in the middle.
        XCTAssertEqual(panel.placeholder.midX, 173, accuracy: 0.5)
        // Focused over the keyboard: 16 in, 8 above it, the placeholder at the text's start.
        let focused = AttachMenuPanelLayout(.init(minX: 0, width: 402, bottom: 538, titles: titles, selected: 0, picking: true, focused: true, textHeight: 21, placeholder: CGSize(width: 110, height: 21), empty: true, count: count, pixel: 1.0 / 3))
        XCTAssertEqual(focused.glass, rect(16, 490, 370, 40))
        XCTAssertEqual(focused.placeholder.minX, 16)
        // Three lines: taller, the confirm at the foot, corners still 20.
        let tall = AttachMenuPanelLayout(.init(minX: 0, width: 402, bottom: 538, titles: titles, selected: 0, picking: true, focused: true, textHeight: 62, placeholder: CGSize(width: 110, height: 21), empty: false, count: count, pixel: 1.0 / 3))
        XCTAssertEqual(tall.glass, rect(16, 449, 370, 81))
        XCTAssertEqual(tall.confirmBackground, rect(315, 44, 52, 34))
        XCTAssertEqual(tall.glassRadius, 20)
        XCTAssertEqual(AttachMenuPanelLayout.textWidth(width: 402, sides: .zero, focused: true, countWidth: 10), 291)
        // A long caption stops at its tallest and scrolls inside, the
        // glass never past the room it was given.
        let long = AttachMenuPanelLayout(.init(minX: 0, width: 402, bottom: 538, titles: titles, selected: 0, picking: true, focused: true, textHeight: 900, placeholder: CGSize(width: 110, height: 21), empty: false, maxHeight: 140, count: count, pixel: 1.0 / 3))
        XCTAssertEqual(long.glass, rect(16, 390, 370, 140))
        XCTAssertEqual(long.text.height, 121)
        XCTAssertEqual(long.text.minY, 9, accuracy: 0.5, "the text left the glass")
        XCTAssertLessThanOrEqual(long.text.maxY, long.glass.height)
        // More picked, a wider count: the text gives way.
        let wide = AttachMenuPanelLayout(.init(minX: 0, width: 402, bottom: 874, titles: titles, selected: 0, picking: true, textHeight: 21, placeholder: CGSize(width: 110, height: 21), empty: true, count: CGSize(width: 20, height: 20.3), pixel: 1.0 / 3))
        XCTAssertEqual(wide.confirmBackground.width, 62)
        XCTAssertEqual(wide.text.width, 257)
    }

    func testTheIPadCardsBarSitsInTheCard() {
        let panel = AttachMenuPanelLayout(.init(minX: 16, width: 390, bottom: 1250, titles: titles, selected: 0, picking: false, pixel: 0.5))
        XCTAssertEqual(panel.tabBar, rect(131, 1166, 160, 62))
    }

    // MARK: The header

    func testTheHeaderIsTelegramsGlassControls() {
        let header = AttachMenuHeaderLayout(width: 402, title: CGSize(width: 64.5, height: 20.3), arrow: true, pixel: 1.0 / 3)
        XCTAssertEqual(header.close, rect(16, 16, 44, 44))
        // Title and arrow centred together on the buttons' middle, 1 up.
        XCTAssertEqual(header.title.minX + (header.arrow!.maxX - header.title.minX) / 2, 201, accuracy: 0.5)
        XCTAssertEqual(header.title.midY, 38 - 1 - 1.0 / 6, accuracy: 0.0001)
        XCTAssertEqual(header.arrow?.minX, header.title.maxX + 1)
        XCTAssertEqual(header.edge, rect(0, 0, 402, 80))
        let plain = AttachMenuHeaderLayout(width: 402, title: CGSize(width: 64.5, height: 20.3), arrow: false, pixel: 1.0 / 3)
        XCTAssertNil(plain.arrow)
        XCTAssertEqual(plain.title.midX, 201, accuracy: 0.5)
        // Sideways, clear of the notch.
        XCTAssertEqual(AttachMenuHeaderLayout(width: 874, sides: LayoutInsets(left: 62, right: 62), title: .zero, arrow: false, pixel: 1.0 / 3).close.minX, 78)
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

    func testTheGridRunsUnderTheHeaderWithTheLimitedNote() {
        let layout = AttachMenuContentLayout(.init(
            width: 402, height: 802, wide: false, pixel: 0.5, count: 10, camera: true,
            note: .fixed(width: 240, height: 36), noteButton: CGSize(width: 64, height: 18), hidden: 217
        ))
        // The grid fills the content, 68 of header over its top.
        XCTAssertEqual(layout.gridFrame, rect(0, 0, 402, 802))
        XCTAssertEqual(layout.topInset, 68)
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
        let layout = AttachMenuContentLayout(.init(width: 402, height: 802, wide: false, pixel: 0.5, count: 3, camera: false))
        XCTAssertNil(layout.note)
        XCTAssertEqual(layout.grid.frame(at: 0), rect(0, 0, 133, 133))
        XCTAssertEqual(layout.bottomInset, 92)
    }

    func testSidewaysTheGridStaysClearOfTheNotch() {
        let layout = AttachMenuContentLayout(.init(width: 874, height: 402, sides: LayoutInsets(left: 62, right: 62), wide: true, pixel: 0.5, count: 3, camera: true))
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

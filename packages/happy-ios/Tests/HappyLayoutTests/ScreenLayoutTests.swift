import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class RestoreQRLayoutTests: XCTestCase {
    func input(size: CGSize = phone, safeArea: LayoutInsets = phoneUnderBar, showsCode: Bool) -> RestoreQRLayout.Input {
        .init(
            size: size,
            safeArea: safeArea,
            instruction: text("Scan this code with your other phone.", lineHeight: 22),
            path: text("Happy › Settings › Account › Link New Device", lineHeight: 20),
            showsCode: showsCode,
            button: block(height: 44)
        )
    }

    func testCodeColumnIsCentred() {
        let layout = RestoreQRLayout(input(showsCode: true))
        // Column 22 + 8 + 40 + 32 + 284 + 32 + 44 = 462 in 715 visible:
        // 103 + 24 + (715 - 48 - 462) / 2 = 229.5.
        assertFrame(layout.instruction, rect(32, 229.5, 329, 22))
        assertFrame(layout.path, rect(32, 259.5, 329, 40))
        // 260 code on a 12pt white frame.
        assertFrame(layout.codeContainer, rect(54.5, 331.5, 284, 284))
        assertFrame(layout.code, rect(66.5, 343.5, 260, 260))
        // Button column is 280 wide, 32 under the code.
        assertFrame(layout.button, rect(56.5, 647.5, 280, 44))
        assertSize(layout.contentSize, phone)
    }

    func testPlaceholderIsTheCodeSize() {
        let layout = RestoreQRLayout(input(showsCode: false))
        XCTAssertNil(layout.code)
        XCTAssertEqual(layout.codeContainer.size, CGSize(width: 260, height: 260))
        XCTAssertEqual(layout.codeContainer.minX, 66.5)
    }

    func testCodeShrinksOnSmallPhones() {
        let layout = RestoreQRLayout(input(size: CGSize(width: 320, height: 568), safeArea: LayoutInsets(top: 64), showsCode: true))
        // 320 - 64 = 256 wide: the code gets 256 - 24.
        XCTAssertEqual(layout.code?.width, 232)
        XCTAssertEqual(layout.codeContainer.width, 256)
        XCTAssertEqual(layout.button.width, 256)
        // Taller than the screen, so it scrolls from the top padding.
        XCTAssertEqual(layout.instruction.minY, 64 + 24)
        XCTAssertEqual(layout.contentSize.height, layout.button.maxY + 24)
    }
}

final class RestoreSecretKeyLayoutTests: XCTestCase {
    func input(keyboard: CGFloat = 0, fieldLines: Int = 1) -> RestoreSecretKeyLayout.Input {
        .init(
            size: phone,
            safeArea: phoneUnderBar,
            keyboardOverlap: keyboard,
            instruction: text(String(repeating: "i", count: 82), lineHeight: 22),
            fieldText: Measurable { width in CGSize(width: width, height: CGFloat(fieldLines) * 22) },
            button: block(height: 50)
        )
    }

    func testFormBelowTheBar() {
        let layout = RestoreSecretKeyLayout(input())
        assertFrame(layout.scroll, rect(0, 0, 393, 852))
        assertFrame(layout.instruction, rect(24, 127, 345, 44))
        // An empty field keeps its 120 minimum.
        assertFrame(layout.field, rect(24, 191, 345, 120))
        assertFrame(layout.button, rect(24, 335, 345, 50))
        XCTAssertEqual(layout.contentSize.height, 385 + 24 + 34)
        XCTAssertEqual(RestoreSecretKeyLayout.fieldTextWidth(size: phone, safeArea: phoneUnderBar), 313)
    }

    func testKeyboardShrinksTheScrollView() {
        let layout = RestoreSecretKeyLayout(input(keyboard: 336))
        assertFrame(layout.scroll, rect(0, 0, 393, 516))
        // The keyboard covers the home indicator inset.
        XCTAssertEqual(layout.contentSize.height, 385 + 24)
    }

    func testFieldGrowsWithText() {
        let layout = RestoreSecretKeyLayout(input(fieldLines: 6))
        XCTAssertEqual(layout.field.height, 6 * 22 + 32)
        XCTAssertEqual(layout.button.minY, layout.field.maxY + 24)
    }
}

final class ServerFormLayoutTests: XCTestCase {
    func testDefaultServerForm() {
        let layout = ServerFormLayout(.init(width: 343, label: text("SERVER URL", lineHeight: 15), fieldLineHeight: 20, save: block(height: 44)))
        assertFrame(layout.label, rect(16, 12, 311, 15))
        // 20 + 12 + 12 = 44, the minimum anyway.
        assertFrame(layout.field, rect(16, 35, 311, 44))
        // 8 under the field and 4 above the button column.
        assertFrame(layout.save, rect(16, 91, 311, 44))
        XCTAssertNil(layout.reset)
        XCTAssertNil(layout.status)
        assertSize(layout.size, CGSize(width: 343, height: 159))
    }

    func testCustomServerWithError() {
        let layout = ServerFormLayout(.init(
            width: 343,
            label: text("SERVER URL", lineHeight: 15),
            fieldLineHeight: 20,
            error: text("Not a valid Happy Server", lineHeight: 15),
            save: block(height: 44),
            reset: block(height: 44),
            status: text("Currently using custom server", lineHeight: 15)
        ))
        assertFrame(layout.error, rect(16, 87, 311, 15))
        assertFrame(layout.save, rect(16, 118, 311, 44))
        assertFrame(layout.reset, rect(16, 166, 311, 44))
        assertFrame(layout.status, rect(16, 222, 311, 15))
        assertSize(layout.size, CGSize(width: 343, height: 249))
    }

    func testValidatingLineFollowsTheError() {
        let layout = ServerFormLayout(.init(
            width: 343,
            label: text("SERVER URL", lineHeight: 15),
            fieldLineHeight: 20,
            error: text("x", lineHeight: 15),
            validating: text("Validating server...", lineHeight: 15),
            save: block(height: 44)
        ))
        assertFrame(layout.validating, rect(16, 114, 311, 15))
        XCTAssertEqual(layout.save.minY, 145)
    }

    func testServerScreenComposesFormGroupAndList() {
        let cardWidth = ItemGroupLayout.cardWidth(forWidth: GroupedListLayout.contentWidth(size: phone, safeArea: phoneUnderBar))
        XCTAssertEqual(cardWidth, 361)
        let form = Measurable { width in
            ServerFormLayout(.init(width: width, label: text("SERVER URL", lineHeight: 15), fieldLineHeight: 20, save: block(height: 44))).size
        }
        let group = Measurable { width in
            ItemGroupLayout(.init(width: width, footer: text(String(repeating: "f", count: 64), lineHeight: 18), rows: [form])).size
        }
        let list = GroupedListLayout(.init(size: phone, safeArea: phoneUnderBar, sections: [group]))
        // 20 above the card, the 159 form, then the two-line footer: 6 + 36 + 8.
        assertFrame(list.sections[0], rect(0, 103, 393, 229))
    }
}

final class QRScannerLayoutTests: XCTestCase {
    func testViewfinderIsCentredInTheSafeArea() {
        let layout = QRScannerLayout(.init(size: phone, safeArea: phoneFullScreen, mode: .scanning(hint: text("Scan the QR code", lineHeight: 22))))
        assertFrame(layout.preview, rect(0, 0, 393, 852))
        assertFrame(layout.close, rect(8, 67, 44, 44))
        assertFrame(layout.viewfinder, rect(56.5, 298.5, 280, 280))
        assertFrame(layout.hint, rect(32, 602.5, 329, 22))
        XCTAssertNil(layout.message)
        XCTAssertNil(layout.button)
    }

    func testLandscapeViewfinderFitsTheHeight() {
        let size = CGSize(width: 852, height: 393)
        let insets = LayoutInsets(top: 0, left: 59, bottom: 21, right: 59)
        let layout = QRScannerLayout(.init(size: size, safeArea: insets, mode: .scanning(hint: text("Scan", lineHeight: 22))))
        // 372 tall safe area less 120 above and below leaves 132.
        assertFrame(layout.viewfinder, rect(360, 120, 132, 132))
        assertFrame(layout.close, rect(67, 8, 44, 44))
    }

    func testPermissionMessageReplacesTheViewfinder() {
        let layout = QRScannerLayout(.init(
            size: phone,
            safeArea: phoneFullScreen,
            mode: .message(text: text(String(repeating: "m", count: 50), lineHeight: 22), button: block(height: 50))
        ))
        XCTAssertNil(layout.viewfinder)
        XCTAssertNil(layout.hint)
        // 44 + 24 + 50 = 118, centred on the safe area's middle (438.5).
        assertFrame(layout.message, rect(32, 379.5, 329, 44))
        assertFrame(layout.button, rect(56.5, 447.5, 280, 50))
        assertFrame(layout.close, rect(8, 67, 44, 44))
    }
}

final class GeometryTests: XCTestCase {
    func testMeasurableNeverExceedsTheOffer() {
        let wide = Measurable.fixed(width: 500, height: 20)
        XCTAssertEqual(wide.size(fitting: 100), CGSize(width: 100, height: 20))
        XCTAssertEqual(wide.size(fitting: -5), CGSize(width: 0, height: 20))
        let negative = Measurable { _ in CGSize(width: -1, height: -1) }
        XCTAssertEqual(negative.size(fitting: 10), .zero)
    }

    func testLargestTakesEachDimensionsMaximum() {
        let largest = Measurable.largest(of: [.fixed(width: 10, height: 50), .fixed(width: 40, height: 20)])
        XCTAssertEqual(largest.size(fitting: 100), CGSize(width: 40, height: 50))
        XCTAssertEqual(Measurable.largest(of: []).size(fitting: 100), .zero)
    }

    func testPixelSnappingRoundsEdges() {
        XCTAssertEqual(PixelGrid.snap(rect(10.2, 20.6, 100.5, 0.33), scale: 2), rect(10, 20.5, 100.5, 0.5))
        XCTAssertEqual(PixelGrid.snap(rect(10.2, 20.6, 100.5, 0.33), scale: 3).height, 1.0 / 3, accuracy: 0.0001)
        // Adjacent frames still meet after snapping.
        let top = PixelGrid.snap(rect(0, 0, 10, 46.33), scale: 3)
        let bottom = PixelGrid.snap(rect(0, 46.33, 10, 46), scale: 3)
        XCTAssertEqual(top.maxY, bottom.minY, accuracy: 0.0001)
        XCTAssertEqual(PixelGrid.snap(.zero, scale: 2), .zero)
    }

    func testInsets() {
        let insets = LayoutInsets(top: 1, left: 2, bottom: 3, right: 4)
        XCTAssertEqual(insets.horizontal, 6)
        XCTAssertEqual(insets.vertical, 4)
    }
}

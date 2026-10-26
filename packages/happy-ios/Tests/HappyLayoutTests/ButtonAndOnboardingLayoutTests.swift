import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class RoundButtonLayoutTests: XCTestCase {
    func testMetricsFollowHappyApp() {
        XCTAssertEqual(RoundButtonMetrics.of(.large), RoundButtonMetrics(height: 50, fontSize: 17, lineHeight: 22, paddingHorizontal: 24, hitSlop: 0))
        XCTAssertEqual(RoundButtonMetrics.of(.normal), RoundButtonMetrics(height: 44, fontSize: 15, lineHeight: 20, paddingHorizontal: 20, hitSlop: 4))
        XCTAssertEqual(RoundButtonMetrics.of(.small), RoundButtonMetrics(height: 32, fontSize: 13, lineHeight: 17, paddingHorizontal: 14, hitSlop: 8))
        for size in RoundButtonSize.allCases {
            let metrics = RoundButtonMetrics.of(size)
            XCTAssertEqual(metrics.lineHeight, (metrics.fontSize * 1.3).rounded())
        }
    }

    func testLargeFilledPill() {
        let layout = RoundButtonLayout(.init(width: 345, label: text("Create account", lineHeight: 22, maxLines: 1)))
        assertSize(layout.size, CGSize(width: 345, height: 50))
        assertFrame(layout.label, rect(24, 14, 297, 22))
        XCTAssertEqual(layout.cornerRadius, 25)
        XCTAssertNil(layout.spinner)
    }

    func testFilledLabelStaysOnOneLine() {
        let layout = RoundButtonLayout(.init(width: 200, size: .normal, label: text(String(repeating: "w", count: 40), lineHeight: 20, maxLines: 1)))
        assertSize(layout.size, CGSize(width: 200, height: 44))
        assertFrame(layout.label, rect(20, 12, 160, 20))
    }

    func testInvertedLabelWrapsAndGrows() {
        let layout = RoundButtonLayout(.init(
            width: 327,
            size: .normal,
            display: .inverted,
            label: text("Can’t scan QR code? Paste link instead", lineHeight: 20)
        ))
        // 38 characters (304pt) do not fit in 287: two lines plus 8 + 8.
        assertSize(layout.size, CGSize(width: 327, height: 56))
        assertFrame(layout.label, rect(20, 8, 287, 40))
        XCTAssertEqual(layout.cornerRadius, 28)
    }

    func testShortInvertedLabelKeepsTheControlHeight() {
        let layout = RoundButtonLayout(.init(width: 280, size: .normal, display: .inverted, label: text("Use a secret key instead", lineHeight: 20)))
        assertSize(layout.size, CGSize(width: 280, height: 44))
        assertFrame(layout.label, rect(20, 12, 240, 20))
    }

    func testMinimumWidth() {
        let layout = RoundButtonLayout(.init(width: 30, size: .small, label: text("OK", lineHeight: 17, maxLines: 1)))
        XCTAssertEqual(layout.size.width, 64)
    }

    func testInlineSpinnerCentresWithItsTitle() {
        let layout = RoundButtonLayout(.init(
            width: 327,
            size: .normal,
            label: text("Linking…", lineHeight: 20, maxLines: 1),
            loading: .inline(spinner: CGSize(width: 20, height: 20))
        ))
        // Spinner 20 + 10 + title 64 = 94, centred in 327.
        assertFrame(layout.spinner, rect(116.5, 12, 20, 20))
        assertFrame(layout.label, rect(146.5, 12, 64, 20))
    }

    func testOverlaySpinnerSitsWhereTheLabelWas() {
        let layout = RoundButtonLayout(.init(
            width: 327,
            label: text("Restore", lineHeight: 22, maxLines: 1),
            loading: .overlay(spinner: CGSize(width: 20, height: 20))
        ))
        assertFrame(layout.spinner, rect(153.5, 15, 20, 20))
        assertFrame(layout.label, rect(24, 14, 279, 22))
    }
}

final class OnboardingLayoutTests: XCTestCase {
    let help = GetHelpButtonLayout(label: CGSize(width: 60, height: 20))

    func testGetHelpPill() {
        assertSize(help.size, CGSize(width: 107, height: 36))
        // The icon's column: OnboardingScreen.tsx's 17pt help-circle-outline
        // is centred in the whole row.
        assertFrame(help.icon, rect(12, 0, 17, 36))
        assertFrame(help.label, rect(35, 8, 60, 20))
    }

    func testBlockIsCentredBetweenBarAndFooter() {
        let layout = OnboardingLayout(.init(
            size: phone,
            safeArea: phoneUnderBar,
            content: block(height: 300),
            primary: block(height: 50),
            secondary: block(height: 44),
            help: help.size
        ))
        // Get help: 16 from the right, 12 above the home indicator.
        assertFrame(layout.help, rect(270, 770, 107, 36))
        assertFrame(layout.scroll, rect(0, 103, 393, 667))
        // Block 300 + 12 + 50 + 4 + 44 = 410; (667 - 16 - 410) / 2 = 120.5.
        assertFrame(layout.content, rect(24, 128.5, 345, 300))
        assertFrame(layout.primary, rect(24, 440.5, 345, 50))
        assertFrame(layout.secondary, rect(24, 494.5, 345, 44))
        assertSize(layout.contentSize, CGSize(width: 393, height: 667))
    }

    func testATertiaryActionSitsUnderTheSecondaryAndTheBlockStaysCentred() {
        let layout = OnboardingLayout(.init(
            size: phone,
            safeArea: phoneUnderBar,
            content: block(height: 300),
            primary: block(height: 50),
            secondary: block(height: 44),
            tertiary: block(height: 44),
            help: help.size
        ))
        // Block 410 + 4 + 44 = 458; (667 - 16 - 458) / 2 = 96.5.
        assertFrame(layout.content, rect(24, 104.5, 345, 300))
        assertFrame(layout.primary, rect(24, 416.5, 345, 50))
        assertFrame(layout.secondary, rect(24, 470.5, 345, 44))
        XCTAssertEqual(layout.tertiary, rect(24, 518.5, 345, 44))
        assertSize(layout.contentSize, CGSize(width: 393, height: 667))
        XCTAssertNil(OnboardingLayout(.init(size: phone, safeArea: phoneUnderBar, content: block(height: 300), primary: block(height: 50), secondary: block(height: 44), help: help.size)).tertiary)
    }

    /// The link sheet's Relay | Direct switch: across the block, just above
    /// the primary button, 16 clear of what is above and below it.
    func testAnAccessorySitsJustAboveThePrimaryAcrossTheBlock() {
        var input = OnboardingLayout.Input(size: phone, safeArea: phoneUnderBar, content: block(height: 300), primary: block(height: 50), secondary: block(height: 44), help: help.size)
        input.accessory = 36
        let layout = OnboardingLayout(input)
        // Block 300 + 16 + 36 + 16 + 50 + 4 + 44 = 466; (667 - 16 - 466) / 2 = 92.5.
        assertFrame(layout.content, rect(24, 100.5, 345, 300))
        XCTAssertEqual(layout.accessory, rect(24, 416.5, 345, 36))
        assertFrame(layout.primary, rect(24, 468.5, 345, 50))
        XCTAssertEqual(layout.accessory?.width, layout.primary.width)
        XCTAssertEqual(layout.accessory?.minX, layout.primary.minX)
        assertFrame(layout.secondary, rect(24, 522.5, 345, 44))
    }

    func testGlassActionsAreSpacedAsPills() {
        var input = OnboardingLayout.Input(
            size: phone,
            safeArea: phoneUnderBar,
            content: block(height: 300),
            primary: block(height: 50),
            secondary: block(height: 44),
            tertiary: block(height: 44),
            help: help.size
        )
        input.glass = true
        let layout = OnboardingLayout(input)
        // Block 300 + 12 + 50 + 12 + 44 + 12 + 44 = 474; (667 - 16 - 474) / 2 = 88.5.
        assertFrame(layout.content, rect(24, 96.5, 345, 300))
        assertFrame(layout.primary, rect(24, 408.5, 345, 50))
        assertFrame(layout.secondary, rect(24, 470.5, 345, 44))
        XCTAssertEqual(layout.tertiary, rect(24, 526.5, 345, 44))
    }

    func testTallBlockScrolls() {
        let layout = OnboardingLayout(.init(
            size: phone,
            safeArea: phoneUnderBar,
            content: block(height: 700),
            primary: block(height: 50),
            secondary: block(height: 44),
            help: help.size
        ))
        XCTAssertEqual(layout.content.minY, 8)
        XCTAssertEqual(layout.secondary.maxY, 818)
        XCTAssertEqual(layout.contentSize.height, 826)
    }

    func testBlockCapsAt480OnTablets() {
        let size = CGSize(width: 1024, height: 1366)
        let insets = LayoutInsets(top: 74, bottom: 20)
        let layout = OnboardingLayout(.init(size: size, safeArea: insets, content: block(height: 300), primary: block(height: 50), secondary: block(height: 44), help: help.size))
        XCTAssertEqual(OnboardingLayout.blockWidth(size: size, safeArea: insets), 432)
        XCTAssertEqual(layout.content.minX, 296)
        XCTAssertEqual(layout.content.width, 432)
    }

    func testLandscapeRespectsSideInsets() {
        let size = CGSize(width: 852, height: 393)
        let insets = LayoutInsets(top: 32, left: 59, bottom: 21, right: 59)
        let layout = OnboardingLayout(.init(size: size, safeArea: insets, content: block(height: 100), primary: block(height: 50), secondary: block(height: 44), help: help.size))
        // 734 wide body, 480 block centred in it, 24 padding.
        XCTAssertEqual(layout.content.minX, 59 + 127 + 24)
        XCTAssertEqual(layout.help.maxX, 852 - 59 - 16)
    }

    func testButtonsLandInTheSamePlaceForEitherContent() {
        let welcome = block(height: 276)
        let link = block(height: 274)
        let reserved = Measurable.largest(of: [welcome, link])
        func primary(showing _: Measurable) -> CGRect {
            OnboardingLayout(.init(size: phone, safeArea: phoneUnderBar, content: reserved, primary: block(height: 50), secondary: block(height: 44), help: help.size)).primary
        }
        XCTAssertEqual(primary(showing: welcome), primary(showing: link))
        XCTAssertEqual(reserved.height(fitting: 345), 276)
    }

    func testWelcomeContent() {
        let layout = WelcomeContentLayout(
            width: 345,
            title: text("Claude, Codex, Grok\nin your pocket", lineHeight: 34, maxLines: 0).withLines(2, lineHeight: 34),
            props: [
                text("End-to-end encrypted", lineHeight: 24),
                text("No email, no password", lineHeight: 24),
                text("Open source, MIT license", lineHeight: 24),
            ]
        )
        // round(84 × 5274 / 1932) = 229.
        assertFrame(layout.wordmark, rect(0, 0, 229, 84))
        assertFrame(layout.title, rect(0, 112, 345, 68))
        assertFrame(layout.props[0], rect(0, 192, 345, 24))
        assertFrame(layout.props[1], rect(0, 216, 345, 24))
        assertFrame(layout.props[2], rect(0, 240, 345, 24))
        assertSize(layout.size, CGSize(width: 345, height: 276))
    }

    func testWordmarkScalesDownWhenNarrow() {
        let layout = WelcomeContentLayout(width: 200, title: block(height: 34), props: [])
        assertFrame(layout.wordmark, rect(0, 0, 200, 84 * 200 / 229))
    }

    func testLinkComputerChecklist() {
        let layout = LinkComputerContentLayout(
            width: 345,
            title: text("Link Your Computer", lineHeight: 34),
            rows: [
                .init(title: text("Install Happy on your computer", lineHeight: 22), body: text(String(repeating: "b", count: 70), lineHeight: 21)),
                .init(title: text("Open Happy and choose Link Mobile App", lineHeight: 22), body: text(String(repeating: "b", count: 70), lineHeight: 21)),
            ],
            errorLineHeight: 20
        )
        assertFrame(layout.title, rect(0, 0, 345, 34))
        // Checklist 24 below; head row 32 high, box and title centred in it.
        assertFrame(layout.rows[0].head, rect(0, 58, 345, 32))
        assertFrame(layout.rows[0].box, rect(0, 61, 26, 26))
        assertFrame(layout.rows[0].title, rect(38, 63, 307, 22))
        // Body indented 38, 6 below the head; 70 characters wrap to 2 lines.
        assertFrame(layout.rows[0].body, rect(38, 96, 307, 42))
        // 20 between rows.
        assertFrame(layout.rows[1].head, rect(0, 158, 345, 32))
        assertFrame(layout.rows[1].body, rect(38, 196, 307, 42))
        // The error line is reserved 16 below, even when empty.
        assertFrame(layout.error, rect(0, 254, 345, 20))
        assertSize(layout.size, CGSize(width: 345, height: 274))
    }

    func testNavigationTitleWithServerSubtitle() {
        let layout = NavigationTitleLayout(title: CGSize(width: 80, height: 20), subtitle: CGSize(width: 150, height: 14), maxWidth: 200)
        assertSize(layout.size, CGSize(width: 150, height: 34))
        assertFrame(layout.title, rect(35, 0, 80, 20))
        assertFrame(layout.subtitle, rect(0, 20, 150, 14))
    }

    func testNavigationSubtitleOnlyIsClampedToTheBar() {
        let layout = NavigationTitleLayout(title: nil, subtitle: CGSize(width: 300, height: 14), maxWidth: 200)
        XCTAssertNil(layout.title)
        assertFrame(layout.subtitle, rect(0, 0, 200, 14))
    }
}

private extension Measurable {
    /// Forces a line count, for text with hard line breaks.
    func withLines(_ lines: Int, lineHeight: CGFloat) -> Measurable {
        Measurable { width in CGSize(width: width, height: CGFloat(lines) * lineHeight) }
    }
}

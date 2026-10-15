#if canImport(UIKit)
import HappyIcons
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

// These need UIKit's text system, so they run only on Apple platforms:
// Xcode (the HappyUIKitTests scheme from project.yml, or the package scheme)
// on an iOS simulator. The frame math itself is covered on Linux by
// HappyLayoutTests; here we check that real views measure the way the
// layouts assume and apply the frames they compute.
@MainActor
final class UIKitMeasurementTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func height(_ view: UIView, width: CGFloat) -> CGFloat {
        view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    }

    func testBundledFontsRegister() {
        for face in FontFace.allCases {
            XCTAssertNotNil(UIFont(name: face.rawValue, size: 17), face.rawValue)
        }
    }

    func testFixedLineHeightIsWhatLabelsMeasure() {
        let label = StyledLabel(style: TextStyles.itemTitle, color: Palette.text, lines: 2)
        label.string = "Logout"
        XCTAssertEqual(height(label, width: 343), 22)
        label.string = String(repeating: "Wrapping title text ", count: 10)
        XCTAssertEqual(height(label, width: 200), 44, "two lines, capped by numberOfLines")
        label.numberOfLines = 0
        XCTAssertEqual(height(label, width: 200).truncatingRemainder(dividingBy: 22), 0)
    }

    func testUppercaseStyleTransformsText() {
        let label = StyledLabel(style: TextStyles.groupHeader, color: Palette.textSecondary)
        label.string = "Backup"
        XCTAssertEqual(label.attributedText?.string, "BACKUP")
    }

    func testItemRowMatchesHappyAppHeights() {
        let plain = ItemRowView(title: "Logout")
        XCTAssertEqual(height(plain, width: 343), 46)

        let subtitled = ItemRowView(
            title: Strings.SettingsAccount.linkNewDevice,
            subtitle: Strings.SettingsAccount.linkNewDeviceSubtitle,
            icon: ItemIcon(.ionicons("qr-code-outline"), tint: Palette.iconBlue),
            onTap: {}
        )
        XCTAssertEqual(height(subtitled, width: 343), 66)
        subtitled.showsDivider = true
        XCTAssertEqual(height(subtitled, width: 343), 66.33, accuracy: 0.001)
    }

    func testItemRowAppliesItsLayout() {
        let row = ItemRowView(title: "Version", detail: "1.8.0", icon: ItemIcon(.ionicons("information-circle-outline"), tint: Palette.textSecondary), onTap: {})
        row.frame = CGRect(x: 0, y: 0, width: 343, height: 46)
        row.layoutIfNeeded()
        let layout = row.layout(width: 343)
        let scale = row.traitCollection.displayScale
        assertSameFrame(row.titleLabel.frame, PixelGrid.snap(layout.title, scale: scale), "title")
        assertSameFrame(row.detailLabel.frame, PixelGrid.snap(layout.detail!, scale: scale), "detail")
        // The chevron is a text box: Yoga floors its position.
        assertSameFrame(row.chevronView.frame, IconLayout.textFrame(layout.accessory!, scale: scale), "chevron")
        assertSameFrame(row.glyphView.frame, PixelGrid.snap(layout.icon!, scale: scale), "icon")
        XCTAssertFalse(row.chevronView.isHidden)
        // Item.tsx's chevron: Ionicons at 17, one em wide.
        XCTAssertEqual(layout.accessory!.width, 17)
    }

    func testRowWithoutActionHasNoChevron() {
        let row = ItemRowView(title: "Status", detail: "Active")
        XCTAssertNil(row.layout(width: 343).accessory)
    }

    func testGroupStacksHeaderRowsAndFooter() {
        let group = ItemGroupView(
            title: "Backup",
            footer: nil,
            rows: [ItemRowView(title: "One"), ItemRowView(title: "Two")]
        )
        // Header 35 + 18 + 6, two 46pt rows, the first with its hairline.
        XCTAssertEqual(height(group, width: 375), 59 + 46.33 + 46, accuracy: 0.001)
        XCTAssertTrue((group.rows[0] as? ItemRowView)?.showsDivider == true)
        XCTAssertTrue((group.rows[1] as? ItemRowView)?.showsDivider == false)
    }

    func testRoundButtonHeights() {
        XCTAssertEqual(height(RoundButton(title: "Create account"), width: 345), 50)
        XCTAssertEqual(height(RoundButton(title: "Save", size: .normal), width: 345), 44)
        XCTAssertEqual(height(RoundButton(title: "OK", size: .small), width: 345), 32)
        let inverted = RoundButton(title: Strings.Onboarding.pasteLink, size: .normal, display: .inverted)
        // One 20pt line plus 8 + 8 stays under the 44 minimum at this width.
        XCTAssertEqual(height(inverted, width: 345), 44)
    }

    func testInlineLoadingShowsTheLoadingTitle() {
        let button = RoundButton(title: Strings.Onboarding.scanButton)
        button.loadingTitle = Strings.Onboarding.linking
        button.isLoading = true
        XCTAssertEqual(button.label.attributedText?.string, Strings.Onboarding.linking)
        let layout = button.layout(width: 345)
        XCTAssertNotNil(layout.spinner)
        XCTAssertEqual(layout.spinner!.size, CGSize(width: 20, height: 20))
    }

    func testWelcomeContentHeight() {
        let content = WelcomeContentView()
        // Wordmark 84, 28, two 34pt headline lines, 12, three 24pt props, 12.
        XCTAssertEqual(height(content, width: 345), 84 + 28 + 68 + 12 + 72 + 12)
        XCTAssertEqual(content.wordmark.intrinsicContentSize, CGSize(width: 229, height: 84))
    }

    func testButtonsDoNotMoveBetweenWelcomeAndLinkComputer() {
        func primaryFrame(_ content: UIView) -> CGRect {
            let screen = OnboardingScreenView(
                content: content,
                primary: RoundButton(title: "Primary"),
                secondary: RoundButton(title: "Secondary", size: .normal, display: .inverted)
            )
            screen.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
            return screen.layout().primary
        }
        XCTAssertEqual(primaryFrame(WelcomeContentView()), primaryFrame(LinkComputerContentView()))
    }

    func testServerFormMatchesLayout() {
        let form = ServerFormView()
        // Label, 44 field, Save: 12 + label + 8 + 44 + 8 + 4 + 44 + 12 + 12.
        let labelHeight = form.label.sizeThatFits(CGSize(width: 311, height: CGFloat.greatestFiniteMagnitude)).height
        XCTAssertEqual(height(form, width: 343), 144 + labelHeight)
        form.isCustomServer = true
        XCTAssertGreaterThan(height(form, width: 343), 144 + labelHeight + 44)
    }

    func testQRCodeImageIsSquare() throws {
        let image = try XCTUnwrap(QRCodeView.image(for: "happy:///account?AAAA"))
        XCTAssertEqual(image.size.width, image.size.height)
    }

    func testNavigationTitleStacksSubtitle() {
        let title = NavigationTitleView(title: "Settings", subtitle: "192.168.1.20:3005")
        let size = title.intrinsicContentSize
        XCTAssertEqual(size.height, 20 + 14)
        XCTAssertLessThanOrEqual(size.width, NavigationTitleView.defaultMaxWidth)
    }

    /// Home and Welcome refit the title when the server under it changes:
    /// `sizeToFit` measures within the old frame, so a longer server would
    /// be cut to the shorter one's width; the intrinsic size is not.
    func testALongerSubtitleIsNotHeldToTheOldWidth() {
        let title = NavigationTitleView(subtitle: "a.io")
        title.frame.size = title.intrinsicContentSize
        let short = title.frame.width
        title.subtitle = "self-hosted.example.com:3005"
        title.sizeToFit()
        XCTAssertEqual(title.frame.width, short, "the trap the screens avoid")
        title.frame.size = title.intrinsicContentSize
        XCTAssertGreaterThan(title.frame.width, short)
        XCTAssertEqual(title.frame.size, title.layout(maxWidth: NavigationTitleView.defaultMaxWidth).size)
    }

    func testGroupedListPlacesSectionsUnderTheSafeArea() {
        let list = GroupedListView(sections: [SettingsHeaderView()])
        list.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        list.layoutIfNeeded()
        // No window, so no safe area: the header card starts at the top.
        XCTAssertEqual(list.sections[0].frame, CGRect(x: 0, y: 0, width: 393, height: 166))
        XCTAssertEqual(list.contentSize.height, 852)
    }
}
#endif

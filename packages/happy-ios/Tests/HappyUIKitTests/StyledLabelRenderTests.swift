#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A label draws its text once, at its screen's text size, when it is made
/// and set up before it joins the screen: not once as designed and again
/// when the screen's size reaches it.
@MainActor
final class StyledLabelRenderTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private let category = UIContentSizeCategory.accessibilityExtraExtraExtraLarge
    private var multiplier: CGFloat { TextScale(TextSizeCategory(category)).multiplier }

    /// A settled view in a window, at the largest size, following it or not.
    private func host(follows: Bool = true) -> (UIWindow, UIView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let host = UIView(frame: window.bounds)
        host.traitOverrides.preferredContentSizeCategory = category
        host.traitOverrides.followsTextSize = follows
        window.addSubview(host)
        window.isHidden = false
        host.updateTraitsIfNeeded()
        return (window, host)
    }

    private func font(_ label: UILabel) -> UIFont? {
        label.attributedText?.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
    }

    func testALabelSetUpBeforeItJoinsItsScreenDrawsOnceAtTheScreensSize() throws {
        let (window, host) = host()
        let label = StyledLabel(style: TextStyles.itemTitle, color: Palette.text, lines: 2)
        label.string = "Created"
        label.color = Palette.textSecondary
        label.numberOfLines = 1
        label.alignment = .center
        XCTAssertEqual(label.renders, 0)
        XCTAssertEqual(label.accessibilityLabel, "Created")

        host.addSubview(label)
        label.frame = CGRect(x: 0, y: 0, width: 300, height: 60)
        host.layoutIfNeeded()
        label.updateTraitsIfNeeded()
        label.layoutIfNeeded()
        XCTAssertEqual(label.renders, 1)
        XCTAssertEqual(try XCTUnwrap(font(label)).pointSize, 17 * multiplier, accuracy: 0.0001)
        XCTAssertEqual(label.attributedText?.string, "Created")
        let color = try XCTUnwrap(label.attributedText?.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor)
        XCTAssertEqual(color.resolvedColor(with: label.traitCollection), UIColor(Palette.textSecondary).resolvedColor(with: label.traitCollection))
        let paragraph = try XCTUnwrap(label.attributedText?.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
        XCTAssertEqual(paragraph.alignment, .center)
        XCTAssertEqual(paragraph.lineBreakMode, .byTruncatingTail)

        // Once drawn, a change draws at once, with no layout pass.
        label.string = "Last updated"
        XCTAssertEqual(label.renders, 2)
        XCTAssertEqual(label.attributedText?.string, "Last updated")
        // An equal value draws nothing.
        label.string = "Last updated"
        label.color = Palette.textSecondary
        XCTAssertEqual(label.renders, 2)
        withExtendedLifetime(window) {}
    }

    /// Session info's rows: every label in an `ItemRowView` and in its
    /// `ItemGroupView` draws once when the group joins the screen.
    func testARowAndItsGroupDrawEachLabelOnce() throws {
        let (window, host) = host()
        let row = ItemRowView(title: "Created", subtitle: "10/16/2026, 9:00:00 AM", detail: "3",
                              icon: ItemIcon(.ionicons("calendar-outline"), tint: Palette.text))
        row.showsChevron = false
        let group = ItemGroupView(title: "Details", rows: [row, ItemRowView(title: "Sequence", detail: "3")])
        let labels = [group.headerLabel, group.footerLabel] + group.rows.compactMap { $0 as? ItemRowView }.flatMap {
            [$0.titleLabel, $0.subtitleLabel, $0.detailLabel]
        }
        XCTAssertEqual(labels.map(\.renders), Array(repeating: 0, count: labels.count))

        host.addSubview(group)
        group.frame = CGRect(x: 0, y: 0, width: 393, height: group.sizeThatFits(CGSize(width: 393, height: 0)).height)
        host.layoutIfNeeded()
        group.layoutIfNeeded()
        for row in group.rows { row.layoutIfNeeded() }
        XCTAssertEqual(labels.map(\.renders), Array(repeating: 1, count: labels.count))
        XCTAssertEqual(try XCTUnwrap(font(row.titleLabel)).pointSize, 17 * multiplier, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(font(row.subtitleLabel)).pointSize, 15 * multiplier, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(font(group.headerLabel)).pointSize, 13 * multiplier, accuracy: 0.0001)
        XCTAssertEqual(row.titleLabel.numberOfLines, 1, "a subtitle caps the title at one line")
        withExtendedLifetime(window) {}
    }

    /// Where the screen keeps the designed size, it is drawn once at it.
    func testOnAScreenThatDoesNotFollowItDrawsOnceAsDesigned() throws {
        let (window, host) = host(follows: false)
        let label = StyledLabel(style: TextStyles.itemTitle, color: Palette.text)
        label.string = "Host"
        host.addSubview(label)
        label.updateTraitsIfNeeded()
        label.layoutIfNeeded()
        XCTAssertEqual(label.renders, 1)
        XCTAssertEqual(font(label)?.pointSize, 17)
        withExtendedLifetime(window) {}
    }

    /// Read or measured before it joins a screen, a label draws then, as
    /// designed, and again at the screen's size once it is there.
    func testALabelReadBeforeItJoinsDrawsThenAndAgainOnTheScreen() throws {
        let (window, host) = host()
        let label = StyledLabel(style: TextStyles.itemTitle, color: Palette.text)
        label.string = "Path"
        XCTAssertEqual(label.attributedText?.string, "Path")
        XCTAssertEqual(font(label)?.pointSize, 17)
        XCTAssertEqual(label.renders, 1)
        let measured = StyledLabel(style: TextStyles.itemTitle, color: Palette.text)
        measured.string = "Path"
        XCTAssertGreaterThan(measured.sizeThatFits(CGSize(width: 300, height: CGFloat.greatestFiniteMagnitude)).height, 0)
        XCTAssertEqual(measured.renders, 1)

        for view in [label, measured] {
            host.addSubview(view)
            view.updateTraitsIfNeeded()
            view.layoutIfNeeded()
            XCTAssertEqual(view.renders, 2)
            XCTAssertEqual(try XCTUnwrap(font(view)).pointSize, 17 * multiplier, accuracy: 0.0001)
        }
        withExtendedLifetime(window) {}
    }

    /// Measuring a first render must not invalidate the container's cache
    /// while it is still being measured. Joining a window still invalidates.
    func testAFirstDrawFromMeasuringAsksNoLayoutOfWhatMeasuresIt() {
        let (window, host) = host()
        let container = MeasuringContainer(frame: CGRect(x: 0, y: 0, width: 300, height: 100))
        let measured = StyledLabel(style: TextStyles.itemTitle, color: Palette.text, lines: 2)
        measured.string = "Measured first"
        container.addSubview(measured)
        let read = StyledLabel(style: TextStyles.itemSubtitle, color: Palette.text)
        read.string = "Read first"
        container.addSubview(read)
        container.measure {
            XCTAssertGreaterThan(measured.sizeThatFits(CGSize(width: 300, height: CGFloat.greatestFiniteMagnitude)).height, 0)
            XCTAssertGreaterThan(read.intrinsicContentSize.height, 0)
            XCTAssertGreaterThan(read.lineHeight, 0)
            XCTAssertEqual(read.attributedText?.string, "Read first")
        }
        XCTAssertEqual(measured.renders, 1)
        XCTAssertEqual(read.renders, 1)
        XCTAssertEqual(container.invalidatedWhileMeasuring, 0)

        let laidOut = StyledLabel(style: TextStyles.itemTitle, color: Palette.text)
        laidOut.string = "Laid out first"
        laidOut.frame = CGRect(x: 0, y: 0, width: 300, height: 40)
        container.addSubview(laidOut)
        let beforeLayout = container.invalidations
        laidOut.setNeedsLayout()
        laidOut.layoutIfNeeded()
        XCTAssertEqual(laidOut.renders, 1)
        XCTAssertGreaterThan(container.invalidations, beforeLayout)

        let joining = StyledLabel(style: TextStyles.itemTitle, color: Palette.text)
        joining.string = "Joined first"
        let holder = MeasuringContainer(frame: CGRect(x: 0, y: 0, width: 300, height: 100))
        holder.addSubview(joining)
        let beforeJoin = holder.invalidations
        host.addSubview(holder)
        XCTAssertEqual(joining.renders, 1)
        XCTAssertGreaterThan(holder.invalidations, beforeJoin)
        withExtendedLifetime(window) {}
    }

    /// Text set straight on the label stands until it next draws: a new
    /// text, style or text size.
    func testTextSetDirectlyStandsUntilTheNextDraw() {
        let (window, host) = host()
        let label = StyledLabel(style: TextStyles.itemTitle, color: Palette.text)
        label.string = "Styled"
        label.attributedText = NSAttributedString(string: "Plain")
        XCTAssertEqual(label.attributedText?.string, "Plain")
        XCTAssertEqual(label.renders, 0)
        // Joining a screen at another size draws it at that size.
        host.addSubview(label)
        label.updateTraitsIfNeeded()
        label.layoutIfNeeded()
        XCTAssertEqual(label.attributedText?.string, "Styled")
        XCTAssertEqual(label.renders, 1)

        label.attributedText = NSAttributedString(string: "Plain")
        label.setNeedsLayout()
        label.layoutIfNeeded()
        XCTAssertEqual(label.attributedText?.string, "Plain")
        XCTAssertEqual(label.renders, 1)
        label.string = "Styled again"
        XCTAssertEqual(label.attributedText?.string, "Styled again")
        XCTAssertEqual(label.renders, 2)
        withExtendedLifetime(window) {}
    }
}

private final class MeasuringContainer: UIView {
    private var measuring = false
    private(set) var invalidations = 0
    private(set) var invalidatedWhileMeasuring = 0

    func measure(_ body: () -> Void) {
        measuring = true
        defer { measuring = false }
        body()
    }

    override func setNeedsLayout() {
        super.setNeedsLayout()
        invalidations += 1
        if measuring { invalidatedWhileMeasuring += 1 }
    }
}
#endif

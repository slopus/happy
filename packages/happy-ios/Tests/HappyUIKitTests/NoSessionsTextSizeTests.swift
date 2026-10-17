#if canImport(UIKit)
import HappyIcons
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// "No sessions yet" at the person's text size: measured off the main
/// thread, laid out from what was measured, and the same layout its glyph,
/// labels and buttons give when they measure themselves.
@MainActor
final class NoSessionsTextSizeTests: XCTestCase {
    private let categories: [UIContentSizeCategory] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    /// A view that sets the traits of what is put in it.
    private func host(width: CGFloat, category: UIContentSizeCategory, scale: CGFloat, follows: Bool = true) -> UIView {
        let host = UIView(frame: CGRect(x: 0, y: 0, width: width, height: 852))
        host.traitOverrides.preferredContentSizeCategory = category
        host.traitOverrides.displayScale = scale
        host.traitOverrides.followsTextSize = follows
        return host
    }

    private func shown(in host: UIView, archived: Bool = false) async -> NoSessionsView {
        let view = NoSessionsView(frame: host.bounds)
        view.showsArchivedAction = archived
        host.addSubview(view)
        host.updateTraitsIfNeeded()
        view.updateTraitsIfNeeded()
        view.layoutIfNeeded()
        await view.measured()
        view.layoutIfNeeded()
        return view
    }

    /// A part measured by itself at the host's text size and scale. Put in
    /// the host, a view made outside it does not reliably take the host's
    /// overrides (the Mac run left them at the simulator's own Large and
    /// 2x), so the part gets them itself, as HomeListTextSizeTests' cells
    /// do.
    private func follow(_ part: UIView, category: UIContentSizeCategory, scale: CGFloat) {
        part.traitOverrides.preferredContentSizeCategory = category
        part.traitOverrides.displayScale = scale
        part.traitOverrides.followsTextSize = true
        part.updateTraitsIfNeeded()
    }

    /// `view` is drawn at `category` and `scale`, and its label draws its
    /// style at that size.
    private func assertDrawnAt(
        _ view: UIView,
        _ label: StyledLabel,
        category: UIContentSizeCategory,
        scale: CGFloat,
        _ message: String,
        line: UInt = #line
    ) {
        XCTAssertEqual(view.traitCollection.preferredContentSizeCategory, category, message, line: line)
        XCTAssertEqual(view.traitCollection.displayScale, scale, message, line: line)
        XCTAssertTrue(view.traitCollection[FollowsTextSize.self], message, line: line)
        XCTAssertNil(label.style.maxScale, message, line: line)
        XCTAssertEqual(label.renderedStyle.size, label.style.size * TextScale(TextSizeCategory(category)).multiplier, message, line: line)
    }

    private func assertRect(_ actual: CGRect?, _ expected: CGRect?, _ message: String, line: UInt = #line) {
        guard let actual, let expected else {
            XCTAssertEqual(actual == nil, expected == nil, message, line: line)
            return
        }
        XCTAssertEqual(actual.minX, expected.minX, accuracy: 0.001, "x, \(message)", line: line)
        XCTAssertEqual(actual.minY, expected.minY, accuracy: 0.001, "y, \(message)", line: line)
        XCTAssertEqual(actual.width, expected.width, accuracy: 0.001, "width, \(message)", line: line)
        XCTAssertEqual(actual.height, expected.height, accuracy: 0.001, "height, \(message)", line: line)
    }

    /// Outside a window, as the glyph and the labels then take the host's
    /// screen scale. The expected layout is the one the view made before:
    /// each part measured on main by itself.
    func testTheMeasuredLayoutIsWhatEachPartMeasuresAtEveryTextSize() async {
        for category in categories {
            for scale in [CGFloat(2), 3] {
                for width in [CGFloat(320), 393] {
                    for archived in [false, true] {
                        let host = host(width: width, category: category, scale: scale)
                        let view = await shown(in: host, archived: archived)
                        let icon = IconView(.ionicons("terminal-outline"), size: NoSessionsLayout.Metrics.iconSize)
                        let title = StyledLabel(
                            style: NoSessionsView.titleText.style, color: Palette.text,
                            lines: NoSessionsView.titleText.lines, alignment: NoSessionsView.titleText.alignment
                        )
                        title.string = Strings.EmptyMain.noSessionsTitle
                        let description = StyledLabel(
                            style: NoSessionsView.descriptionText.style, color: Palette.textSecondary,
                            lines: NoSessionsView.descriptionText.lines, alignment: NoSessionsView.descriptionText.alignment
                        )
                        description.string = Strings.EmptyMain.noSessionsDescription
                        let button = RoundButton(title: Strings.NewSession.startNewSession)
                        let action = TextActionButton(title: Strings.Sidebar.showArchived)
                        for part in [icon, title, description, button, action] as [UIView] {
                            host.addSubview(part)
                            follow(part, category: category, scale: scale)
                        }
                        let message = "\(width) @\(scale)x, \(category.rawValue), archived: \(archived)"
                        // The view's own labels are drawn at the row's text
                        // size and scale (they are never measured on main).
                        assertDrawnAt(view.titleLabel, view.titleLabel, category: category, scale: scale, "view's title, \(message)")
                        assertDrawnAt(view.descriptionLabel, view.descriptionLabel, category: category, scale: scale, "view's description, \(message)")
                        assertDrawnAt(view.startNewSession, view.startNewSession.label, category: category, scale: scale, "view's button, \(message)")
                        assertDrawnAt(view.showArchived, view.showArchived.label, category: category, scale: scale, "view's action, \(message)")

                        let expected = NoSessionsLayout(.init(
                            size: view.bounds.size,
                            safeArea: LayoutInsets(view.safeAreaInsets),
                            icon: icon.sizeThatFits(.zero),
                            title: title.measurable,
                            description: description.measurable,
                            buttonHeight: button.layout(width: view.bounds.width).size.height,
                            action: archived ? action.measurable : nil
                        ))
                        // And the parts were measured at it, as drawn.
                        XCTAssertEqual(icon.traitCollection.displayScale, scale, "icon, \(message)")
                        assertDrawnAt(title, title, category: category, scale: scale, "title, \(message)")
                        assertDrawnAt(description, description, category: category, scale: scale, "description, \(message)")
                        assertDrawnAt(button, button.label, category: category, scale: scale, "button, \(message)")
                        if archived {
                            assertDrawnAt(action, action.label, category: category, scale: scale, "action, \(message)")
                        }
                        guard let sizes = view.applied else {
                            XCTFail("nothing measured, \(message)")
                            continue
                        }
                        let derived = NoSessionsLayout(.init(
                            size: view.bounds.size,
                            safeArea: LayoutInsets(view.safeAreaInsets),
                            icon: sizes.icon,
                            title: .fixed(sizes.title),
                            description: .fixed(sizes.description),
                            buttonHeight: sizes.buttonHeight,
                            action: sizes.action.map(Measurable.fixed)
                        ))
                        assertRect(derived.icon, expected.icon, "icon, \(message)")
                        assertRect(derived.title, expected.title, "title, \(message)")
                        assertRect(derived.description, expected.description, "description, \(message)")
                        assertRect(derived.button, expected.button, "button, \(message)")
                        assertRect(derived.action, expected.action, "action, \(message)")
                        XCTAssertEqual(derived.contentHeight, expected.contentHeight, accuracy: 0.001, "content, \(message)")

                        // Inside the buttons too: their labels as measured
                        // off main, against the labels measuring themselves.
                        let buttonWidth = view.bounds.width
                        assertRect(
                            view.startNewSession.layout(width: buttonWidth).label,
                            button.layout(width: buttonWidth).label,
                            "button label, \(message)"
                        )
                        if let frame = expected.action {
                            assertRect(
                                TextActionLayout(width: frame.width, label: .fixed(sizes.actionLabel ?? .zero)).label,
                                TextActionLayout(width: frame.width, label: action.label.measurable).label,
                                "action label, \(message)"
                            )
                        } else {
                            XCTAssertNil(sizes.actionLabel, message)
                        }

                        // What the view placed is that layout, read back
                        // from UIKit on the screen's pixels.
                        assertSamePixels(view.titleLabel.frame, PixelGrid.snap(derived.title, scale: scale), scale: scale, "placed title, \(message)")
                        assertSamePixels(view.startNewSession.frame, PixelGrid.snap(derived.button ?? .zero, scale: scale), scale: scale, "placed button, \(message)")
                        XCTAssertEqual(view.showArchived.isHidden, !archived, message)
                        XCTAssertFalse(view.scrollView.isHidden, message)
                    }
                }
            }
        }
    }

    /// One measurement for one input, off the main thread, applied once.
    func testItIsMeasuredOnceOffTheMainThread() async throws {
        let host = host(width: 393, category: .accessibilityLarge, scale: 3)
        let view = await shown(in: host)
        let counts = view.measuring.counts
        XCTAssertEqual(counts.derivations, 1)
        XCTAssertEqual(counts.applies, 1)
        XCTAssertEqual(counts.rejected, 0)
        // Laying out again with nothing new asks for nothing, so nothing
        // can be measured.
        let input = try XCTUnwrap(view.requested)
        view.setNeedsLayout()
        view.layoutIfNeeded()
        XCTAssertEqual(view.requested, input)
        XCTAssertEqual(view.applied?.input, input)

        // Measuring itself refuses the main thread in Debug builds; off it,
        // it gives what the view applied.
        let sizes = await Task.detached { NoSessionsMeasure.sizes(input) }.value
        XCTAssertEqual(sizes, view.applied)
    }

    /// Sizes measured for an earlier width, archive action or text size are
    /// refused, and the view waits for its own.
    func testSizesForAnythingElseAreRefused() async throws {
        let host = host(width: 393, category: .large, scale: 3)
        let view = await shown(in: host)
        let wide = try XCTUnwrap(view.applied)

        view.frame.size.width = 320
        view.layoutIfNeeded()
        XCTAssertFalse(view.apply(wide))
        XCTAssertEqual(view.applied?.input.width, 393, "the old ones stay until the new ones are in")
        await view.measured()
        XCTAssertEqual(view.applied?.input.width, 320)

        let without = try XCTUnwrap(view.applied)
        view.showsArchivedAction = true
        view.layoutIfNeeded()
        XCTAssertFalse(view.apply(without))
        XCTAssertTrue(view.showArchived.isHidden, "not shown before it is measured")
        await view.measured()
        view.layoutIfNeeded()
        XCTAssertNotNil(view.applied?.action)
        XCTAssertFalse(view.showArchived.isHidden)

        let large = try XCTUnwrap(view.applied)
        host.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        host.updateTraitsIfNeeded()
        view.updateTraitsIfNeeded()
        view.setNeedsLayout()
        view.layoutIfNeeded()
        XCTAssertFalse(view.apply(large))
        await view.measured()
        XCTAssertEqual(view.applied?.input.text.scale, TextScale(.accessibilityExtraExtraExtraLarge))
        XCTAssertGreaterThan(view.applied?.title.height ?? 0, large.title.height)
    }

    #if DEBUG
    /// Nothing on the screen measures text on main: not while it waits for
    /// its first sizes with nothing shown, not laying out again, not while
    /// sizes for an earlier width or without the archive are refused.
    func testNothingOnItMeasuresTextOnTheMainThread() async {
        let host = host(width: 393, category: .accessibilityExtraExtraExtraLarge, scale: 3)
        let view = NoSessionsView(frame: host.bounds)
        host.addSubview(view)
        host.updateTraitsIfNeeded()
        view.updateTraitsIfNeeded()
        let labels = [view.titleLabel, view.descriptionLabel, view.startNewSession.label, view.showArchived.label]
        func layOutEverything(_ step: String) {
            for control in [view.startNewSession, view.showArchived] as [UIView] {
                control.setNeedsLayout()
                _ = control.sizeThatFits(CGSize(width: view.bounds.width, height: .greatestFiniteMagnitude))
            }
            view.setNeedsLayout()
            view.layoutIfNeeded()
            XCTAssertEqual(labels.map(\.measurements), [0, 0, 0, 0], step)
        }

        layOutEverything("waiting for the first sizes")
        XCTAssertTrue(view.scrollView.isHidden)
        await view.measured()
        layOutEverything("measured")
        layOutEverything("again, nothing new")

        view.frame.size.width = 320
        layOutEverything("a new width, its sizes not yet in")
        await view.measured()
        layOutEverything("the new width measured")

        view.showsArchivedAction = true
        layOutEverything("the archive offered, not yet measured")
        await view.measured()
        layOutEverything("the archive measured")
        XCTAssertFalse(view.showArchived.isHidden)
        XCTAssertGreaterThan(view.showArchived.frame.width, 0)
    }
    #endif

    /// A view not yet given a size measures nothing.
    func testAViewWithNoWidthYetMeasuresNothing() {
        let view = NoSessionsView(frame: .zero)
        view.layoutIfNeeded()
        XCTAssertNil(view.requested)
        XCTAssertEqual(view.measuring.counts.derivations, 0)
    }

    /// Content that shrinks while scrolled past its new end comes back to
    /// that end.
    func testShrinkingContentIsNotLeftScrolledPastItsEnd() async {
        let host = host(width: 393, category: .accessibilityExtraExtraExtraLarge, scale: 3)
        let view = await shown(in: host)
        let before = view.scrollView.contentSize.height
        XCTAssertGreaterThan(before, view.bounds.height)
        view.scrollView.contentOffset.y = before - view.bounds.height
        host.traitOverrides.preferredContentSizeCategory = .accessibilityLarge
        host.updateTraitsIfNeeded()
        view.updateTraitsIfNeeded()
        view.setNeedsLayout()
        view.layoutIfNeeded()
        await view.measured()
        view.layoutIfNeeded()
        let after = view.scrollView.contentSize.height
        XCTAssertLessThan(after, before)
        XCTAssertEqual(view.scrollView.contentOffset.y, max(0, after - view.bounds.height))
    }

    /// A screen that doesn't follow the text size measures at the designed
    /// size: the title is one 30 point line.
    func testWithoutTheTraitItIsTheDesignedSize() async {
        let host = host(width: 393, category: .accessibilityExtraExtraExtraLarge, scale: 3, follows: false)
        let view = await shown(in: host)
        XCTAssertEqual(view.applied?.input.text.scale, .standard)
        XCTAssertEqual(view.applied?.title.height, 30)
        XCTAssertEqual(view.startNewSession.frame.height, 50)
    }

    /// At the largest size the content outgrows the space between the
    /// header and the dock: it starts under the header and scrolls, and
    /// "Start New Session" can be scrolled to above the dock and tapped.
    func testTallerThanTheScreenItScrollsAndTheButtonCanBeReached() async throws {
        final class Screen: UIViewController {
            let content = NoSessionsView()
            override func loadView() { view = content }
        }
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let screen = Screen()
        screen.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        screen.followsTextSize()
        // The header above, the dock below.
        screen.additionalSafeAreaInsets = UIEdgeInsets(top: 103, left: 0, bottom: 150, right: 0)
        window.rootViewController = screen
        window.isHidden = false
        defer { window.isHidden = true }
        let view = screen.content
        view.layoutIfNeeded()
        await view.measured()
        view.layoutIfNeeded()

        // The header and dock come on top of the window's own insets: none
        // on an iPhone SE simulator, the status bar and home indicator on an
        // iPhone Air's (68 at the top).
        let device = window.safeAreaInsets
        let safe = view.safeAreaInsets
        XCTAssertEqual(safe.top, device.top + 103)
        XCTAssertEqual(safe.bottom, device.bottom + 150)
        XCTAssertGreaterThan(view.scrollView.contentSize.height, view.bounds.height)
        XCTAssertEqual(view.icon.frame.minY, safe.top, accuracy: 1e-6, "from the top of the safe area")

        view.scrollView.contentOffset = CGPoint(x: 0, y: view.scrollView.contentSize.height - view.bounds.height)
        view.layoutIfNeeded()
        let button = view.convert(view.startNewSession.bounds, from: view.startNewSession)
        XCTAssertGreaterThanOrEqual(button.minY, safe.top)
        XCTAssertLessThanOrEqual(button.maxY, view.bounds.height - safe.bottom, "above the dock")
        let hit = try XCTUnwrap(view.hitTest(CGPoint(x: button.midX, y: button.midY), with: nil))
        XCTAssertTrue(hit === view.startNewSession)
    }
}
#endif

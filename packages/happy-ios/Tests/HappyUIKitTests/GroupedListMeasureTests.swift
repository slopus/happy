#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// GroupedListView measures each section once per width (`GroupedListCache`,
/// `WidthLayoutCache`), and What's New measures its text off the main thread
/// (`ChangelogPlan`): a scroll measures nothing, a new text size or width
/// plans each release once, a swapped group is the only one measured, and
/// what is drawn is where the plan put it.
@MainActor
final class GroupedListMeasureTests: XCTestCase {
    #if DEBUG
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    /// An iPhone 17 Pro's screen.
    private let portrait = CGRect(x: 0, y: 0, width: 402, height: 874)

    private func until(_ seconds: Double = 20, _ condition: () -> Bool) async throws -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    private func whatsNew(_ category: UIContentSizeCategory) -> (UIWindow, ChangelogViewController, GroupedListView) {
        let screen = ChangelogViewController(readMarker: ChangelogReadMarker(storage: InMemoryKeyValueStore()))
        let window = UIWindow(frame: portrait)
        window.traitOverrides.preferredContentSizeCategory = category
        window.traitOverrides.displayScale = 3
        window.rootViewController = screen
        window.isHidden = false
        window.layoutIfNeeded()
        return (window, screen, screen.view as! GroupedListView)
    }

    private func environment(_ category: UIContentSizeCategory) -> TextEnvironment {
        TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: 3)
    }

    /// Every release planned for `text` and laid out.
    private func settle(_ screen: ChangelogViewController, _ list: GroupedListView, text: TextEnvironment) async throws -> Bool {
        let settled = try await until {
            screen.shown?.input.text == text && screen.shown?.count == screen.entryViews.count
        }
        list.layoutIfNeeded()
        return settled
    }

    // MARK: What's New

    func testScrollingWhatsNewMeasuresNothing() async throws {
        let planned = ChangelogPlan.planned.value
        let (window, screen, list) = whatsNew(.large)
        defer { window.isHidden = true }
        XCTAssertFalse(screen.entryViews.isEmpty)
        let settled = try await settle(screen, list, text: environment(.large))
        XCTAssertTrue(settled)
        XCTAssertEqual(ChangelogPlan.planned.value - planned, screen.entryViews.count, "the first screen, then the rest: each release once")
        XCTAssertGreaterThan(list.contentSize.height, list.bounds.height * 4)

        MeasureCounters.reset()
        let labels = allLabels(in: list).map(\.measurements)
        let bottom = list.contentSize.height - list.bounds.height
        for step in 0...120 {
            list.contentOffset.y = bottom * CGFloat(step) / 120
            list.layoutIfNeeded()
        }
        for step in (0...120).reversed() {
            list.contentOffset.y = bottom * CGFloat(step) / 120
            list.layoutIfNeeded()
        }
        XCTAssertEqual(MeasureCounters["list.layout"], 0, "the list placed nothing again")
        XCTAssertEqual(MeasureCounters["group.layout"], 0)
        XCTAssertEqual(allLabels(in: list).map(\.measurements), labels, "no label measured itself")
        XCTAssertEqual(ChangelogPlan.planned.value - planned, screen.entryViews.count, "nothing planned again")
        XCTAssertFalse(containsTextView(list), "no UITextView left")
        // Near the top again: the far ones dropped their text.
        let drawn = screen.entryViews.filter(\.drawsText).count
        XCTAssertGreaterThan(drawn, 0)
        XCTAssertLessThan(drawn, screen.entryViews.count)
    }

    func testANewTextSizeOrWidthPlansEachReleaseOnce() async throws {
        let (window, screen, list) = whatsNew(.large)
        defer { window.isHidden = true }
        var settled = try await settle(screen, list, text: environment(.large))
        XCTAssertTrue(settled)
        let count = screen.entryViews.count
        let designed = list.contentSize.height

        var planned = ChangelogPlan.planned.value
        MeasureCounters.reset()
        window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        window.updateTraitsIfNeeded()
        window.layoutIfNeeded()
        settled = try await settle(screen, list, text: environment(.accessibilityExtraExtraExtraLarge))
        XCTAssertTrue(settled)
        XCTAssertEqual(ChangelogPlan.planned.value - planned, count, "each release planned once at the new size")
        XCTAssertGreaterThan(list.contentSize.height, designed * 1.5)
        XCTAssertEqual(MeasureCounters["group.layout"], 0)

        planned = ChangelogPlan.planned.value
        window.frame = CGRect(x: 0, y: 0, width: portrait.height, height: portrait.width)
        window.layoutIfNeeded()
        let wide = try await until { screen.shown?.input.width == list.bounds.width && screen.shown?.count == count }
        XCTAssertTrue(wide)
        XCTAssertEqual(ChangelogPlan.planned.value - planned, count, "each release planned once at the new width")
    }

    /// The text views draw the plan's own layouts in the plan's frames,
    /// snapped to the screen, and the sections sit where the list's layout
    /// of the planned sizes puts them.
    func testDrawnFramesAreThePlansAtEveryTextSize() async throws {
        for category in [UIContentSizeCategory.large, .extraExtraExtraLarge, .accessibilityMedium, .accessibilityExtraExtraExtraLarge] {
            let (window, screen, list) = whatsNew(category)
            let text = environment(category)
            let settled = try await settle(screen, list, text: text)
            XCTAssertTrue(settled, category.rawValue)
            for offset in [0, 0.5, 1] as [CGFloat] {
                list.contentOffset.y = (list.contentSize.height - list.bounds.height) * offset
                list.layoutIfNeeded()
                let rasterized = try await until { screen.entryViews.allSatisfy { !$0.drawsText || $0.isRasterized } }
                XCTAssertTrue(rasterized, category.rawValue)
                assertDrawnAsPlanned(screen, list, text: text, at: "\(category.rawValue) at \(offset)")
            }
            window.isHidden = true
        }
    }

    private func assertDrawnAsPlanned(_ screen: ChangelogViewController, _ list: GroupedListView, text: TextEnvironment, at: String) {
        let plans = screen.entryViews.compactMap(\.plan)
        XCTAssertEqual(plans.count, screen.entryViews.count, at)
        let layout = GroupedListLayout(.init(
            size: list.bounds.size,
            safeArea: LayoutInsets(list.safeAreaInsets),
            sections: plans.map { .fixed($0.layout.size) }
        ))
        XCTAssertEqual(list.contentSize, layout.contentSize, at)
        func snapped(_ frame: CGRect) -> CGRect { PixelGrid.snap(frame, scale: 3) }
        var checked = 0
        for (index, view) in screen.entryViews.enumerated() {
            let plan = plans[index]
            assertSameFrame(view.frame, snapped(layout.sections[index]), "release \(index), \(at)")
            assertSameFrame(view.card.frame, snapped(plan.layout.group.card), "card \(index), \(at)")
            guard view.drawsText else { continue }
            checked += 1
            let body = plan.layout.body
            var pairs: [(ChangelogTextView?, ChatTextLayout?, CGRect?)] = [
                (view.titleView, plan.title, plan.layout.group.header),
                (view.summaryView, plan.summary, body.summary),
            ]
            XCTAssertEqual(view.textViews.count, plan.texts.count, at)
            pairs += zip(view.textViews, zip(plan.texts, body.texts)).map { ($0, $1.0, $1.1) }
            let bullets = body.bullets.compactMap { $0 }
            XCTAssertEqual(view.bulletViews.count, bullets.count, at)
            pairs += zip(view.bulletViews, bullets).map { ($0, plan.bullet, $1) }
            for (drawn, planned, frame) in pairs {
                guard let planned, let frame else {
                    XCTAssertNil(drawn, "nothing planned, nothing drawn: \(index), \(at)")
                    continue
                }
                guard let drawn else { return XCTFail("planned but not drawn: \(index), \(at)") }
                XCTAssertTrue(drawn.layout === planned, "\(index), \(at)")
                assertSameFrame(drawn.frame, snapped(frame), "\(planned.string.string.prefix(20)), \(at)")
                // The bitmap is the frame, pixel for pixel.
                let image = drawn.image
                XCTAssertEqual(image.map { CGSize(width: $0.width, height: $0.height) },
                               CGSize(width: (drawn.frame.width * 3).rounded(), height: (drawn.frame.height * 3).rounded()), at)
                XCTAssertLessThanOrEqual(planned.size.height, frame.height, at)
                // Wrapped at its frame's width; the bullet is one line, unwrapped.
                if planned !== plan.bullet { XCTAssertEqual(planned.width, frame.width, at) }
            }
            if let first = plan.texts.first {
                let font = first.string.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
                XCTAssertEqual(font?.pointSize ?? 0, TextStyles.changelogBody.size * text.scale.multiplier, accuracy: 0.0001, at)
            }
        }
        XCTAssertGreaterThan(checked, 0, at)
    }

    func testTheReadMarkerIsSet() {
        let storage = InMemoryKeyValueStore()
        let marker = ChangelogReadMarker(storage: storage)
        let screen = ChangelogViewController(readMarker: marker)
        screen.loadViewIfNeeded()
        XCTAssertFalse(ChangelogViewController.bundled.latestTitle.isEmpty)
        XCTAssertEqual(marker.lastViewedTitle, ChangelogViewController.bundled.latestTitle)
    }

    func testLinksOpenAndParagraphsReadAsText() throws {
        let plan = ChangelogPlan.make(
            .init(width: 402, text: environment(.large), maxWidth: nil),
            entries: [Changelog.Entry(
                title: "1.0",
                summary: "Thanks [@a](https://example.com/a)",
                markdown: "- Read [the docs](https://example.com/docs) now\n\nNot a web [link](mailto:x@y.z)."
            )]
        )
        let view = ChangelogEntryView()
        view.plan = try XCTUnwrap(plan.entries.first)
        view.frame = CGRect(origin: .zero, size: view.sizeThatFits(CGSize(width: 402, height: 0)))
        var opened: [URL] = []
        view.openLink = { opened.append($0) }

        // Every link under the text, found by scanning it.
        var found = Set<URL>()
        let entry = try XCTUnwrap(view.plan)
        let card = entry.layout.group.card
        for frame in [entry.layout.body.summary].compactMap({ $0 }) + entry.layout.body.texts {
            let inEntry = frame.offsetBy(dx: card.minX, dy: card.minY)
            for y in stride(from: inEntry.minY + 2, to: inEntry.maxY, by: 4) {
                for x in stride(from: inEntry.minX + 1, to: inEntry.maxX, by: 3) {
                    if let url = view.link(at: CGPoint(x: x, y: y)) { found.insert(url) }
                }
            }
        }
        XCTAssertEqual(found, [URL(string: "https://example.com/a")!, URL(string: "https://example.com/docs")!],
                       "summary links open, markdown links only over http(s)")

        let elements = try XCTUnwrap(view.accessibilityElements as? [UIAccessibilityElement])
        XCTAssertEqual(elements.map { $0.accessibilityLabel ?? "" }, ["1.0", "Thanks @a", "Read the docs now", "Not a web link."])
        XCTAssertTrue(elements[0].accessibilityTraits.contains(.header))
        let docs = try XCTUnwrap(elements[2].accessibilityCustomActions?.first)
        XCTAssertEqual(docs.name, "the docs")
        XCTAssertTrue(docs.actionHandler?(docs) ?? false)
        XCTAssertEqual(opened, [URL(string: "https://example.com/docs")!])
        XCTAssertEqual(elements[3].accessibilityCustomActions?.count ?? 0, 0)
        let plain = entry.texts[1].string
        let range = (plain.string as NSString).range(of: "link")
        XCTAssertNil(plain.attribute(.underlineStyle, at: range.location, effectiveRange: nil), "a mailto link reads as text, as RenderSpans has it")
        // VoiceOver's frames are the plan's, drawn or not.
        XCTAssertFalse(view.drawsText)
        XCTAssertEqual(elements[2].accessibilityFrameInContainerSpace, entry.layout.body.texts[0].offsetBy(dx: card.minX, dy: card.minY))
    }

    // MARK: Other lists

    /// Settings › Agents and session info swap only the groups that
    /// changed: only the new one is measured, and a scroll measures nothing.
    func testSwappingOneGroupMeasuresOnlyThatGroup() throws {
        func group(_ title: String) -> ItemGroupView {
            ItemGroupView(title: title, rows: (0..<4).map { ItemRowView(title: "\(title) \($0)", subtitle: "Subtitle") })
        }
        var groups = (0..<6).map { group("Group \($0)") }
        let list = GroupedListView(sections: groups)
        list.traitOverrides.followsTextSize = true
        let window = UIWindow(frame: portrait)
        window.traitOverrides.displayScale = 3
        window.traitOverrides.preferredContentSizeCategory = .large
        window.addSubview(list)
        list.frame = window.bounds
        window.isHidden = false
        defer { window.isHidden = true }
        MeasureCounters.reset()
        list.layoutIfNeeded()
        XCTAssertEqual(MeasureCounters["group.layout"], groups.count, "each group measured once")
        XCTAssertEqual(MeasureCounters["list.layout"], 1)

        MeasureCounters.reset()
        let labels = allLabels(in: list).map(\.measurements)
        for step in 0...40 {
            list.contentOffset.y = CGFloat(step) * 10
            list.layoutIfNeeded()
        }
        XCTAssertEqual(MeasureCounters.snapshot(), [:], "a scroll measures no group and lays out no list")
        // Rows crossing the bars' edges get new safe areas and lay
        // themselves out again (ItemRowView keeps no layout): reported, so
        // the remaining work is known.
        let rowMeasurements = zip(allLabels(in: list).map(\.measurements), labels).map { $0 - $1 }.reduce(0, +)
        print("GROUPED_LIST_SCROLL label measurements over 41 frames: \(rowMeasurements)")

        let below = groups[3].frame.minY
        groups[2] = group("Rebuilt")
        groups[2].rows = Array(groups[2].rows.prefix(2))
        list.sections = groups
        list.layoutIfNeeded()
        XCTAssertEqual(MeasureCounters["group.layout"], 1, "only the new group")
        XCTAssertEqual(MeasureCounters["list.layout"], 1)
        XCTAssertLessThan(groups[3].frame.minY, below, "two rows fewer above it")

        // A row patched in place (Agents' computers) measures its group.
        MeasureCounters.reset()
        let moved = groups[5].frame.minY
        (groups[4].rows[0] as? ItemRowView)?.subtitle = "A subtitle\nover two lines"
        list.layoutIfNeeded()
        XCTAssertEqual(MeasureCounters["group.layout"], 1)
        XCTAssertGreaterThan(groups[5].frame.minY, moved)

        // A new text size measures every group once.
        MeasureCounters.reset()
        window.traitOverrides.preferredContentSizeCategory = .accessibilityMedium
        window.updateTraitsIfNeeded()
        list.layoutIfNeeded()
        XCTAssertEqual(MeasureCounters["group.layout"], groups.count)
        XCTAssertEqual(MeasureCounters["list.layout"], 1)
        // Each section is as tall as its group says.
        for section in groups {
            XCTAssertEqual(section.frame.height, section.layout(width: list.bounds.width).size.height, accuracy: 0.34)
        }
    }

    private func allLabels(in view: UIView) -> [StyledLabel] {
        ((view as? StyledLabel).map { [$0] } ?? []) + view.subviews.flatMap { allLabels(in: $0) }
    }

    private func containsTextView(_ view: UIView) -> Bool {
        view is UITextView || view.subviews.contains(where: containsTextView)
    }
    #endif
}
#endif

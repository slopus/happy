import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// Counts how many times its content is measured.
private final class Counted {
    private(set) var count = 0
    private let content: Measurable

    init(_ content: Measurable) {
        self.content = content
    }

    var measurable: Measurable {
        Measurable { [self] width in
            count += 1
            return content.size(fitting: width)
        }
    }
}

/// An `ItemGroupView` as the list sees it: an `ItemGroupLayout` kept per
/// width, over rows that count their measurements.
private final class Group {
    let rows: [Counted]
    var layouts = WidthLayoutCache<ItemGroupLayout>()

    init(rows: Int) {
        self.rows = (0..<rows).map { _ in Counted(block(height: 44)) }
    }

    var measured: Int { rows.reduce(0) { $0 + $1.count } }

    var content: Measurable {
        Measurable { [self] width in
            layouts.layout(width: width) { ItemGroupLayout(.init(width: $0, rows: rows.map(\.measurable))) }.size
        }
    }
}

final class WidthLayoutCacheTests: XCTestCase {
    func testAWidthIsMadeOnceUntilInvalidated() {
        var cache = WidthLayoutCache<CGFloat>()
        var made: [CGFloat] = []
        let make: (CGFloat) -> CGFloat = { made.append($0); return $0 * 2 }
        XCTAssertEqual(cache.layout(width: 361, make), 722)
        XCTAssertEqual(cache.layout(width: 361, make), 722)
        XCTAssertEqual(cache.layout(width: 320, make), 640)
        XCTAssertEqual(cache.layout(width: 361, make), 722, "the last two widths are kept")
        XCTAssertEqual(made, [361, 320])

        _ = cache.layout(width: 300, make)
        _ = cache.layout(width: 361, make)
        XCTAssertEqual(made, [361, 320, 300, 361], "a third width drops the oldest")

        cache.invalidate()
        _ = cache.layout(width: 361, make)
        XCTAssertEqual(made, [361, 320, 300, 361, 361])
        XCTAssertEqual(cache.made, 5)
    }
}

final class GroupedListCacheTests: XCTestCase {
    private func sections(_ ids: [Int], _ contents: [Int: Counted]) -> [GroupedListCache<Int>.Section] {
        ids.map { GroupedListCache.Section(id: $0, content: contents[$0]!.measurable) }
    }

    func testFramesAreGroupedListLayoutsAndAScrollMeasuresNothing() throws {
        let contents = [1: Counted(block(height: 100)), 2: Counted(block(height: 50)), 3: Counted(block(height: 200))]
        var cache = GroupedListCache<Int>()
        let layout = try XCTUnwrap(cache.layout(size: phone, safeArea: phoneUnderBar, sections: sections([1, 2, 3], contents)))
        assertFrame(layout.sections[0], rect(0, 103, 393, 100))
        assertFrame(layout.sections[1], rect(0, 203, 393, 50))
        assertFrame(layout.sections[2], rect(0, 253, 393, 200))
        assertSize(layout.contentSize, CGSize(width: 393, height: 852))
        XCTAssertEqual(contents.values.map(\.count), [1, 1, 1])

        // Every scroll frame lays the list out with the same inputs.
        for _ in 0..<200 {
            XCTAssertNil(cache.layout(size: phone, safeArea: phoneUnderBar, sections: sections([1, 2, 3], contents)))
        }
        XCTAssertEqual(contents.values.map(\.count), [1, 1, 1])
        XCTAssertEqual(cache.measured, 3)
    }

    func testANewSafeAreaTopMovesSectionsWithoutMeasuring() throws {
        let contents = [1: Counted(block(height: 100)), 2: Counted(block(height: 50))]
        var cache = GroupedListCache<Int>()
        _ = cache.layout(size: phone, safeArea: phoneUnderBar, sections: sections([1, 2], contents))
        let moved = try XCTUnwrap(cache.layout(size: phone, safeArea: phoneFullScreen, sections: sections([1, 2], contents)))
        assertFrame(moved.sections[0], rect(0, 59, 393, 100))
        assertFrame(moved.sections[1], rect(0, 159, 393, 50))
        XCTAssertEqual(cache.measured, 2)
    }

    func testANewWidthMeasuresEverySectionOnce() throws {
        let contents = [1: Counted(text(String(repeating: "a", count: 60), lineHeight: 20)), 2: Counted(block(height: 50))]
        var cache = GroupedListCache<Int>()
        _ = cache.layout(size: phone, safeArea: phoneUnderBar, sections: sections([1, 2], contents))
        let landscape = CGSize(width: 852, height: 393)
        let wide = LayoutInsets(top: 32, left: 59, bottom: 21, right: 59)
        let layout = try XCTUnwrap(cache.layout(size: landscape, safeArea: wide, sections: sections([1, 2], contents)))
        assertFrame(layout.sections[0], rect(59, 32, 734, 20))
        assertFrame(layout.sections[1], rect(59, 52, 734, 50))
        XCTAssertEqual(contents[1]?.count, 2)
        XCTAssertEqual(contents[2]?.count, 2)
        XCTAssertNil(cache.layout(size: landscape, safeArea: wide, sections: sections([1, 2], contents)))
        XCTAssertEqual(cache.measured, 4)
    }

    func testOnlyASectionThatChangedOrJoinedIsMeasured() throws {
        let contents = [1: Counted(block(height: 100)), 2: Counted(block(height: 50)), 3: Counted(block(height: 70)), 4: Counted(block(height: 30))]
        var cache = GroupedListCache<Int>()
        _ = cache.layout(size: phone, safeArea: phoneUnderBar, sections: sections([1, 2, 3], contents))

        cache.invalidate(2)
        _ = try XCTUnwrap(cache.layout(size: phone, safeArea: phoneUnderBar, sections: sections([1, 2, 3], contents)))
        XCTAssertEqual([1, 2, 3].map { contents[$0]!.count }, [1, 2, 1])

        // Swapped for another (Agents rebuilding one group), and reordered.
        let swapped = try XCTUnwrap(cache.layout(size: phone, safeArea: phoneUnderBar, sections: sections([3, 1, 4], contents)))
        XCTAssertEqual([1, 2, 3, 4].map { contents[$0]!.count }, [1, 2, 1, 1])
        assertFrame(swapped.sections[0], rect(0, 103, 393, 70))
        assertFrame(swapped.sections[1], rect(0, 173, 393, 100))
        assertFrame(swapped.sections[2], rect(0, 273, 393, 30))

        // One that left is forgotten: back, it is measured again.
        _ = cache.layout(size: phone, safeArea: phoneUnderBar, sections: sections([3, 1, 4, 2], contents))
        XCTAssertEqual(contents[2]?.count, 3)

        cache.invalidateAll()
        _ = cache.layout(size: phone, safeArea: phoneUnderBar, sections: sections([3, 1, 4, 2], contents))
        XCTAssertEqual([1, 2, 3, 4].map { contents[$0]!.count }, [2, 4, 2, 2])
        XCTAssertEqual(cache.measured, 10)
    }

    /// Settings › Agents swaps one group for a rebuilt one: only the new
    /// group's rows are measured, and the list then lays out once.
    func testSwappingOneGroupMeasuresOnlyItsRows() throws {
        let groups = (0..<4).map { _ in Group(rows: 3) }
        var cache = GroupedListCache<ObjectIdentifier>()
        func layout(_ groups: [Group]) -> GroupedListLayout? {
            cache.layout(size: phone, safeArea: phoneUnderBar, sections: groups.map {
                GroupedListCache.Section(id: ObjectIdentifier($0), content: $0.content)
            })
        }
        _ = layout(groups)
        XCTAssertEqual(groups.map(\.measured), [3, 3, 3, 3])

        var next = groups
        let rebuilt = Group(rows: 2)
        next[2] = rebuilt
        let swapped = try XCTUnwrap(layout(next))
        XCTAssertEqual(groups.map(\.measured), [3, 3, 3, 3])
        XCTAssertEqual(rebuilt.measured, 2)
        // 20 above an untitled card, two 44 rows.
        assertFrame(swapped.sections[2], rect(0, 103 + 2 * 152, 393, 108))
        XCTAssertNil(layout(next))
        XCTAssertEqual(rebuilt.measured, 2)
    }
}

final class ChangelogEntryLayoutTests: XCTestCase {
    func testTheTitleCardAndBodyAreOneLayout() {
        let title = Counted(text("1.2.3", lineHeight: 28))
        let summary = Counted(text("Thanks", lineHeight: 23))
        let items = [Counted(text("aaaa", lineHeight: 25)), Counted(text("bb", lineHeight: 25)), Counted(text("cc", lineHeight: 25))]
        let layout = ChangelogEntryLayout(
            width: 393,
            title: title.measurable,
            summary: summary.measurable,
            items: zip(items, [true, true, false]).map { ChangelogBodyLayout.Item(text: $0.measurable, bulleted: $1) },
            bullet: CGSize(width: 7, height: 25)
        )
        // ItemGroup: 35 above the title, 6 under it; the card 16 in.
        assertFrame(layout.group.header, rect(32, 35, 329, 28))
        assertFrame(layout.group.card, rect(16, 69, 361, 168))
        XCTAssertEqual(layout.group.rows, [rect(0, 0, 361, 168)])
        assertFrame(layout.body.summary, rect(16, 14, 329, 23))
        assertFrame(layout.body.bullets[0], rect(16, 54, 7, 25))
        assertFrame(layout.body.texts[0], rect(31, 53, 314, 25))
        assertFrame(layout.body.texts[1], rect(31, 85, 314, 25))
        XCTAssertNil(layout.body.bullets[2])
        assertFrame(layout.body.texts[2], rect(16, 127, 329, 25))
        assertSize(layout.size, CGSize(width: 393, height: 237))
        XCTAssertEqual([title, summary].map(\.count) + items.map(\.count), [1, 1, 1, 1, 1], "each text measured once")
    }

    func testCentredAtTheMaximumWidthOnATablet() {
        let layout = ChangelogEntryLayout(
            width: 1024,
            title: text("1.2.3", lineHeight: 28),
            summary: nil,
            items: [.init(text: text("cc", lineHeight: 25), bulleted: false)],
            bullet: .zero,
            maxWidth: 700
        )
        assertFrame(layout.group.header, rect(194, 35, 636, 28))
        assertFrame(layout.group.card, rect(178, 69, 668, 63))
        assertFrame(layout.body.texts[0], rect(16, 22, 636, 25))
    }

    /// What's New's main thread: the plan measures each text once per width
    /// and text size, off the main thread; the list asks each release for
    /// its planned size once per plan, and a scroll asks nothing.
    func testWhatsNewMeasuresEachTextOncePerWidthAndTextSize() {
        let releases = 21
        let words = (0..<releases).map { index in (0..<5).map { String(repeating: "w", count: 10 + 7 * index + $0 * 13) } }
        var measured = 0
        func plan(width: CGFloat, lineHeight: CGFloat) -> [CGSize] {
            words.map { texts in
                let counted = texts.map { Counted(text($0, lineHeight: lineHeight)) }
                let layout = ChangelogEntryLayout(
                    width: width,
                    title: counted[0].measurable,
                    summary: counted[1].measurable,
                    items: counted.dropFirst(2).map { .init(text: $0.measurable, bulleted: true) },
                    bullet: CGSize(width: 7, height: lineHeight)
                )
                measured += counted.reduce(0) { $0 + $1.count }
                return layout.size
            }
        }
        var cache = GroupedListCache<Int>()
        var asked = 0
        func list(_ sizes: [CGSize], size: CGSize = phone) -> GroupedListLayout? {
            cache.layout(size: size, safeArea: phoneUnderBar, sections: sizes.enumerated().map { index, planned in
                GroupedListCache.Section(id: index, content: Measurable { _ in asked += 1; return planned })
            })
        }

        var sizes = plan(width: 393, lineHeight: 25)
        XCTAssertNotNil(list(sizes))
        XCTAssertEqual(measured, releases * 5)
        XCTAssertEqual(asked, releases)

        for _ in 0..<300 { XCTAssertNil(list(sizes)) }
        XCTAssertEqual(measured, releases * 5, "a scroll measures nothing")
        XCTAssertEqual(asked, releases)

        // A new text size: a new plan, and the list told every size moved.
        sizes = plan(width: 393, lineHeight: 50)
        cache.invalidateAll()
        XCTAssertNotNil(list(sizes))
        XCTAssertEqual(measured, releases * 10)
        XCTAssertEqual(asked, releases * 2)

        // A new width: the list measures each release once at it.
        sizes = plan(width: 852, lineHeight: 50)
        XCTAssertNotNil(list(sizes, size: CGSize(width: 852, height: 393)))
        XCTAssertEqual(measured, releases * 15)
        XCTAssertEqual(asked, releases * 3)
    }
}

final class DrawnSectionsTests: XCTestCase {
    /// Ten 300-point sections under an 800-point screen.
    private let frames = (0..<10).map { rect(0, CGFloat($0) * 300, 393, 300) }

    func testWithinAScreenOfTheVisibleOnesDraw() {
        let top = DrawnSections.update([], frames: frames, visible: rect(0, 0, 393, 800))
        XCTAssertEqual(top, Set(0...5), "to 1600")
        let middle = DrawnSections.update([], frames: frames, visible: rect(0, 1500, 393, 800))
        XCTAssertEqual(middle, Set(2...9), "700 to 3100")
    }

    func testOneThatDrawsKeepsDrawingUntilTwoScreensAway() {
        var drawn = DrawnSections.update([], frames: frames, visible: rect(0, 0, 393, 800))
        drawn = DrawnSections.update(drawn, frames: frames, visible: rect(0, 1300, 393, 800))
        // Within one screen of 1300...2100 is 500...2900; the top ones
        // drew and are within two screens (-300 and on) until section 0.
        XCTAssertEqual(drawn, Set(0...9))
        drawn = DrawnSections.update(drawn, frames: frames, visible: rect(0, 1700, 393, 800))
        XCTAssertEqual(drawn, Set(0...9), "section 0 ends at 300, past two screens above 1700 (100)")
        drawn = DrawnSections.update(drawn, frames: frames, visible: rect(0, 2000, 393, 800))
        XCTAssertEqual(drawn, Set(1...9), "two screens above 2000 is 400")
        drawn = DrawnSections.update(drawn, frames: frames, visible: rect(0, 2300, 393, 800))
        XCTAssertEqual(drawn, Set(2...9))
        // Back up, section 1 has to come within one screen again.
        drawn = DrawnSections.update(drawn, frames: frames, visible: rect(0, 1500, 393, 800))
        XCTAssertEqual(drawn, Set(2...9), "one screen above 1500 is 700; section 1 ends at 600")
        drawn = DrawnSections.update(drawn, frames: frames, visible: rect(0, 1350, 393, 800))
        XCTAssertEqual(drawn, Set(1...9))
    }

    func testASectionWithNoHeightDrawsNothing() {
        var frames = frames
        frames[1] = rect(0, 300, 393, 0)
        XCTAssertEqual(DrawnSections.update([], frames: frames, visible: rect(0, 0, 393, 800)), [0, 2, 3, 4, 5])
    }
}

/// A cache held by a view, as `ItemGroupView` and `GroupedListView` hold
/// theirs, whose content asks it to measure again while it is measured: a
/// label drawing for the first time asks its superview for layout.
private final class Holder {
    var layouts = WidthLayoutCache<CGFloat>()
    var list = GroupedListCache<Int>()
}

final class ReentrantInvalidationTests: XCTestCase {
    func testAWidthInvalidatedWhileItIsMadeIsReturnedButNotKept() {
        let holder = Holder()
        var made = 0
        var invalidates = true
        let make: (CGFloat) -> CGFloat = { width in
            made += 1
            // Without the static entry point this is a simultaneous access
            // to `layouts` and traps.
            if invalidates { holder.layouts.invalidate() }
            return width * 2
        }
        XCTAssertEqual(WidthLayoutCache.layout(holder, \.layouts, width: 361, make), 722)
        XCTAssertNil(holder.layouts.cached(width: 361), "made across an invalidation: not kept")
        XCTAssertEqual(made, 1)

        invalidates = false
        XCTAssertEqual(WidthLayoutCache.layout(holder, \.layouts, width: 361, make), 722)
        XCTAssertEqual(made, 2, "made again")
        XCTAssertEqual(holder.layouts.cached(width: 361), 722)
        XCTAssertEqual(WidthLayoutCache.layout(holder, \.layouts, width: 361, make), 722)
        XCTAssertEqual(made, 2, "kept once nothing invalidated it")
        XCTAssertEqual(holder.layouts.made, 2)
    }

    func testASectionInvalidatedWhileItIsMeasuredIsMeasuredAgainNextPass() throws {
        let holder = Holder()
        var asked: [Int] = [0, 0]
        var invalidating: Int? = 1
        let content: (Int) -> Measurable = { index in
            Measurable { width in
                asked[index] += 1
                if invalidating == index { holder.list.invalidate(index) }
                return CGSize(width: width, height: CGFloat(100 + index))
            }
        }
        func pass() -> GroupedListLayout? {
            GroupedListCache.layout(holder, \.list, size: phone, safeArea: phoneUnderBar, ids: [0, 1], content: content)
        }
        let first = try XCTUnwrap(pass())
        assertFrame(first.sections[0], rect(0, 103, 393, 100))
        assertFrame(first.sections[1], rect(0, 203, 393, 101))
        XCTAssertEqual(asked, [1, 1])

        // Nothing measured across the invalidation was kept: not the pass,
        // and not the heights.
        invalidating = nil
        let second = try XCTUnwrap(pass(), "the pass after is laid out, not skipped as already applied")
        XCTAssertEqual(second, first)
        XCTAssertEqual(asked, [2, 2])
        XCTAssertNil(pass())
        XCTAssertEqual(asked, [2, 2])
        XCTAssertEqual(holder.list.measured, 4)
    }
}

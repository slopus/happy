#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A post's summary, laid out as the Feed draws it: four lines cut with
/// "… Show more" or all of it with "Show less", line breaks kept, measured
/// again at a new width; and the post's row around it, with or without a
/// cover, held to 640 on an iPad.
@MainActor
final class FeedPostLayoutTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private let font = CardFont(.regular, FeedMetrics.captionSize)
    private let words = FeedWords.english
    private static let long = """
        Revenue up 18% QoQ, driven by enterprise seats.

        Enterprise grew 31% on three new logos (Northwind, Globex, Initech) and 12% expansion across the existing base. Self-serve was flat at $2.1M, with churn down to 1.8% after the onboarding changes.

        Gross margin held at 78%. Next quarter: price the team plan, ship SSO to every tier, and close the two renewals still in legal.
        """

    private func fit(_ text: String, width: CGFloat = 326, expanded: Bool = false) -> FeedSummaryText {
        FeedSummaryText.fit(text, font: font, width: width, expanded: expanded, more: words.showMore, less: words.showLess, scale: 3)
    }

    private func lines(_ count: Int) -> CGFloat {
        CardText.measure(Array(repeating: "Ag", count: count).joined(separator: "\n"), font: font, width: 326, maxLines: 0, scale: 3).height
    }

    func testAShortSummaryIsAllOfItWithNoToggle() {
        let short = fit("Revenue up 18% QoQ, driven by enterprise seats.")
        XCTAssertEqual(short.text, "Revenue up 18% QoQ, driven by enterprise seats.")
        XCTAssertNil(short.toggle)
        XCTAssertNil(short.toggleFrame)
        XCTAssertEqual(short.size.height, lines(2), accuracy: 0.5)
        XCTAssertEqual(fit("Revenue up", expanded: true), fit("Revenue up"), "nothing to open, nothing to close")
    }

    /// Collapsed: exactly four lines, the fourth ending "… Show more",
    /// the words cut at a space, Show more inside the width on that line.
    func testCollapsedIsFourLinesEndingShowMore() throws {
        let cut = fit(Self.long)
        XCTAssertEqual(cut.toggle, "Show\u{00A0}more")
        XCTAssertTrue(cut.text.hasSuffix("…\u{00A0}"), cut.text)
        XCTAssertTrue(Self.long.hasPrefix(String(cut.text.dropLast(2))), "the summary's own words, cut: \(cut.text)")
        XCTAssertTrue(cut.text.hasPrefix("Revenue up 18% QoQ, driven by enterprise seats.\n\nEnterprise"), "line breaks are kept")
        XCTAssertFalse(cut.text.dropLast(2).last?.isWhitespace ?? true)
        XCTAssertEqual(cut.size.height, lines(4), accuracy: 0.5)
        let toggle = try XCTUnwrap(cut.toggleFrame)
        XCTAssertEqual(toggle.maxY, cut.size.height, accuracy: 1, "on the last line")
        XCTAssertLessThanOrEqual(toggle.maxX, 326.5)
        XCTAssertGreaterThan(toggle.width, 40)
    }

    /// Expanded: all of it, then "Show less" after it, taller than cut.
    func testExpandedIsAllOfItEndingShowLess() throws {
        let cut = fit(Self.long)
        let open = fit(Self.long, expanded: true)
        XCTAssertEqual(open.text, Self.long + " ")
        XCTAssertEqual(open.toggle, "Show\u{00A0}less")
        XCTAssertEqual(open.size.height, CardText.measure(Self.long + " Show\u{00A0}less", font: font, width: 326, maxLines: 0, scale: 3).height, accuracy: 0.5)
        XCTAssertGreaterThan(open.size.height, cut.size.height + lines(2))
        let toggle = try XCTUnwrap(open.toggleFrame)
        XCTAssertEqual(toggle.maxY, open.size.height, accuracy: 1, "at the end")
    }

    /// One line each: the fifth is cut, and the fourth says Show more.
    func testLineBreaksCountAsLines() {
        let text = "One\nTwo\nThree\nFour\nFive"
        let cut = fit(text)
        XCTAssertEqual(cut.text, "One\nTwo\nThree\nFour…\u{00A0}")
        XCTAssertEqual(cut.size.height, lines(4), accuracy: 0.5)
        XCTAssertEqual(fit("One\nTwo\nThree\nFour").toggle, nil, "four lines fit")
        XCTAssertEqual(fit(text, expanded: true).size.height, lines(5), accuracy: 0.5)
    }

    /// A narrower post cuts earlier at the same four lines.
    func testANewWidthMeasuresAgain() {
        let wide = fit(Self.long)
        let narrow = fit(Self.long, width: 200)
        XCTAssertLessThan(narrow.text.count, wide.text.count)
        XCTAssertEqual(narrow.size.height, wide.size.height, accuracy: 0.5)
        XCTAssertLessThanOrEqual(narrow.toggleFrame?.maxX ?? .infinity, 200.5)
        XCTAssertGreaterThan(fit(Self.long, width: 200, expanded: true).size.height, fit(Self.long, expanded: true).size.height)
    }

    /// A word longer than the line is cut inside it, and CJK has no spaces.
    func testTextWithoutSpaces() {
        let cut = fit(String(repeating: "制品和新任务会显示在这里", count: 30))
        XCTAssertEqual(cut.toggle, "Show\u{00A0}more")
        XCTAssertEqual(cut.size.height, CardText.measure("制\n制\n制\n制", font: font, width: 326, maxLines: 0, scale: 3).height, accuracy: 0.5)
    }

    // MARK: The row

    private func row(summary: String?, cover: Bool, width: CGFloat = 390, maxWidth: CGFloat = .greatestFiniteMagnitude, expanded: Bool = false) -> CardItem {
        let post = FeedPost(cover: cover ? .init(image: "/v0/artifacts/r/versions/1/files/c.png", aspect: .wide, width: 1600, height: 900) : nil, summary: summary)
        let entry = FeedRow(
            id: "item-8", title: "Q3 revenue review", face: .tile(.artifact, artifactType: "html"), kind: .artifact, detail: nil,
            created: true, updates: 1, actors: [], actorNames: [], actorCount: 0, lastAt: Date().timeIntervalSince1970 * 1000,
            unread: false, target: nil, post: post
        )
        var input = FeedListInput(words: words, dates: .current)
        input.width = width
        input.maxWidth = maxWidth
        input.displayScale = 3
        if expanded { input.expanded = ["item-8"] }
        return FeedListItems.row(entry, place: .alone, input: input).item
    }

    private func frame(_ item: CardItem, _ kind: String) -> CGRect? { item.overlays.first { $0.kind == kind }?.frame }

    /// Collapsed and expanded: the caption's lines change the height, the
    /// cover keeps its shape under them, and the toggle's target says which.
    func testThePostCollapsedAndExpanded() throws {
        let collapsed = row(summary: Self.long, cover: true)
        let expanded = row(summary: Self.long, cover: true, expanded: true)
        let cut = fit(Self.long)
        let open = fit(Self.long, expanded: true)
        XCTAssertEqual(expanded.size.height - collapsed.size.height, open.size.height - cut.size.height, accuracy: 0.5)
        let shut = try XCTUnwrap(frame(collapsed, FeedListItems.coverKind))
        let shown = try XCTUnwrap(frame(expanded, FeedListItems.coverKind))
        XCTAssertEqual(shut.size, shown.size)
        XCTAssertEqual(shut.height, (326 * 9 / 16 * 3).rounded() / 3, accuracy: 0.01)
        XCTAssertEqual(shown.minY - shut.minY, open.size.height - cut.size.height, accuracy: 0.5)

        let target = try XCTUnwrap(collapsed.overlays.first { $0.kind == FeedListItems.toggleKind })
        XCTAssertTrue(target.key.hasSuffix("|false"))
        XCTAssertGreaterThanOrEqual(target.frame.height, FeedMetrics.toggleTarget)
        let toggle = try XCTUnwrap(cut.toggleFrame)
        XCTAssertTrue(FeedListItems.toggleHit(collapsed, at: CGPoint(x: 32 + toggle.midX, y: 64 + toggle.midY)))
        XCTAssertFalse(FeedListItems.toggleHit(collapsed, at: CGPoint(x: 40, y: 70)), "the rest of the post opens it")
        XCTAssertFalse(FeedListItems.toggleHit(collapsed, at: CGPoint(x: shut.midX, y: shut.midY)))
        XCTAssertTrue(expanded.overlays.contains { $0.kind == FeedListItems.toggleKind && $0.key.hasSuffix("|true") })
        XCTAssertTrue(collapsed.accessibilityValue?.contains("Gross margin held at 78%") == true, "VoiceOver reads all of it")
    }

    /// A summary and no cover is a post of words: no picture, no slot.
    func testASummaryOnlyPost() {
        let post = row(summary: Self.long, cover: false)
        XCTAssertNil(frame(post, FeedListItems.coverKind))
        XCTAssertEqual(post.size.height, 64 + fit(Self.long).size.height + FeedMetrics.postBottom, accuracy: 0.5)
        let short = row(summary: "Two short lines\nof words.", cover: false)
        XCTAssertNil(frame(short, FeedListItems.toggleKind))
        XCTAssertEqual(short.size.height, 64 + lines(2) + FeedMetrics.postBottom, accuracy: 0.5)
    }

    /// On an iPad the card keeps the readable column and the post stops at
    /// 640, its words cut at that width.
    func testAnIPadPostIs640Wide() throws {
        let item = row(summary: Self.long, cover: true, width: 1024, maxWidth: 800)
        let cover = try XCTUnwrap(frame(item, FeedListItems.coverKind))
        XCTAssertEqual(cover, CGRect(x: 144, y: cover.minY, width: 640, height: 360))
        XCTAssertEqual(item.card?.width, 768)
        let cut = FeedSummaryText.fit(Self.long, font: font, width: 640, expanded: false, more: words.showMore, less: words.showLess, scale: 3)
        XCTAssertEqual(cover.minY, 64 + cut.size.height + FeedMetrics.postGap, accuracy: 0.5)
    }
}
#endif

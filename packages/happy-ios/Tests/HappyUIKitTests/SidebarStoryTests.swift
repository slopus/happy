#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A task with a live story wears an outline around its own icon, the
/// row exactly where and as big as it was. A tap on the icon opens the
/// story; anywhere else on the row, its chat.
@MainActor
final class SidebarStoryTests: XCTestCase {
    func testStoriesAreARealFirstRowAndKeepTheirContentFrameWhileScrolling() async throws {
        let rows = (0..<30).map { Row(id: "task:\($0)", nodeId: "task:\($0)", kind: .space, label: "Task \($0)") }
        let (list, window) = try await list(rows)
        defer { window.isHidden = true }
        list.setInsets(UIEdgeInsets(top: 120, left: 0, bottom: 0, right: 0), indicator: .zero, keepsTop: true)
        let stories = StoriesRowView(); stories.apply([], enabled: true)
        list.stories = stories
        await list.settle(); window.layoutIfNeeded()
        XCTAssertEqual(list.list.items.first?.identity, SidebarStoriesItem.id)
        let host = try XCTUnwrap(stories.superview)
        XCTAssertTrue(list.list.loadedItemViews.contains { $0 === host })
        let frame = stories.frame
        let first = try XCTUnwrap(list.view(for: "task:0"))
        let distance = first.convert(first.bounds, to: list).minY - stories.convert(stories.bounds, to: list).minY
        for offset: CGFloat in [60, -80, 0] {
            list.setContentOffsetY(offset); await list.settle(); window.layoutIfNeeded()
            if offset < 0 { XCTAssertLessThan(list.contentOffsetY, 0) }
            if offset > 0 { XCTAssertGreaterThan(list.contentOffsetY, 0) }
            XCTAssertEqual(stories.frame, frame)
            XCTAssertEqual(first.convert(first.bounds, to: list).minY - stories.convert(stories.bounds, to: list).minY, distance, accuracy: 0.5)
            XCTAssertEqual(stories.convert(stories.bounds, to: list).minY + list.contentOffsetY, 0, accuracy: 0.5)
        }
        list.stories = nil; await list.settle()
        XCTAssertFalse(list.list.items.contains { $0.identity == SidebarStoriesItem.id })
        let plain = SidebarList.derive(.init(rows: rows, width: 390, dark: false, displayScale: 3, selected: nil, notice: nil), previous: nil)
        XCTAssertEqual(list.list.items.map(\.identity), plain.identities)
    }

    func testYourStoryKeepsOnePhotoTileWithAnIndependentAddBadge() throws {
        let row = StoriesRowView(frame: CGRect(x: 0, y: 0, width: 390, height: 104))
        let mark = Row.Mark.image(path: "/v0/profile/photo", thumbhash: nil)
        row.apply([], enabled: true, personMark: mark); row.layoutIfNeeded()
        func own() throws -> UIView { try XCTUnwrap(row.subviews.first { $0.accessibilityIdentifier == "storyOwn" }) }
        XCTAssertEqual(try own().accessibilityLabel, "Your Story")
        XCTAssertEqual(try own().layer.borderWidth, 0)
        XCTAssertEqual(row.personMark, mark)
        let badge = try XCTUnwrap(row.subviews.first { $0.accessibilityIdentifier == "storyAdd" } as? UIButton)
        XCTAssertEqual(badge.frame, StoryLayout.row(count: 1, nameHeight: 14).tiles[0].add)
        var additions = 0; row.onAdd = { additions += 1 }
        for seen in [false, true] {
            let story = Story(id: "own", poster: "person", media: .init(kind: "image", mimeType: "image/png"), postedAt: 1, expiresAt: .greatestFiniteMagnitude, seen: seen)
            row.apply(Stories.posters([story], rows: [], users: [:], profile: nil), enabled: true, personMark: mark); row.layoutIfNeeded()
            XCTAssertEqual(row.subviews.compactMap { $0 as? UILabel }.map(\.text), ["Your Story"])
            XCTAssertEqual(try own().accessibilityValue, seen ? "story seen" : "story unseen")
            XCTAssertEqual(try own().layer.borderWidth, StoryLayout.Metrics.ringWidth)
            badge.sendActions(for: .touchUpInside)
        }
        XCTAssertEqual(additions, 2)
    }

    private static let rows: [Row] = (0..<4).map { index in
        var row = Row(id: "task:t\(index)", nodeId: "task:t\(index)", kind: .space, label: "Task \(index)", mark: .placeholder(seed: "t\(index)"), agentId: "agent-\(index)", targetKind: "task")
        row.targetId = "t\(index)"
        return row
    }

    private static func rows(seen: Bool?) -> [Row] {
        guard let seen else { return rows }
        let story = Story(id: "s1", taskId: "t1", media: .init(kind: "image", mimeType: "image/png"), postedAt: 1, expiresAt: .greatestFiniteMagnitude, seen: seen)
        return Stories.ring(rows, stories: [story])
    }

    private func list(_ rows: [Row]) async throws -> (SidebarList, UIWindow) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let list = SidebarList(frame: window.bounds)
        window.addSubview(list)
        window.isHidden = false
        list.apply(rows)
        await list.settle()
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        return (list, window)
    }

    private func ring(_ view: UIView) -> UIView? {
        view.subviews.first { $0.accessibilityIdentifier?.hasPrefix("story:") == true && !$0.isHidden }
    }

    func testTheOutlineHugsTheIconAndTheRowStaysPut() async throws {
        let (list, window) = try await list(Self.rows(seen: nil))
        defer { window.isHidden = true }
        let before = try XCTUnwrap(list.view(for: "task:t1")).convert(try XCTUnwrap(list.view(for: "task:t1")).box, to: window)
        XCTAssertTrue(list.mountedViews.allSatisfy { ring($0) == nil }, "an outline with no story")
        XCTAssertNil(list.view(for: "task:t1")?.accessibilityValue)

        list.apply(Self.rows(seen: false))
        await list.settle()
        window.layoutIfNeeded()
        let view = try XCTUnwrap(list.view(for: "task:t1"))
        XCTAssertEqual(view.convert(view.box, to: window), before, "the row moved or grew")
        let unseen = try XCTUnwrap(ring(view))
        XCTAssertEqual(unseen.accessibilityIdentifier, "story:unseen:Task 1")
        XCTAssertEqual(view.accessibilityValue, "story unseen", "VoiceOver and UI tests read the outline here")
        XCTAssertEqual(unseen.frame, StoryLayout.ring(around: try XCTUnwrap(view.frames.mark), markRadius: GroupedSidebarMetrics.tileRadius).frame)
        XCTAssertEqual(unseen.layer.borderColor, UIColor(Palette.storyUnseen).resolvedColor(with: view.traitCollection).cgColor)
        XCTAssertNil(ring(try XCTUnwrap(list.view(for: "task:t0"))), "another task wore the story")

        list.apply(Self.rows(seen: true))
        await list.settle()
        let seen = try XCTUnwrap(ring(try XCTUnwrap(list.view(for: "task:t1"))))
        XCTAssertEqual(seen.accessibilityIdentifier, "story:seen:Task 1")
        XCTAssertEqual(list.view(for: "task:t1")?.accessibilityValue, "story seen")
        XCTAssertEqual(seen.layer.borderColor, UIColor(Palette.storySeen).resolvedColor(with: view.traitCollection).cgColor)
    }

    func testOnlyTheIconOpensTheStory() async throws {
        let (list, window) = try await list(Self.rows(seen: false))
        defer { window.isHidden = true }
        var stories: [String] = []
        var chats: [String] = []
        list.onOpenStory = { row, _ in stories.append(row.id) }
        list.onSelect = { row in chats.append(row.id) }
        let view = try XCTUnwrap(list.view(for: "task:t1"))
        let mark = try XCTUnwrap(view.frames.mark)
        list.tap(view, at: CGPoint(x: mark.midX, y: mark.midY))
        list.tap(view, at: CGPoint(x: view.frames.label.midX, y: view.frames.label.midY))
        // A row without a story opens its chat from its icon too, as on main.
        let plain = try XCTUnwrap(list.view(for: "task:t2"))
        let plainMark = try XCTUnwrap(plain.frames.mark)
        list.tap(plain, at: CGPoint(x: plainMark.midX, y: plainMark.midY))
        XCTAssertEqual(stories, ["task:t1"])
        XCTAssertEqual(chats, ["task:t1", "task:t2"])
    }
}
#endif

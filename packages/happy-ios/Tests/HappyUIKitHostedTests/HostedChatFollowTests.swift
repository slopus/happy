#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import UltraView
import XCTest

/// The chat list stands the natural way up and keeps the reader's place:
/// the newest message rests on the composer; a reply streaming there is
/// followed by two lines of text from its first words and then the list
/// holds still until the reader is back at the foot; a finished message
/// arriving there comes into view whole; a reader further back never sees
/// what they are looking at move, whatever grows, arrives or goes around
/// it; a send of the person's own always comes fully into view and,
/// last at the foot, stays on the composer while the reply above it grows.
///
/// Plans here are plain boxes of known heights, so every distance is exact.
@MainActor
final class HostedChatFollowTests: XCTestCase {
    /// The relay chat's list over a window, 100 under the bar and 60 over
    /// the composer, with a 10-tall footer under the newest row.
    @MainActor
    private final class Chat {
        let adapter = ChatUltraListAdapter(olderEnd: ChatOlderEndView())
        var list: UltraListView { adapter.list }
        let root: UIView
        var insets = UIEdgeInsets(top: 100, left: 0, bottom: 60, right: 0)
        /// Newest first, as the rows are derived.
        var plans: [ChatRowPlan] = []
        var pinning: String?
        /// The agent is at work: a newest row of its words streams.
        var streaming = false
        var width: CGFloat { root.bounds.width }
        var visibleHeight: CGFloat { root.bounds.height - insets.top - insets.bottom }

        init(root: UIView, heights: [CGFloat]) {
            self.root = root
            list.frame = root.bounds
            root.addSubview(list)
            list.layoutIfNeeded()
            adapter.followBudget = 50
            adapter.setViewport(frame: root.bounds, insets: insets)
            plans = heights.enumerated().map { plan("m\($0.offset)", height: $0.element) }
        }

        /// `words`: an agent's words, which stream while it is at work.
        /// `mine`: the person's own message.
        func plan(_ id: String, height: CGFloat, words: Bool = false, mine: Bool = false) -> ChatRowPlan {
            ChatRowPlan(id: id, size: .init(width: width, height: height), items: [
                .box(ChatBox(frame: .init(x: 0, y: 0, width: width, height: height), fill: Palette.surface)),
            ], mine: mine, revealable: words)
        }

        func update() -> ChatListUpdate {
            let footer = plan("footer", height: 10)
            return ChatListUpdate(ids: plans.map(\.id), plans: plans,
                                  model: ChatListLayout(width: width, heights: plans.map(\.size.height), newerEndHeight: 10, olderEndHeight: ChatOlderEndLayout.height),
                                  footer: footer, changeset: .init(), pinning: pinning, streaming: streaming)
        }

        func apply(animated: Bool = false) {
            adapter.apply(update(), animated: animated)
            pinning = nil
        }

        func setHeight(_ id: String, _ height: CGFloat) {
            let index = plans.firstIndex { $0.id == id }!
            plans[index] = plan(id, height: height, words: plans[index].revealable, mine: plans[index].mine)
        }

        func setInsets(_ insets: UIEdgeInsets, keyboard: ChatUltraKeyboard.Change? = nil) {
            self.insets = insets
            adapter.setViewport(frame: list.frame, insets: insets, keyboard: keyboard)
        }

        /// The row's settled frame in the list, if loaded.
        func frame(_ id: String) -> CGRect? {
            guard let index = list.items.firstIndex(where: { $0.identity == "chat:message:\(id)" }) else { return nil }
            return list.settledFrame(at: index)
        }

        /// The row's frame as drawn this instant, in the list.
        func presented(_ id: String) -> CGRect? {
            guard let index = list.items.firstIndex(where: { $0.identity == "chat:message:\(id)" }),
                  let view = list.loadedItemView(at: index) else { return nil }
            let layer = view.layer.presentation() ?? view.layer
            return layer.convert(layer.bounds, to: list.layer.presentation() ?? list.layer)
        }

        /// The rows on screen and where each stands.
        func onScreen() -> [String: CGFloat] {
            var rows: [String: CGFloat] = [:]
            for plan in plans {
                guard let frame = frame(plan.id), frame.maxY > insets.top, frame.minY < root.bounds.height - insets.bottom else { continue }
                rows[plan.id] = frame.minY
            }
            return rows
        }

        /// The foot the newest row rests on: the composer, less the footer.
        var restingFoot: CGFloat { root.bounds.height - insets.bottom - 10 }
    }

    private func chat(_ heights: [CGFloat]) async throws -> Chat {
        let scene = try await hostedActiveScene()
        let original = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        let root = try XCTUnwrap(window.rootViewController?.view)
        window.layoutIfNeeded()
        let chat = Chat(root: root, heights: heights)
        addTeardownBlock { @MainActor in
            chat.adapter.deactivate()
            window.isHidden = true
            original?.makeKey()
        }
        chat.apply()
        try await settle(chat)
        return chat
    }

    /// Every row committed and drawn, and nothing in flight.
    private func settle(_ chat: Chat, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if chat.adapter.isDisplayReady, !chat.list.isScrollFlightActive { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(chat.adapter.isDisplayReady, "the list never committed: \(chat.list.items.count) items, first \(chat.list.items.first.map { "\($0.identity)@\($0.revision)" } ?? "-"), loaded \(chat.list.loadedItemViews.count), not ready \(chat.list.loadedIndexRange.filter { chat.list.loadedItemView(at: $0)?.isDisplayReady == false }.map { chat.list.items[$0].identity }), flight \(chat.list.isScrollFlightActive)", file: file, line: line)
        // A pass's own follow lands in the pass after it.
        try await Task.sleep(for: .milliseconds(50))
    }

    private func scroll(_ chat: Chat, to distance: CGFloat, file: StaticString = #filePath, line: UInt = #line) async throws {
        chat.adapter.setVisibleMinY(distance)
        try await settle(chat)
        XCTAssertEqual(chat.adapter.visibleMinY, distance, accuracy: 0.5, "never reached \(distance)", file: file, line: line)
    }

    private func assertSame(_ before: [String: CGFloat], _ after: [String: CGFloat], _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(before.isEmpty, "no rows on screen", file: file, line: line)
        for (id, y) in before {
            guard let now = after[id] else { continue }
            XCTAssertEqual(now, y, accuracy: 0.5, "\(what): \(id) moved from \(y) to \(now)", file: file, line: line)
        }
    }

    private var forty: [CGFloat] { Array(repeating: 100, count: 40) }

    // MARK: Resting

    func testAnEmptyChatRestsItsEndsOnTheComposer() async throws {
        let chat = try await chat([])
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5)
        let older = try XCTUnwrap(chat.list.items.firstIndex { $0.identity == "chat:older-end" }.flatMap(chat.list.settledFrame(at:)))
        XCTAssertEqual(older.maxY, chat.restingFoot, accuracy: 0.5, "the older end sits on the footer, on the composer")
        XCTAssertNil(chat.list.items.first { $0.identity.hasPrefix("chat:") && $0.identity != "chat:older-end" && $0.identity != "chat:newer-end" })
    }

    func testOneMessageRestsOnTheComposerUnderTheOlderEnd() async throws {
        let chat = try await chat([80])
        let message = try XCTUnwrap(chat.frame("m0"))
        XCTAssertEqual(message.maxY, chat.restingFoot, accuracy: 0.5)
        let older = try XCTUnwrap(chat.list.settledFrame(at: 0))
        XCTAssertEqual(chat.list.items.first?.identity, "chat:older-end", "the older end heads the list")
        XCTAssertEqual(older.maxY, message.minY, accuracy: 0.5)
        XCTAssertEqual(chat.list.items.last?.identity, "chat:newer-end", "the footer ends it")
    }

    func testRowsStandOldestFirstWithNoFlip() async throws {
        let chat = try await chat(forty)
        XCTAssertEqual(chat.list.contentView.transform, .identity)
        for view in chat.list.loadedItemViews { XCTAssertEqual(view.transform, .identity) }
        let ids = chat.list.items.map(\.identity)
        XCTAssertEqual(ids.first, "chat:older-end")
        XCTAssertEqual(ids[1], "chat:message:m39", "the oldest message comes first")
        XCTAssertEqual(ids[ids.count - 2], "chat:message:m0", "the newest message comes last")
        let newest = try XCTUnwrap(chat.frame("m0")), older = try XCTUnwrap(chat.frame("m1"))
        XCTAssertEqual(older.maxY, newest.minY, accuracy: 0.5, "the older row stands above")
    }

    // MARK: Following

    func testAGrowingReplyIsFollowedByTwoLinesThenGrowsBelowTheFold() async throws {
        let chat = try await chat(forty)
        let start = try XCTUnwrap(chat.frame("m0")).minY
        var height: CGFloat = 100
        let expected: [CGFloat] = [0, 0, 25, 50, 75, 100, 125, 150]
        for step in 0..<8 {
            height += 25
            chat.setHeight("m0", height)
            chat.apply()
            try await settle(chat)
            XCTAssertEqual(chat.adapter.visibleMinY, expected[step], accuracy: 0.5, "after \(Int(height - 100)) of growth")
        }
        XCTAssertEqual(try XCTUnwrap(chat.frame("m0")).minY, start - 50, accuracy: 0.5, "the reply rose by the budget, no more")
        XCTAssertFalse(chat.adapter.isFollowingNewest)
    }

    func testAShrinkAtTheFootGivesTheBudgetBack() async throws {
        let chat = try await chat(forty)
        chat.setHeight("m0", 140)
        chat.apply()
        try await settle(chat)
        chat.setHeight("m0", 120)
        chat.apply()
        try await settle(chat)
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5)
        chat.setHeight("m0", 180)
        chat.apply()
        try await settle(chat)
        // 20 net was spent; 30 is left of 50, so 60 of growth leaves 30 below.
        XCTAssertEqual(chat.adapter.visibleMinY, 30, accuracy: 0.5)
    }

    func testAReplyTallerThanTheScreenRisesOnlyByTheBudget() async throws {
        let chat = try await chat(forty)
        let top = try XCTUnwrap(chat.frame("m0")).minY
        chat.setHeight("m0", 3000)
        chat.apply()
        try await settle(chat)
        XCTAssertEqual(chat.adapter.visibleMinY, 2900 - 50, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(chat.frame("m0")).minY, top - 50, accuracy: 0.5, "its start stays on screen")
    }

    func testContentCrossingTheScreenWhileStreamingStopsWithItsStartInView() async throws {
        let chat = try await chat([100, 100])
        var height: CGFloat = 100
        while height < chat.visibleHeight + 600 {
            height += 50
            chat.setHeight("m0", height)
            chat.apply()
            try await settle(chat)
        }
        let content = chat.update().model.contentHeight
        XCTAssertGreaterThan(content, chat.visibleHeight + 500)
        // The short chat rose with every line until it filled the screen;
        // the budget was spent by then, so it stopped with the oldest end
        // at the top and the reply growing below the fold.
        XCTAssertEqual(chat.adapter.visibleMinY, content - chat.visibleHeight, accuracy: 0.5)
        XCTAssertFalse(chat.adapter.isFollowingNewest)
    }

    func testVeryFastTokensNeverJumpAndStopAtTheBudget() async throws {
        let chat = try await chat(forty)
        let watched = "m3"
        let start = try XCTUnwrap(chat.presented(watched)).minY
        var samples: [CGFloat] = []
        let sampler = Task { @MainActor in
            while !Task.isCancelled {
                if let frame = chat.presented(watched) { samples.append(frame.minY) }
                try? await Task.sleep(for: .milliseconds(4))
            }
        }
        defer { sampler.cancel() }
        var height: CGFloat = 100
        for _ in 0..<200 {
            height += 3
            chat.setHeight("m0", height)
            chat.apply(animated: true)
            try await Task.sleep(for: .milliseconds(2))
        }
        try await settle(chat)
        try await Task.sleep(for: .milliseconds(400))
        sampler.cancel()
        XCTAssertEqual(chat.adapter.visibleMinY, 600 - 50, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(chat.frame(watched)).minY, start - 50, accuracy: 0.5)
        // Drawn, the row only ever rose, and never past the budget.
        XCTAssertFalse(samples.isEmpty)
        for (previous, next) in zip(samples, samples.dropFirst()) {
            XCTAssertLessThanOrEqual(next, previous + 0.5, "the row went back down")
        }
        XCTAssertGreaterThanOrEqual(samples.min() ?? 0, start - 50 - 0.5, "the row rose past the budget")
    }

    // MARK: Streaming and finished messages

    /// A reply's first words count against the two lines as its growth
    /// does: a new streaming row is followed, with what grows after it, by
    /// the budget in all.
    func testANewStreamingReplyIsFollowedByTwoLinesFromItsFirstWords() async throws {
        let chat = try await chat(forty)
        chat.streaming = true
        chat.plans.insert(chat.plan("r", height: 30, words: true), at: 0)
        chat.apply(animated: true)
        try await settle(chat)
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5, "its first line is followed")
        XCTAssertEqual(try XCTUnwrap(chat.frame("r")).maxY, chat.restingFoot, accuracy: 0.5)
        let top = try XCTUnwrap(chat.frame("m0")).minY
        chat.setHeight("r", 130)
        chat.apply(animated: true)
        try await settle(chat)
        // 30 on arriving and 20 of the 100 it grew make the 50.
        XCTAssertEqual(try XCTUnwrap(chat.frame("m0")).minY, top - 20, accuracy: 0.5)
        XCTAssertEqual(chat.adapter.visibleMinY, 80, accuracy: 0.5)
        XCTAssertFalse(chat.adapter.isFollowingNewest)
    }

    /// A tall first chunk of a streaming reply is followed by the budget
    /// only, not shown whole.
    func testATallFirstChunkOfAStreamingReplyRisesOnlyByTheBudget() async throws {
        let chat = try await chat(forty)
        let top = try XCTUnwrap(chat.frame("m0")).minY
        chat.streaming = true
        chat.plans.insert(chat.plan("r", height: 300, words: true), at: 0)
        chat.apply(animated: true)
        try await settle(chat)
        XCTAssertEqual(try XCTUnwrap(chat.frame("m0")).minY, top - 50, accuracy: 0.5)
        XCTAssertEqual(chat.adapter.visibleMinY, 250, accuracy: 0.5)
    }

    /// A message that arrives finished at the foot is brought into view
    /// whole, as any chat does, and the list stays on the foot.
    func testAFinishedMessageArrivingAtTheFootComesIntoViewWhole() async throws {
        let chat = try await chat(forty)
        for (index, height) in [CGFloat(300), 120, 260].enumerated() {
            chat.plans.insert(chat.plan("n\(index)", height: height), at: 0)
            chat.apply(animated: true)
            try await settle(chat)
            XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5, "message \(index) whole")
            XCTAssertEqual(try XCTUnwrap(chat.frame("n\(index)")).maxY, chat.restingFoot, accuracy: 0.5)
            XCTAssertTrue(chat.adapter.isFollowingNewest)
        }
        // So is an agent's message that comes when it is at rest.
        chat.plans.insert(chat.plan("done", height: 240, words: true), at: 0)
        chat.apply(animated: true)
        try await settle(chat)
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5, "an agent's finished words whole")
    }

    /// Taller than the screen, a finished message shows its top under the
    /// bar, and the list holds there.
    func testAFinishedMessageTallerThanTheScreenShowsItsTop() async throws {
        let chat = try await chat(forty)
        chat.plans.insert(chat.plan("long", height: 2000), at: 0)
        chat.apply(animated: true)
        try await settle(chat)
        XCTAssertEqual(try XCTUnwrap(chat.frame("long")).minY, chat.insets.top, accuracy: 0.5)
        XCTAssertFalse(chat.adapter.isFollowingNewest)
        let before = chat.onScreen()
        chat.setHeight("long", 2100)
        chat.apply()
        try await settle(chat)
        assertSame(before, chat.onScreen(), "it grew below the fold")
    }

    /// A finished message arriving while the reader is up in history
    /// moves nothing.
    func testAFinishedMessageArrivingAwayFromTheFootMovesNothing() async throws {
        let chat = try await chat(forty)
        try await scroll(chat, to: 400)
        let before = chat.onScreen()
        chat.plans.insert(chat.plan("n", height: 300), at: 0)
        chat.apply(animated: true)
        try await settle(chat)
        assertSame(before, chat.onScreen(), "a finished message below")
        XCTAssertEqual(chat.adapter.visibleMinY, 700, accuracy: 0.5)
    }

    /// Follow, stop, back at the foot, follow two lines, stop, three times
    /// over, the foot reached by scrolling there, by a drag and by the
    /// button. Once stopped, growth moves nothing at all, token by token;
    /// near the foot without reaching it is not the foot.
    func testEachReturnToTheFootFollowsTwoLinesAgainAndOnlyThen() async throws {
        let chat = try await chat(forty)
        chat.streaming = true
        var height: CGFloat = 100
        chat.plans[0] = chat.plan("m0", height: height, words: true)
        func stream(_ points: CGFloat, by step: CGFloat = 5) async throws {
            var left = points
            while left > 0 {
                height += min(step, left); left -= step
                chat.setHeight("m0", height)
                chat.apply(animated: true)
                try await Task.sleep(for: .milliseconds(4))
            }
            try await settle(chat)
        }
        func reachTheFoot(_ how: Int) async throws {
            switch how {
            case 0:
                try await scroll(chat, to: 0)
            case 1:
                // A drag up past the foot, let go there: it springs back
                // and rests on it.
                let time = CACurrentMediaTime()
                let distance = chat.adapter.visibleMinY
                chat.list.receiveScrollInput(.init(time: time, phase: .touchDown))
                chat.list.receiveScrollInput(.init(time: time + 0.01, phase: .began))
                chat.list.receiveScrollInput(.init(time: time + 0.05, phase: .changed, translation: .init(y: -(distance + 40))))
                chat.list.receiveScrollInput(.init(time: time + 0.3, phase: .ended, translation: .init(y: -(distance + 40)), velocity: .zero))
                let rest = ContinuousClock.now + .seconds(3)
                while chat.list.isDecelerating || chat.list.isScrollFlightActive || chat.adapter.visibleMinY > 0.5, ContinuousClock.now < rest {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try await settle(chat)
            default:
                chat.adapter.scrollToNewest(animated: false)
                try await settle(chat)
            }
            XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5, "way \(how) reached the foot")
            XCTAssertTrue(chat.adapter.isFollowingNewest, "way \(how) followed again")
        }
        for cycle in 0..<3 {
            let top = try XCTUnwrap(chat.frame("m1")).minY
            try await stream(120)
            XCTAssertEqual(try XCTUnwrap(chat.frame("m1")).minY, top - 50, accuracy: 0.5, "cycle \(cycle): two lines followed")
            XCTAssertFalse(chat.adapter.isFollowingNewest, "cycle \(cycle): stopped")
            // Held: token after token moves nothing on screen, once the
            // follow's own animation has landed.
            try await Task.sleep(for: .milliseconds(400))
            let held = chat.onScreen()
            var samples: [CGFloat] = []
            for _ in 0..<20 {
                height += 5
                chat.setHeight("m0", height)
                chat.apply(animated: true)
                try await Task.sleep(for: .milliseconds(8))
                if let frame = chat.presented("m1") { samples.append(frame.minY) }
            }
            try await settle(chat)
            assertSame(held, chat.onScreen(), "cycle \(cycle): held")
            XCTAssertLessThanOrEqual((samples.max() ?? 0) - (samples.min() ?? 0), 0.5, "cycle \(cycle): drawn, it crept: \(samples)")
            // Near the foot is not on it.
            if cycle == 0 {
                try await scroll(chat, to: 10)
                let near = chat.onScreen()
                try await stream(60)
                assertSame(near, chat.onScreen(), "10 from the foot")
                XCTAssertEqual(chat.adapter.visibleMinY, 70, accuracy: 0.5)
            }
            try await reachTheFoot(cycle)
        }
    }

    // MARK: Away from the newest

    func testAReaderBackInHistoryNeverSeesRowsMove() async throws {
        let chat = try await chat(forty)
        try await scroll(chat, to: 1000)
        var before = chat.onScreen()

        chat.setHeight("m0", 400)
        chat.apply()
        try await settle(chat)
        assertSame(before, chat.onScreen(), "the newest grew below")

        chat.plans.insert(chat.plan("n0", height: 150), at: 0)
        chat.apply(animated: true)
        try await settle(chat)
        assertSame(before, chat.onScreen(), "a newer row arrived below")

        chat.plans.removeAll { $0.id == "m1" }
        chat.apply(animated: true)
        try await settle(chat)
        assertSame(before, chat.onScreen(), "a row below went")

        chat.setHeight("m35", 300)
        chat.apply()
        try await settle(chat)
        assertSame(before, chat.onScreen(), "a row above grew")

        chat.plans.removeAll { $0.id == "m37" }
        chat.apply(animated: true)
        try await settle(chat)
        assertSame(before, chat.onScreen(), "a row above went")

        chat.plans.append(contentsOf: (40..<60).map { chat.plan("m\($0)", height: 90) })
        chat.apply()
        try await settle(chat)
        assertSame(before, chat.onScreen(), "an older page joined")
        before = chat.onScreen()
        XCTAssertGreaterThan(chat.adapter.visibleMinY, 1000)
    }

    func testAnOlderPageWhileTheNewestStreamsKeepsTheFoot() async throws {
        let chat = try await chat(forty)
        let foot = try XCTUnwrap(chat.frame("m0")).maxY
        chat.setHeight("m0", 120)
        chat.plans.append(contentsOf: (40..<60).map { chat.plan("m\($0)", height: 90) })
        chat.apply(animated: true)
        try await settle(chat)
        XCTAssertEqual(try XCTUnwrap(chat.frame("m0")).maxY, foot, accuracy: 0.5, "following, the newest still rests on the composer")
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5)
    }

    func testAnOlderPageAndGrowthUnderADragKeepTheFinger() async throws {
        let chat = try await chat(forty)
        let time = CACurrentMediaTime()
        chat.list.receiveScrollInput(.init(time: time, phase: .touchDown))
        chat.list.receiveScrollInput(.init(time: time + 0.01, phase: .began, translation: .init(y: 0)))
        chat.list.receiveScrollInput(.init(time: time + 0.05, phase: .changed, translation: .init(y: 240)))
        XCTAssertTrue(chat.list.isDragging)
        let before = chat.onScreen()
        chat.setHeight("m0", 260)
        chat.plans.append(contentsOf: (40..<60).map { chat.plan("m\($0)", height: 90) })
        chat.apply(animated: true)
        try await settle(chat)
        XCTAssertTrue(chat.list.isDragging)
        assertSame(before, chat.onScreen(), "under the finger")
        chat.list.receiveScrollInput(.init(time: time + 0.5, phase: .cancelled))
    }

    func testAnOlderPageWhileDeceleratingKeepsTheGlide() async throws {
        let chat = try await chat(forty)
        let watched = "m6"
        var samples: [CGFloat] = []
        let sampler = Task { @MainActor in
            while !Task.isCancelled {
                if let frame = chat.presented(watched) { samples.append(frame.minY) }
                try? await Task.sleep(for: .milliseconds(4))
            }
        }
        defer { sampler.cancel() }
        let time = CACurrentMediaTime()
        chat.list.receiveScrollInput(.init(time: time, phase: .touchDown))
        chat.list.receiveScrollInput(.init(time: time + 0.01, phase: .began))
        chat.list.receiveScrollInput(.init(time: time + 0.03, phase: .changed, translation: .init(y: 60), velocity: .init(y: 1500)))
        chat.list.receiveScrollInput(.init(time: time + 0.05, phase: .ended, translation: .init(y: 120), velocity: .init(y: 1500)))
        let gliding = ContinuousClock.now + .milliseconds(200)
        while !chat.list.isDecelerating, ContinuousClock.now < gliding { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(chat.list.isDecelerating, "the fling never glided")
        try await Task.sleep(for: .milliseconds(60))
        chat.setHeight("m0", 220)
        chat.plans.append(contentsOf: (40..<60).map { chat.plan("m\($0)", height: 90) })
        chat.apply()
        let rest = ContinuousClock.now + .seconds(4)
        while chat.list.isDecelerating, ContinuousClock.now < rest { try await Task.sleep(for: .milliseconds(10)) }
        sampler.cancel()
        // The glide carries the rows down smoothly: nothing joining above
        // (20 rows, 1800 points) or growing below (130 points) makes them
        // jump. A frame of the fling moves them 25 points at 60 Hz and
        // less as it slows; they never back up.
        XCTAssertGreaterThan(samples.count, 20)
        let steps = zip(samples, samples.dropFirst()).map { $1 - $0 }
        XCTAssertLessThanOrEqual(steps.max() ?? 0, 40, "a row jumped mid-glide: \(steps.map { Int($0.rounded()) })")
        XCTAssertGreaterThanOrEqual(steps.min() ?? 0, -1, "a row went back up mid-glide")
    }

    // MARK: Keyboard, composer, width

    func testTheKeyboardAndTheComposerKeepTheNewestOnTheComposer() async throws {
        let chat = try await chat(forty)
        let height = chat.root.bounds.height
        chat.setInsets(.init(top: 100, left: 0, bottom: 336 + 60, right: 0), keyboard: .init(transition: .keyboard(0.25)))
        try await settle(chat)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(chat.frame("m0")).maxY, height - 396 - 10, accuracy: 0.5)
        chat.setInsets(.init(top: 100, left: 0, bottom: 336 + 120, right: 0))
        try await settle(chat)
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5, "the composer grew a line")
        chat.setInsets(.init(top: 100, left: 0, bottom: 60, right: 0), keyboard: .init(transition: .keyboard(0.25)))
        try await settle(chat)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(chat.frame("m0")).maxY, chat.restingFoot, accuracy: 0.5)
    }

    func testTheKeyboardAwayFromTheNewestKeepsTheDistance() async throws {
        let chat = try await chat(forty)
        try await scroll(chat, to: 800)
        chat.setInsets(.init(top: 100, left: 0, bottom: 396, right: 0), keyboard: .init(transition: .keyboard(0.25)))
        try await settle(chat)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(chat.adapter.visibleMinY, 800, accuracy: 0.5, "the conversation rode up with the composer")
        // Growth at the foot meanwhile goes below the fold.
        let before = chat.onScreen()
        chat.setHeight("m0", 300)
        chat.apply()
        try await settle(chat)
        assertSame(before, chat.onScreen(), "growth with the keyboard up")
        chat.setInsets(.init(top: 100, left: 0, bottom: 60, right: 0), keyboard: .init(transition: .keyboard(0.25)))
        try await settle(chat)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(chat.adapter.visibleMinY, 1000, accuracy: 0.5)
    }

    func testANewWidthMidHistoryKeepsTheTopRow() async throws {
        let chat = try await chat(forty)
        try await scroll(chat, to: 1200)
        let top = try XCTUnwrap(chat.onScreen().min { $0.value < $1.value })
        let frame = chat.list.frame
        chat.adapter.setViewport(frame: CGRect(x: frame.minX, y: frame.minY, width: frame.width - 80, height: frame.height), insets: chat.insets)
        try await settle(chat)
        XCTAssertEqual(try XCTUnwrap(chat.frame(top.key)).minY, top.value, accuracy: 0.5)
        chat.adapter.setViewport(frame: frame, insets: chat.insets)
        try await settle(chat)
        XCTAssertEqual(try XCTUnwrap(chat.frame(top.key)).minY, top.value, accuracy: 0.5)
    }

    // MARK: The reader's own acts

    func testASendFromHistoryComesFullyIntoView() async throws {
        let chat = try await chat(forty)
        try await scroll(chat, to: 1500)
        chat.adapter.revealNextSend()
        // Meanwhile the reply above it streams past the budget.
        chat.setHeight("m0", 400)
        chat.apply()
        try await settle(chat)
        chat.plans.insert(chat.plan("sent", height: 120), at: 0)
        chat.apply(animated: true)
        try await settle(chat)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5)
        let sent = try XCTUnwrap(chat.frame("sent"))
        XCTAssertEqual(sent.maxY, chat.restingFoot, accuracy: 0.5)
        XCTAssertGreaterThanOrEqual(sent.minY, chat.insets.top)
    }

    func testASendTallerThanTheScreenShowsItsFoot() async throws {
        let chat = try await chat(forty)
        chat.adapter.revealNextSend()
        chat.plans.insert(chat.plan("sent", height: 2000), at: 0)
        chat.apply(animated: true)
        try await settle(chat)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(try XCTUnwrap(chat.frame("sent")).maxY, chat.restingFoot, accuracy: 0.5)
    }

    /// The person's message, sent and last: it rests on the composer.
    private func send(_ chat: Chat, _ id: String = "sent", height: CGFloat = 90, file: StaticString = #filePath, line: UInt = #line) async throws {
        chat.adapter.revealNextSend()
        chat.plans.insert(chat.plan(id, height: height, mine: true), at: 0)
        chat.apply(animated: true)
        try await settle(chat)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(try XCTUnwrap(chat.frame(id), file: file, line: line).maxY, chat.restingFoot, accuracy: 0.5, "the send on the composer", file: file, line: line)
    }

    /// The reply above the person's newest message grows a line at a
    /// time; the message stays on the composer through every one of them.
    private func growAbove(_ chat: Chat, _ id: String, lines: Int, keeping sent: String, on foot: CGFloat, file: StaticString = #filePath, line: UInt = #line) async throws {
        for index in 0..<lines {
            chat.setHeight(id, try XCTUnwrap(chat.plans.first { $0.id == id }).size.height + 24)
            chat.apply(animated: true)
            try await settle(chat)
            XCTAssertEqual(try XCTUnwrap(chat.frame(sent), file: file, line: line).maxY, foot, accuracy: 0.5, "line \(index): the send left the composer", file: file, line: line)
        }
        XCTAssertTrue(chat.adapter.isFollowingNewest, file: file, line: line)
    }

    func testThePersonsNewestMessageStaysOnTheComposerWhileTheReplyAboveGrows() async throws {
        let chat = try await chat(forty)
        try await send(chat)
        // Thirty-five lines over it, far past the two-line budget.
        try await growAbove(chat, "m0", lines: 35, keeping: "sent", on: chat.restingFoot)
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5)
    }

    /// The person's message going from the outbox to confirmed is a new
    /// plan of the same row: it stays on the composer through it,
    /// mid-stream.
    func testASendConfirmedMidStreamStaysOnTheComposer() async throws {
        let chat = try await chat(forty)
        try await send(chat)
        try await growAbove(chat, "m0", lines: 5, keeping: "sent", on: chat.restingFoot)
        // Confirmed, with its time under it, as the reply grows.
        chat.plans[0] = chat.plan("sent", height: 96, mine: true)
        chat.setHeight("m0", try XCTUnwrap(chat.plans.first { $0.id == "m0" }).size.height + 24)
        chat.apply(animated: true)
        try await settle(chat)
        XCTAssertEqual(try XCTUnwrap(chat.frame("sent")).maxY, chat.restingFoot, accuracy: 0.5)
        try await growAbove(chat, "m0", lines: 10, keeping: "sent", on: chat.restingFoot)
    }

    /// A drag away from the pinned message ends its pin: what grows above
    /// it then moves nothing. Back at the foot, it holds the composer again.
    func testAPinnedMessageDraggedAwayFromMovesNothingUntilTheFoot() async throws {
        let chat = try await chat(forty)
        try await send(chat)
        try await growAbove(chat, "m0", lines: 3, keeping: "sent", on: chat.restingFoot)
        let time = CACurrentMediaTime()
        chat.list.receiveScrollInput(.init(time: time, phase: .touchDown))
        chat.list.receiveScrollInput(.init(time: time + 0.01, phase: .began))
        chat.list.receiveScrollInput(.init(time: time + 0.05, phase: .changed, translation: .init(y: 200)))
        chat.list.receiveScrollInput(.init(time: time + 0.3, phase: .ended, translation: .init(y: 200), velocity: .zero))
        let rest = ContinuousClock.now + .seconds(3)
        while chat.list.isDecelerating || chat.list.isScrollFlightActive, ContinuousClock.now < rest { try await Task.sleep(for: .milliseconds(10)) }
        try await settle(chat)
        XCTAssertEqual(chat.adapter.visibleMinY, 200, accuracy: 0.5)
        XCTAssertFalse(chat.adapter.isFollowingNewest)
        let before = chat.onScreen()
        for _ in 0..<10 {
            chat.setHeight("m0", try XCTUnwrap(chat.plans.first { $0.id == "m0" }).size.height + 24)
            chat.apply(animated: true)
            try await settle(chat)
            assertSame(before, chat.onScreen(), "dragged away")
        }
        chat.adapter.scrollToNewest(animated: false)
        try await settle(chat)
        XCTAssertEqual(try XCTUnwrap(chat.frame("sent")).maxY, chat.restingFoot, accuracy: 0.5)
        try await growAbove(chat, "m0", lines: 10, keeping: "sent", on: chat.restingFoot)
    }

    /// The agent's reply arriving under the person's message ends the pin:
    /// a streaming reply is followed by two lines from its first words, a
    /// finished one comes in whole.
    func testAReplyUnderThePinnedMessageEndsThePin() async throws {
        let chat = try await chat(forty)
        try await send(chat)
        try await growAbove(chat, "m0", lines: 10, keeping: "sent", on: chat.restingFoot)
        let top = try XCTUnwrap(chat.frame("sent")).minY
        chat.streaming = true
        chat.plans.insert(chat.plan("r", height: 30, words: true), at: 0)
        chat.apply(animated: true)
        try await settle(chat)
        XCTAssertEqual(try XCTUnwrap(chat.frame("sent")).minY, top - 30, accuracy: 0.5, "its first line followed")
        chat.setHeight("r", 330)
        chat.apply(animated: true)
        try await settle(chat)
        XCTAssertEqual(try XCTUnwrap(chat.frame("sent")).minY, top - 50, accuracy: 0.5, "30 and 20 make the 50")
        XCTAssertEqual(chat.adapter.visibleMinY, 280, accuracy: 0.5)
        XCTAssertFalse(chat.adapter.isFollowingNewest)

        // Again, and a finished message comes in under it.
        chat.streaming = false
        chat.adapter.scrollToNewest(animated: false)
        try await settle(chat)
        try await send(chat, "again")
        chat.plans.insert(chat.plan("done", height: 260, words: true), at: 0)
        chat.apply(animated: true)
        try await settle(chat)
        XCTAssertEqual(try XCTUnwrap(chat.frame("done")).maxY, chat.restingFoot, accuracy: 0.5, "a finished reply whole")
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5)
    }

    /// The keyboard and the composer coming and going keep the pinned
    /// message on the composer, and growth above it meanwhile.
    func testTheKeyboardKeepsThePinnedMessageOnTheComposer() async throws {
        let chat = try await chat(forty)
        try await send(chat)
        let height = chat.root.bounds.height
        chat.setInsets(.init(top: 100, left: 0, bottom: 336 + 60, right: 0), keyboard: .init(transition: .keyboard(0.25)))
        try await settle(chat)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(try XCTUnwrap(chat.frame("sent")).maxY, height - 396 - 10, accuracy: 0.5, "the keyboard up")
        try await growAbove(chat, "m0", lines: 10, keeping: "sent", on: height - 396 - 10)
        chat.setInsets(.init(top: 100, left: 0, bottom: 336 + 120, right: 0))
        try await settle(chat)
        XCTAssertEqual(try XCTUnwrap(chat.frame("sent")).maxY, height - 456 - 10, accuracy: 0.5, "the composer grew a line")
        chat.setInsets(.init(top: 100, left: 0, bottom: 60, right: 0), keyboard: .init(transition: .keyboard(0.25)))
        try await settle(chat)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(try XCTUnwrap(chat.frame("sent")).maxY, chat.restingFoot, accuracy: 0.5, "the keyboard down")
        try await growAbove(chat, "m0", lines: 5, keeping: "sent", on: chat.restingFoot)
    }

    func testScrollToTheNewestMidStreamFollowsTwoLinesAgain() async throws {
        let chat = try await chat(forty)
        chat.setHeight("m0", 400)
        chat.apply()
        try await settle(chat)
        XCTAssertEqual(chat.adapter.visibleMinY, 250, accuracy: 0.5)
        chat.adapter.scrollToNewest(animated: false)
        try await settle(chat)
        XCTAssertEqual(chat.adapter.visibleMinY, 0, accuracy: 0.5)
        XCTAssertTrue(chat.adapter.isFollowingNewest)
        chat.setHeight("m0", 600)
        chat.apply()
        try await settle(chat)
        XCTAssertEqual(chat.adapter.visibleMinY, 150, accuracy: 0.5)
    }

    func testARowOpenedAtTheNewestGrowsUnderTheFinger() async throws {
        let chat = try await chat(forty)
        let top = try XCTUnwrap(chat.frame("m2")).minY
        chat.setHeight("m2", 500)
        chat.pinning = "m2"
        chat.apply(animated: true)
        try await settle(chat)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(try XCTUnwrap(chat.frame("m2")).minY, top, accuracy: 0.5, "the opened row's head stays")
        XCTAssertFalse(chat.adapter.isFollowingNewest)
    }

    // MARK: The agents' transcript

    private final class Host: AgentChatTranscriptHost {
        func show(_ plan: ChatRowPlan, in view: ChatPlanView) { view.apply(plan) }
        func placedChunks(of plan: ChatRowPlan, in view: ChatPlanView) {}
        func transcriptScrolled() {}
        func transcriptWillBeginDragging() {}
        func transcriptDidEndDragging() {}
        func transcriptTapped(_ action: ChatRowAction) {}
        func transcriptOpened(_ url: String) {}
        func transcriptHeld(_ action: ChatRowAction, in view: UIView, frame: CGRect, at point: CGPoint) {}
    }

    func testTheAgentsTranscriptFollowsTwoLinesAndRevealsASend() async throws {
        let scene = try await hostedActiveScene()
        let original = scene.keyWindow
        let root = UIViewController()
        let window = hostedKeyWindow(in: scene, root: root)
        let host = Host()
        let transcript = AgentChatUltraList(frame: root.view.bounds)
        transcript.host = host
        root.view.addSubview(transcript)
        defer {
            transcript.deactivate()
            window.isHidden = true
            original?.makeKey()
        }
        window.layoutIfNeeded()
        transcript.followBudget = ChatFollow.budget(body: ChatTextStyles.text, scale: .standard)
        XCTAssertEqual(transcript.followBudget, 48)
        transcript.setViewport(frame: root.view.bounds, insets: .init(top: 100, left: 0, bottom: 80, right: 0))
        let width = root.view.bounds.width
        func plan(_ id: String, _ height: CGFloat) -> ChatRowPlan { ChatRowPlan(id: id, size: .init(width: width, height: height), items: []) }
        var plans = (0..<40).map { plan("r\($0)", 100) }
        func wait(_ condition: () -> Bool = { false }, seconds: Double = 0.4) async throws {
            let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
            while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
            try await Task.sleep(for: .milliseconds(60))
        }
        transcript.apply(plans)
        try await wait({ transcript.list.newestLoadedView != nil }, seconds: 5)
        XCTAssertEqual(transcript.distanceFromNewest, 0, accuracy: 0.5)
        XCTAssertEqual(transcript.list.items.last?.identity, "chat:row:r39", "oldest first: the last plan is the newest row")

        plans[39] = plan("r39", 400)
        transcript.apply(plans, streaming: true)
        try await wait()
        XCTAssertEqual(transcript.distanceFromNewest, 300 - 48, accuracy: 0.5)

        transcript.revealNextSend(animated: false)
        plans.append(plan("sent", 90))
        transcript.apply(plans)
        try await wait({ abs(transcript.distanceFromNewest) < 0.5 }, seconds: 5)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(transcript.distanceFromNewest, 0, accuracy: 0.5)
        let sent = try XCTUnwrap(transcript.list.newestLoadedView)
        XCTAssertEqual(sent.convert(sent.bounds, to: transcript).maxY, root.view.bounds.height - 80, accuracy: 0.5)

        // Back in history, an opened row and the newest growing move nothing.
        transcript.scroll(toDistanceFromNewest: 900)
        try await wait()
        let index = try XCTUnwrap(transcript.list.loadedIndexRange.first { transcript.list.settledFrame(at: $0).map { $0.minY > 100 } == true })
        let before = try XCTUnwrap(transcript.list.settledFrame(at: index)).minY
        plans[plans.count - 1] = plan("sent", 300)
        transcript.apply(plans)
        try await wait()
        XCTAssertEqual(try XCTUnwrap(transcript.list.settledFrame(at: index)).minY, before, accuracy: 0.5)

        // Back at the foot: a finished row (a tool's, here) comes in whole;
        // the agent's words starting to stream under it are followed by
        // two lines from their first, then held.
        transcript.scrollToNewest(animated: false)
        try await wait({ abs(transcript.distanceFromNewest) < 0.5 })
        plans.append(plan("tool", 260))
        transcript.apply(plans, streaming: true)
        try await wait({ (transcript.list.newestLoadedView as? AgentChatRowView)?.row.identity == "chat:row:tool" })
        XCTAssertEqual(transcript.distanceFromNewest, 0, accuracy: 0.5, "a finished row whole")
        let foot = root.view.bounds.height - 80
        let tool = try XCTUnwrap(transcript.list.newestLoadedView)
        XCTAssertEqual(tool.convert(tool.bounds, to: transcript).maxY, foot, accuracy: 0.5)
        func words(_ height: CGFloat) -> ChatRowPlan {
            ChatRowPlan(id: "words", size: .init(width: width, height: height), items: [], revealable: true)
        }
        plans.append(words(30))
        transcript.apply(plans, streaming: true)
        try await wait()
        XCTAssertEqual(transcript.distanceFromNewest, 0, accuracy: 0.5, "its first line followed")
        let toolTop = tool.convert(tool.bounds, to: transcript).minY
        plans[plans.count - 1] = words(200)
        transcript.apply(plans, streaming: true)
        try await wait()
        XCTAssertEqual(tool.convert(tool.bounds, to: transcript).minY, toolTop - 18, accuracy: 0.5, "30 and 18 make the 48")
        XCTAssertEqual(transcript.distanceFromNewest, 200 - 48, accuracy: 0.5)
    }

    /// In the agents' chat a send while the agent works waits under its
    /// reply, and stays on the composer as the reply streams above it,
    /// line after line; a second send takes its place there; the first,
    /// taken into the run, stays put above it.
    func testTheAgentsQueuedSendsStayOnTheComposerWhileTheReplyAboveStreams() async throws {
        let scene = try await hostedActiveScene()
        let original = scene.keyWindow
        let root = UIViewController()
        let window = hostedKeyWindow(in: scene, root: root)
        let host = Host()
        let transcript = AgentChatUltraList(frame: root.view.bounds)
        transcript.host = host
        root.view.addSubview(transcript)
        defer {
            transcript.deactivate()
            window.isHidden = true
            original?.makeKey()
        }
        window.layoutIfNeeded()
        transcript.followBudget = 48
        transcript.setViewport(frame: root.view.bounds, insets: .init(top: 100, left: 0, bottom: 80, right: 0))
        let width = root.view.bounds.width
        let foot = root.view.bounds.height - 80
        func plan(_ id: String, _ height: CGFloat, words: Bool = false, mine: Bool = false) -> ChatRowPlan {
            ChatRowPlan(id: id, size: .init(width: width, height: height), items: [], mine: mine, revealable: words)
        }
        func frame(_ id: String) -> CGRect? {
            guard let index = transcript.list.items.firstIndex(where: { $0.identity == "chat:row:\(id)" }),
                  let view = transcript.list.loadedItemView(at: index) else { return nil }
            return view.convert(view.bounds, to: transcript)
        }
        func wait(_ condition: () -> Bool = { false }, seconds: Double = 0.4) async throws {
            let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
            while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
            try await Task.sleep(for: .milliseconds(60))
        }
        var settled = (0..<39).map { plan("r\($0)", 100) } + [plan("reply", 100, words: true)]
        var waiting: [ChatRowPlan] = []
        func apply() { transcript.apply(settled + waiting, streaming: true, queued: waiting.count) }
        apply()
        try await wait({ transcript.list.newestLoadedView != nil }, seconds: 5)
        XCTAssertEqual(transcript.distanceFromNewest, 0, accuracy: 0.5)

        func grow(_ id: String, lines: Int, keeping sent: String, file: StaticString = #filePath, line: UInt = #line) async throws {
            for index in 0..<lines {
                let at = try XCTUnwrap(settled.firstIndex { $0.id == id }, file: file, line: line)
                let height = settled[at].size.height + 24
                settled[at] = plan(id, height, words: true)
                apply()
                try await wait({ frame(id)?.height == height })
                XCTAssertEqual(try XCTUnwrap(frame(sent), file: file, line: line).maxY, foot, accuracy: 0.5, "line \(index): the send left the composer", file: file, line: line)
            }
            XCTAssertEqual(transcript.distanceFromNewest, 0, accuracy: 0.5, file: file, line: line)
        }

        // Sent under the streaming reply: it waits there, on the composer,
        // for thirty-five lines of the reply.
        transcript.revealNextSend(animated: true)
        waiting = [plan("q1", 90, mine: true)]
        apply()
        try await wait({ frame("q1")?.maxY == foot }, seconds: 2)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(try XCTUnwrap(frame("q1")).maxY, foot, accuracy: 0.5)
        try await grow("reply", lines: 35, keeping: "q1")

        // Its row going from the outbox to confirmed, mid-stream.
        waiting = [plan("q1", 96, mine: true)]
        try await grow("reply", lines: 3, keeping: "q1")

        // A second send waits under the first and takes the composer.
        transcript.revealNextSend(animated: true)
        waiting.append(plan("q2", 60, mine: true))
        apply()
        try await wait({ frame("q2")?.maxY == foot }, seconds: 2)
        try await Task.sleep(for: .milliseconds(300))
        try await grow("reply", lines: 5, keeping: "q2")
        XCTAssertEqual(try XCTUnwrap(frame("q1")).maxY, try XCTUnwrap(frame("q2")).minY, accuracy: 0.5, "the first send right above it")

        // The agent takes the first in, and answers it above the second,
        // still waiting: that answer grows above the second as well.
        waiting.removeFirst()
        settled.append(plan("q1", 96, mine: true))
        settled.append(plan("answer", 30, words: true))
        apply()
        try await wait({ frame("answer") != nil })
        XCTAssertEqual(try XCTUnwrap(frame("q2")).maxY, foot, accuracy: 0.5)
        try await grow("answer", lines: 10, keeping: "q2")

        // The second taken in too and answered under it: a streaming
        // answer is followed by two lines from its first words, then held.
        waiting = []
        settled.append(plan("q2", 60, mine: true))
        settled.append(plan("last", 30, words: true))
        apply()
        try await wait({ frame("last") != nil })
        let top = try XCTUnwrap(frame("q2")).minY
        let at = try XCTUnwrap(settled.firstIndex { $0.id == "last" })
        settled[at] = plan("last", 330, words: true)
        apply()
        try await wait({ frame("last")?.height == 330 })
        XCTAssertEqual(try XCTUnwrap(frame("q2")).minY, top - 18, accuracy: 0.5, "30 and 18 make the 48")
        XCTAssertEqual(transcript.distanceFromNewest, 330 - 48, accuracy: 0.5)
    }
}
#endif

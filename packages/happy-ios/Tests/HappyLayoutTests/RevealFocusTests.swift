import XCTest
@testable import HappyLayout

/// Which row of a transcript comes out as it streams (`RevealFocus`): only
/// the newest, still growing, with words that arrive on screen; any row
/// that stops being it finishes.
final class RevealFocusTests: XCTestCase {
    private typealias Row = RevealFocus.Row

    private func user(_ id: String, _ change: RevealFocus.Change = .same) -> Row { Row(id: id, revealable: false, change: change) }
    private func agent(_ id: String, _ change: RevealFocus.Change = .same) -> Row { Row(id: id, revealable: true, change: change) }

    /// A transcript that opened with `history` on screen.
    private func opened(_ history: [Row]) -> RevealFocus {
        var focus = RevealFocus()
        _ = focus.update(history.map { Row(id: $0.id, revealable: $0.revealable, change: .new) }, streaming: true, onScreen: true, revealing: [])
        return focus
    }

    private let history = [Row(id: "u1", revealable: false, change: .same), Row(id: "a1", revealable: true, change: .same)]

    // MARK: What starts

    func testANewReplyAtTheNewestEndStarts() {
        var focus = opened(history)
        let steps = focus.update(history + [user("u2", .new)], streaming: true, onScreen: true, revealing: [])
        XCTAssertEqual(steps, [:])
        XCTAssertEqual(focus.update(history + [user("u2"), agent("a2", .new)], streaming: true, onScreen: true, revealing: []), ["a2": .start])
        XCTAssertEqual(focus.target, "a2")
    }

    /// The history a chat opens with never comes out, the newest message
    /// still streaming included.
    func testTheHistoryAChatOpensWithShowsWhole() {
        var focus = RevealFocus()
        XCTAssertEqual(focus.update(history.map { Row(id: $0.id, revealable: $0.revealable, change: .new) }, streaming: true, onScreen: true, revealing: []), [:])
        XCTAssertNil(focus.target)
        // Even after the screen showed nothing first (the chat still loading).
        var loading = RevealFocus()
        _ = loading.update([], streaming: true, onScreen: true, revealing: [])
        XCTAssertEqual(loading.update([agent("a1", .new)], streaming: true, onScreen: true, revealing: []), [:])
        // The newest words grow next: those come out.
        XCTAssertEqual(loading.update([agent("a1", .grew(by: 12))], streaming: true, onScreen: true, revealing: []), ["a1": .start])
    }

    /// Rows that came while the chat was off screen (another screen over
    /// it, not yet in a window) show whole, and the first update on screen
    /// again does too.
    func testWhatCameWhileOffScreenShowsWhole() {
        var focus = opened(history)
        XCTAssertEqual(focus.update(history + [agent("a2", .new)], streaming: true, onScreen: false, revealing: []), [:])
        XCTAssertEqual(focus.update(history + [agent("a2", .grew(by: 30))], streaming: true, onScreen: true, revealing: []), [:])
        XCTAssertEqual(focus.update(history + [agent("a2", .grew(by: 8))], streaming: true, onScreen: true, revealing: []), ["a2": .start])
    }

    /// Several rows arriving in one update (a reconnect, a burst) show
    /// whole, the newest too.
    func testABurstShowsWhole() {
        var focus = opened(history)
        let burst = history + [agent("a2", .new), user("t1", .new), agent("a3", .new)]
        XCTAssertEqual(focus.update(burst, streaming: true, onScreen: true, revealing: []), [:])
        XCTAssertNil(focus.target)
        // The newest, still streaming, comes out from where it is with its next words.
        let after = history + [agent("a2"), user("t1"), agent("a3", .grew(by: 10))]
        XCTAssertEqual(focus.update(after, streaming: true, onScreen: true, revealing: []), ["a3": .start])
    }

    /// Words that grew while the newest row grew too are a burst as well.
    func testAGrowthWithANewerRowIsABurst() {
        var focus = opened(history)
        XCTAssertEqual(focus.update([user("u1"), agent("a1", .grew(by: 10)), agent("a2", .new)], streaming: true, onScreen: true, revealing: []), [:])
    }

    /// Older history paged in at the far end is no burst.
    func testOlderPagesDoNotHoldTheNewestBack() {
        var focus = opened(history)
        let paged = [user("o1", .new), agent("o2", .new)] + history.dropLast() + [agent("a1", .grew(by: 10))]
        XCTAssertEqual(focus.update(paged, streaming: true, onScreen: true, revealing: []), ["a1": .start])
    }

    /// A row that grew by more than a model's chunks at once was caught up
    /// with: it shows whole, and stops if it was coming out.
    func testACatchUpShowsWhole() {
        var focus = opened(history)
        XCTAssertEqual(focus.update([user("u1"), agent("a1", .grew(by: RevealFocus.catchUp + 1))], streaming: true, onScreen: true, revealing: []), [:])
        XCTAssertEqual(focus.update([user("u1"), agent("a1", .grew(by: 20))], streaming: true, onScreen: true, revealing: []), ["a1": .start])
        XCTAssertEqual(focus.update([user("u1"), agent("a1", .grew(by: 2000))], streaming: true, onScreen: true, revealing: ["a1"]), ["a1": .stop])
        XCTAssertNil(focus.target)
    }

    /// The person's message, a tool call: not the agent's words.
    func testOnlyTheAgentsWordsStart() {
        var focus = opened(history)
        XCTAssertEqual(focus.update(history + [user("u2", .new)], streaming: true, onScreen: true, revealing: []), [:])
        XCTAssertNil(focus.target)
    }

    /// Nothing starts while the agent isn't at work.
    func testNothingStartsWhileIdle() {
        var focus = opened(history)
        XCTAssertEqual(focus.update(history + [agent("a2", .new)], streaming: false, onScreen: true, revealing: []), [:])
    }

    /// Planned again (another width, the turn's fold) is not growing.
    func testReplanningIsNotGrowing() {
        var focus = opened(history)
        XCTAssertEqual(focus.update(history, streaming: true, onScreen: true, revealing: []), [:])
    }

    // MARK: When the target changes

    /// A newer segment arrives while one is still coming out: the old one
    /// finishes, the new one starts, and only it is the target.
    func testANewerSegmentFinishesTheOneComingOut() {
        var focus = opened(history)
        XCTAssertEqual(focus.update(history + [agent("a2", .new)], streaming: true, onScreen: true, revealing: []), ["a2": .start])
        XCTAssertEqual(focus.update(history + [agent("a2", .grew(by: 9))], streaming: true, onScreen: true, revealing: ["a2"]), ["a2": .grow])
        let steps = focus.update(history + [agent("a2"), agent("a3", .new)], streaming: true, onScreen: true, revealing: ["a2"])
        XCTAssertEqual(steps, ["a2": .finish, "a3": .start])
        XCTAssertEqual(focus.target, "a3")
        // The old one, finishing, stays finishing as the new one grows.
        XCTAssertEqual(focus.update(history + [agent("a2"), agent("a3", .grew(by: 5))], streaming: true, onScreen: true, revealing: ["a2", "a3"]),
                       ["a2": .finish, "a3": .grow])
    }

    /// A tool call after the words: they finish, and nothing paces.
    func testAToolCallAfterTheWordsFinishesThem() {
        var focus = opened(history)
        _ = focus.update(history + [agent("a2", .new)], streaming: true, onScreen: true, revealing: [])
        XCTAssertEqual(focus.update(history + [agent("a2"), user("tool", .new)], streaming: true, onScreen: true, revealing: ["a2"]), ["a2": .finish])
        XCTAssertNil(focus.target)
        // It grows after all, under the tool call: still not the newest.
        XCTAssertEqual(focus.update(history + [agent("a2", .grew(by: 4)), user("tool")], streaming: true, onScreen: true, revealing: ["a2"]), ["a2": .finish])
    }

    /// The agent stops: whatever is coming out finishes.
    func testTheTurnEndingFinishesTheReveal() {
        var focus = opened(history)
        _ = focus.update(history + [agent("a2", .new)], streaming: true, onScreen: true, revealing: [])
        XCTAssertEqual(focus.update(history + [agent("a2")], streaming: false, onScreen: true, revealing: ["a2"]), ["a2": .finish])
        XCTAssertNil(focus.target)
    }

    /// The chat leaves the screen mid-reveal: it finishes.
    func testLeavingTheScreenFinishesTheReveal() {
        var focus = opened(history)
        _ = focus.update(history + [agent("a2", .new)], streaming: true, onScreen: true, revealing: [])
        XCTAssertEqual(focus.update(history + [agent("a2", .grew(by: 3))], streaming: true, onScreen: false, revealing: ["a2"]), ["a2": .finish])
    }

    /// The same rows again (every layout hands them over) leave the
    /// reveal as it is.
    func testTheSameRowsAgainChangeNothing() {
        var focus = opened(history)
        _ = focus.update(history + [agent("a2", .new)], streaming: true, onScreen: true, revealing: [])
        XCTAssertEqual(focus.update(history + [agent("a2")], streaming: true, onScreen: true, revealing: ["a2"]), ["a2": .grow])
        XCTAssertEqual(focus.target, "a2")
    }

    // MARK: The background

    /// What arrives on the way back from the background is the catch-up:
    /// it shows whole, and the words after it come out again.
    func testTheCatchUpAfterTheBackgroundShowsWhole() {
        var focus = opened(history)
        _ = focus.update(history + [agent("a2", .new)], streaming: true, onScreen: true, revealing: [])
        focus.wentAway()
        XCTAssertNil(focus.target)
        // Still in the background: nothing starts.
        XCTAssertEqual(focus.update(history + [agent("a2", .grew(by: 30))], streaming: true, onScreen: true, revealing: []), [:])
        focus.cameBack()
        // Nothing arrived yet: still waiting for the catch-up.
        XCTAssertEqual(focus.update(history + [agent("a2")], streaming: true, onScreen: true, revealing: []), [:])
        XCTAssertEqual(focus.update(history + [agent("a2", .grew(by: 80))], streaming: true, onScreen: true, revealing: []), [:])
        XCTAssertEqual(focus.update(history + [agent("a2", .grew(by: 9))], streaming: true, onScreen: true, revealing: []), ["a2": .start])
    }
}

#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The chat's history paging on screen: the window starting over at the
/// newest when the covered window drops rows (W3), the older end in its
/// slot, and EmptyMessages' and the first load's buttons.
@MainActor
final class ChatHistoryViewsTests: XCTestCase {
    private let width: CGFloat = 393

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    /// Turns of a prompt and its answer. A window ends on the prompt that
    /// opened its oldest turn (`ChatDisplay.windowEnd`), so answers alone
    /// would be one turn the first window holds whole.
    private func messages(_ count: Int) -> [ChatMessage] {
        (0..<count).map { index in
            index.isMultiple(of: 2)
                ? .userText(UserTextMessage(id: "m\(index)", createdAt: Int64(index), text: "message \(index)"))
                : .agentText(AgentTextMessage(id: "m\(index)", createdAt: Int64(index), text: "message \(index)"))
        }
    }

    private func input(_ messages: [ChatMessage], epoch: Int, grows: Int) -> ChatRowsInput {
        var view = ChatRowsView()
        view.width = width
        view.requests.grows = grows
        return ChatRowsInput(
            snapshot: ChatSnapshot(sessionId: "s", messages: messages, isLoaded: true, hasMoreOlder: true, olderBoundary: 1, windowEpoch: epoch),
            session: ChatSessionState(record: nil, settings: AccountSettings()),
            view: view,
            render: .isolated()
        )
    }

    func testAWindowResetStartsAgainFromTheNewestPage() throws {
        let planner = RowPlanner<ChatRowInput, ChatRowPlan> { ChatRowRenderer.plan($0, width: $1) }
        let all = messages(200)
        let first = try XCTUnwrap(ChatRows.derive(input(all, epoch: 0, grows: 0), applied: ChatRowsApplied(), planner: planner))
        XCTAssertLessThan(first.state.window.windowCount, all.count)
        XCTAssertNotNil(first.output.oldestBoundary)

        // The reader paged back once.
        let grown = try XCTUnwrap(ChatRows.derive(input(all, epoch: 0, grows: 1), applied: first.state, planner: planner))
        XCTAssertGreaterThan(grown.state.window.windowCount, first.state.window.windowCount)
        XCTAssertEqual(grown.output.grows, 1)

        // A growth asked for, then the window drops rows it showed: back
        // to the newest page, and the growth is dropped, not carried out.
        let clipped = Array(all.suffix(150))
        let reset = try XCTUnwrap(ChatRows.derive(input(clipped, epoch: 1, grows: 2), applied: grown.state, planner: planner))
        XCTAssertEqual(reset.state.window.windowCount, first.state.window.windowCount)
        XCTAssertEqual(reset.state.window.oldestRenderedId, first.state.window.oldestRenderedId)
        XCTAssertEqual(reset.output.oldestBoundary, first.output.oldestBoundary)
        XCTAssertEqual(reset.output.grows, 2, "nothing pending")
        XCTAssertEqual(reset.output.facts?.windowEpoch, 1)
        XCTAssertFalse(reset.output.reachesOldest)

        // In the same epoch, growth keeps the window's oldest.
        let again = try XCTUnwrap(ChatRows.derive(input(clipped, epoch: 1, grows: 3), applied: reset.state, planner: planner))
        XCTAssertEqual(again.state.window.windowCount, grown.state.window.windowCount)
    }

    func testTheOlderEndSitsInItsSlotPastTheOldestRow() throws {
        let planner = RowPlanner<ChatRowInput, ChatRowPlan> { ChatRowRenderer.plan($0, width: $1) }
        let derived = try XCTUnwrap(ChatRows.derive(input(messages(5), epoch: 0, grows: 0), applied: ChatRowsApplied(), planner: planner))
        let update = try XCTUnwrap(derived.output.list)
        let list = ChatListView(frame: CGRect(x: 0, y: 0, width: width, height: 600))
        list.layoutIfNeeded()
        list.apply(update, animated: false)
        let slot = update.model.olderEndFrame
        XCTAssertEqual(slot.height, ChatOlderEndLayout.height)
        XCTAssertEqual(list.olderEnd.bounds.size, slot.size)
        XCTAssertEqual(list.olderEnd.center, CGPoint(x: slot.midX, y: slot.midY))
        XCTAssertTrue(list.olderEnd.superview === list.collectionView)

        var actions = 0
        list.olderEnd.onAction = { actions += 1 }
        list.olderEnd.status = .error
        let retry = try XCTUnwrap(list.olderEnd.subviews.compactMap { $0 as? RoundButton }.first)
        XCTAssertFalse(retry.isHidden)
        retry.onTap?()
        XCTAssertEqual(actions, 1)
    }

    private func state() -> ChatEmptyState {
        ChatEmptyState(metadata: .object(["host": .string("mac"), "path": .string("/p")]), createdAt: 0, now: 60_000)
    }

    /// Shows `content` once its plan, made off the main thread, is in.
    private func show(_ content: ChatPlaceholderView.Content, in placeholder: ChatPlaceholderView) async {
        placeholder.show(content)
        placeholder.layoutIfNeeded()
        await placeholder.measure.measured()
        placeholder.layoutIfNeeded()
    }

    func testEmptyMessagesShowsWhatItsPagingSays() async {
        let placeholder = ChatPlaceholderView(frame: CGRect(x: 0, y: 0, width: 393, height: 600))
        var actions = 0
        placeholder.onAction = { actions += 1 }

        await show(.empty(state(), .noMessages), in: placeholder)
        XCTAssertTrue(placeholder.button.isHidden)
        XCTAssertFalse(placeholder.pagingSpinner.isAnimating)

        await show(.empty(state(), .loading), in: placeholder)
        XCTAssertTrue(placeholder.button.isHidden)
        XCTAssertTrue(placeholder.pagingSpinner.isAnimating)
        XCTAssertGreaterThan(placeholder.pagingSpinner.frame.height, 0)

        await show(.empty(state(), .error), in: placeholder)
        XCTAssertFalse(placeholder.button.isHidden)
        XCTAssertEqual(placeholder.button.title, Strings.Chat.retry)
        XCTAssertFalse(placeholder.pagingSpinner.isAnimating)
        XCTAssertGreaterThan(placeholder.button.frame.height, 0)
        placeholder.button.onTap?()
        XCTAssertEqual(actions, 1)

        await show(.empty(state(), .loadMore), in: placeholder)
        XCTAssertEqual(placeholder.button.title, Strings.Chat.loadMore)
        XCTAssertFalse(placeholder.button.isHidden)
    }

    func testAFailedFirstLoadOffersRetryInTheSpinnersPlace() async {
        let placeholder = ChatPlaceholderView(frame: CGRect(x: 0, y: 0, width: 393, height: 600))
        var actions = 0
        placeholder.onAction = { actions += 1 }
        await show(.loadFailed, in: placeholder)
        XCTAssertFalse(placeholder.button.isHidden)
        XCTAssertEqual(placeholder.button.title, Strings.Chat.retry)
        XCTAssertEqual(placeholder.button.center.y, 300, accuracy: 1)
        placeholder.button.onTap?()
        XCTAssertEqual(actions, 1)

        await show(.loading, in: placeholder)
        XCTAssertTrue(placeholder.button.isHidden)
    }

    /// The plan is measured off the main thread for the width, and laid
    /// out on main for the height: a new height (the keyboard moving the
    /// dock) recentres the column and measures nothing.
    func testANewHeightMeasuresNothing() async {
        let placeholder = ChatPlaceholderView(frame: CGRect(x: 0, y: 0, width: 393, height: 600))
        await show(.empty(state(), .noMessages), in: placeholder)
        let requested = placeholder.measure.requested
        let tall = placeholder.subviews.compactMap { $0 as? ChatTextView }.filter { !$0.isHidden }.map(\.frame)
        XCTAssertFalse(tall.isEmpty)
        placeholder.frame.size.height = 400
        placeholder.layoutIfNeeded()
        XCTAssertEqual(placeholder.measure.requested, requested)
        XCTAssertTrue(placeholder.measure.isCurrent)
        let short = placeholder.subviews.compactMap { $0 as? ChatTextView }.filter { !$0.isHidden }.map(\.frame)
        XCTAssertEqual(short.map(\.size), tall.map(\.size))
        for (moved, was) in zip(short, tall) {
            XCTAssertEqual(moved.minY, was.minY - 100, accuracy: 0.5)
        }
        placeholder.frame.size.width = 320
        placeholder.layoutIfNeeded()
        XCTAssertNotEqual(placeholder.measure.requested, requested)
    }
}
#endif

#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// How the list moves while it follows the newest message
/// (`ChatFollowMotion`), on UICollectionView: a streamed line and a sent
/// message move what is on screen as one block on the ease-out, and a
/// row arriving at the newest end rises with the rows it pushes instead of
/// fading in where it lands.
@MainActor
final class HostedChatFollowMotionTests: XCTestCase {
    private let renderServices = RenderServices.isolated()
    private let planner = RowPlanner<ChatRowInput, ChatRowPlan> { ChatRowRenderer.plan($0, width: $1) }

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func messages(_ count: Int) -> [ChatMessage] {
        (0..<count).map { index in
            let text = "message \(index): " + String(repeating: "words in a line ", count: 1 + index % 7)
            return index.isMultiple(of: 2)
                ? .userText(UserTextMessage(id: "m\(index)", createdAt: Int64(index), text: text))
                : .agentText(AgentTextMessage(id: "m\(index)", createdAt: Int64(index), text: text))
        }
    }

    private func input(_ messages: [ChatMessage], width: CGFloat) -> ChatRowsInput {
        var view = ChatRowsView()
        view.width = width
        return ChatRowsInput(
            snapshot: ChatSnapshot(sessionId: "s", messages: messages, isLoaded: true, hasMoreOlder: false, olderBoundary: nil, windowEpoch: 0),
            session: ChatSessionState(record: nil, settings: AccountSettings()),
            view: view,
            render: renderServices
        )
    }

    private final class Chat {
        var list: ChatListView
        var messages: [ChatMessage]
        var applied: ChatRowsApplied
        init(list: ChatListView, messages: [ChatMessage], applied: ChatRowsApplied) {
            self.list = list; self.messages = messages; self.applied = applied
        }
    }

    /// 40 messages under a 100-tall header and over a 70-tall composer, at
    /// the newest message.
    private func chat(_ renderer: ChatListRenderer) async throws -> Chat {
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        let root = try XCTUnwrap(window.rootViewController?.view)
        window.layoutIfNeeded()
        let list = ChatListView(frame: root.bounds, renderer: renderer)
        root.addSubview(list)
        list.layoutIfNeeded()
        list.setEdgeInsets(newest: 70, oldest: 100)
        let all = messages(40)
        let derived = try XCTUnwrap(ChatRows.derive(input(all, width: list.bounds.width), applied: ChatRowsApplied(), planner: planner))
        list.apply(try XCTUnwrap(derived.output.list), animated: false)
        list.layoutIfNeeded()
        let drawn = try await until { list.isDisplayReady }
        XCTAssertTrue(drawn, "the rows never drew")
        XCTAssertEqual(list.visibleMinY, 0, accuracy: 0.5, "at the newest message")
        return Chat(list: list, messages: all, applied: derived.state)
    }

    /// Applies `messages`, animated, as the chat does once it has rows.
    @discardableResult
    private func apply(_ messages: [ChatMessage], to chat: Chat) throws -> ChatListUpdate {
        let derived = try XCTUnwrap(ChatRows.derive(input(messages, width: chat.list.bounds.width), applied: chat.applied, planner: planner))
        let update = try XCTUnwrap(derived.output.list)
        chat.applied = derived.state
        chat.messages = messages
        chat.list.apply(update, animated: true)
        return update
    }

    private func growingNewest(_ chat: Chat, by text: String) -> [ChatMessage] {
        var messages = chat.messages
        guard case .agentText(var last) = messages.removeLast() else { XCTFail("expected an agent reply"); return messages }
        last.text += text
        messages.append(.agentText(last))
        return messages
    }

    private func follows(_ list: ChatListView) -> [CABasicAnimation] {
        let layer = list.collectionView.layer
        return (layer.animationKeys() ?? []).filter { $0.hasPrefix("chat.follow.") }.compactMap { layer.animation(forKey: $0) as? CABasicAnimation }
    }

    private func shift(_ slide: CABasicAnimation) -> CGFloat {
        CGFloat((slide.fromValue as? NSNumber)?.doubleValue ?? .nan)
    }

    private func cell(_ list: ChatListView, id: String) -> ChatRowCell? {
        list.collectionView.visibleCells.compactMap { $0 as? ChatRowCell }.first { $0.plan?.id == id }
    }

    private func assertEaseOut(_ function: CAMediaTimingFunction?, file: StaticString = #filePath, line: UInt = #line) {
        var first: [Float] = [0, 0], second: [Float] = [0, 0]
        function?.getControlPoint(at: 1, values: &first)
        function?.getControlPoint(at: 2, values: &second)
        let points = ChatFollowMotion.controlPoints
        XCTAssertEqual(first + second, [points.x1, points.y1, points.x2, points.y2].map(Float.init), file: file, line: line)
    }

    // MARK: UICollectionView

    /// A reply grows a line at a time: the content slides back by each
    /// line as a whole, the slides stack, and no cell animates on its own,
    /// so the reply can't tear away from the row above it.
    func testAStreamedLineSlidesTheCollectionAsOneBlock() async throws {
        let chat = try await chat(.collectionView)
        let list = chat.list
        let before = list.contentHeight
        try apply(growingNewest(chat, by: " and one more line of the streamed answer"), to: chat)
        let grown = list.contentHeight - before
        XCTAssertGreaterThan(grown, 0, "the reply grew")
        XCTAssertEqual(follows(list).count, 1)
        let slide = try XCTUnwrap(follows(list).first)
        XCTAssertEqual(shift(slide), grown, accuracy: 0.01)
        XCTAssertTrue(slide.isAdditive)
        XCTAssertEqual(slide.duration, ChatFollowMotion.duration)
        assertEaseOut(slide.timingFunction)
        for cell in list.collectionView.visibleCells {
            XCTAssertNil(cell.layer.animationKeys(), "a cell animated on its own")
        }
        XCTAssertEqual(list.visibleMinY, 0, accuracy: 0.5)

        let more = list.contentHeight
        try apply(growingNewest(chat, by: "\n\nAnother paragraph streams in before the last slide ends."), to: chat)
        XCTAssertEqual(follows(list).count, 2, "a second line adds its own slide to the first")
        XCTAssertEqual(shift(try XCTUnwrap(follows(list).last)), list.contentHeight - more, accuracy: 0.01)
    }

    /// A short sent message rises with the rows it pushes, drawn: it is
    /// part of the slide, not faded in where it lands.
    func testASentMessageRisesWithTheCollection() async throws {
        let chat = try await chat(.collectionView)
        let list = chat.list
        let before = list.contentHeight
        let sent = ChatMessage.userText(UserTextMessage(id: "sent", createdAt: 1000, text: "Walk me through the anchor"))
        let update = try apply(chat.messages + [sent], to: chat)
        let height = list.contentHeight - before
        XCTAssertLessThanOrEqual(height, list.contentInsets.bottom, "short enough to slide")
        XCTAssertEqual(follows(list).count, 1)
        XCTAssertEqual(shift(try XCTUnwrap(follows(list).first)), height, accuracy: 0.01)
        // Without UIKit's animation the sent cell is made on the next pass.
        list.collectionView.layoutIfNeeded()
        let arrived = try XCTUnwrap(cell(list, id: try XCTUnwrap(update.ids.first)))
        XCTAssertNil(arrived.layer.animationKeys(), "the sent row isn't faded in")
        XCTAssertEqual(arrived.alpha, 1)
    }

    /// A message taller than the header takes UIKit's animation, where
    /// the rows coming in past the far edge are laid out, on the same
    /// timing, and rises from the newest edge.
    func testATallArrivalRisesOnUIKitsAnimation() async throws {
        let chat = try await chat(.collectionView)
        let list = chat.list
        let long = String(repeating: "A long reply arrives all at once from a catch-up. ", count: 30)
        let reply = ChatMessage.agentText(AgentTextMessage(id: "reply", createdAt: 1000, text: long))
        let update = try apply(chat.messages + [reply], to: chat)
        XCTAssertEqual(follows(list).count, 0, "too tall to slide")
        let arrived = try XCTUnwrap(cell(list, id: try XCTUnwrap(update.ids.first)))
        let rise = try XCTUnwrap((arrived.layer.animationKeys() ?? []).compactMap { arrived.layer.animation(forKey: $0) as? CABasicAnimation }
            .first { $0.keyPath == "position" }, "the reply rises")
        XCTAssertEqual(rise.duration, ChatFollowMotion.duration, accuracy: 0.001)
        assertEaseOut(rise.timingFunction)
        XCTAssertFalse((arrived.layer.animationKeys() ?? []).contains { arrived.layer.animation(forKey: $0)?.isKind(of: CAPropertyAnimation.self) == true
            && (arrived.layer.animation(forKey: $0) as? CAPropertyAnimation)?.keyPath == "opacity" }, "rises drawn, not faded in")
    }

    /// Away from the newest message nothing slides: the row the reader
    /// looks at keeps its place, so the offset takes the growth below it.
    func testAReaderAwayFromTheNewestIsNotSlid() async throws {
        let chat = try await chat(.collectionView)
        let list = chat.list
        list.setVisibleMinY(list.maximumVisibleMinY / 2)
        list.layoutIfNeeded()
        let place = list.visibleMinY
        let before = list.contentHeight
        try apply(growingNewest(chat, by: " and one more line"), to: chat)
        XCTAssertEqual(follows(list).count, 0)
        XCTAssertEqual(list.visibleMinY - place, list.contentHeight - before, accuracy: 0.5)
        for cell in list.collectionView.visibleCells {
            XCTAssertNil(cell.layer.animationKeys(), "a row moved on screen")
        }
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        return condition()
    }
}
#endif

#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import UltraView
import XCTest

private actor DelayedChatMeasurer: NodeRowMeasuring {
    private var heldHeight: CGFloat?
    private var continuation: CheckedContinuation<Void, Never>?
    var isWaiting: Bool { continuation != nil }
    func hold(height: CGFloat) { heldHeight = height }
    func release() { continuation?.resume(); continuation = nil }
    func measure(_ root: UltraNode, width: CGFloat, environment: RenderEnvironment) async -> CGSize {
        if root.style.height == .points(heldHeight ?? -1) {
            heldHeight = nil
            await withCheckedContinuation { continuation = $0 }
        }
        return await NodeRowMeasurer().measure(root, width: width, environment: environment)
    }
}

@MainActor
final class HostedChatUltraPreparationTests: XCTestCase {
    private func until(_ condition: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return await condition()
    }

    func testFirstPreparedRowsSurviveAQuestionDockInsetChange() async throws {
        let scene = try await hostedActiveScene()
        let oldWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        addTeardownBlock { @MainActor in window.isHidden = true; oldWindow?.makeKey() }
        let root = try XCTUnwrap(window.rootViewController?.view)
        window.layoutIfNeeded()
        let gate = DelayedChatMeasurer()
        let adapter = ChatUltraListAdapter(olderEnd: ChatOlderEndView(), measurer: gate)
        defer { adapter.deactivate() }
        let list = adapter.list
        list.frame = root.bounds
        root.addSubview(list)
        list.layoutIfNeeded()
        adapter.setViewport(size: root.bounds.size, insets: .init(top: 96, left: 0, bottom: 113, right: 0))
        let width = root.bounds.width
        let plans = (0..<5).map { index in
            let height: CGFloat = index == 0 ? 160 : 100
            return ChatRowPlan(id: "question\(index)", size: .init(width: width, height: height), items: [
                .box(ChatBox(frame: .init(x: 0, y: 0, width: width, height: height), fill: Palette.surface))
            ])
        }
        await gate.hold(height: 160)
        adapter.apply(ChatListUpdate(ids: plans.map(\.id), plans: plans,
                                    model: ChatListLayout(width: width, heights: plans.map { $0.size.height },
                                                          olderEndHeight: ChatOlderEndLayout.height),
                                    footer: nil, changeset: .init()), animated: false)
        let waiting = await until { await gate.isWaiting }
        XCTAssertTrue(waiting)
        XCTAssertTrue(list.items.isEmpty, "the initial snapshot is still preparing")

        // The open-question banner can arrive after the initial rows, while
        // their first asynchronous preparation is still in progress.
        adapter.setViewport(size: root.bounds.size, insets: .init(top: 246, left: 0, bottom: 113, right: 0))
        await gate.release()

        let committed = await until { adapter.isDisplayReady }
        XCTAssertTrue(committed, "the dock change must not strand the first prepared snapshot")
        XCTAssertEqual(list.items.count, 6)
        XCTAssertFalse(list.loadedItemViews.isEmpty)
        XCTAssertEqual(list.viewportInsets.top, 246)
        XCTAssertEqual(list.viewportInsets.bottom, 113)
    }

    func testPreparedTokenUpdateCannotHaltADragThatStartedWhileItWaited() async throws {
        let scene = try await hostedActiveScene()
        let oldWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        addTeardownBlock { @MainActor in window.isHidden = true; oldWindow?.makeKey() }
        let root = try XCTUnwrap(window.rootViewController?.view)
        window.layoutIfNeeded()
        let gate = DelayedChatMeasurer()
        let adapter = ChatUltraListAdapter(olderEnd: ChatOlderEndView(), measurer: gate)
        let list = adapter.list
        list.frame = root.bounds
        root.addSubview(list)
        list.layoutIfNeeded()
        adapter.setViewport(size: root.bounds.size, insets: .init(top: 100, left: 0, bottom: 60, right: 0))
        let width = root.bounds.width
        func plan(_ id: String, height: CGFloat) -> ChatRowPlan {
            ChatRowPlan(id: id, size: .init(width: width, height: height), items: [.box(ChatBox(frame: .init(x: 0, y: 0, width: width, height: height), fill: Palette.surface))])
        }
        var plans = (0..<40).map { plan("row\($0)", height: 100) }
        let footer = plan("footer", height: 10)
        func update() -> ChatListUpdate {
            ChatListUpdate(ids: plans.map(\.id), plans: plans, model: ChatListLayout(width: width, heights: plans.map { $0.size.height }, newerEndHeight: 10, olderEndHeight: ChatOlderEndLayout.height), footer: footer, changeset: .init(reconfigures: [0]))
        }
        adapter.apply(update(), animated: false)
        let first = await until { adapter.isDisplayReady }
        XCTAssertTrue(first)
        await gate.hold(height: 160)
        plans[0] = plan("row0", height: 160)
        adapter.apply(update(), animated: true)
        let waiting = await until { await gate.isWaiting }
        XCTAssertTrue(waiting)
        XCTAssertFalse(adapter.isDisplayReady, "the changed row is still awaiting preparation")
        let time = CACurrentMediaTime()
        list.receiveScrollInput(.init(time: time, phase: .began, translation: .init(y: -180)))
        XCTAssertTrue(list.isDragging)
        let before = try XCTUnwrap(list.settledFrame(at: 2))
        await gate.release()
        let committed = await until { adapter.isDisplayReady }
        XCTAssertTrue(committed)
        XCTAssertTrue(list.isDragging, "a prepared token cannot halt the newer drag")
        let after = try XCTUnwrap(list.settledFrame(at: 2))
        XCTAssertEqual(after.minY, before.minY, accuracy: 0.5, "the committed window keeps the row under the finger")
        list.receiveScrollInput(.init(time: time + 0.5, phase: .cancelled))
        adapter.deactivate()
    }

    func testToolPinSurvivesATokenUpdateSupersedingItsPreparation() async throws {
        try await toolPin(insetDelta: 0)
    }

    func testPendingToolPinFollowsTheKeyboardInset() async throws {
        try await toolPin(insetDelta: 100)
    }

    private func toolPin(insetDelta: CGFloat) async throws {
        let scene = try await hostedActiveScene()
        let oldWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        addTeardownBlock { @MainActor in window.isHidden = true; oldWindow?.makeKey() }
        let root = try XCTUnwrap(window.rootViewController?.view)
        window.layoutIfNeeded()
        let gate = DelayedChatMeasurer()
        let adapter = ChatUltraListAdapter(olderEnd: ChatOlderEndView(), measurer: gate)
        let list = adapter.list
        list.frame = root.bounds
        root.addSubview(list)
        list.layoutIfNeeded()
        adapter.setViewport(size: root.bounds.size, insets: .init(top: 100, left: 0, bottom: 60, right: 0))
        let width = root.bounds.width
        func plan(_ id: String, height: CGFloat) -> ChatRowPlan {
            ChatRowPlan(id: id, size: .init(width: width, height: height), items: [.box(ChatBox(frame: .init(x: 0, y: 0, width: width, height: height), fill: Palette.surface))])
        }
        var plans = (0..<40).map { plan("row\($0)", height: 100) }
        let footer = plan("footer", height: 10)
        func update(pin: String? = nil) -> ChatListUpdate {
            ChatListUpdate(ids: plans.map(\.id), plans: plans, model: ChatListLayout(width: width, heights: plans.map { $0.size.height }, newerEndHeight: 10, olderEndHeight: ChatOlderEndLayout.height), footer: footer, changeset: .init(reconfigures: [0, 5]), pinning: pin)
        }
        adapter.apply(update(), animated: false)
        let first = await until { adapter.isDisplayReady }
        XCTAssertTrue(first)
        adapter.setVisibleMinY(500)
        let positioned = await until { abs(adapter.visibleMinY - 500) < 0.5 && adapter.isDisplayReady }
        XCTAssertTrue(positioned)
        let before = try XCTUnwrap(list.settledFrame(at: 6))
        await gate.hold(height: 260)
        plans[5] = plan("row5", height: 260)
        adapter.apply(update(pin: "row5"), animated: false)
        let waiting = await until { await gate.isWaiting }
        XCTAssertTrue(waiting)
        XCTAssertFalse(adapter.isDisplayReady)
        plans[0] = plan("row0", height: 120)
        adapter.apply(update(), animated: false)
        if insetDelta != 0 {
            adapter.setViewport(size: root.bounds.size, insets: .init(top: 100 + insetDelta, left: 0, bottom: 60, right: 0))
        }
        await gate.release()
        let committed = await until { adapter.isDisplayReady }
        XCTAssertTrue(committed)
        let after = try XCTUnwrap(list.settledFrame(at: 6))
        XCTAssertEqual(after.maxY, before.maxY + insetDelta, accuracy: 0.5, "coalescing a later token retains the tool pin relative to the dock")
        adapter.deactivate()
    }
}
#endif
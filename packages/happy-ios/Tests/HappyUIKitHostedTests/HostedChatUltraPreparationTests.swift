#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import UltraView
import XCTest

private actor DelayedChatMeasurer: NodeRowMeasuring {
    private var holdsNext = false
    private var continuation: CheckedContinuation<Void, Never>?
    var isWaiting: Bool { continuation != nil }
    func holdNext() { holdsNext = true }
    func release() { continuation?.resume(); continuation = nil }
    func measure(_ root: UltraNode, width: CGFloat, environment: RenderEnvironment) async -> CGSize {
        if holdsNext {
            holdsNext = false
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
        await gate.holdNext()
        plans[0] = plan("row0", height: 160)
        adapter.apply(update(), animated: true)
        let waiting = await until { await gate.isWaiting }
        XCTAssertTrue(waiting)
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
}
#endif
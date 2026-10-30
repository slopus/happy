#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

private struct NoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

private struct Unreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// What home's list does to the rows a reader is looking at: nothing may
/// move them on screen except that reader's own scroll. This measures
/// where a row sits **in the window**, which is what an eye sees, rather
/// than where it sits in the content: a row inserted above moves the
/// content under it, and keeping the reader's place means moving the list
/// by exactly as much, so the content moves and the window position does
/// not.
///
/// Two ways of reading it, because they catch different things:
///   - at rest, around one update: the row's window position before and
///     after must be the same. Any difference is a jump, in points.
///   - under a scroll: the row's window position is read on every display
///     frame; a smooth scroll moves it by about the same amount each
///     frame, so an update that moves it shows as a frame whose step is
///     unlike its neighbours'. That difference is the jump.
///
/// This is the measurement for "it jumps a little when I am scrolling".
/// It is not a finger: `setContentOffset(animated:)` drives the scroll, so
/// what it catches is everything home does to its own list while the list
/// moves. The fixture is a fresh account with an unreachable computer and
/// rows applied by hand, so nothing arrives but what each case sends.
@MainActor
final class HostedHomeScrollTraceTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    /// One display frame: when, where the list is, and where the anchor row
    /// sits in the window.
    private struct Sample {
        var time: CFTimeInterval
        var offset: CGFloat
        var insetTop: CGFloat
        var contentHeight: CGFloat
        /// In the content.
        var anchorContentY: CGFloat
        /// In the window: what the reader sees.
        var anchorWindowY: CGFloat
    }

    /// Enough rows to scroll, in the shapes home draws. The sections sit
    /// at fixed places, so a case that adds conversations at the end moves
    /// nothing above them; only the cases that mean to do so.
    private static func rows(
        count: Int,
        working: Set<Int> = [],
        labels: [Int: String] = [:],
        extraAtTop: Bool = false
    ) -> [Row] {
        var rows: [Row] = [
            Row(id: "section:bots", nodeId: "bots", kind: .section, label: "Bots", collapsed: false),
        ]
        func space(_ id: String, _ index: Int) -> Row {
            Row(
                id: id,
                nodeId: id,
                kind: .space,
                label: labels[index] ?? "Conversation \(index)",
                mark: .glyph(index.isMultiple(of: 2) ? "agents" : "tasks"),
                status: working.contains(index) ? .working : .none,
                agentId: "agent-\(index)",
                spaceId: "space-\(index)"
            )
        }
        if extraAtTop { rows.append(space("space:arrived", -1)) }
        for index in 0..<20 { rows.append(space("space:\(index)", index)) }
        rows.append(Row(id: "section:tasks", nodeId: "tasks", kind: .section, label: "Tasks", collapsed: false))
        for index in 20..<count { rows.append(space("space:\(index)", index)) }
        return rows
    }

    private func home() async throws -> (AccountController, UIWindow, SidebarView) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"scroll-trace","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = AgentHomeViewController(context: context, id: computer.id)
        let navigation = UINavigationController(rootViewController: home)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        let sidebar = try XCTUnwrap(Self.subview(SidebarView.self, in: home.view))
        return (controller, window, sidebar)
    }

    private static func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        for child in view.subviews {
            if let match = child as? T { return match }
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }

    /// A list scrolled to `offset`, showing `rows`, settled.
    private func list(_ rows: [Row], at offset: CGFloat, _ sidebar: SidebarView) {
        sidebar.apply(rows)
        sidebar.layoutIfNeeded()
        sidebar.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
        sidebar.layoutIfNeeded()
    }

    /// Where `id` sits in the window now.
    private func windowY(_ id: String, _ sidebar: SidebarView, _ window: UIWindow) -> CGFloat? {
        sidebar.view(for: id).map { sidebar.convert($0.frame.origin, to: window).y }
    }

    /// How far `anchor` moved on screen across `update`, with nobody
    /// touching the list: zero, or the jump in points.
    private func jumpAtRest(
        _ name: String,
        anchor: String,
        _ sidebar: SidebarView,
        _ window: UIWindow,
        update: () -> Void
    ) throws -> CGFloat {
        let before = try XCTUnwrap(windowY(anchor, sidebar, window), "\(name): no anchor before")
        let offsetBefore = sidebar.contentOffset.y
        update()
        sidebar.layoutIfNeeded()
        let after = try XCTUnwrap(windowY(anchor, sidebar, window), "\(name): no anchor after")
        print("JUMP \(name): the row moved \(after - before)pt on screen; the list moved \(sidebar.contentOffset.y - offsetBefore)pt")
        return after - before
    }

    /// Records every display frame for `seconds`, running `during` at the
    /// times it names (seconds from the start).
    private func trace(
        _ sidebar: SidebarView,
        window: UIWindow,
        anchor: String,
        seconds: Double,
        during: [(at: Double, run: () -> Void)] = []
    ) async throws -> [Sample] {
        var samples: [Sample] = []
        var pending = during
        let start = CACurrentMediaTime()
        let recorder = TickRecorder { _ in
            MainActor.assumeIsolated {
                let now = CACurrentMediaTime() - start
                while let next = pending.first, next.at <= now {
                    pending.removeFirst()
                    next.run()
                    sidebar.layoutIfNeeded()
                }
                guard let row = sidebar.view(for: anchor) else { return }
                samples.append(Sample(
                    time: now,
                    offset: sidebar.contentOffset.y,
                    insetTop: sidebar.contentInset.top,
                    contentHeight: sidebar.contentSize.height,
                    anchorContentY: row.frame.minY,
                    anchorWindowY: sidebar.convert(row.frame.origin, to: window).y
                ))
            }
        }
        try await Task.sleep(for: .milliseconds(Int(seconds * 1000)))
        recorder.stop()
        return samples
    }

    /// The worst frame whose step on screen is unlike the steps on either
    /// side of it. A scroll, even one easing in and out, changes its step
    /// by a little from frame to frame, so each step is close to the
    /// middle of its neighbours'; a row moved by something other than the
    /// scroll breaks that in one frame. Returns the points it breaks it by.
    private func worstStep(_ name: String, _ samples: [Sample]) -> CGFloat {
        let steps = zip(samples, samples.dropFirst()).map { (time: $1.time, step: $1.anchorWindowY - $0.anchorWindowY, sample: $1) }
        guard steps.count > 4 else { return 0 }
        var odd: [(time: CFTimeInterval, by: CGFloat, sample: Sample)] = []
        for index in 1..<(steps.count - 1) {
            let expected = (steps[index - 1].step + steps[index + 1].step) / 2
            odd.append((steps[index].time, steps[index].step - expected, steps[index].sample))
        }
        let worst = odd.max { abs($0.by) < abs($1.by) }
        print("""
        SCROLL-TRACE \(name): \(samples.count) frames, the list moved \
        \((samples.last?.offset ?? 0) - (samples.first?.offset ?? 0))pt, \
        inset top \(samples.first?.insetTop ?? 0) → \(samples.last?.insetTop ?? 0), \
        content \(samples.first?.contentHeight ?? 0) → \(samples.last?.contentHeight ?? 0), \
        the biggest step \(steps.map { abs($0.step) }.max() ?? 0)pt, \
        worst step out of line by \(worst?.by ?? 0)pt at \(worst?.time ?? 0)s, \
        out by over 2pt on \(odd.filter { abs($0.by) > 2 }.count) frames
        """)
        for frame in odd where abs(frame.by) > 2 {
            print("SCROLL-TRACE \(name) jump \(frame.by)pt at \(frame.time)s (content \(frame.sample.anchorContentY), offset \(frame.sample.offset))")
        }
        return worst.map { abs($0.by) } ?? 0
    }

    // MARK: At rest

    /// Each kind of update the computer sends, with the list still and the
    /// reader part way down it: none may move what is on screen.
    func testUpdatesAtRestMoveNothingOnScreen() async throws {
        let (controller, window, sidebar) = try await home()
        let anchor = "space:30"
        let base = Self.rows(count: 60)

        // A conversation starts and stops working, above what is on screen.
        list(base, at: 1000, sidebar)
        var jump = try jumpAtRest("a row starts working above", anchor: anchor, sidebar, window) {
            sidebar.apply(Self.rows(count: 60, working: [3, 4]))
        }
        XCTAssertEqual(jump, 0, accuracy: 0.01, "a status above moved the rows on screen")

        // A rename above and below.
        list(base, at: 1000, sidebar)
        jump = try jumpAtRest("a rename above", anchor: anchor, sidebar, window) {
            sidebar.apply(Self.rows(count: 60, labels: [2: "Renamed while reading", 50: "Also renamed"]))
        }
        XCTAssertEqual(jump, 0, accuracy: 0.01, "a rename moved the rows on screen")

        // Conversations arrive at the end, below what is on screen.
        list(base, at: 1000, sidebar)
        jump = try jumpAtRest("rows added below", anchor: anchor, sidebar, window) {
            sidebar.apply(Self.rows(count: 72))
        }
        XCTAssertEqual(jump, 0, accuracy: 0.01, "rows added below moved the rows on screen")

        // One arrives above what is on screen: the reader's place is kept,
        // so the list moves by the row's height and the screen does not.
        list(base, at: 1000, sidebar)
        let offsetBefore = sidebar.contentOffset.y
        jump = try jumpAtRest("a row arriving above", anchor: anchor, sidebar, window) {
            sidebar.apply(Self.rows(count: 60, extraAtTop: true))
        }
        XCTAssertEqual(jump, 0, accuracy: 0.01, "a row arriving above moved the rows on screen")
        XCTAssertGreaterThan(sidebar.contentOffset.y - offsetBefore, 1, "the list must move by what arrived above it")

        // One goes away above what is on screen: likewise, the other way.
        list(Self.rows(count: 60, extraAtTop: true), at: 1000, sidebar)
        jump = try jumpAtRest("a row leaving above", anchor: anchor, sidebar, window) {
            sidebar.apply(base)
        }
        XCTAssertEqual(jump, 0, accuracy: 0.01, "a row leaving above moved the rows on screen")
        withExtendedLifetime(controller) {}
    }

    /// At the very top, a row arriving above is the point: it shows,
    /// and the list stays at its top rather than being pushed down.
    func testAtTheTopARowArrivingShows() async throws {
        let (controller, window, sidebar) = try await home()
        list(Self.rows(count: 60), at: -sidebar.contentInset.top, sidebar)
        let top = sidebar.contentOffset.y
        let below = try XCTUnwrap(windowY("space:0", sidebar, window))
        let heading = try jumpAtRest("a row arriving at the top", anchor: "section:bots", sidebar, window) {
            sidebar.apply(Self.rows(count: 60, extraAtTop: true))
        }
        XCTAssertEqual(sidebar.contentOffset.y, top, accuracy: 0.01, "the list left its top")
        XCTAssertEqual(heading, 0, accuracy: 0.01, "the heading above it stays")
        XCTAssertNotNil(windowY("space:arrived", sidebar, window), "the row that arrived isn't there")
        let moved = try XCTUnwrap(windowY("space:0", sidebar, window)) - below
        XCTAssertGreaterThan(moved, 1, "the rows under it must make room")
        withExtendedLifetime(controller) {}
    }

    // MARK: Under a scroll

    /// The computer's updates while the list moves: a status, a rename,
    /// rows at the end, and one arriving above. The same scroll is driven
    /// twice, once with the updates and once without, and the two are
    /// compared: an eased scroll bends a little at its ends, which is the
    /// control's own worst step, so what counts is whether the updates
    /// make it worse. No absolute number is asserted, because frame times
    /// under a loaded host are not repeatable.
    ///
    /// This is a programmatic scroll. A finger's drag and the glide after
    /// it are not covered here and are still to be seen.
    func testUpdatesWhileScrollingAreNoWorseThanTheScrollAlone() async throws {
        let (controller, window, sidebar) = try await home()
        func scroll(_ updates: [(at: Double, run: () -> Void)]) async throws -> [Sample] {
            list(Self.rows(count: 60), at: 400, sidebar)
            return try await trace(sidebar, window: window, anchor: "space:30", seconds: 1.4, during: [
                (at: 0.1, run: { sidebar.setContentOffset(CGPoint(x: 0, y: 1200), animated: true) }),
            ] + updates)
        }
        let alone = try await scroll([])
        XCTAssertGreaterThan(alone.count, 20, "no frames recorded")
        let control = worstStep("scroll only", alone)

        let updated = try await scroll([
            (at: 0.2, run: { sidebar.apply(Self.rows(count: 60, working: [3, 4])) }),
            (at: 0.35, run: { sidebar.apply(Self.rows(count: 60, working: [3, 4], labels: [2: "Renamed while scrolling"])) }),
            (at: 0.5, run: { sidebar.apply(Self.rows(count: 72, working: [3, 4], labels: [2: "Renamed while scrolling"])) }),
            (at: 0.65, run: { sidebar.apply(Self.rows(count: 72, labels: [2: "Renamed while scrolling"], extraAtTop: true)) }),
        ])
        XCTAssertGreaterThan(updated.count, 20, "no frames recorded")
        let worst = worstStep("updates while scrolling", updated)
        print("SCROLL-TRACE the updates cost \(worst - control)pt over the scroll alone")
        XCTAssertLessThan(worst, control + 2, "an update moved the rows under the scroll")
        withExtendedLifetime(controller) {}
    }

    // MARK: A fold the finger makes

    /// Bots and its twenty, Tasks and its ten, open or folded, then a Later
    /// section with thirty more: folding Tasks leaves the list long enough
    /// that it never has to scroll back to stay inside what it holds, which
    /// would move the rows for a reason that is not the fold's.
    private static func tasks(open: Bool) -> [Row] {
        let all = rows(count: 60)
        let tasks = all.firstIndex { $0.id == "section:tasks" }!
        var rows = Array(all[...tasks])
        rows[tasks].collapsed = !open
        if open { rows += all[(tasks + 1)..<(tasks + 11)] }
        rows.append(Row(id: "section:later", nodeId: "later", kind: .section, label: "Later", collapsed: false))
        rows += all[(tasks + 11)...]
        return rows
    }

    /// Every row view in the list for `id`, the ones fading out included.
    private func drawn(_ id: String, _ sidebar: SidebarView) -> [RowView] {
        sidebar.subviews.compactMap { $0 as? RowView }.filter { $0.row?.id == id }
    }

    /// A finger on `id`'s heading. The store is left out: what the fold
    /// would bring is applied by hand, so the case controls it exactly.
    private func tapFold(_ id: String, _ sidebar: SidebarView) throws {
        let view = try XCTUnwrap(sidebar.view(for: id), "no \(id)")
        sidebar.tap(view, at: CGPoint(x: view.frame.midX, y: view.frame.midY))
    }

    /// Reduce Motion as this host reads it. A run that sets it says so in
    /// `HAPPY_EXPECT_REDUCE_MOTION`, and the host must agree, so a run in
    /// either state proves which state it tested rather than assuming.
    private func reduceMotion() -> Bool {
        let on = UIAccessibility.isReduceMotionEnabled
        if let expected = ProcessInfo.processInfo.environment["HAPPY_EXPECT_REDUCE_MOTION"] {
            XCTAssertEqual(on, expected == "1", "the host's Reduce Motion is not what this run set")
        }
        print("FOLD-TRACE reduce motion \(on ? "on" : "off")")
        return on
    }

    /// Folding a section with a finger. With motion, what it took away fades
    /// where it stood and is gone after, and opening it again fades its rows
    /// in where they belong. Under Reduce Motion both happen at once: gone
    /// on the fold, whole on the opening, nothing animating.
    func testAFoldTheFingerMakesFadesItsRowsOrIsInstantUnderReduceMotion() async throws {
        let still = reduceMotion()
        let (controller, _, sidebar) = try await home()
        sidebar.onFold = { _ in }
        list(Self.tasks(open: true), at: -sidebar.contentInset.top, sidebar)
        let child = "space:22"
        let before = try XCTUnwrap(sidebar.view(for: child))

        try tapFold("section:tasks", sidebar)
        sidebar.apply(Self.tasks(open: false))
        sidebar.layoutIfNeeded()
        XCTAssertNil(sidebar.view(for: child), "a folded row is not one of the list's rows")
        if still {
            XCTAssertNil(before.superview, "under Reduce Motion a folded row is gone at once")
            XCTAssertTrue(drawn(child, sidebar).isEmpty)
        } else {
            XCTAssertTrue(drawn(child, sidebar).first === before, "it fades where it stood instead of vanishing")
            XCTAssertEqual(before.alpha, 0, "its fade is under way")
            XCTAssertFalse(before.isUserInteractionEnabled, "a row on its way out takes no touch")
            try await Task.sleep(for: .milliseconds(400))
            XCTAssertNil(before.superview, "once faded, it is gone")
        }

        try tapFold("section:tasks", sidebar)
        sidebar.apply(Self.tasks(open: true))
        sidebar.layoutIfNeeded()
        let back = try XCTUnwrap(sidebar.view(for: child))
        let heading = try XCTUnwrap(sidebar.view(for: "section:tasks"))
        XCTAssertGreaterThan(back.frame.minY, heading.frame.maxY - 0.5, "it is placed where it belongs, under its heading")
        XCTAssertEqual(back.alpha, 1)
        if still {
            XCTAssertEqual(back.layer.presentation()?.opacity ?? 1, 1, "under Reduce Motion it is shown whole at once")
            XCTAssertNil(back.layer.animationKeys(), "and nothing about it animates")
        } else {
            // A view that has never been drawn has no presentation layer to
            // read yet; the fade itself is on the layer at once.
            XCTAssertNotNil(back.layer.animation(forKey: "opacity"), "it fades in rather than being simply shown")
            try await Task.sleep(for: .milliseconds(400))
            XCTAssertEqual(back.layer.presentation()?.opacity ?? 1, 1)
        }
        withExtendedLifetime(controller) {}
    }

    /// Folded and opened again before anything settles, three times over.
    /// With motion the same views come back rather than new ones over
    /// half-faded old ones; either way exactly one view per row is left,
    /// whole, and taking touches.
    func testAFoldUndoneAtOnceLeavesOneWholeRow() async throws {
        let still = reduceMotion()
        let (controller, _, sidebar) = try await home()
        sidebar.onFold = { _ in }
        list(Self.tasks(open: true), at: -sidebar.contentInset.top, sidebar)
        let child = "space:22"
        let before = try XCTUnwrap(sidebar.view(for: child))

        for _ in 0..<3 {
            try tapFold("section:tasks", sidebar)
            sidebar.apply(Self.tasks(open: false))
            sidebar.layoutIfNeeded()
            try tapFold("section:tasks", sidebar)
            sidebar.apply(Self.tasks(open: true))
            sidebar.layoutIfNeeded()
        }
        let row = try XCTUnwrap(sidebar.view(for: child))
        if !still { XCTAssertTrue(row === before, "the row came back as itself") }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(drawn(child, sidebar).count, 1, "one view for the row, nothing half-faded left")
        XCTAssertTrue(row.superview === sidebar)
        XCTAssertEqual(row.alpha, 1)
        XCTAssertTrue(row.isUserInteractionEnabled)
        XCTAssertFalse(row.accessibilityElementsHidden)
        withExtendedLifetime(controller) {}
    }

    /// The other fold: a conversation's own chevron opening and closing its
    /// subtasks, which goes the same way through `onFold` as a heading does.
    /// Its subtasks fade out and in under it with motion, at once without.
    func testAConversationsChevronFoldsItsSubtasksTheSameWay() async throws {
        let still = reduceMotion()
        let (controller, _, sidebar) = try await home()
        var folded: [String] = []
        sidebar.onFold = { folded.append($0.id) }
        func rows(open: Bool) -> [Row] {
            var rows = Self.rows(count: 30)
            let at = rows.firstIndex { $0.id == "space:3" }!
            rows[at].collapsed = !open
            if open {
                let subtasks = (0..<3).map {
                    Row(id: "session:3-\($0)", nodeId: "session-3-\($0)", kind: .session, depth: 1, label: "Subtask \($0)", agentId: "agent-3")
                }
                rows.insert(contentsOf: subtasks, at: at + 1)
            }
            return rows
        }
        list(rows(open: true), at: -sidebar.contentInset.top, sidebar)
        let parent = try XCTUnwrap(sidebar.view(for: "space:3"))
        let chevron = try XCTUnwrap(parent.frames?.chevron, "a conversation with subtasks has its chevron")
        let subtask = try XCTUnwrap(sidebar.view(for: "session:3-1"))
        let after = try XCTUnwrap(sidebar.view(for: "space:4"))
        let afterTop = after.frame.minY

        // On the chevron, not the title: the title would open the chat.
        sidebar.tap(parent, at: CGPoint(x: chevron.midX, y: parent.frame.midY))
        XCTAssertEqual(folded, ["space:3"], "the chevron folds the conversation, and nothing else")
        sidebar.apply(rows(open: false))
        sidebar.layoutIfNeeded()
        XCTAssertNil(sidebar.view(for: "session:3-1"))
        XCTAssertLessThan(after.frame.minY, afterTop, "the rows under it close up")
        if still {
            XCTAssertNil(subtask.superview, "under Reduce Motion the subtasks are gone at once")
        } else {
            XCTAssertTrue(drawn("session:3-1", sidebar).first === subtask, "the subtask fades where it stood")
            try await Task.sleep(for: .milliseconds(400))
            XCTAssertNil(subtask.superview)
        }

        sidebar.tap(parent, at: CGPoint(x: chevron.midX, y: parent.frame.midY))
        sidebar.apply(rows(open: true))
        sidebar.layoutIfNeeded()
        let back = try XCTUnwrap(sidebar.view(for: "session:3-1"))
        XCTAssertGreaterThan(back.frame.minY, parent.frame.maxY - 0.5, "the subtask is placed under its conversation")
        if still {
            XCTAssertNil(back.layer.animationKeys(), "under Reduce Motion it is shown at once")
        } else {
            XCTAssertNotNil(back.layer.animation(forKey: "opacity"), "it fades in")
        }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(after.frame.minY, afterTop, accuracy: 0.01, "the rows under it are back where they were")
        withExtendedLifetime(controller) {}
    }

    /// Only the reader's own fold glides. The same rows going because of
    /// something elsewhere are shown at once, as every other update is.
    func testAFoldFromElsewhereIsShownAtOnce() async throws {
        let (controller, _, sidebar) = try await home()
        sidebar.onFold = { _ in }
        list(Self.tasks(open: true), at: -sidebar.contentInset.top, sidebar)
        let before = try XCTUnwrap(sidebar.view(for: "space:22"))
        sidebar.apply(Self.tasks(open: false))
        sidebar.layoutIfNeeded()
        XCTAssertNil(before.superview, "no fade for a change the reader didn't make")
        XCTAssertTrue(drawn("space:22", sidebar).isEmpty)
        withExtendedLifetime(controller) {}
    }

    /// The rows above a fold don't move on screen, while it glides or
    /// after: the reader's place is kept as it is for every other update.
    func testAFoldMovesNothingAboveIt() async throws {
        let (controller, window, sidebar) = try await home()
        sidebar.onFold = { _ in }
        list(Self.tasks(open: true), at: -sidebar.contentInset.top, sidebar)
        // The heading on screen with rows above it: a finger can reach it.
        let heading = try XCTUnwrap(sidebar.view(for: "section:tasks"))
        sidebar.setContentOffset(CGPoint(x: 0, y: heading.frame.minY - 300), animated: false)
        sidebar.layoutIfNeeded()
        let above = "space:17"
        let start = try XCTUnwrap(windowY(above, sidebar, window), "no row above the fold on screen")

        try tapFold("section:tasks", sidebar)
        sidebar.apply(Self.tasks(open: false))
        sidebar.layoutIfNeeded()
        XCTAssertEqual(try XCTUnwrap(windowY(above, sidebar, window)), start, accuracy: 0.01, "folding moved the rows above it")
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(try XCTUnwrap(windowY(above, sidebar, window)), start, accuracy: 0.01, "the rows above it moved once it settled")

        try tapFold("section:tasks", sidebar)
        sidebar.apply(Self.tasks(open: true))
        sidebar.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(try XCTUnwrap(windowY(above, sidebar, window)), start, accuracy: 0.01, "opening it moved the rows above it")
        withExtendedLifetime(controller) {}
    }
}
#endif

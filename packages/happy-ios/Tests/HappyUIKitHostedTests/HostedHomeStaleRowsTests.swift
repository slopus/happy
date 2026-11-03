#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Home's list while agents work: titles redrawn as line counts tick, rows
/// arriving at a card's top, leaving and moving with the list's
/// animation, and a finger scrolling through it all. Once it settles, every
/// row on the list shows its own latest drawing, at its own size, and
/// nothing left over from an earlier one: no blank title, no title where
/// the row used to be, no title over another.
@MainActor
final class HostedHomeStaleRowsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    /// Steps of a seeded run, as home's sync would make them.
    private struct Script {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9e3779b97f4a7c15
            var z = state
            z = (z ^ (z >> 30)) &* 0xbf58476d1ce4e5b9
            z = (z ^ (z >> 27)) &* 0x94d049bb133111eb
            return z ^ (z >> 31)
        }
        mutating func int(_ range: Range<Int>) -> Int { range.lowerBound + Int(next() % UInt64(range.count)) }
        mutating func chance(_ share: Double) -> Bool { Double(next() % 10_000) / 10_000 < share }
    }

    private static let titles = [
        "Creating and Writing Artifacts", "Digital Marketing Plan", "Website Maintanance", "Brand Rebrand", "Release notes",
        "Fix the login flow", "Home list stale rows", "Quarterly numbers", "Onboarding copy", "Android emulator farm",
        "Deploy the worker", "Design review", "Calendar sync", "Push notifications", "Voice mode", "Billing", "Search ranking",
    ]

    private static func row(_ n: Int, working: Bool, script: inout Script) -> Row {
        var row = Row(id: "space:r\(n)", nodeId: "r\(n)", kind: .space, label: "\(titles[n % titles.count]) \(n)", mark: .placeholder(seed: "r\(n)"), status: working ? .working : .none, agentId: "a\(n)", targetKind: n % 2 == 0 ? "bot" : "task")
        row.activityTime = Double(1_800_000_000_000 + script.int(0..<1_000_000) * 60_000)
        if working { row.lineChanges = GitLineChanges(approximate: false, insertions: script.int(1..<400), deletions: script.int(0..<200)) }
        return row
    }

    /// Cards of rows between separators, the first rows of each working.
    private static func cards(_ cards: [[Row]]) -> [Row] {
        var rows: [Row] = []
        for (index, card) in cards.enumerated() {
            if index > 0 { rows.append(Row(id: "separator:\(index)", nodeId: "separator:\(index)", kind: .separator, label: "")) }
            rows += card
        }
        return rows
    }

    /// Settled: every mounted row shows its current item's drawing, ready,
    /// at its slot's size, with nothing else in its bitmap's view; and no
    /// other row view of the list is still on screen.
    /// `assertSettled`, once the pipeline has drained: what is still wrong
    /// after up to 20 seconds at rest is wrong for good.
    private func assertSettledAtRest(_ list: SidebarList, step: String, file: StaticString = #filePath, line: UInt = #line) async throws -> Int {
        let deadline = ContinuousClock.now + .seconds(20)
        while ContinuousClock.now < deadline, assertSettled(list, step: step, report: false) > 0 {
            try await Task.sleep(for: .milliseconds(250))
            await list.settle()
        }
        return assertSettled(list, step: step, file: file, line: line)
    }

    private func assertSettled(_ list: SidebarList, step: String, report: Bool = true, file: StaticString = #filePath, line: UInt = #line) -> Int {
        func fail(_ message: String, file: StaticString, line: UInt) { if report { XCTFail(message, file: file, line: line) } }
        var failures = 0
        if report { print("STALE CHECK \(step): \(list.mountedViews.count) rows mounted, \(list.mountedViews.filter { $0.shownDrawing.shown.count == 1 }.count) showing one host") }
        for view in list.mountedViews {
            let id = view.row.id
            let current = view.item.entry
            let shown = view.shownDrawing
            var problems: [String] = []
            if !view.isDisplayReady { problems.append("not display-ready") }
            if current.drawing.dark != (view.traitCollection.userInterfaceStyle == .dark) { problems.append("current drawing dark \(current.drawing.dark) on a \(view.traitCollection.userInterfaceStyle == .dark ? "dark" : "light") screen") }
            if shown.shown.count != 1 { problems.append("\(shown.shown.count) hosts shown") }
            if let host = shown.shown.first {
                // What is drawn: a row that changed only what isn't keeps its drawing.
                if host.drawing.map({ !($0.row.label == current.row.label && $0.row.lineChanges == current.row.lineChanges && $0.row.status == current.row.status) }) ?? true { problems.append("shows \(host.drawing.map { "\"\($0.row.label)\" \($0.row.lineChanges.map { "+\($0.insertions)-\($0.deletions)" } ?? "")" } ?? "nothing"), current is \"\(current.row.label)\" \(current.row.lineChanges.map { "+\($0.insertions)-\($0.deletions)" } ?? "")") }
                else if host.drawing?.frame != current.drawing.frame { problems.append("drawn at frames for another slot (label \(host.drawing?.frame.label ?? .null), current \(current.drawing.frame.label))") }
                else if host.drawing != current.drawing { problems.append("drawn \(host.drawing.map { "dark \($0.dark) selected \($0.selected)" } ?? ""), current dark \(current.drawing.dark) selected \(current.drawing.selected)") }
                if abs(host.size.height - current.size.height) > 0.5 || abs(host.size.width - current.size.width) > 0.5 { problems.append("host \(host.size), slot \(current.size)") }
                if let bitmap = host.bitmap {
                    if abs(bitmap.height - current.size.height) > 0.5 || abs(bitmap.width - current.size.width) > 0.5 { problems.append("bitmap \(bitmap), slot \(current.size)") }
                } else if current.row.kind != .separator {
                    problems.append("no bitmap")
                }
            }
            if shown.hidden != 0 { problems.append("\(shown.hidden) hidden hosts waiting") }
            if shown.others != 0 { problems.append("\(shown.others) leftover snapshot views") }
            if !problems.isEmpty {
                failures += 1
                fail("\(step): \(id) \"\(view.row.label)\": " + problems.joined(separator: "; "), file: file, line: line)
            }
        }
        // Nothing else of the list stands on screen: no ghost or carried row left behind.
        let mounted = Set(list.mountedViews.map(ObjectIdentifier.init))
        func strays(in view: UIView) -> [SidebarItemView] {
            if let row = view as? SidebarItemView {
                return !mounted.contains(ObjectIdentifier(row)) && !row.isHidden && row.alpha > 0.01 ? [row] : []
            }
            if view.isHidden || view.alpha < 0.01 { return [] }
            return view.subviews.flatMap(strays)
        }
        let left = strays(in: list.list)
        if !left.isEmpty {
            failures += left.count
            fail("\(step): row views left on screen: \(left.map(\.row.label))", file: file, line: line)
        }
        return failures
    }

    private func settle(_ list: SidebarList) async throws {
        await list.settle()
        // The list's own animations and the rows' reveals run out, and the
        // slowest drawings land.
        try await Task.sleep(for: .milliseconds(900 + Int(SidebarItemDrawing.testDrawDelay * 4000)))
        await list.settle()
    }

    func testWorkingRowsShowTheirLatestDrawing() async throws {
        let scene = try await hostedActiveScene()
        let root = UIViewController()
        root.view.backgroundColor = UIColor(Palette.groupedGround)
        let window = hostedKeyWindow(in: scene, root: root)
        window.overrideUserInterfaceStyle = .dark
        addTeardownBlock { @MainActor in window.isHidden = true }
        let list = SidebarList(frame: window.bounds)
        root.view.addSubview(list)
        list.layoutIfNeeded()
        list.setInsets(UIEdgeInsets(top: 100, left: 0, bottom: 40, right: 0), indicator: .zero, keepsTop: true)

        SidebarItemDrawing.testDrawDelay = Double(ProcessInfo.processInfo.environment["HAPPY_STALE_DRAW_DELAY"] ?? "") ?? 0.12
        addTeardownBlock { @MainActor in SidebarItemDrawing.testDrawDelay = 0 }
        var script = Script(state: UInt64(ProcessInfo.processInfo.environment["HAPPY_STALE_SEED"] ?? "") ?? 7)
        var next = 0
        func make(working: Bool) -> Row {
            next += 1
            return Self.row(next, working: working, script: &script)
        }
        var cards: [[Row]] = (0..<4).map { card in (0..<(card == 0 ? 6 : 9)).map { make(working: $0 < 4) } }
        list.apply(Self.cards(cards))
        await list.settle()
        var failures = 0
        var away = 0
        let rounds = Int(ProcessInfo.processInfo.environment["HAPPY_STALE_ROUNDS"] ?? "") ?? 6
        for round in 0..<rounds {
            for step in 0..<40 {
                // Working rows tick their line counts and activity.
                for c in cards.indices {
                    for r in cards[c].indices where cards[c][r].status == .working {
                        if script.chance(0.6) {
                            var changes = cards[c][r].lineChanges ?? GitLineChanges(approximate: false, insertions: 0, deletions: 0)
                            changes.insertions += script.int(1..<30)
                            if script.chance(0.3) { changes.deletions += script.int(1..<10) }
                            cards[c][r].lineChanges = changes
                        }
                        if script.chance(0.3) { cards[c][r].activityTime = (cards[c][r].activityTime ?? 0) + 60_000 }
                    }
                }
                switch script.int(0..<17) {
                case 0, 1:
                    // A new conversation at a card's top, working.
                    let c = script.int(0..<cards.count)
                    cards[c].insert(make(working: true), at: 0)
                case 2:
                    let c = script.int(0..<cards.count)
                    if cards[c].count > 2 { cards[c].remove(at: script.int(0..<cards[c].count)) }
                case 3:
                    // A row that just did something goes to its card's top.
                    let c = script.int(0..<cards.count)
                    if cards[c].count > 1 { cards[c].insert(cards[c].remove(at: script.int(1..<cards[c].count)), at: 0) }
                case 4:
                    // To another card's top.
                    let from = script.int(0..<cards.count), to = script.int(0..<cards.count)
                    if from != to, cards[from].count > 2 { cards[to].insert(cards[from].remove(at: script.int(0..<cards[from].count)), at: 0) }
                case 5:
                    let c = script.int(0..<cards.count)
                    let r = script.int(0..<cards[c].count)
                    cards[c][r].status = cards[c][r].status == .working ? .none : .working
                    if cards[c][r].status == .working, cards[c][r].lineChanges == nil { cards[c][r].lineChanges = GitLineChanges(approximate: false, insertions: 1, deletions: 0) }
                case 6, 7:
                    // A finger: through the list, or back to the top.
                    let height = max(0, list.edge.contentSize.height - list.bounds.height + 140)
                    let offset = script.chance(0.25) ? -100 : CGFloat(script.int(0..<max(1, Int(height))))
                    list.setContentOffsetY(offset, animated: script.chance(0.5))
                case 8:
                    // A row opens: lit while its screen comes in, then let go.
                    let c = script.int(0..<cards.count)
                    list.selectedRowId = script.chance(0.5) ? cards[c][script.int(0..<cards[c].count)].id : nil
                case 9:
                    list.notice = list.notice == nil ? "The computer refused the last action" : nil
                case 10:
                    // A chat pushed over home: the list leaves the window while
                    // rows go on changing, and comes back.
                    list.removeFromSuperview()
                    away = script.int(1..<8)
                case 12:
                    // The phone turns, or a window narrows, and back.
                    var frame = list.frame
                    frame.size.width = frame.width == window.bounds.width ? window.bounds.width + CGFloat(script.int(-60..<300)) : window.bounds.width
                    list.frame = frame
                    list.layoutIfNeeded()
                case 11:
                    // The app goes to the background: iOS draws the screen in
                    // both appearances for the app switcher, and back.
                    let style = window.overrideUserInterfaceStyle
                    window.overrideUserInterfaceStyle = style == .dark ? .light : .dark
                    list.layoutIfNeeded()
                    try await Task.sleep(for: .milliseconds(script.int(0..<30)))
                    window.overrideUserInterfaceStyle = style
                    list.layoutIfNeeded()
                default:
                    break
                }
                list.apply(Self.cards(cards))
                if away > 0 {
                    away -= 1
                    if away == 0 {
                        list.selectedRowId = nil
                        root.view.addSubview(list)
                    }
                }
                // Applies land mid-animation, a frame apart or more.
                try await Task.sleep(for: .milliseconds(script.int(0..<4) * 16 + script.int(0..<12)))
            }
            if list.superview == nil { root.view.addSubview(list); away = 0 }
            if list.frame != window.bounds { list.frame = window.bounds; list.layoutIfNeeded() }
            try await settle(list)
            failures += try await assertSettledAtRest(list, step: "round \(round)")
            // Every row on its turn: scrolled through, so each is mounted once.
            var offset: CGFloat = -100
            while offset < list.edge.contentSize.height {
                list.setContentOffsetY(offset, animated: false)
                try await Task.sleep(for: .milliseconds(50))
                await list.settle()
                offset += list.bounds.height / 2
            }
            try await settle(list)
            failures += try await assertSettledAtRest(list, step: "round \(round), scrolled to the end")
            list.setContentOffsetY(-100, animated: false)
            try await settle(list)
            failures += try await assertSettledAtRest(list, step: "round \(round), back at the top")
            if failures > 0 { break }
        }
        print("STALE ROWS: \(failures) failing rows")
    }

    /// What a person sees of a row's drawing: its words, counts, marks and
    /// where they stand, not what the row carries besides.
    private static func looksAlike(_ a: SidebarItemDrawing, _ b: SidebarItemDrawing) -> Bool {
        a.frame == b.frame && a.selected == b.selected && a.dark == b.dark && a.row.label == b.row.label
            && a.row.lineChanges == b.row.lineChanges && a.row.status == b.row.status && a.row.unread == b.row.unread && a.row.isNew == b.row.isNew
    }

    /// A computer with many agents at work, as the heat branch streams it:
    /// every agent event applies the catalog again, so each moment some
    /// rows' activity times move, a few line counts tick, now and then a
    /// run starts at a card's top. Rows on screen keep up: none looks
    /// different from its row for long, and once the stream stops every
    /// one shows its own drawing.
    func testRowsKeepUpWithAStreamOfAgentEvents() async throws {
        let scene = try await hostedActiveScene()
        let root = UIViewController()
        let window = hostedKeyWindow(in: scene, root: root)
        window.overrideUserInterfaceStyle = .dark
        addTeardownBlock { @MainActor in window.isHidden = true }
        let list = SidebarList(frame: window.bounds)
        root.view.addSubview(list)
        list.layoutIfNeeded()
        list.setInsets(UIEdgeInsets(top: 100, left: 0, bottom: 40, right: 0), indicator: .zero, keepsTop: true)
        // A slow display queue (a hot phone), when asked for.
        SidebarItemDrawing.testDrawDelay = Double(ProcessInfo.processInfo.environment["HAPPY_STALE_STREAM_DELAY"] ?? "") ?? 0
        addTeardownBlock { @MainActor in SidebarItemDrawing.testDrawDelay = 0 }
        var script = Script(state: 11)
        var next = 0
        func make() -> Row {
            next += 1
            return Self.row(next, working: true, script: &script)
        }
        var cards: [[Row]] = (0..<4).map { _ in (0..<10).map { _ in make() } }
        list.apply(Self.cards(cards))
        await list.settle()
        let seconds = Double(ProcessInfo.processInfo.environment["HAPPY_STALE_STREAM_SECONDS"] ?? "") ?? 12
        let end = ContinuousClock.now + .seconds(seconds)
        var applies = 0
        var wrongSince: [String: ContinuousClock.Instant] = [:]
        var worst: Duration = .zero
        var worstRow = ""
        var revisions = Set<String>()
        while ContinuousClock.now < end {
            // Agent events: activity for a handful, a count for a few.
            for _ in 0..<6 {
                let c = script.int(0..<cards.count), r = script.int(0..<cards[c].count)
                cards[c][r].activityTime = (cards[c][r].activityTime ?? 0) + 60_000
            }
            if script.chance(0.3) {
                let c = script.int(0..<cards.count), r = script.int(0..<cards[c].count)
                var changes = cards[c][r].lineChanges ?? GitLineChanges(approximate: false, insertions: 0, deletions: 0)
                changes.insertions += script.int(1..<30)
                cards[c][r].lineChanges = changes
            }
            if script.chance(0.01) {
                let c = script.int(0..<cards.count)
                cards[c].insert(make(), at: 0)
                cards[c].removeLast()
            }
            list.apply(Self.cards(cards))
            applies += 1
            try await Task.sleep(for: .milliseconds(30))
            let now = ContinuousClock.now
            for view in list.mountedViews {
                revisions.insert("\(view.row.id)#\(view.item.revision)")
                let shown = view.shownDrawing.shown
                let alike = shown.count == 1 && shown[0].drawing.map { Self.looksAlike($0, view.item.entry.drawing) } == true
                if alike { wrongSince[view.row.id] = nil; continue }
                let since = wrongSince[view.row.id] ?? now
                wrongSince[view.row.id] = since
                if now - since > worst { worst = now - since; worstRow = view.row.label }
            }
        }
        print("STALE STREAM: \(applies) applies, \(revisions.count) row revisions mounted, worst row looked wrong for \(worst) (\(worstRow))")
        // How long the rows take to catch up once the stream stops.
        let stopped = ContinuousClock.now
        await list.settle()
        while ContinuousClock.now - stopped < .seconds(60), assertSettled(list, step: "", report: false) > 0 {
            try await Task.sleep(for: .milliseconds(50))
        }
        print("STALE STREAM: caught up \(ContinuousClock.now - stopped) after the stream stopped")
        if SidebarItemDrawing.testDrawDelay == 0 {
            XCTAssertLessThan(worst, .milliseconds(1000), "a row on screen looked wrong for \(worst): \(worstRow)")
        }
        _ = try await assertSettledAtRest(list, step: "after the stream")
    }

    /// A row that changes only what isn't drawn (when it last did
    /// something, its subtasks, where it opens) keeps its revision, its
    /// node and the bitmap on screen; its view still takes the new row, so
    /// a tap opens where it now says. A change to what is drawn (its line
    /// counts) makes a new revision, drawn and shown.
    func testAChangeNothingDrawsKeepsTheRowsDrawing() async throws {
        let scene = try await hostedActiveScene()
        let root = UIViewController()
        let window = hostedKeyWindow(in: scene, root: root)
        addTeardownBlock { @MainActor in window.isHidden = true }
        let list = SidebarList(frame: window.bounds)
        root.view.addSubview(list)
        list.layoutIfNeeded()
        var script = Script(state: 3)
        var rows = (1...8).map { Self.row($0, working: true, script: &script) }
        list.apply(rows)
        await list.settle()
        let id = rows[2].id
        let view = try XCTUnwrap(list.view(for: id))
        let node = view.item.node, revision = view.item.revision
        let hosts = view.drawingHosts
        XCTAssertEqual(hosts.count, 1)

        for step in 0..<20 {
            rows[2].activityTime = (rows[2].activityTime ?? 0) + 60_000
            rows[2].sessions = (0...step).map { SidebarDocumentEdits.SessionTree(id: "sub\($0)") }
            rows[2].hasShownSessions = step % 2 == 0
            rows[2].agentId = "moved-\(step)"
            rows[2].workspaceId = "w-\(step)"
            rows[2].canArchive = step % 2 == 1
            list.apply(rows)
            await list.settle()
        }
        let same = try XCTUnwrap(list.view(for: id))
        XCTAssertTrue(same === view)
        XCTAssertEqual(same.item.revision, revision, "nothing drawn changed: the same revision")
        XCTAssertTrue(same.item.node === node, "and the same node, measured and drawn once")
        XCTAssertEqual(same.drawingHosts.map(ObjectIdentifier.init), hosts.map(ObjectIdentifier.init), "the same bitmap stays on screen")
        XCTAssertEqual(same.row, rows[2], "the view has the row as it is now")
        XCTAssertEqual(same.row.agentId, "moved-19")

        // Off the main thread, too: the slot keeps its revision.
        let input = SidebarList.Input(rows: rows, width: window.bounds.width, dark: false, displayScale: 3, selected: nil, notice: nil)
        let before = SidebarList.derive(input, previous: nil)
        var later = input
        later.rows[2].activityTime = (later.rows[2].activityTime ?? 0) + 60_000
        later.rows[2].sessions = []
        let after = SidebarList.derive(later, previous: before)
        XCTAssertEqual(after.entries.map(\.revision), before.entries.map(\.revision))
        XCTAssertEqual(after.sequence, before.sequence)

        // A count that moves is drawn: a new revision, shown.
        rows[2].lineChanges = GitLineChanges(approximate: false, insertions: 999, deletions: 1)
        list.apply(rows)
        await list.settle()
        let redrawn = try XCTUnwrap(list.view(for: id))
        XCTAssertNotEqual(redrawn.item.revision, revision)
        XCTAssertFalse(redrawn.item.node === node)
        _ = try await assertSettledAtRest(list, step: "after a count moved")
        XCTAssertEqual(redrawn.shownDrawing.shown.first?.drawing?.row.lineChanges?.insertions, 999)
    }
}
#endif

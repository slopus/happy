import ObjectiveC
import UIKit
import XCTest

/// XCUITest waits up to a minute for the app to idle around every action,
/// and home never idles for it at launch. As the chat UI tests do, the
/// private wait is replaced where it is found (ChatScrollUITests.swift).
private let skipsQuiescence: Bool = {
    guard let process = NSClassFromString("XCUIApplicationProcess") else { return false }
    var replaced = false
    let one: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
    let two: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
    for (name, block) in [
        ("waitForQuiescenceIncludingAnimationsIdle:", one as Any),
        ("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:", two as Any),
    ] {
        guard let method = class_getInstanceMethod(process, NSSelectorFromString(name)) else { continue }
        method_setImplementation(method, imp_implementationWithBlock(block))
        replaced = true
    }
    return replaced
}()

/// V2 against a real throwaway Happy Agent on this Mac. A driver
/// outside the test opens the daemon's pairing link on this simulator,
/// confirms the pairing on the daemon's side and records the screen; the
/// test is the person's finger. Nothing here holds a credential. The
/// "+" sheet's strip and the app's own library sheet show the library
/// only once the app may read it, and the app never asks for that from
/// the composer: the driver grants it first
/// (`xcrun simctl privacy <udid> grant photos <bundle>`).
@MainActor
final class UITests: XCTestCase {
    /// The transcript, whichever renderer drew it: the agents' chat draws
    /// on UltraList, which is not a scroll view, so it is found by its
    /// identifier rather than by kind.
    var transcriptElement: XCUIElement {
        app.descendants(matching: .any).matching(identifier: "transcript").firstMatch
    }

    private let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        print("V2UITests skips quiescence: \(skipsQuiescence)")
        // Direct connection is an experiment, off on a fresh install.
        app.launch()
    }

    /// Pairs if this simulator has no computer yet, then waits for its sidebar.
    private func home() {
        // Any row: Prioritizing may have filed Happy's under a folded section.
        let happy = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:")).firstMatch
        if happy.waitForExistence(timeout: 8) { return }
        print("HAPPY_PAIR_READY")
        let match = app.buttons["Emoji match"]
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, !match.exists {
            for alert in [app.alerts.firstMatch, springboard.alerts.firstMatch] where alert.buttons["Open"].exists {
                alert.buttons["Open"].tap()
            }
            _ = match.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(match.exists, "pairing never showed its emoji")
        pause(1.5)
        match.tap()
        XCTAssertTrue(happy.waitForExistence(timeout: 90))
    }

    private func row(_ kind: String, _ label: String) -> XCUIElement {
        app.descendants(matching: .any)["row:\(kind):\(label)"]
    }

    /// Scrolls the list in short, held drags from the middle of the screen
    /// until `element` sits between 20% and 60% of its height, clear of
    /// the bars, the dock and the home indicator.
    private func bringIntoView(_ element: XCUIElement) {
        let height = app.frame.height
        // Enough for a transcript many runs long.
        for _ in 0..<24 {
            let y = element.frame.midY
            if y > height * 0.2, y < height * 0.6 { break }
            let shift = min(max((y - height * 0.4) / height, -0.35), 0.35)
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6 - shift)),
                withVelocity: .slow, thenHoldForDuration: 0.4
            )
            pause(0.8)
            if abs(element.frame.midY - y) < 1, element.isHittable { break }
        }
    }

    /// A tap on a row's chevron, at its trailing end: its centre half the
    /// row's height in from the row's end.
    private func tapChevron(_ row: XCUIElement) {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: row.frame.maxX - row.frame.height / 2, dy: row.frame.midY)).tap()
    }

    /// Opens every folded section, top to bottom.
    private func openFoldedSections() {
        let sections = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:section:"))
        for id in sections.allElementsBoundByIndex.map(\.identifier) {
            let section = app.descendants(matching: .any)[id]
            bringIntoView(section)
            pause(0.5)
            let under = rowUnder(section)
            if under == nil || under!.identifier.hasPrefix("row:section:") || under!.identifier.hasPrefix("row:separator") {
                tapChevron(section)
                pause(1)
            }
        }
    }

    /// The row drawn right under `row`, if any.
    private func rowUnder(_ row: XCUIElement) -> XCUIElement? {
        let bottom = row.frame.maxY
        guard let under = shownRows("row:").filter({ $0.frame.minY >= bottom - 1 }).min(by: { $0.frame.minY < $1.frame.minY }) else { return nil }
        return app.descendants(matching: .any)[under.identifier].firstMatch
    }

    /// The drawn rows whose identifier starts with `prefix`, read from one
    /// snapshot: the sidebar moves rows while they are read one by one, and an
    /// element gone by its turn fails the test.
    private func shownRows(_ prefix: String) -> [(identifier: String, frame: CGRect)] {
        guard let root = try? app.snapshot() else { return [] }
        var rows: [(identifier: String, frame: CGRect)] = []
        func walk(_ node: XCUIElementSnapshot) {
            if node.identifier.hasPrefix(prefix), node.frame.height > 0 { rows.append((node.identifier, node.frame)) }
            node.children.forEach(walk)
        }
        walk(root)
        return rows
    }

    private func pause(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Pairing, the sidebar in desktop's order, and folding a section.
    func testSidebar() {
        home()
        // Search is the header's button and Create the dock: neither is a row.
        XCTAssertFalse(row("search", "Search").exists)
        XCTAssertFalse(row("create", "Create").exists)
        XCTAssertTrue(app.buttons["search"].exists)
        pause(2)
        capture("sidebar")
        let sections = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:section:"))
        if sections.count > 0 {
            let section = sections.element(boundBy: 0)
            // Not under the dock, where a tap is the dock's.
            bringIntoView(section)
            section.tap()
            pause(1.5)
            capture("folded")
            section.tap()
            pause(1.5)
        }
    }

    /// New work from the dock's field: the intro at once, the composer up,
    /// a message, the agent's answer, and the row named back in the sidebar.
    func testNewWork() {
        home()
        pause(1.5)
        app.descendants(matching: .any)["new-work"].tap()
        let intro = app.staticTexts["Say what it is — it’ll find its place."]
        XCTAssertTrue(intro.waitForExistence(timeout: 3))
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        pause(1.5)
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        capture("new-work-intro")
        composer.typeText("Write a four-line poem about a pineapple that wants to be a cactus. No tools, just answer.")
        pause(1)
        app.buttons["Send"].tap()
        // The simulator's first keyboard explains swipe typing once.
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        let messages = app.descendants(matching: .any).matching(identifier: "message")
        let working = app.descendants(matching: .any)["working"]
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, messages.count < 2 || working.exists { pause(1) }
        XCTAssertGreaterThanOrEqual(messages.count, 2, "the agent never answered")
        pause(2)
        capture("new-work-answered")
        app.tapBack()
        pause(4)
        capture("sidebar-after-new-work")
    }

    /// Desktop's chat layout: new work's intro pinned under the bar, the
    /// first message right under it with nothing moving, and a follow-up
    /// sent while the agent is idle lifted 30% down the transcript (no
    /// higher than the intro's line), the room under it held for the reply.
    func testChatLayout() {
        home()
        pause(1.5)
        app.descendants(matching: .any)["new-work"].tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        pause(1.5)
        let intro = app.descendants(matching: .any)["intro"]
        let back = app.buttons["chat-back"]
        let input = app.descendants(matching: .any)["input"]
        let top = intro.frame.minY
        XCTAssertGreaterThanOrEqual(top, back.frame.maxY - 1, "the intro is under the bar's row")
        XCTAssertLessThan(top - back.frame.maxY, 16, "the intro isn't pinned under the bar")
        capture("layout-intro")
        // Claude's week is spent on the e2e computer: a model that answers.
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model: ")).firstMatch
        if !model.label.contains("GPT-6.1 Sol") { pickIn(model, "picker-models", "GPT-6.1 Sol", shot: "layout-model") }
        XCTAssertEqual(intro.frame.minY, top, accuracy: 1, "picking a model moved the intro")
        composer.tap()
        composer.typeText("Plan a long weekend in Lisbon for the four of us. Two lines, no tools.")
        app.buttons["Send"].tap()
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        let messages = app.descendants(matching: .any).matching(identifier: "message")
        XCTAssertTrue(until(5) { messages.count >= 1 }, "the send never showed")
        pause(1)
        XCTAssertEqual(intro.frame.minY, top, accuracy: 1, "the first send moved the intro")
        XCTAssertEqual(messages.element(boundBy: 0).frame.minY, intro.frame.maxY, accuracy: 1, "the first message isn't right under the intro")
        let introLine = intro.frame.height
        capture("layout-first")
        // The agent done with it, answered or not.
        let working = app.descendants(matching: .any)["working"]
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, messages.count < 2 || working.exists { pause(1) }
        pause(2)
        capture("layout-answered")
        let before = messages.count
        composer.typeText("Swap Saturday and Sunday. One line.")
        app.buttons["Send"].tap()
        XCTAssertTrue(until(5) { messages.count > before }, "the follow-up never showed")
        pause(1)
        let sent = messages.element(boundBy: before)
        let viewport = input.frame.minY - 8 - top
        // The intro's line raises the line only while the intro is on screen;
        // scrolled away under the bar, the line is desktop's 30%.
        let introShows = intro.frame.maxY > top + 1
        let line = introShows ? min(max((viewport * 0.3).rounded(), introLine), (viewport * 0.5).rounded()) : (viewport * 0.3).rounded()
        XCTAssertEqual(sent.frame.minY - top, line, accuracy: 1.5, "the follow-up isn't lifted to the line (viewport \(viewport))")
        XCTAssertGreaterThan(input.frame.minY - sent.frame.maxY, 40, "no room held for the reply")
        capture("layout-follow-up")
        let deadlineReply = Date().addingTimeInterval(120)
        while Date() < deadlineReply, messages.count < before + 2 || working.exists { pause(1) }
        pause(2)
        capture("layout-follow-up-answered")
    }

    /// New work stands until it is used: leaving it, any way, closes
    /// nothing, and the next new work opens that same one instead of
    /// making another, so there is never more than one empty. Each way out
    /// in turn: the back button with the keyboard up or down, the edge
    /// swipe, a swipe let go of halfway then the back button, the "+"
    /// sheet opened and closed (from the chat and from the dock), a model
    /// or effort picked, and the app killed. New work with a draft on the
    /// computer (the driver's `draft-newest`) is not reused.
    func testNewWorkIsReused() {
        // Every way is reported, not only the first that fails.
        continueAfterFailure = true
        print("HAPPY_STEP undraft")
        home()
        pause(1.5)
        let untitled = app.descendants(matching: .any).matching(identifier: "row:space:New")
        let composer = app.textViews["composer"]
        // How many the computer holds, as the driver's `count-new` reads it.
        let counted = URL(fileURLWithPath: "/Users/kirilldubovitskiy/Happy/Workspaces/happy/ios-settings-rework/.context/tmp/count-new")
        func onComputer() -> Int? {
            try? FileManager.default.removeItem(at: counted)
            print("HAPPY_STEP count-new")
            let deadline = Date().addingTimeInterval(10)
            while Date() < deadline {
                if let text = try? String(contentsOf: counted, encoding: .utf8), let count = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) { return count }
                pause(0.3)
            }
            return nil
        }
        let only = ProcessInfo.processInfo.environment["HAPPY_EXIT_PATHS"]?.split(separator: ",").map(String.init)
        func start(fromPlus: Bool = false, settle: Bool = true) {
            if fromPlus {
                app.buttons["Add a picture"].firstMatch.tap()
            } else {
                app.descendants(matching: .any)["new-work"].tap()
            }
            XCTAssertTrue(composer.waitForExistence(timeout: 5))
            guard settle else { return }
            pause(1)
            if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        }
        func swipeFromEdge(to x: CGFloat) {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.5)), withVelocity: x < 0.5 ? .slow : .fast, thenHoldForDuration: x < 0.5 ? 0.3 : 0)
        }
        func closeSheet() {
            let close = app.buttons["attach-close"]
            XCTAssertTrue(close.waitForExistence(timeout: 5), "+ opened no sheet")
            pause(0.8)
            close.tap()
            pause(1)
        }
        func keyboardDown() {
            app.descendants(matching: .any)["intro"].firstMatch.tap()
            pause(1)
            if app.keyboards.firstMatch.exists { app.swipeDown(velocity: .slow); pause(1) }
        }
        func pickEffort() {
            let effort = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Effort: ")).firstMatch
            XCTAssertTrue(effort.waitForExistence(timeout: 5), "no effort chip")
            pickIn(effort, "picker-efforts", effort.label.contains("High") ? "Low" : "High", shot: "reuse-effort")
        }
        func pickModel() {
            let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model: ")).firstMatch
            XCTAssertTrue(model.waitForExistence(timeout: 5), "no model chip")
            open(model, "picker-models")
            let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND selected == false", "picker-row:"))
            let other = rows.allElementsBoundByIndex.first { $0.isHittable }
            XCTAssertNotNil(other, "no other model to pick")
            other?.tap()
            pause(1.5)
        }
        // The first new work: the one every way below comes back to.
        start()
        capture("reuse-first")
        app.tapBack()
        pause(2)
        let shown = untitled.count
        let held = onComputer()
        XCTAssertGreaterThan(shown, 0, "leaving new work closed it")
        let paths: [(String, () -> Void)] = [
            ("again", { start(); self.app.tapBack() }),
            ("back-keyboard-down", { start(); keyboardDown(); self.app.tapBack() }),
            ("edge-swipe", { start(); swipeFromEdge(to: 0.9) }),
            ("edge-swipe-cancelled-then-back", {
                start()
                swipeFromEdge(to: 0.15)
                self.pause(1.5)
                XCTAssertTrue(composer.exists, "a swipe let go of early left the chat")
                self.app.tapBack()
            }),
            ("plus-sheet-then-back", { start(); self.app.buttons["Add a picture"].firstMatch.tap(); closeSheet(); self.app.tapBack() }),
            ("dock-plus-then-back", { start(fromPlus: true); closeSheet(); self.app.tapBack() }),
            ("effort-then-back", { start(); pickEffort(); self.app.tapBack() }),
            ("model-then-back", { start(); pickModel(); self.app.tapBack() }),
            ("back-at-once", { start(settle: false); self.app.tapBack() }),
            ("killed", {
                start()
                self.pause(1)
                self.app.terminate()
                self.app.launch()
                self.home()
                self.pause(3)
            }),
        ]
        for (name, leave) in paths where only?.contains(name) ?? true {
            print("HAPPY_REUSE \(name)")
            leave()
            pause(2)
            capture("reuse-\(name)")
            XCTAssertEqual(untitled.count, shown, "\(name): another new work showed")
            if let held { XCTAssertEqual(onComputer(), held, "\(name): the computer made another") }
        }
        // Written in on another device (a draft there): not offered as
        // empty. Another empty one may be; the drafted one never is.
        print("HAPPY_STEP draft-newest")
        pause(2)
        start()
        XCTAssertFalse((composer.value as? String ?? "").contains("keep this"), "new work holding a draft was reused")
        capture("reuse-drafted")
        app.tapBack()
        pause(2)
        print("HAPPY_STEP undraft")
        pause(2)
    }

    /// Archive and Leave from a row's hold menu take the row off at once,
    /// with the computer made to answer seconds later
    /// (`V2_SLOW_WRITES`), and nothing brings it back while it does or
    /// after: no read, no event. Two fresh tasks each run (the driver's
    /// `make-removables`).
    func testRemovalsAreOptimistic() {
        let run = String(Int(Date().timeIntervalSince1970) % 100_000)
        try? run.write(toFile: "/Users/kirilldubovitskiy/Happy/Workspaces/happy/ios-settings-rework/.context/tmp/remove-run", atomically: true, encoding: .utf8)
        print("HAPPY_STEP make-removables")
        pause(3)
        app.terminate()
        app.launchEnvironment["HAPPY_SLOW_WRITES"] = "4"
        app.launch()
        home()
        pause(2)
        for (name, act) in [("Archive me \(run)", "Archive task"), ("Leave me \(run)", "Leave task")] {
            let target = row("space", name)
            XCTAssertTrue(target.waitForExistence(timeout: 10), "no \(name)")
            bringIntoView(target)
            pause(1)
            capture("remove-\(act)-before")
            target.press(forDuration: 1.0)
            let item = app.buttons[act]
            XCTAssertTrue(item.waitForExistence(timeout: 3), "\(name)'s menu has no \(act)")
            print("HAPPY_REMOVE \(act)")
            item.tap()
            let tapped = Date()
            XCTAssertTrue(until(1.5) { !target.exists }, "\(act): the row waited for the computer")
            print("HAPPY_REMOVE_GONE \(act) \(Date().timeIntervalSince(tapped))")
            capture("remove-\(act)-at-once")
            // Through the slow answer and the events after it.
            var back = false
            for _ in 0..<40 {
                if target.exists { back = true }
                pause(0.25)
            }
            XCTAssertFalse(back, "\(act): the row came back before or after the computer answered")
        }
        app.terminate()
        app.launchEnvironment["HAPPY_SLOW_WRITES"] = nil
        app.launch()
        home()
        pause(3)
        for name in ["Archive me \(run)", "Leave me \(run)"] {
            XCTAssertFalse(row("space", name).exists, "the computer still has \(name)")
        }
    }

    /// New work, then back to the sidebar to watch its seedling hatch into
    /// the picture Prioritizing gives it.
    func testHatch() {
        home()
        pause(1)
        let cells = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND value BEGINSWITH %@", "row:space:", "seedling"))
        let before = cells.count
        app.descendants(matching: .any)["new-work"].tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        composer.typeText("Plan a weekend of bouldering in Fontainebleau. One line, no tools.")
        app.buttons["Send"].tap()
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        pause(2)
        app.tapBack()
        XCTAssertGreaterThan(cells.count, before, "no seedling row")
        capture("hatch-waiting")
        let deadline = Date().addingTimeInterval(150)
        while Date() < deadline, cells.count > before { pause(0.5) }
        // The hatch plays for 2.5 s.
        pause(1.2)
        capture("hatching")
        pause(4)
        capture("hatched")
        XCTAssertLessThan(Date(), deadline, "the seedling never hatched")
    }

    /// Happy's own conversation opens from its row and stays selected.
    func testOpenHappy() {
        home()
        pause(1)
        row("space", "Happy").tap()
        pause(4)
        capture("happy-chat")
        app.tapBack()
        pause(2)
        capture("happy-selected")
    }

    /// Renaming a task from its row's menu, in the row itself: the title
    /// turns into a field, Return keeps the new name, and it stays.
    func testRename() {
        home()
        // Whichever of the two names the last run left.
        let (from, to) = row("space", "Pick a new laptop").waitForExistence(timeout: 3) ? ("Pick a new laptop", "Choose a laptop") : ("Choose a laptop", "Pick a new laptop")
        let task = row("space", from)
        XCTAssertTrue(task.exists)
        bringIntoView(task)
        pause(1)
        task.press(forDuration: 1.0)
        let rename = app.buttons["Rename task"]
        XCTAssertTrue(rename.waitForExistence(timeout: 3))
        pause(1)
        capture("row-menu")
        rename.tap()
        let field = app.textFields["rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        pause(1)
        capture("rename-in-place")
        // The old name is selected: typing replaces it.
        field.typeText(to)
        pause(0.8)
        capture("rename-typed")
        field.typeText("\n")
        let renamed = row("space", to)
        XCTAssertTrue(renamed.waitForExistence(timeout: 2))
        pause(4)
        XCTAssertTrue(renamed.exists, "the name went back")
        capture("renamed")
    }

    /// A hold on a row previews its conversation as Telegram's chat list
    /// does: the real newest messages under its name in a card at
    /// Telegram's size, the menu under it. It stays when let go; a tap on
    /// it opens the conversation; Rename edits the row in place; Archive
    /// puts a bot away. A sideways pull does nothing any more.
    func testHoldPreview() {
        home()
        let screen = app.windows.firstMatch.frame
        let chat = row("space", "Birthday party for Maya")
        bringIntoView(chat)
        pause(1)
        chat.press(forDuration: 1.0)
        let preview = app.descendants(matching: .any)["preview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 3), "a hold showed no preview")
        XCTAssertTrue(preview.descendants(matching: .any)["preview-title"].exists, "the preview has no name")
        XCTAssertTrue(preview.staticTexts["Birthday party for Maya"].exists, "the preview's name is not the row's")
        let messages = preview.descendants(matching: .any).matching(NSPredicate(format: "label != %@ AND label != %@", "", "Birthday party for Maya"))
        XCTAssertTrue(until(8) { messages.count > 0 }, "the preview shows no messages")
        // References read as names, as desktop shows them: no raw tag.
        let raw = NSPredicate(format: "label CONTAINS %@", "<happy-")
        XCTAssertEqual(preview.descendants(matching: .any).matching(raw).count, 0, "the preview shows a raw reference tag")
        // Telegram's size: 12 from either edge, at most 460 tall, the menu 10 under it.
        XCTAssertEqual(preview.frame.minX, 12, accuracy: 0.5)
        XCTAssertEqual(preview.frame.width, screen.width - 24, accuracy: 0.5)
        XCTAssertLessThanOrEqual(preview.frame.height, 460.5)
        XCTAssertGreaterThan(preview.frame.height, 300)
        let menu = app.descendants(matching: .any)["hold-menu"]
        XCTAssertTrue(menu.exists, "no menu under the preview")
        XCTAssertEqual(menu.frame.minY, preview.frame.maxY + 10, accuracy: 0.5)
        XCTAssertEqual(menu.frame.maxX, preview.frame.maxX, accuracy: 0.5)
        // Only what changes the row: its name, putting it away.
        XCTAssertTrue(menu.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Rename")).count == 1, "no Rename in the menu")
        XCTAssertFalse(menu.buttons["Reorder"].exists, "the menu still offers Reorder")
        for gone in ["Open", "Show subtasks", "Hide subtasks", "Collapse", "Expand", "Mark as read", "Mark as unread"] {
            XCTAssertFalse(menu.buttons[gone].exists, "the menu still offers \(gone)")
        }
        pause(1.5)
        capture("hold-preview")
        // Let go, it stayed; a tap on it opens the conversation.
        preview.tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 4), "tapping the preview didn't open the conversation")
        XCTAssertTrue(until(4) { app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Guest list")).count > 0 }, "the conversation doesn't name its subtask")
        XCTAssertEqual(app.descendants(matching: .any).matching(raw).count, 0, "the conversation shows a raw reference tag")
        XCTAssertFalse(preview.exists)
        pause(1)
        capture("hold-opened")
        app.tapBack()
        pause(1)

        // Rename from the menu: the preview goes and the row's title is a field.
        let (from, to) = row("space", "Organize garage sale").waitForExistence(timeout: 3) ? ("Organize garage sale", "Garage sale prep") : ("Garage sale prep", "Organize garage sale")
        let task = row("space", from)
        bringIntoView(task)
        pause(1)
        task.press(forDuration: 1.0)
        let rename = app.buttons["Rename task"]
        XCTAssertTrue(rename.waitForExistence(timeout: 3))
        rename.tap()
        let field = app.textFields["rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 3), "Rename didn't edit the row")
        XCTAssertFalse(app.descendants(matching: .any)["preview"].exists)
        field.typeText(to)
        pause(0.6)
        capture("hold-rename-typed")
        field.typeText("\n")
        XCTAssertTrue(row("space", to).waitForExistence(timeout: 2))
        pause(3)
        XCTAssertTrue(row("space", to).exists, "the name went back")

        // A sideways pull opens nothing and moves nothing.
        let renamed = row("space", to)
        let before = renamed.frame
        renamed.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)).press(forDuration: 0.01, thenDragTo: renamed.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)), withVelocity: .fast, thenHoldForDuration: 0)
        pause(1)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "swipe")).count, 0, "a pull still uncovers actions")
        XCTAssertEqual(renamed.frame.minX, before.minX, accuracy: 0.5)

        // A throwaway bot the run made, archived from its menu.
        let bot = row("space", "Hold Me")
        if bot.waitForExistence(timeout: 2) {
            bringIntoView(bot)
            pause(1)
            bot.press(forDuration: 1.0)
            let archive = app.buttons["Archive bot"]
            XCTAssertTrue(archive.waitForExistence(timeout: 3))
            pause(1)
            capture("hold-archive")
            archive.tap()
            XCTAssertTrue(until(10) { !bot.exists }, "the archived bot stayed")
            pause(1)
            capture("hold-archived")
        } else {
            XCTFail("no Hold Me bot to archive")
        }
    }

    /// Search in place, on home itself: the header's search button grows
    /// into a field with the keyboard up and nothing pushed; typing narrows
    /// the sidebar (a folded section's rows too), quick actions and
    /// settings coming under it, or alone when no row answers; a setting
    /// found opens Settings on its row; Cancel folds the field back and
    /// the list is as it was, folds and scroll and all.
    func testInlineSearch() {
        home()
        pause(1.5)
        // A fold to keep: Bots folded, its rows gone.
        let bots = row("section", "Bots")
        XCTAssertTrue(bots.waitForExistence(timeout: 5), "no Bots section")
        bringIntoView(bots)
        if row("space", "Chef").exists { bots.tap(); pause(1.5) }
        XCTAssertFalse(row("space", "Chef").exists, "Bots didn't fold")
        // And somewhere down the list, to come back to.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(
            forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)),
            withVelocity: .slow, thenHoldForDuration: 0.5
        )
        pause(1.5)
        let before = shownRows("row:")
        XCTAssertFalse(before.isEmpty)
        capture("search-before")

        let field = app.textFields["search-field"]
        app.buttons["search"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 3), "search didn't open in the header")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "no keyboard")
        XCTAssertTrue(until(3) { field.value(forKey: "hasKeyboardFocus") as? Bool == true }, "the caret isn't in the field")
        // The keyboard's first-run tip, on a fresh simulator.
        if app.buttons["Continue"].waitForExistence(timeout: 1) { app.buttons["Continue"].tap(); pause(0.5) }
        // Nothing pushed: home's rows are still the screen, with no back.
        XCTAssertFalse(app.buttons["glass-back"].exists, "search pushed a screen")
        XCTAssertTrue(row("space", "Plan Lisbon trip").exists)
        pause(1)
        capture("search-open")

        app.typeText("lis")
        XCTAssertTrue(until(3) { !self.row("space", "Renew passport").exists }, "the list didn't narrow")
        XCTAssertTrue(row("space", "Plan Lisbon trip").exists, "the match went")
        XCTAssertTrue(row("section", "Tasks").exists, "the match lost its section")
        pause(1)
        capture("search-lis")

        // A folded section's rows answer too.
        clear(field)
        app.typeText("chef")
        XCTAssertTrue(row("space", "Chef").waitForExistence(timeout: 3), "a folded row isn't found")
        XCTAssertTrue(row("section", "Bots").exists)

        // Rows, then quick actions and settings under them.
        clear(field)
        app.typeText("re")
        XCTAssertTrue(row("result", "Report an Issue").waitForExistence(timeout: 3), "no settings under the rows")
        XCTAssertTrue(row("section", "Settings").exists)
        XCTAssertTrue(row("section", "Quick actions").exists)
        XCTAssertTrue(row("space", "Renew passport").exists)
        XCTAssertLessThan(row("space", "Renew passport").frame.minY, row("section", "Quick actions").frame.minY, "the actions aren't under the rows")
        XCTAssertLessThan(row("section", "Quick actions").frame.minY, row("section", "Settings").frame.minY, "settings aren't under the actions")
        pause(1)
        capture("search-both")
        // Under the rows, the quick actions and then the settings; a drag
        // puts the keyboard away and keeps what was found.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(
            forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)),
            withVelocity: .slow, thenHoldForDuration: 0.3
        )
        pause(1)
        XCTAssertTrue(until(3) { !self.app.keyboards.firstMatch.exists }, "a drag kept the keyboard")
        XCTAssertTrue(row("result", "Report an Issue").isHittable)
        capture("search-both-results")
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))

        clear(field)
        app.typeText("zzqx")
        XCTAssertTrue(app.staticTexts["search-nothing"].waitForExistence(timeout: 3), "nothing said nothing was found")
        pause(0.5)
        capture("search-nothing")

        // No row answers: the settings alone.
        clear(field)
        app.typeText("theme")
        let theme = row("result", "Theme")
        XCTAssertTrue(theme.waitForExistence(timeout: 3), "no Theme setting")
        XCTAssertTrue(shownRows("row:space:").isEmpty && shownRows("row:session:").isEmpty, "rows answered theme")
        pause(1)
        capture("search-settings-only")

        // It opens Settings on its row.
        theme.tap()
        XCTAssertTrue(app.descendants(matching: .any)["settings"].waitForExistence(timeout: 5), "Settings didn't open")
        let themeRow = app.descendants(matching: .any)["settings:theme"]
        XCTAssertTrue(themeRow.waitForExistence(timeout: 3))
        XCTAssertTrue(until(3) { themeRow.isHittable }, "Theme isn't on screen")
        pause(0.3)
        capture("search-opened-setting")
        pause(1.5)
        closeSettings()
        // Back on home, the search as it was left.
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        XCTAssertEqual(field.value as? String, "theme")
        XCTAssertTrue(theme.exists)

        // Cancel: the field folds back, the list as it was.
        app.buttons["search-cancel"].tap()
        XCTAssertTrue(until(3) { !field.exists || !field.isHittable }, "the field stayed")
        XCTAssertTrue(until(3) { !self.app.keyboards.firstMatch.exists }, "the keyboard stayed")
        pause(1.5)
        capture("search-restored")
        XCTAssertFalse(row("space", "Chef").exists, "the fold was lost")
        let after = shownRows("row:")
        XCTAssertEqual(after.map(\.identifier), before.map(\.identifier), "other rows came back")
        for (one, two) in zip(before, after) {
            XCTAssertEqual(one.frame.minY, two.frame.minY, accuracy: 1, "\(one.identifier) moved: the scroll wasn't kept")
        }
        // Bots open again, as the daemon had it.
        bringIntoView(bots)
        bots.tap()
        pause(1)
    }

    /// Empties the search field with the keyboard's delete.
    private func clear(_ field: XCUIElement) {
        let text = field.value as? String ?? ""
        app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: text.count))
        pause(0.4)
    }

    /// New work makes only new work: its intro offers no todo list,
    /// document, calendar, chat or bot to make instead.
    func testNoOffers() {
        home()
        pause(1.5)
        app.descendants(matching: .any)["new-work"].tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 5))
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        XCTAssertTrue(app.staticTexts["Say what it is — it’ll find its place."].waitForExistence(timeout: 5))
        pause(1.5)
        capture("no-offers")
        XCTAssertFalse(app.staticTexts["Or start one of these:"].exists, "new work still offers things to start")
        let offers = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "offer"))
        XCTAssertEqual(offers.count, 0, "new work still offers things to make")
        for gone in ["New todo list", "New document", "New calendar", "New system monitor", "New chat", "New bot"] {
            XCTAssertFalse(app.buttons[gone].exists, "new work still offers \(gone)")
        }
        app.tapBack()
        pause(1)
        let fresh = row("space", "New").firstMatch
        if fresh.exists {
            fresh.press(forDuration: 1.0)
            let close = app.buttons["Close new work"]
            if close.waitForExistence(timeout: 3) { close.tap() }
            pause(1)
        }
    }

    /// Home as it looks: the sidebar on the chat's own ground, unread rows
    /// bold and nothing red beside them. The harness runs it light and dark.
    func testSidebarLook() {
        home()
        pause(2)
        capture("sidebar-look")
        app.descendants(matching: .any)["new-work"].tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 5))
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        pause(1.5)
        capture("sidebar-look-chat")
        app.tapBack()
        pause(1)
        let fresh = row("space", "New").firstMatch
        if fresh.exists {
            fresh.press(forDuration: 1.0)
            let discard = app.buttons["Close new work"]
            if discard.waitForExistence(timeout: 3) { discard.tap() }
            pause(1)
        }
    }

    /// Two tasks set working on the computer (the driver's `work-rows`):
    /// their titles and row heights stay fixed in both themes. Braille
    /// lifecycle and run-state transitions are covered by UIKit tests.
    func testWorkingRowsKeepTheirTitlesAndHeight() {
        home()
        pause(2)
        // The computer's Theme, gone round to `name`; what it was before.
        @discardableResult func theme(_ name: String) -> String {
            app.descendants(matching: .any)["settings-mark"].tap()
            let row = app.descendants(matching: .any)["settings:theme"]
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            let was = row.label
            for _ in 0..<3 where !row.label.contains(name) {
                row.tap()
                pause(0.8)
            }
            XCTAssertTrue(row.label.contains(name), "the theme never reached \(name)")
            app.buttons["glass-back"].firstMatch.tap()
            pause(1.5)
            return was
        }
        let was = theme("Light")
        let env = ProcessInfo.processInfo.environment
        let garden = row("space", env["HAPPY_WORK_ROW"] ?? "Plan the garden beds")
        let flights = row("space", env["HAPPY_WORK_ROW_2"] ?? "Compare flight prices")
        let idle = row("space", env["HAPPY_IDLE_ROW"] ?? "Draft the newsletter")
        XCTAssertTrue(garden.waitForExistence(timeout: 8))
        // Somewhere clear of the bars and the dock; the list may end too
        // soon to bring it higher.
        func show(_ row: XCUIElement) {
            let height = app.frame.height
            if row.frame.midY < height * 0.15 || row.frame.midY > height * 0.75 { bringIntoView(row) }
        }
        show(garden)
        let title = garden.label
        let height = garden.frame.height
        capture("braille-before")
        print("HAPPY_STEP work-rows")
        for frame in 0..<6 {
            XCTAssertEqual(garden.label, title)
            XCTAssertEqual(garden.frame.height, height)
            for element in [garden, flights, idle] {
                XCTAssertFalse((element.value as? String)?.contains("working") == true)
            }
            capture("braille-light-\(frame)")
            pause(0.27)
        }
        theme("Dark")
        show(garden)
        for frame in 0..<6 {
            XCTAssertEqual(garden.label, title)
            XCTAssertEqual(garden.frame.height, height)
            capture("braille-dark-\(frame)")
            pause(0.27)
        }
        for name in ["Adaptive", "Light", "Dark"] where was.contains(name) { theme(name); break }
    }

    /// An unread conversation opened and left reads as read: its row's
    /// title is no longer bold, here and on the computer (the harness
    /// checks the daemon after).
    func testUnreadClears() {
        home()
        pause(1.5)
        capture("unread-before")
        row("space", "Pasted from").firstMatch.tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 8))
        pause(3)
        app.tapBack()
        pause(2)
        capture("unread-after")
    }

    /// A row that folds, selected: its mark and its fold each centred
    /// half the row in from its ends, folded and open (the frames are
    /// pinned in LayoutTests; this is how it looks).
    func testRowBalance() {
        home()
        pause(1.5)
        let happy = row("space", "Happy")
        XCTAssertTrue(happy.waitForExistence(timeout: 5))
        happy.tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 8))
        pause(1)
        app.tapBack()
        pause(1.5)
        capture("balance-closed")
        // The fold, at the row's end.
        let rowsClosed = shownRows("row:").count
        tapChevron(happy)
        XCTAssertTrue(until(3) { self.shownRows("row:").count != rowsClosed }, "the fold didn't open")
        pause(1.5)
        capture("balance-open")
        tapChevron(happy)
        XCTAssertTrue(until(3) { self.shownRows("row:").count == rowsClosed }, "the fold didn't close")
        pause(1)
    }

    /// Into a conversation from the sidebar and back, slowly enough to
    /// watch its header come in (the harness slows the recording).
    func testOpenFromSidebar() {
        // UIKit's own slow motion, the simulator's Slow Animations: 4 is 0.25x.
        if let drag = ProcessInfo.processInfo.environment["HAPPY_ANIMATION_DRAG"] {
            app.launchEnvironment["UIAnimationDragCoefficient"] = drag
            app.launch()
        }
        home()
        pause(1.5)
        let target = row("space", "Pasted from").firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        target.tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 8))
        pause(2)
        app.tapBack()
        pause(1.5)
        target.tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 8))
        pause(2)
        app.tapBack()
        pause(1.5)
    }

    /// Conversations read ahead open drawn: several sidebar rows, each
    /// pushed with its transcript on the push's first frame, timed from
    /// the tap until it was on screen. `V2_WARM=0` is the cold "before",
    /// timed the same way.
    func testWarmOpens() {
        let warm = ProcessInfo.processInfo.environment["HAPPY_WARM"] != "0"
        if !warm { app.launchEnvironment["HAPPY_WARM"] = "0" }
        // Slowed for the recording, the screens take that much longer.
        var slow = 1.0
        if let drag = ProcessInfo.processInfo.environment["HAPPY_ANIMATION_DRAG"] {
            app.launchEnvironment["UIAnimationDragCoefficient"] = drag
            slow = Double(drag) ?? 1
        }
        app.launch()
        home()
        // Desktop's 1.5s before reading ahead, then one conversation at a time.
        pause(6)
        var opened: [String] = []
        // Whatever rows show whole between the bar and the dock, top first,
        // once each: other tests reorder the sidebar.
        let dock = app.descendants(matching: .any)["new-work"].frame.minY
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:space:")).allElementsBoundByIndex
            .filter { $0.frame.minY > 100 && $0.frame.maxY < dock - 30 }
            .sorted { $0.frame.minY < $1.frame.minY }
        var labels: [String] = []
        for element in rows {
            let label = String(element.identifier.dropFirst("row:space:".count))
            if !labels.contains(label) { labels.append(label) }
        }
        for label in labels {
            let target = row("space", label).firstMatch
            guard target.exists, target.isHittable else { continue }
            target.tap()
            let transcript = transcriptElement
            XCTAssertTrue(transcript.waitForExistence(timeout: 8), "\(label) didn't open")
            var value = ""
            let deadline = Date().addingTimeInterval(10)
            while Date() < deadline {
                value = transcript.value as? String ?? ""
                if !value.isEmpty { break }
                pause(0.1)
            }
            print("HAPPY_TIMING \(warm ? "warm" : "cold") \(label): \(value)")
            XCTAssertTrue(value.contains("rows="), "\(label) never showed its transcript")
            if warm {
                XCTAssertTrue(value.hasPrefix("first=true"), "\(label) opened without its transcript: \(value)")
                // An empty one (a bot just made) is drawn too, with nothing in it.
                if !value.hasSuffix("rows=0") {
                    XCTAssertTrue(app.descendants(matching: .any)["message"].firstMatch.exists, "\(label) has no message")
                }
            }
            capture("warm-\(opened.count)")
            opened.append(label)
            pause(1.5 * slow)
            app.tapBack()
            pause(1.5 * slow)
            if opened.count == 4 { break }
        }
        XCTAssertGreaterThanOrEqual(opened.count, 3, "too few conversations on screen: \(opened)")
        // One left a moment ago comes back drawn too.
        if warm, let first = opened.first {
            row("space", first).firstMatch.tap()
            let transcript = transcriptElement
            XCTAssertTrue(transcript.waitForExistence(timeout: 8))
            var value = ""
            for _ in 0..<100 where value.isEmpty {
                value = transcript.value as? String ?? ""
                if value.isEmpty { pause(0.1) }
            }
            print("HAPPY_TIMING warm \(first) again: \(value)")
            XCTAssertTrue(value.hasPrefix("first=true"), "\(first) came back without its transcript: \(value)")
            pause(1.5 * slow)
            app.tapBack()
        }
    }

    /// The header's capsule runs to the right edge and opens the
    /// conversation's detail, never a rename: its model, effort and start;
    /// what it shared (a grid of its pictures, recordings and files, each
    /// opened whole, then its links); at the top level no family but its
    /// children; nested, its parent, siblings and children, each opening
    /// its conversation. Needs `shared_fixture.py`'s links and pictures.
    func testSessionDetail() {
        home()
        pause(1)
        let bot = row("space", "Research Assistant")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let title = app.descendants(matching: .any)["chat-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        pause(1)
        capture("detail-header")
        // The capsule's far right, well past the name, still opens it.
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.width - 30, dy: title.frame.midY)).tap()
        let detail = app.descendants(matching: .any)["detail"]
        XCTAssertTrue(detail.waitForExistence(timeout: 5), "the capsule's right end didn't open the detail")
        XCTAssertFalse(app.textFields["chat-title-field"].exists, "the header renamed")
        XCTAssertEqual(app.staticTexts["detail-name"].label, "Research Assistant")
        assertTiles()
        assertPencil()
        // At the top level: no section, no siblings.
        let family = app.descendants(matching: .any)["detail-family"]
        if family.exists {
            let tops = family.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:space:")).allElementsBoundByIndex.map(\.identifier)
            XCTAssertEqual(tops, ["row:space:Research Assistant"], "a top-level conversation showed siblings")
        }
        XCTAssertFalse(family.exists && family.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:section:")).firstMatch.exists, "a top-level conversation showed its section")
        // What it shared: its media first, a grid.
        let cells = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "detail-media:"))
        XCTAssertTrue(cells.firstMatch.waitForExistence(timeout: 10), "no shared media")
        pause(1.5)
        capture("detail-top")
        let first = cells.element(boundBy: 0).frame
        let second = cells.element(boundBy: 1).frame
        XCTAssertEqual(first.width, first.height, accuracy: 1, "a cell isn't square")
        XCTAssertEqual(second.minY, first.minY, accuracy: 1, "the grid isn't in rows")
        bringIntoView(cells.firstMatch)
        pause(1)
        capture("detail-media")
        let more = app.descendants(matching: .any)["detail-media-more"]
        if more.exists {
            let before = cells.count
            bringIntoView(more)
            more.tap()
            XCTAssertTrue(until(10) { cells.count > before }, "Show more showed no more")
            pause(1.5)
            capture("detail-media-more")
        }
        // A picture opens whole, paging through the rest.
        let picture = cells.matching(NSPredicate(format: "label ENDSWITH %@ OR label == %@", ".png", "Picture")).firstMatch
        XCTAssertTrue(picture.exists, "no picture among the media")
        bringIntoView(picture)
        picture.tap()
        XCTAssertTrue(app.images["picture-viewer"].waitForExistence(timeout: 5), "the picture didn't open")
        pause(2)
        capture("detail-viewer")
        app.swipeLeft()
        pause(1.5)
        capture("detail-viewer-next")
        app.buttons["Close"].tap()
        XCTAssertTrue(until(3) { !self.app.images["picture-viewer"].exists })
        pause(1)
        // Then its links, each a title over its address.
        let link = app.descendants(matching: .any)["detail-link:https://telegram.org/blog/shared-media"]
        XCTAssertTrue(link.waitForExistence(timeout: 10), "no shared links")
        XCTAssertEqual(link.label, "Telegram's shared media")
        XCTAssertEqual(link.value as? String, "telegram.org/blog/shared-media")
        XCTAssertTrue(app.descendants(matching: .any)["detail-link:https://crdt.tech/"].exists)
        bringIntoView(link)
        pause(1)
        capture("detail-links")
        app.tapBack()
        XCTAssertTrue(title.waitForExistence(timeout: 5), "back didn't come back to the conversation")
        pause(1)
        app.tapBack()
        pause(1)

        // Nested: Day Trips, a subtask of Plan Lisbon trip.
        let task = row("space", "Plan Lisbon trip")
        if !task.waitForExistence(timeout: 3) { openFoldedSections() }
        XCTAssertTrue(task.waitForExistence(timeout: 5))
        bringIntoView(task)
        let trips = row("session", "Day Trips")
        if !(trips.exists && trips.isHittable) {
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: task.frame.maxX - 25, dy: task.frame.midY)).tap()
        }
        XCTAssertTrue(until(5) { trips.exists && trips.isHittable }, "Day Trips isn't under its task")
        trips.tap()
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        pause(1)
        title.tap()
        XCTAssertTrue(detail.waitForExistence(timeout: 5), "the capsule didn't open the subtask's detail")
        assertTiles()
        XCTAssertTrue(family.waitForExistence(timeout: 5), "a subtask has no family")
        // First, right under its name, before the tiles.
        let model = app.descendants(matching: .any)["detail-tile:model"]
        XCTAssertGreaterThan(family.frame.minY, app.staticTexts["detail-subtitle"].frame.maxY, "the family isn't under the name")
        XCTAssertLessThan(family.frame.maxY, model.frame.minY, "the family isn't before the tiles")
        XCTAssertFalse(app.buttons["detail-rename-button"].exists, "a subtask offered a rename")
        for (id, what) in [("row:space:Plan Lisbon trip", "its parent"), ("row:session:Day Trips", "itself"), ("row:session:Neighbourhoods", "its sibling"), ("row:session:Best train day trip", "its child")] {
            XCTAssertTrue(family.descendants(matching: .any)[id].exists, "the family lacks \(what)")
        }
        XCTAssertTrue(cells.firstMatch.waitForExistence(timeout: 10), "the subtask's pictures aren't shared")
        XCTAssertEqual(cells.count, 3)
        XCTAssertTrue(app.descendants(matching: .any)["detail-link:https://www.visitcascais.com/en"].waitForExistence(timeout: 5))
        pause(1.5)
        capture("detail-nested-top")
        bringIntoView(app.descendants(matching: .any)["detail-links"])
        pause(1)
        capture("detail-nested-shared")
        bringIntoView(family)
        pause(1)
        capture("detail-nested-family")
        // A sibling opens its own conversation; back comes back here.
        family.descendants(matching: .any)["row:session:Neighbourhoods"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "chat-title", "Neighbourhoods")).firstMatch.waitForExistence(timeout: 8), "the sibling didn't open")
        pause(1.5)
        app.tapBack()
        XCTAssertTrue(detail.waitForExistence(timeout: 5), "back didn't come back to the detail")
        pause(1)
        app.tapBack()
        pause(1)
        app.tapBack()
    }

    /// A 30-line message, sent: its bubble shows desktop's first ten lines
    /// and Show full under them (10 + 10 × 24 + 8 + 16 + 10, 8 above and
    /// below), a tap opens all 30 (some wrapped), and another cuts it back.
    func testLongMessageFolds() {
        home()
        pause(1)
        let bot = row("space", "Research Assistant")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(2)
        let mark = "Fold check \(Int(Date().timeIntervalSince1970))"
        // Every third line runs past a bubble's width and wraps.
        let text = ([mark] + (2...30).map { "Line \($0) of 30" + ($0 % 3 == 0 ? ", long enough to run the whole width of the bubble and wrap" : "") }).joined(separator: "\n")
        composer.tap()
        composer.typeText(text)
        pause(1)
        app.buttons["Send"].tap()
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        let message = app.descendants(matching: .any).matching(identifier: "message").matching(NSPredicate(format: "label BEGINSWITH %@", mark)).firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 10), "the message isn't in the chat")
        // The keyboard dragged down, the message where it can be read.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(
            forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)), withVelocity: .slow, thenHoldForDuration: 0.2
        )
        pause(2)
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the keyboard is still up")
        bringIntoView(message)
        pause(1)
        capture("fold-closed")
        XCTAssertEqual(message.frame.height, 300, accuracy: 18, "the message isn't cut to ten lines")
        message.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)).tap()
        pause(1.5)
        bringIntoView(message)
        capture("fold-open")
        XCTAssertGreaterThan(message.frame.height, 780, "the tap didn't open all thirty lines")
        message.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)).tap()
        pause(1.5)
        XCTAssertEqual(message.frame.height, 300, accuracy: 18, "a second tap didn't cut it back")
        app.tapBack()
    }

    /// Pulled past either end and held there, the finger still pulling
    /// slowly a long way, three times over: the detail stretches under the
    /// finger and settles back. The content never steps back against the
    /// pull, and what sat on screen before the pulls sits in the same place
    /// after them.
    func testSessionDetailBounce() {
        pullPastTheEnds(probe: "watch", distance: (0.72, 0.12), velocity: 120, hold: 2)
    }

    /// The same while the screen is laid out again on every frame, as a
    /// working conversation lays it out (`V2_DETAIL_PROBE=relayout`).
    func testSessionDetailBounceWhileWorking() {
        pullPastTheEnds(probe: "relayout", distance: (0.75, 0.3), velocity: 300, hold: 1.2)
    }

    private func pullPastTheEnds(probe: String, distance: (from: CGFloat, to: CGFloat), velocity: XCUIGestureVelocity, hold: TimeInterval) {
        app.terminate()
        app.launchEnvironment["HAPPY_DETAIL_PROBE"] = probe
        app.launch()
        home()
        pause(1)
        let bot = row("space", "Research Assistant")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let title = app.descendants(matching: .any)["chat-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        pause(1)
        title.tap()
        XCTAssertTrue(app.descendants(matching: .any)["detail"].waitForExistence(timeout: 5))
        let media = app.descendants(matching: .any)["detail-media"]
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "detail-media:")).firstMatch.waitForExistence(timeout: 10), "no shared media")
        let scroll = app.scrollViews["detail-scroll"]
        XCTAssertTrue(scroll.waitForExistence(timeout: 5), "the probe isn't on")
        pause(2)
        let low = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: distance.from))
        let high = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: distance.to))
        let name = app.staticTexts["detail-name"]
        // Each end in turn: brought there, pulled past it three times and
        // let go, the content where it was.
        for (end, toEnd, from, to) in [("bottom", { self.app.swipeUp(velocity: .fast) }, low, high), ("top", { self.app.swipeDown(velocity: .fast) }, high, low)] {
            for _ in 0..<8 { toEnd() }
            pause(2)
            let anchor = end == "top" ? name : media
            let before = anchor.frame
            capture("bounce-\(end)-before")
            for _ in 0..<3 {
                from.press(forDuration: 0.05, thenDragTo: to, withVelocity: velocity, thenHoldForDuration: hold)
                pause(1.5)
            }
            capture("bounce-\(end)-after")
            XCTAssertEqual(anchor.frame.minY, before.minY, accuracy: 0.5, "pulled past the \(end), the content didn't settle where it was")
            XCTAssertEqual(anchor.frame.height, before.height, accuracy: 0.5)
        }
        let value = scroll.value as? String ?? ""
        print("HAPPY_BOUNCE \(probe) \(value)")
        let counts = Dictionary(uniqueKeysWithValues: value.split(separator: " ").compactMap { pair -> (String, Int)? in
            let parts = pair.split(separator: "=")
            guard parts.count == 2, let count = Int(parts[1]) else { return nil }
            return (String(parts[0]), count)
        })
        XCTAssertGreaterThan(counts["stretched"] ?? 0, 60, "the pulls never stretched it: \(value)")
        XCTAssertEqual(counts["backwards"], 0, "the content stepped back against the pull: \(value)")
    }

    /// The chat pulled past its newest row and held there, the finger still
    /// pulling slowly, three times over, while a reply streams in: the
    /// content never steps back against the pull, nothing writes the
    /// transcript's height, inset or offset while it is held stretched, and
    /// let go it settles on the newest line. Needs the e2e computer's fake
    /// model (`fakellm.py`), which streams "stream P W": P paragraphs, W ms
    /// a word, in the conversation `V2_STREAM_ROW` (Stream Lab).
    func testChatBounceWhileStreaming() {
        let composer = openStreamLab(probe: "watch")
        send(composer, "stream 40 30")
        let working = app.descendants(matching: .any)["working"]
        XCTAssertTrue(working.waitForExistence(timeout: 15), "the reply never started")
        let transcript = transcriptElement
        // Long enough to scroll before the pulls.
        pause(8)
        dismissKeyboard()
        toNewest()
        capture("chat-bounce-before")
        let low = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        let high = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
        for _ in 0..<3 {
            XCTAssertTrue(working.exists, "the reply ended before the pulls did")
            low.press(forDuration: 0.05, thenDragTo: high, withVelocity: 120, thenHoldForDuration: 2)
            pause(1.5)
        }
        capture("chat-bounce-after")
        let counts = probeCounts(transcript)
        print("HAPPY_CHAT_BOUNCE \(transcript.value as? String ?? "")")
        XCTAssertGreaterThan(counts["stretched"] ?? 0, 60, "the pulls never stretched it")
        XCTAssertEqual(counts["backwards"], 0, "the content stepped back against the pull")
        XCTAssertEqual(counts["held"], 0, "the transcript was written while held stretched")
        // Let go, it follows the reply again: the newest row ends over the composer.
        let messages = app.descendants(matching: .any).matching(identifier: "message")
        let input = app.descendants(matching: .any)["input"]
        pause(1)
        let newest = messages.element(boundBy: messages.count - 1).frame
        XCTAssertLessThan(newest.maxY, input.frame.minY + 1, "the newest row went under the composer")
        XCTAssertGreaterThan(newest.maxY, input.frame.minY - 120, "it didn't follow the reply once let go")
        // The turn over, back as it was.
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, working.exists { pause(1) }
    }

    /// Uses the same paired synthetic conversation as the streaming checks.
    func checkComposerTracksHeldKeyboardDrag() {
        XCUIDevice.shared.orientation = .portrait
        let composer = openStreamLab(probe: "watch")
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        pause(1.5)
        let input = app.descendants(matching: .any)["input"]
        let keyboard = app.keyboards.firstMatch.frame
        print("HAPPY_KEYBOARD before input=\(input.frame) keyboard=\(keyboard) probe=\(transcriptElement.value ?? "")")
        let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.midX, dy: input.frame.minY - 40))
        let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.midX, dy: keyboard.minY + 110))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: 160, thenHoldForDuration: 2)
        pause(1)
        let value = transcriptElement.value as? String ?? ""
        print("HAPPY_KEYBOARD after \(value)")
        capture("keyboard-held-drag")
        let fields = Dictionary(uniqueKeysWithValues: value.split(separator: " ").compactMap { item -> (String, Double)? in
            let pair = item.split(separator: "=")
            guard pair.count == 2, let number = Double(pair[1]) else { return nil }
            return (String(pair[0]), number)
        })
        XCTAssertGreaterThan(fields["keyboardFrames"] ?? 0, 20, "the keyboard was never held partially dismissed")
        XCTAssertLessThan(fields["keyboardGap"] ?? 999, 2, "the composer left the keyboard while the finger held it")
    }

    /// A send against a streaming reply, step by step: a send by a reader
    /// at the end lands at the foot, over the composer, and nothing is
    /// held under it; the turns above it move up by what the send is tall
    /// and no further; a send mid-turn does the same; and a send made
    /// while reading history moves nothing at all, with a way back to the
    /// newest. This is where the transcript used to lift a send 30% down
    /// the viewport, which read as the chat jumping away on send
    /// (`SendFollow`). Needs `fakellm.py` as above.
    func testASendLandsAtTheFootAndLiftsNothing() throws {
        defer { XCUIDevice.shared.orientation = .portrait }
        let composer = openStreamLab(probe: "watch")
        let transcript = transcriptElement
        let messages = app.descendants(matching: .any).matching(identifier: "message")
        let input = app.descendants(matching: .any)["input"]
        // Each run's sends are its own: the conversation keeps the last run's.
        let run = String(Int(Date().timeIntervalSince1970) % 100_000)
        func say(_ text: String) -> XCUIElement {
            send(composer, "\(text) \(run)")
            return app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "message", "\(text) \(run)")).firstMatch
        }
        composer.tap()
        pause(1)
        func assertKeyboardDock(file: StaticString = #filePath, line: UInt = #line) {
            // XCUI's keyboard frame can exclude the 44pt prediction strip.
            // The UIKit keyboard notification includes it; the card sits
            // eight points above that full frame in either orientation.
            let gap = app.keyboards.firstMatch.frame.minY - input.frame.maxY
            XCTAssertTrue(abs(gap - 8) <= 2 || abs(gap - 52) <= 2,
                          "the composer does not ride the full keyboard (XCUI gap \(gap))", file: file, line: line)
        }
        assertKeyboardDock()
        // Leave enough time for XCUI's screenshot and repeated accessibility
        // reads before the first reply word; those reads take seconds.
        let first = say("stream 1 20 wait 10000 first")
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        pause(0.2)
        let top = app.navigationBars.firstMatch.frame.maxY
        let viewport = input.frame.minY - 8 - top
        let firstID = (first.value as? String)?.components(separatedBy: ",").first
        let firstY = first.frame.minY
        print("HAPPY_SEND initial \(first.value ?? "") frame=\(first.frame)")
        capture("send-1-landed")
        XCTAssertLessThan(first.frame.maxY, input.frame.minY + 1, "the send went under the composer")
        XCTAssertGreaterThan(first.frame.maxY, input.frame.minY - 24, "the send isn't at the foot: \(first.frame)")
        XCTAssertGreaterThan(first.frame.minY - top, (viewport * 0.3).rounded() + 40,
                             "the send was lifted towards the old 30% line (viewport \(viewport))")
        pause(0.5)
        XCTAssertNotNil(firstID)
        XCTAssertEqual((first.value as? String)?.components(separatedBy: ",").first, firstID)
        XCTAssertEqual(first.frame.minY, firstY, accuracy: 1, "accepting the send moved its row before the reply")
        print("HAPPY_SEND accepted \(first.value ?? "") frame=\(first.frame)")
        pause(16)
        capture("send-2-reply")
        let end = messages.allElementsBoundByIndex.map(\.frame).filter { $0.minY < input.frame.minY && $0.maxY > top }.map(\.maxY).max() ?? 0
        XCTAssertEqual(end, input.frame.minY - 8, accuracy: 6, "the reply's end isn't followed")

        // A send during a reply is appended at the end too.
        let mid = say("stream 2 20 midturn")
        XCTAssertTrue(mid.waitForExistence(timeout: 5))
        pause(0.8)
        // Keep the reply out of the screenshot/AX reads: once it arrives,
        // following it correctly carries this older user row upwards.
        let second = say("stream 1 5 wait 10000 alsomidturn")
        XCTAssertTrue(second.waitForExistence(timeout: 5))
        pause(0.8)
        capture("send-3-midturn")
        XCTAssertLessThan(second.frame.maxY, input.frame.minY + 1, "a send mid-turn is under the composer")
        XCTAssertGreaterThan(second.frame.minY - top, (viewport * 0.3).rounded() + 40, "a send mid-turn was lifted")
        pause(12)
        XCUIDevice.shared.orientation = .landscapeLeft
        pause(1.5)
        capture("send-landscape-keyboard")
        assertKeyboardDock()
        let landscapeEnd = messages.allElementsBoundByIndex.map(\.frame).filter { $0.minY < input.frame.minY }.map(\.maxY).max() ?? 0
        XCTAssertEqual(landscapeEnd, input.frame.minY - 8, accuracy: 6, "rotation put the newest message under the composer")
        XCUIDevice.shared.orientation = .portrait
        pause(1.5)

        // Actually move into history. UltraList keeps a window, so retain
        // a visible row by identity rather than by its index in that window.
        dismissKeyboard()
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the transcript did not dismiss the keyboard interactively")
        for _ in 0..<3 { transcript.swipeDown(velocity: .fast) }
        composer.tap()
        pause(1)
        let visible = messages.allElementsBoundByIndex.filter { $0.frame.maxY > top + 40 && $0.frame.minY < input.frame.minY - 40 }
        let anchor = try XCTUnwrap(visible.first, "no history row is visible")
        let anchorLabel = anchor.label
        let anchorID = (anchor.value as? String)?.components(separatedBy: ",").first
        XCTAssertNotNil(anchorID)
        let parked = anchor.frame.minY
        print("HAPPY_SEND history-before \(anchor.value ?? "") frame=\(anchor.frame)")
        _ = say("stream 1 5 parked")
        pause(1.5)
        capture("send-4-parked")
        let kept = messages.matching(NSPredicate(format: "label == %@", anchorLabel)).firstMatch
        XCTAssertTrue(kept.exists, "sending unmounted the history anchor")
        XCTAssertEqual((kept.value as? String)?.components(separatedBy: ",").first, anchorID)
        XCTAssertEqual(kept.frame.minY, parked, accuracy: 1, "a send from history moved the reader")
        print("HAPPY_SEND history-after \(kept.value ?? "") frame=\(kept.frame)")
        XCTAssertTrue(app.descendants(matching: .any)["jump-latest"].exists, "no way back to the newest")
    }

    /// A phone held sideways with the keyboard up leaves the full card a
    /// sliver of transcript: the card goes to one row, the chips behind its
    /// options button, and the navigation bar goes (Steve's OK, 2026-10-30).
    /// The bar is back as the keyboard goes down and upright, and the draft
    /// and the keyboard carry across the turns. Actual native swipe-back
    /// cancellation and completion are covered by `testNativeSwipeBackCancelsAndCompletesWithTheKeyboard`.
    /// The transcript's room sideways is read off the
    /// screen (`HAPPY_COMPACT`), empty and with three lines.
    func testCompactComposerSideways() {
        // Upright to start, whatever a run before left; back upright however it ends.
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        let composer = openStreamLab(probe: "watch")
        let options = app.buttons["composer-options"]
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model: ")).firstMatch
        let bar = app.navigationBars.firstMatch
        func barShows() -> Bool { bar.exists && bar.isHittable && bar.frame.maxY > 0 }
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        // A run before leaves its draft: the caret to its end, then all of it deleted.
        if let draft = composer.value as? String, !draft.isEmpty, draft != composer.placeholderValue {
            composer.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.95)).tap()
            composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: draft.count + 2))
        }
        pause(1)
        XCTAssertEqual(composer.value as? String ?? "", composer.placeholderValue ?? "", "the draft wasn't cleared")
        XCTAssertFalse(options.exists && options.isHittable, "the options button upright")
        XCTAssertTrue(model.isHittable, "no model chip upright")
        XCTAssertTrue(barShows(), "no bar upright with the keyboard up")
        capture("compact-0-portrait-empty")

        /// The transcript's room: from under the bar (or the top, with it
        /// hidden) to 8 above the card. The card's top is 8 over the text's
        /// container: one line stands 7 into its 44, a scrolled text 9
        /// into its 62 (a hairline left out).
        func room(_ name: String, scrolled: Bool = false) -> CGFloat {
            let shows = barShows()
            let top = shows ? bar.frame.maxY : 0
            let text = composer.frame
            let cardTop = text.minY - (scrolled ? 9 : 7) - 8
            let room = cardTop - 8 - top
            print("HAPPY_COMPACT \(name) window \(app.windows.firstMatch.frame) bar \(shows ? bar.frame : .zero) keyboard \(app.keyboards.firstMatch.frame) "
                + "composer \(text) options \(options.frame) send \(app.buttons["Send"].frame) cardTop \(cardTop) room \(room)")
            return room
        }

        XCUIDevice.shared.orientation = .landscapeLeft
        pause(2.5)
        XCTAssertTrue(app.keyboards.firstMatch.exists, "the keyboard went with the turn")
        XCTAssertTrue(options.waitForExistence(timeout: 3) && options.isHittable, "no options button sideways")
        XCTAssertFalse(model.exists && model.isHittable, "the chips still in the row sideways")
        XCTAssertTrue(app.buttons["Send"].isHittable)
        XCTAssertFalse(barShows(), "the bar sideways with the keyboard up")
        // Under the bar the compact card left 39.67.
        XCTAssertGreaterThan(room("landscape empty"), 60, "the transcript's room sideways without the bar")
        capture("compact-1-landscape-empty")

        // Who has the keys, and where the composer stands, with the menu up.
        func focus(_ name: String) {
            let keyboard = app.keyboards.firstMatch
            print("HAPPY_COMPACT_FOCUS \(name) composerFocus \(String(describing: composer.value(forKey: "hasKeyboardFocus"))) "
                + "keyboard exists \(keyboard.exists) hittable \(keyboard.exists && keyboard.isHittable) frame \(keyboard.exists ? keyboard.frame : .zero) composer \(composer.frame)")
        }
        focus("before menu")
        options.tap()
        let modelRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model: ")).firstMatch
        XCTAssertTrue(modelRow.waitForExistence(timeout: 3), "the options menu has no model")
        pause(0.5)
        focus("menu up")
        capture("compact-2-options")
        modelRow.tap()
        XCTAssertTrue(app.descendants(matching: .any)["picker-models"].waitForExistence(timeout: 5), "the model list didn't open")
        focus("picker up")
        capture("compact-3-picker")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)).tap()
        pause(1)

        if !app.keyboards.firstMatch.exists { composer.tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        composer.typeText("first line\nsecond line\nthird line")
        pause(1.5)
        XCTAssertTrue(options.isHittable, "no options button with three lines")
        XCTAssertTrue(app.buttons["Send"].isHittable)
        XCTAssertGreaterThan(room("landscape three lines", scrolled: true), 40, "the transcript's room sideways with three lines")
        capture("compact-4-landscape-three-lines")

        // The keyboard down, still sideways: the bar is back.
        // Dragged down from the transcript, the only room above the card
        // sideways.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).press(
            forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)), withVelocity: .slow, thenHoldForDuration: 0.2
        )
        pause(1.5)
        XCTAssertFalse(app.keyboards.firstMatch.exists && app.keyboards.firstMatch.isHittable, "the keyboard stayed up")
        XCTAssertTrue(barShows(), "no bar sideways with the keyboard down")
        capture("compact-5-landscape-keyboard-down")
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        pause(1)
        XCTAssertFalse(barShows(), "the bar again with the keyboard up again")

        XCUIDevice.shared.orientation = .portrait
        pause(2.5)
        XCTAssertTrue(barShows(), "no bar upright again")
        XCTAssertFalse(options.exists && options.isHittable, "the options button upright again")
        XCTAssertTrue(model.isHittable, "no model chip upright again")
        XCTAssertEqual(composer.value as? String, "first line\nsecond line\nthird line")
        capture("compact-6-portrait-again")

    }

    /// Settings is the control; the same native gestures must leave a chat.
    func testNativeSwipeBack() {
        XCUIDevice.shared.orientation = .portrait
        app.terminate()
        app.launch()
        home()
        pause(1.5)
        let name = ProcessInfo.processInfo.environment["HAPPY_STREAM_ROW"] ?? "Stream Lab"
        let bot = row("space", name)
        func mark(_ text: String) { print("HAPPY_NATIVE_POP \(text)") }
        func swipe(_ from: CGFloat, _ to: CGFloat, y: CGFloat = 0.5) {
            app.coordinate(withNormalizedOffset: CGVector(dx: from, dy: y)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: to, dy: y)), withVelocity: .slow, thenHoldForDuration: 0.1
            )
            pause(1.5)
        }
        func atHome() -> Bool { app.buttons["search"].firstMatch.exists && !app.textViews["composer"].exists }
        for (label, from) in [("edge", CGFloat(0.005)), ("content", CGFloat(0.3))] {
            // Settings, the control.
            app.buttons["settings"].firstMatch.tap()
            XCTAssertTrue(app.descendants(matching: .any)["settings"].waitForExistence(timeout: 5))
            pause(1)
            mark("settings \(label) start")
            swipe(from, 0.95)
            let settingsPopped = atHome()
            mark("settings \(label) popped \(settingsPopped)")
            XCTAssertTrue(settingsPopped, "Settings must pop with the native \(label) swipe")

            // The agent chat, keyboard down.
            bot.tap()
            XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 5))
            pause(2)
            mark("chat \(label) start")
            swipe(from, 0.95)
            let chatPopped = atHome()
            mark("chat \(label) popped \(chatPopped)")
            XCTAssertTrue(chatPopped, "Chat must pop with the native \(label) swipe")
        }
    }

    /// A short native swipe cancels without losing focus; a full one pops,
    /// including the sideways chat whose standard bar is hidden by the keyboard.
    func testNativeSwipeBackCancelsAndCompletesWithTheKeyboard() {
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        app.terminate()
        app.launchEnvironment["HAPPY_CHAT_PROBE"] = "native-pop"
        app.launch()
        home()
        let bot = row("space", ProcessInfo.processInfo.environment["HAPPY_STREAM_ROW"] ?? "Stream Lab")
        let composer = app.textViews["composer"]
        bot.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("Swipe verification draft")
        app.buttons["Back"].tap()
        XCTAssertTrue(app.buttons["search"].firstMatch.waitForExistence(timeout: 5))
        func probe() -> [String: String] {
            let value = app.descendants(matching: .any)["transcript"].value as? String ?? ""
            return Dictionary(value.split(separator: " ").compactMap { token -> (String, String)? in
                let pair = token.split(separator: "=", maxSplits: 1)
                return pair.count == 2 ? (String(pair[0]), String(pair[1])) : nil
            }, uniquingKeysWith: { _, last in last })
        }
        for (orientationName, orientation) in [("portrait", UIDeviceOrientation.portrait), ("landscape", .landscapeLeft)] {
            XCUIDevice.shared.orientation = orientation
            pause(1.5)
            for keyboardUp in [false, true] {
                for (kind, from) in [("edge", CGFloat(0.005)), ("content", CGFloat(0.3))] {
                    let label = "\(orientationName)-keyboard-\(keyboardUp)-\(kind)"
                    if let focus = ProcessInfo.processInfo.environment["HAPPY_POP_FOCUS"], !label.hasPrefix(focus) { continue }
                    bot.tap()
                    XCTAssertTrue(composer.waitForExistence(timeout: 5))
                    pause(1)
                    if keyboardUp {
                        composer.tap()
                        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
                        pause(1)
                    } else {
                        XCTAssertFalse(app.keyboards.firstMatch.exists)
                    }
                    let bar = app.navigationBars.firstMatch
                    let showsBar = bar.exists && bar.isHittable && bar.frame.maxY > 0
                    XCTAssertEqual(showsBar, orientationName != "landscape" || !keyboardUp)
                    let top = showsBar ? bar.frame.maxY : 0
                    let bottom = composer.frame.minY - 24
                    var y = (top + bottom) / 2 / app.frame.height
                    if ProcessInfo.processInfo.environment["HAPPY_POP_REQUIRE_FITTING"] == "1" {
                        let fitting = (probe()["hFit"] ?? "").split(separator: ",").compactMap { Double($0) }
                        XCTAssertEqual(fitting.count, 7, "a real visible fitting table must be under the finger")
                        guard fitting.count == 7 else { return }
                        XCTAssertLessThanOrEqual(fitting[5], fitting[6] + 1)
                        y = (fitting[1] + fitting[3] / 2) / app.frame.height
                        print("HAPPY_NATIVE_POP fitting \(label) \(fitting)")
                    }
                    let keyboardFrame = keyboardUp ? app.keyboards.firstMatch.frame : .zero
                    print("HAPPY_NATIVE_POP geometry \(label) y \(y) bar \(showsBar ? bar.frame : .zero) composer \(composer.frame) keyboard \(keyboardFrame)")
                    capture("pop-\(label)-before")
                    func drag(to x: CGFloat, hold: TimeInterval) {
                        app.coordinate(withNormalizedOffset: CGVector(dx: from, dy: y)).press(
                            forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)),
                            withVelocity: .slow, thenHoldForDuration: hold
                        )
                        pause(1.5)
                    }
                    let before = probe()
                    let draft = composer.value as? String
                    XCTAssertTrue(draft?.contains("Swipe verification draft") == true)
                    // Content recognition has a larger activation distance than
                    // the edge. Travel remains below half of the window, then
                    // hold still so releasing cancels rather than flings home.
                    let cancellationTravel = kind == "content" ? min(0.32, 134 / app.frame.width) : 0.08
                    drag(to: from + cancellationTravel, hold: 0.4)
                    XCTAssertTrue(composer.exists, "\(label): cancelled swipe left chat")
                    XCTAssertEqual(app.keyboards.firstMatch.exists, keyboardUp, "\(label): cancelled swipe changed keyboard")
                    XCTAssertEqual(composer.value as? String, draft, "\(label): cancellation changed the draft")
                    let after = probe()
                    let sampleKey = kind == "content" ? "popContent" : "popEdge"
                    let translationKey = sampleKey + "X"
                    XCTAssertGreaterThan(Double(after[sampleKey] ?? "") ?? -1, Double(before[sampleKey] ?? "") ?? 0,
                                         "\(label): cancellation must follow observed native motion during UIKit's interactive transition")
                    XCTAssertGreaterThan(Double(after[translationKey] ?? "") ?? 0, 0)
                    print("HAPPY_NATIVE_POP observed \(label) \(sampleKey)=\(after[sampleKey] ?? "missing") translation=\(after[translationKey] ?? "missing")")
                    print("HAPPY_NATIVE_POP \(label) cancelled")
                    capture("pop-\(label)-cancelled")
                    if !keyboardUp, kind == "content" {
                        let visible = CGRect(x: 0, y: top, width: app.frame.width, height: bottom - top)
                        let messages = app.descendants(matching: .any).matching(identifier: "message")
                        let row = messages.allElementsBoundByIndex.first { !$0.label.isEmpty && $0.frame.intersects(visible) }
                        XCTAssertNotNil(row, "no message to check vertical scrolling")
                        if let row {
                            let anchor = messages.matching(NSPredicate(format: "label == %@", row.label)).firstMatch
                            let before = anchor.frame.minY
                            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y))
                            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 90)), withVelocity: .slow, thenHoldForDuration: 0.2)
                            pause(1)
                            XCTAssertTrue(composer.exists, "vertical scroll popped chat")
                            XCTAssertTrue(!anchor.exists || abs(anchor.frame.minY - before) > 10, "native pop priority blocked vertical scrolling")
                            print("HAPPY_NATIVE_POP \(label) vertical scroll moved \(anchor.exists ? anchor.frame.minY - before : .infinity)")
                        }
                    }
                    drag(to: 0.95, hold: 0.1)
                    XCTAssertTrue(app.buttons["search"].firstMatch.waitForExistence(timeout: 4), "\(label): full swipe did not return home")
                    XCTAssertFalse(composer.exists, "\(label): full swipe left chat mounted")
                    print("HAPPY_NATIVE_POP \(label) completed")
                }
            }
        }
    }

    /// Stream Lab's conversation, with the transcript's probe on.
    private func openStreamLab(probe: String) -> XCUIElement {
        app.terminate()
        app.launchEnvironment["HAPPY_CHAT_PROBE"] = probe
        app.launch()
        home()
        pause(1)
        let bot = row("space", ProcessInfo.processInfo.environment["HAPPY_STREAM_ROW"] ?? "Stream Lab")
        XCTAssertTrue(bot.waitForExistence(timeout: 8), "no Stream Lab")
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(transcriptElement.waitForExistence(timeout: 5))
        pause(2)
        return composer
    }

    private func send(_ composer: XCUIElement, _ text: String) {
        if !app.keyboards.firstMatch.exists { composer.tap() }
        composer.typeText(text)
        app.buttons["Send"].tap()
    }

    /// Dragged down into the keyboard, as a person puts it away.
    private func dismissKeyboard() {
        guard app.keyboards.firstMatch.exists else { return }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(
            forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)), withVelocity: .slow, thenHoldForDuration: 0.2
        )
        pause(1)
    }

    /// Back at the newest row, following it.
    private func toNewest() {
        let jump = app.descendants(matching: .any)["jump-latest"]
        if jump.exists, jump.isHittable { jump.tap() }
        for _ in 0..<3 { app.swipeUp(velocity: .fast) }
        pause(2.5)
    }

    /// The probe's counts, from the transcript's value.
    private func probeCounts(_ transcript: XCUIElement) -> [String: Int] {
        let value = transcript.value as? String ?? ""
        return Dictionary(value.split(separator: " ").compactMap { pair -> (String, Int)? in
            let parts = pair.split(separator: "=")
            guard parts.count == 2, let count = Int(parts[1]) else { return nil }
            return (String(parts[0]), count)
        }, uniquingKeysWith: { _, last in last })
    }

    /// The pencil right after the name, on its line, and no Rename row.
    private func assertPencil() {
        let pencil = app.buttons["detail-rename-button"]
        let name = app.staticTexts["detail-name"]
        XCTAssertTrue(pencil.waitForExistence(timeout: 5), "no pencil after the name")
        XCTAssertEqual(pencil.frame.midY, name.frame.midY, accuracy: 1.5, "the pencil isn't on the name's line")
        XCTAssertGreaterThan(pencil.frame.midX, name.frame.maxX, "the pencil isn't after the name")
        XCTAssertLessThan(pencil.frame.minX, name.frame.maxX + 12, "the pencil isn't next to the name")
        XCTAssertFalse(app.descendants(matching: .any)["settings:rename"].exists, "the Rename row is still there")
    }

    /// Model, effort and when it started; nothing else counted.
    private func assertTiles() {
        let started = app.descendants(matching: .any)["detail-tile:started"]
        XCTAssertTrue(started.waitForExistence(timeout: 5), "no Started tile")
        XCTAssertTrue(until(8) { (started.value as? String) != "—" }, "when it started never came")
        for id in ["model", "effort", "started"] {
            let tile = app.descendants(matching: .any)["detail-tile:\(id)"]
            print("HAPPY_DETAIL \(id) = \(tile.value as? String ?? "")")
            XCTAssertNotEqual(tile.value as? String, "—", "\(id) never came")
        }
        for id in ["tokens", "messages", "subagents", "age"] {
            XCTAssertFalse(app.descendants(matching: .any)["detail-tile:\(id)"].exists, "\(id) is still counted")
        }
    }

    /// Every modal sheet closes from a button at its top right, as far
    /// from the top as from the side: settings' QR sheet, the link sheet
    /// "+" opens and the attach sheet. The link sheet's
    /// Relay | Direct switch runs across the screen just above what it
    /// switches (the scan), tagged Beta.
    func testSheetsClose() {
        home()
        app.descendants(matching: .any)["settings-mark"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["settings-qr"].waitForExistence(timeout: 5))
        pause(1)

        app.descendants(matching: .any)["settings-qr"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["qr"].waitForExistence(timeout: 3))
        pause(1)
        capture("sheet-qr")
        assertCloses(app.descendants(matching: .any)["qr-close"], in: app.descendants(matching: .any)["qr-sheet"], "the QR sheet")
        closeSheet(app.descendants(matching: .any)["qr-close"], app.descendants(matching: .any)["qr"])
        XCTAssertTrue(app.descendants(matching: .any)["profile-add"].waitForExistence(timeout: 3))

        app.descendants(matching: .any)["profile-add"].tap()
        let link = app.descendants(matching: .any)["link"]
        XCTAssertTrue(link.waitForExistence(timeout: 5), "+ didn't open the link sheet")
        let control = app.segmentedControls["link-method"]
        if !control.buttons["Direct"].isSelected { control.buttons["Direct"].tap() }
        let scan = app.buttons["Scan QR code"]
        XCTAssertTrue(scan.waitForExistence(timeout: 3))
        pause(1)
        // What to do on the computer, in numbered steps, the scan last.
        for (index, step) in ["Install Happy on your computer", "Open Happy and choose Link Mobile App", "Scan the QR code"].enumerated() {
            let row = app.descendants(matching: .any)["link-step-\(index + 1)"]
            XCTAssertTrue(row.exists, "no step \(index + 1)")
            // The localized lines may hold no-break spaces.
            XCTAssertEqual(row.label.replacingOccurrences(of: "\u{00A0}", with: " "), "\(index + 1). \(step)")
        }
        XCTAssertTrue(app.descendants(matching: .any)["link-paste"].exists, "the paste link is gone")
        capture("sheet-link-direct")
        let close = app.buttons["glass-close"]
        assertCloses(close, in: link, "the link sheet")
        XCTAssertEqual(control.frame.width, scan.frame.width * 0.6, accuracy: 1, "the switch isn't 60% of the scan's width")
        XCTAssertEqual(control.frame.midX, scan.frame.midX, accuracy: 1, "the switch isn't centred over the scan")
        XCTAssertTrue(app.staticTexts["Connect Agent"].exists, "the title isn't Link your computer")
        XCTAssertGreaterThan(control.frame.minY, link.frame.midY, "the switch isn't down over the scan")
        XCTAssertLessThan(control.frame.maxY, scan.frame.minY, "the switch isn't above the scan")
        XCTAssertTrue(app.descendants(matching: .any)["link-beta"].exists, "no Beta tag")
        XCTAssertFalse(app.staticTexts["EXPERIMENTAL"].exists, "the tag still says Experimental")
        let switchOnAgentConnections = control.frame
        control.buttons["Relay"].tap()
        XCTAssertTrue(app.buttons["Create account"].waitForExistence(timeout: 5), "Relay didn't show Welcome")
        pause(1)
        capture("sheet-link-relay")
        XCTAssertEqual(control.frame.minY, switchOnAgentConnections.minY, accuracy: 0.5, "the switch moved between Direct and Relay")
        XCTAssertLessThan(control.frame.maxY, app.buttons["Create account"].frame.minY, "the switch isn't above Relay's buttons")
        control.buttons["Direct"].tap()
        pause(0.8)
        closeSheet(close, link)
        app.tapBack()
        pause(1.5)

        // The attach sheet, over new work.
        app.descendants(matching: .any)["new-work"].tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 5))
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        openSheet()
        capture("sheet-attach")
        let sheet = app.descendants(matching: .any)["attach-sheet"]
        assertCloses(app.buttons["attach-close"], in: sheet, "the attach sheet")
        closeSheet(app.buttons["attach-close"], sheet)
        app.tapBack()
        pause(1)
        let fresh = row("space", "New").firstMatch
        if fresh.exists {
            fresh.press(forDuration: 1.0)
            let discard = app.buttons["Close new work"]
            if discard.waitForExistence(timeout: 3) { discard.tap() }
            pause(1)
        }
    }

    /// `close` at `sheet`'s top right, as far from its top as from its side.
    private func assertCloses(_ close: XCUIElement, in sheet: XCUIElement, _ name: String) {
        guard close.waitForExistence(timeout: 3), sheet.exists else { return XCTFail("\(name) has no close button") }
        let button = close.frame, frame = sheet.frame
        XCTAssertGreaterThan(button.midX, frame.midX, "\(name)'s close button isn't at the right")
        XCTAssertEqual(button.minY - frame.minY, frame.maxX - button.maxX, accuracy: 0.5, "\(name)'s close button: \(button) in \(frame) isn't as far from the top as from the side")
    }

    private func closeSheet(_ close: XCUIElement, _ sheet: XCUIElement) {
        if close.exists, close.isHittable { close.tap() } else { app.swipeDown(velocity: .fast) }
        XCTAssertTrue(until(4) { !sheet.exists }, "the sheet didn't close")
        pause(0.8)
    }

    /// Surfaces made elsewhere open from the sidebar: a todo list that takes
    /// a todo, a document with its heading. The harness makes them first.
    func testSurfaces() {
        home()
        let list = row("space", "Weekend errands").firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 15), "the todo list isn't in the sidebar")
        list.tap()
        let field = app.textFields["todo-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        let todos = app.descendants(matching: .any).matching(identifier: "todo")
        XCTAssertTrue(todos.firstMatch.waitForExistence(timeout: 10))
        let before = todos.count
        field.tap()
        field.typeText("Water the cactus\n")
        XCTAssertTrue(until(10) { todos.count == before + 1 }, "the todo wasn't added")
        pause(1)
        capture("todo-list")
        app.tapBack()
        pause(1)
        let notes = row("space", "Trip notes").firstMatch
        XCTAssertTrue(notes.waitForExistence(timeout: 15), "the document isn't in the sidebar")
        notes.tap()
        XCTAssertTrue(app.descendants(matching: .any)["document"].waitForExistence(timeout: 10))
        pause(1)
        capture("document")
        app.tapBack()
        pause(1)
    }

    /// Prioritizing on (home never mentions it off), then new work: live over the
    /// events stream the row grows its icon and its name, Prioritizing puts
    /// its own row in, and its batch moves the new row where it belongs.
    func testPrioritizing() {
        home()
        XCTAssertFalse(app.staticTexts["Prioritizing is off"].exists, "home mentions Prioritizing being off")
        app.descendants(matching: .any)["new-work"].tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(1)
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        composer.typeText("Plan a weekend hiking trip to Sintra: a short packing list and two trails. A few lines, no tools.")
        pause(0.5)
        app.buttons["Send"].tap()
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        let messages = app.descendants(matching: .any).matching(identifier: "message")
        let working = app.descendants(matching: .any)["working"]
        var deadline = Date().addingTimeInterval(120)
        while Date() < deadline, messages.count < 2 || working.exists { pause(1) }
        XCTAssertGreaterThanOrEqual(messages.count, 2, "the agent never answered")
        pause(2)
        capture("prioritizing-chat")
        app.tapBack()
        // The sidebar, untouched, while Prioritizing works: the seedling
        // grows its icon and name at once, and the batch moves the row once
        // Prioritizing's turn ends.
        let fresh = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND value BEGINSWITH %@", "row:space:New", "seedling"))
        deadline = Date().addingTimeInterval(180)
        while Date() < deadline, fresh.count > 0 { pause(2) }
        XCTAssertEqual(fresh.count, 0, "the new work never grew its icon and name")
        capture("prioritizing-named")
        pause(60)
        capture("prioritizing-placed")
        // Where the batch put it: under its section, further down.
        for _ in 0..<4 { app.swipeUp(); pause(1) }
        pause(2)
        capture("prioritizing-section")
        for _ in 0..<4 { app.swipeDown(); pause(0.5) }
        pause(1)
    }

    /// The sidebar left alone for a while, for what arrives over events.
    func testWatchSidebar() {
        home()
        pause(Double(ProcessInfo.processInfo.environment["HAPPY_WATCH_SECONDS"] ?? "") ?? 150)
        capture("watched")
        for _ in 0..<4 { app.swipeUp(); pause(1.5) }
        capture("watched-bottom")
        for _ in 0..<4 { app.swipeDown(); pause(0.5) }
        pause(1)
    }

    /// A task's subtasks shown under its row from its menu, one opened, and
    /// Prioritizing's own row with its notes.
    func testSubtasks() {
        home()
        pause(1.5)
        for label in ["Plan Lisbon trip", "Refactor billing service"] {
            let task = row("space", label)
            // Prioritizing may have filed it under a folded section.
            if !task.waitForExistence(timeout: 3) { openFoldedSections() }
            XCTAssertTrue(task.waitForExistence(timeout: 5), "no \(label)")
            // Into the middle of the screen, clear of the dock, and still.
            bringIntoView(task)
            pause(1)
            // Its chevron unfolds it, bringing subtasks the sidebar didn't
            // hold yet; open from an earlier run, it folds and opens again.
            // (A closure over `task`: a local function in a loop keeps the first turn's.)
            // Open: a subtask among the rows right under it (a task set under it may come first).
            let open: (XCUIElement) -> Bool = { [unowned self] task in
                let below = task.frame
                return shownRows("row:session:").contains { $0.frame.minY >= below.maxY - 1 && $0.frame.minY < below.maxY + below.height * 3 }
            }
            if open(task) { tapChevron(task); XCTAssertTrue(until(2) { !open(task) }, "\(label) didn't fold") }
            tapChevron(task)
            XCTAssertTrue(until(5) { open(task) }, "\(label)'s chevron showed no subtasks")
            pause(1.5)
        }
        let sessions = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:session:"))
        XCTAssertTrue(sessions.firstMatch.waitForExistence(timeout: 5), "no subtask showed under its task")
        pause(1.5)
        capture("subtasks")
        sessions.firstMatch.tap()
        pause(4)
        capture("subtask-chat")
        app.tapBack()
        pause(1.5)
        for _ in 0..<3 { app.swipeDown(); pause(0.3) }
        let prioritizing = row("space", "Prioritizing")
        if prioritizing.waitForExistence(timeout: 3) {
            prioritizing.tap()
            pause(4)
            capture("prioritizing-notes")
            app.tapBack()
            pause(1.5)
        }
    }

    /// What an agent presents comes inline: a picture and a recording, read
    /// over the paired connection, each opened whole; then a photo the
    /// person pastes goes with their words and shows under them.
    func testMedia() {
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["HAPPY_MEDIA_ROW"] ?? "Research Assistant")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(3)
        let tiles = app.descendants(matching: .any).matching(identifier: "media")
        let videos = tiles.matching(NSPredicate(format: "label ENDSWITH %@", ".mp4"))
        let pictures = tiles.matching(NSPredicate(format: "label ENDSWITH %@", ".png"))
        let working = app.descendants(matching: .any)["working"]
        if videos.count == 0 || pictures.count == 0 {
            composer.tap()
            composer.typeText(
                "Please make two files in a temporary folder: a 960x600 PNG bar chart of four made-up fruit sales (python or ffmpeg, whatever you have), "
                    + "and a 4 second 640x360 MP4 with ffmpeg's testsrc pattern. Then present both to me inline with present_files so I see them here. One short sentence of text is enough."
            )
            pause(1)
            app.buttons["Send"].tap()
            if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
            let deadline = Date().addingTimeInterval(360)
            while Date() < deadline, videos.count == 0 || pictures.count == 0 || working.exists { pause(2) }
        }
        XCTAssertGreaterThan(pictures.count, 0, "no picture was presented")
        XCTAssertGreaterThan(videos.count, 0, "no recording was presented")
        let picture = pictures.element(boundBy: pictures.count - 1)
        let video = videos.element(boundBy: videos.count - 1)
        // Read over the paired connection, then drawn.
        let loaded = NSPredicate(format: "value == %@", "loaded")
        expectation(for: loaded, evaluatedWith: picture)
        expectation(for: loaded, evaluatedWith: video)
        waitForExpectations(timeout: 60)
        pause(2)
        // The keyboard down and the picture in view, above the recording.
        app.swipeDown(velocity: .slow)
        pause(1)
        bringIntoView(picture)
        pause(1.5)
        capture("media-inline")

        // The tiles take no touches of their own: the transcript's tap opens them.
        picture.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.images["picture-viewer"].waitForExistence(timeout: 5))
        pause(2.5)
        capture("media-picture-open")
        app.buttons["Close"].tap()
        pause(1.5)

        bringIntoView(video)
        pause(1.5)
        video.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        pause(6)
        capture("media-video-playing")
        app.swipeDown(velocity: .fast)
        pause(1)
        if !composer.isHittable {
            for name in ["Close", "Done"] where app.buttons[name].exists {
                app.buttons[name].tap()
                break
            }
        }
        pause(1.5)

        // A photo from the library (the newest: the swatch the run put
        // there with `simctl addmedia`), with a question about it.
        // "+" is the "+" sheet; its Photos, the shared library sheet.
        openLibrary()
        let newest = app.descendants(matching: .any)["library-cell:0"]
        XCTAssertTrue(newest.waitForExistence(timeout: 10), "the library sheet never showed a photo")
        pause(1)
        capture("media-library")
        // Newest first.
        newest.tap()
        pause(0.8)
        app.descendants(matching: .any)["library-add"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer-attachment"].waitForExistence(timeout: 8), "the photo didn't attach")
        pause(2)
        capture("media-picked")
        composer.tap()
        composer.typeText("What colours and words are in this picture? Answer in one sentence, no tools.")
        pause(1)
        capture("media-photo-attached")
        app.buttons["Send"].tap()
        let sent = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label ENDSWITH %@", "media", "Picture"))
        XCTAssertTrue(sent.firstMatch.waitForExistence(timeout: 10), "the photo never showed under the message")
        let deadline = Date().addingTimeInterval(120)
        pause(3)
        while Date() < deadline, working.exists { pause(1) }
        pause(2)
        capture("media-photo-answered")
    }

    /// What an agent arranges and publishes: a `present_files` layout with
    /// a caption, a document's card, a layout block in its reply, and an
    /// artifact's card that opens it; then a file in Quick Look.
    func testLayouts() {
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["HAPPY_LAYOUT_ROW"] ?? "Chef")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(3)
        let tiles = app.descendants(matching: .any).matching(identifier: "media")
        let cards = app.descendants(matching: .any).matching(identifier: "card")
        let artifact = cards.matching(NSPredicate(format: "label == %@", "Open Pantry notes")).firstMatch
        let file = cards.matching(NSPredicate(format: "label ENDSWITH %@", ".csv")).firstMatch
        let working = app.descendants(matching: .any)["working"]
        if !artifact.exists || tiles.count < 3 {
            composer.tap()
            composer.typeText(
                "In a temporary folder make three 800x500 PNG swatches with python or ffmpeg: tomato.png (red), basil.png (green), lemon.png (yellow), "
                    + "and pantry.csv with three lines of made-up stock. Then call present_files once with all four files and this layout argument: "
                    + "<figure style=\"display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px\"><img src=\"TOMATO\"><img src=\"BASIL\"><img src=\"LEMON\">"
                    + "<figcaption style=\"grid-column: span 3; tone: muted\">Three swatches, one <strong>per</strong> ingredient</figcaption></figure> "
                    + "(put the real paths in each src). Then use create_artifact to publish a markdown artifact titled Pantry notes with a heading and two bullet points. "
                    + "End your reply with exactly this HTML block on its own lines, paths filled in: "
                    + "<div style=\"display: flex; gap: 12px\"><img src=\"TOMATO\" style=\"width: 120px\"><img src=\"LEMON\" style=\"width: 120px\"></div>"
            )
            pause(1)
            app.buttons["Send"].tap()
            if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
            let deadline = Date().addingTimeInterval(420)
            while Date() < deadline, !artifact.exists || tiles.count < 5 || working.exists { pause(2) }
        }
        XCTAssertGreaterThanOrEqual(tiles.count, 5, "the layout and the block should show five pictures")
        XCTAssertTrue(artifact.exists, "no artifact card")
        XCTAssertTrue(file.exists, "no file card")
        let loaded = NSPredicate(format: "value == %@", "loaded")
        for index in 0..<tiles.count { expectation(for: loaded, evaluatedWith: tiles.element(boundBy: index)) }
        waitForExpectations(timeout: 60)
        // The keyboard down: dragged away from the transcript.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        pause(1)
        bringIntoView(tiles.element(boundBy: tiles.count - 5))
        pause(1.5)
        capture("layout-tree")
        for index in 0..<tiles.count {
            let tile = tiles.element(boundBy: index)
            print("HAPPY_TILE \(index) \(tile.label) \(tile.frame)")
        }
        print("HAPPY_CARD file \(file.frame) artifact \(artifact.frame)")
        bringIntoView(tiles.element(boundBy: tiles.count - 1))
        pause(1.5)
        capture("layout-block")

        bringIntoView(artifact)
        pause(1)
        artifact.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.descendants(matching: .any)["artifact-document"].waitForExistence(timeout: 15), "the artifact never opened")
        pause(2)
        capture("layout-artifact")
        app.tapBack()
        pause(1.5)

        bringIntoView(file)
        pause(1)
        file.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        pause(4)
        capture("layout-file")
        for name in ["Done", "Close"] where app.buttons[name].exists {
            app.buttons[name].tap()
            break
        }
        pause(1.5)
    }

    /// Pictures that failed while the computer was away load once it is back:
    /// every picture fails at first (`V2_MEDIA_FAIL_UNTIL_RETRY`), the
    /// driver stops the daemon and starts it again, and the reconnect asks
    /// for them once more.
    func testMediaRetry() {
        app.terminate()
        app.launchEnvironment["HAPPY_MEDIA_FAIL_UNTIL_RETRY"] = "1"
        app.launch()
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["HAPPY_LAYOUT_ROW"] ?? "Chef")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let tiles = app.descendants(matching: .any).matching(identifier: "media")
        let failed = tiles.matching(NSPredicate(format: "value == %@", "failed"))
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline, failed.count == 0 { pause(0.5) }
        XCTAssertGreaterThan(failed.count, 0, "nothing failed")
        app.swipeDown(velocity: .slow)
        bringIntoView(failed.firstMatch)
        pause(1.5)
        capture("retry-failed")
        print("HAPPY_STOP_DAEMON")
        pause(6)
        print("HAPPY_START_DAEMON")
        let back = Date().addingTimeInterval(90)
        while Date() < back, failed.count > 0 { pause(0.5) }
        XCTAssertEqual(failed.count, 0, "pictures stayed failed after the computer came back")
        pause(2)
        capture("retry-loaded")
    }

    /// A long recording plays while it streams, a range at a time; the run
    /// reads the ranges from the app's log (`v2-media`). The file is the
    /// one the driver made (`V2_VIDEO_PATH`).
    func testStreaming() {
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["HAPPY_LAYOUT_ROW"] ?? "Chef")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(3)
        let video = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label ENDSWITH %@", "media", "countdown.mp4"))
        let working = app.descendants(matching: .any)["working"]
        if video.count == 0 {
            let path = ProcessInfo.processInfo.environment["HAPPY_VIDEO_PATH"] ?? ""
            composer.tap()
            composer.typeText("Please present the file \(path) to me inline with present_files, and say nothing else.")
            pause(1)
            app.buttons["Send"].tap()
            let deadline = Date().addingTimeInterval(240)
            while Date() < deadline, video.count == 0 || working.exists { pause(2) }
        }
        XCTAssertGreaterThan(video.count, 0, "the recording was never presented")
        let tile = video.element(boundBy: video.count - 1)
        expectation(for: NSPredicate(format: "value == %@", "loaded"), evaluatedWith: tile)
        waitForExpectations(timeout: 60)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        pause(1)
        bringIntoView(tile)
        pause(1)
        print("HAPPY_PLAY")
        tile.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        pause(8)
        capture("streaming-playing")
        // Halfway along: the player asks for a range far ahead.
        let scrubber = app.sliders.firstMatch
        if !scrubber.exists { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        if scrubber.waitForExistence(timeout: 3) {
            print("HAPPY_SEEK")
            scrubber.adjust(toNormalizedSliderPosition: 0.75)
            pause(6)
            capture("streaming-seeked")
        }
    }

    /// A file larger than one answer may hold (8 MiB) opens in Quick Look,
    /// read a range at a time. The file is the one the driver made
    /// (`V2_FILE_PATH`).
    func testLargeFile() {
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["HAPPY_LAYOUT_ROW"] ?? "Chef")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(3)
        let path = ProcessInfo.processInfo.environment["HAPPY_FILE_PATH"] ?? ""
        let name = (path as NSString).lastPathComponent
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "card", "Open \(name)"))
        let working = app.descendants(matching: .any)["working"]
        if card.count == 0 {
            composer.tap()
            composer.typeText("Please present the file \(path) to me inline with present_files, and say nothing else.")
            pause(1)
            app.buttons["Send"].tap()
            let deadline = Date().addingTimeInterval(240)
            while Date() < deadline, card.count == 0 || working.exists { pause(2) }
        }
        XCTAssertGreaterThan(card.count, 0, "the file was never presented")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        pause(1)
        let open = card.element(boundBy: card.count - 1)
        bringIntoView(open)
        pause(1)
        let start = Date()
        open.tap()
        // Quick Look draws in its own process: what shows here is that it
        // covers the conversation, and that no alert says the read failed.
        let covered = Date().addingTimeInterval(60)
        while Date() < covered, composer.isHittable, app.alerts.count == 0 { pause(0.2) }
        XCTAssertEqual(app.alerts.count, 0, "the file could not be read")
        XCTAssertFalse(composer.isHittable, "Quick Look never showed the file")
        print("HAPPY_FILE_OPENED \(String(format: "%.1f", Date().timeIntervalSince(start)))s")
        pause(3)
        capture("large-file")
    }

    /// A task's name renamed from its conversation's detail, where the name
    /// stands: the detail, the bar and the sidebar row wear it at once and
    /// the computer keeps it (`V2_RENAMED`, read back by the run). Renamed
    /// back after, so the test can run again.
    func testRenameTitle() {
        home()
        pause(1.5)
        let old = ProcessInfo.processInfo.environment["HAPPY_RENAME_ROW"] ?? "Renew passport"
        let new = old + " by May"
        let titled = { (name: String) in self.app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "chat-title", name)).firstMatch }
        let field = app.textFields["detail-rename"]
        for (from, to) in [(old, new), (new, old)] {
            let task = row("space", from)
            XCTAssertTrue(task.waitForExistence(timeout: 10), "no row named \(from)")
            bringIntoView(task)
            task.tap()
            let title = titled(from)
            XCTAssertTrue(title.waitForExistence(timeout: 5), "the bar doesn't show \(from)")
            pause(1)
            if to == new { capture("rename-before") }
            title.tap()
            XCTAssertTrue(app.descendants(matching: .any)["detail"].waitForExistence(timeout: 5), "the capsule didn't open the detail")
            let name = app.staticTexts["detail-name"].frame
            app.buttons["detail-rename-button"].tap()
            XCTAssertTrue(field.waitForExistence(timeout: 3), "the name never became a field")
            XCTAssertEqual(field.frame.midY, name.midY, accuracy: 1, "the field isn't where the name was")
            XCTAssertFalse(app.buttons["detail-rename-button"].exists && app.buttons["detail-rename-button"].isHittable, "the pencil stayed while renaming")
            pause(0.8)
            if to == new { capture("rename-editing") }
            // The field opens with its name selected: typing replaces it.
            field.typeText(to + "\n")
            XCTAssertEqual(app.staticTexts["detail-name"].label, to, "the detail never showed \(to)")
            XCTAssertFalse(field.exists)
            app.tapBack()
            XCTAssertTrue(titled(to).waitForExistence(timeout: 3), "the bar never showed \(to)")
            pause(1)
            if to == new {
                capture("rename-after")
                print("HAPPY_RENAMED \(to)")
            }
            app.tapBack()
            XCTAssertTrue(row("space", to).waitForExistence(timeout: 5), "the sidebar row never showed \(to)")
            if to == new {
                pause(1)
                capture("rename-sidebar")
            }
        }
    }

    /// Prioritizing asked, in its own conversation, for a tidier sidebar: its
    /// proposal arrives live as the sidebar's own rows in a card, a folded
    /// section opens in the card alone, and the answer is given there. The
    /// first proposal is taken ("Use this sidebar"), the second declined
    /// ("Keep mine"); each prints `V2_PROPOSAL` with how it ended, so the
    /// run can read the sidebar back.
    func testProposal() {
        home()
        pause(1.5)
        // The first ask flips what the last run's took, so the test runs again.
        let asks = [
            ProcessInfo.processInfo.environment["HAPPY_PROPOSAL_ASK"] ?? "Please propose a sidebar with propose_sidebar (don't apply anything yourself). If there is a Distractions section, move its rows to the end of the Travel section and drop the Distractions section. If there isn't, take the last two rows of the Travel section into a new section called Distractions, folded, right after Travel. Only propose it.",
            "Please propose one more sidebar with propose_sidebar (don't apply anything yourself): move the Bots section to the very end. Only propose it.",
        ]
        let open = row("space", "Prioritizing")
        for _ in 0..<3 where !open.exists { app.swipeDown(); pause(0.3) }
        XCTAssertTrue(open.waitForExistence(timeout: 5), "no Prioritizing row")
        bringIntoView(open)
        open.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        for (round, ask) in asks.enumerated() {
            let take = round == 0
            let answers = app.buttons.matching(identifier: take ? "proposal-use" : "proposal-keep")
            pause(2)
            // An answered card shows no buttons: one that does was left open
            // by an earlier run, and is answered as it stands.
            if answers.count == 0 {
                if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
                composer.tap()
                composer.typeText(ask)
                pause(0.5)
                app.buttons["Send"].tap()
                // Prioritizing reads the sidebar, then proposes: the card comes live.
                let deadline = Date().addingTimeInterval(300)
                while Date() < deadline, answers.count == 0 { pause(1) }
                XCTAssertGreaterThan(answers.count, 0, "no proposal arrived in round \(round + 1)")
            }
            let answer = answers.element(boundBy: answers.count - 1)
            pause(3)
            // The keyboard down, pulled away as a finger would.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)),
                withVelocity: .default, thenHoldForDuration: 0.2
            )
            pause(1)
            bringIntoView(answer)
            pause(1)
            capture("proposal-\(round + 1)-open")
            // A folded section opens in the card alone.
            // The newest card: earlier runs' stay in the transcript, answered.
            let cards = app.descendants(matching: .any).matching(identifier: "proposal")
            let card = cards.element(boundBy: cards.count - 1)
            let folded = card.descendants(matching: .any)["row:section:Travel"]
            if take, folded.exists {
                let shown = card.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:space:")).count
                bringIntoView(folded)
                folded.tap()
                pause(1.5)
                capture("proposal-1-unfolded")
                let opened = card.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:space:")).count
                print("HAPPY_PROPOSAL_FOLD \(shown) -> \(opened)")
                folded.tap()
                pause(1)
                bringIntoView(answer)
            }
            answer.tap()
            let said = take ? "You use this sidebar now." : "You kept your own sidebar."
            let status = app.staticTexts.matching(NSPredicate(format: "identifier == %@ AND label == %@", "proposal-status", said)).firstMatch
            XCTAssertTrue(status.waitForExistence(timeout: 30), "the card never said \(said)")
            pause(1)
            bringIntoView(status)
            pause(1)
            capture("proposal-\(round + 1)-answered")
            print("HAPPY_PROPOSAL \(take ? "accepted" : "declined")")
            pause(1)
        }
        app.tapBack()
        pause(2)
        capture("proposal-sidebar")
    }

    /// Opening a conversation with pictures twice: cold, read over the
    /// paired connection, then warm, from what the first open kept. Each
    /// open prints how long its pictures took (`V2_OPEN`).
    func testMediaColdWarm() {
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["HAPPY_LAYOUT_ROW"] ?? "Chef")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        let loaded = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND value == %@", "media", "loaded"))
        let tiles = app.descendants(matching: .any).matching(identifier: "media")
        for pass in ["cold", "warm"] {
            let start = Date()
            bot.tap()
            let deadline = Date().addingTimeInterval(30)
            while Date() < deadline, tiles.count == 0 || loaded.count < tiles.count { pause(0.1) }
            print("HAPPY_OPEN \(pass) \(String(format: "%.2f", Date().timeIntervalSince(start)))s \(loaded.count)/\(tiles.count)")
            XCTAssertGreaterThan(loaded.count, 0)
            pause(2)
            capture("open-\(pass)")
            app.tapBack()
            pause(2)
        }
    }

    /// The working line through a real turn: the loader, the clock and the
    /// phase as the agent's status moves, each change printed with its
    /// time (`V2_PHASE <seconds> <line>`) for desktop's side of the video.
    func testWorking() {
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["HAPPY_MEDIA_ROW"] ?? "Research Assistant")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(2)
        composer.tap()
        composer.typeText("Think for a moment about what a good haiku needs. Then run `sleep 5` with your shell tool, one call and nothing else. Then write me a haiku about waiting.")
        pause(0.5)
        let working = app.descendants(matching: .any)["working"]
        app.buttons["Send"].tap()
        let start = Date()
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        XCTAssertTrue(working.waitForExistence(timeout: 10), "the working line never showed")
        var seen: [String] = []
        var last = ""
        let deadline = Date().addingTimeInterval(240)
        while Date() < deadline {
            // Read once, as it is: the line may go between two queries.
            guard let line = (try? working.snapshot())?.label else { break }
            if line != last, !line.isEmpty {
                // The phase, without the clock that moves every second.
                let phase = line.components(separatedBy: " · ").last ?? line
                if seen.last != phase { seen.append(phase) }
                print(String(format: "HAPPY_PHASE %.2f %@", Date().timeIntervalSince(start), line))
                last = line
            }
            pause(0.1)
        }
        print("HAPPY_PHASES \(seen.joined(separator: " > "))")
        XCTAssertFalse(working.exists, "the turn never finished")
        XCTAssertTrue(seen.contains("Running tools") || seen.contains("Preparing tools"), "no tool phase showed: \(seen)")
        pause(2)
        capture("working-answered")
        // Its row in the sidebar while it works: the name under the sheen.
        composer.tap()
        composer.typeText("Run sleep 8 with your shell tool, then say done.")
        app.buttons["Send"].tap()
        XCTAssertTrue(working.waitForExistence(timeout: 10))
        app.tapBack()
        pause(6)
        capture("working-row")
    }

    /// A cold launch with the computer stopped: the sidebar, the rows'
    /// pictures and the dock's model chips come from what this phone kept,
    /// at once; the computer comes back and its live sidebar takes over
    /// with no row moving. The driver stops and starts the throwaway
    /// daemon when asked (`.context/offline.sh`).
    func testOfflineLaunch() {
        home()
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:"))
        let connecting = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "connecting")).firstMatch
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, connecting.exists { pause(0.5) }
        XCTAssertFalse(connecting.exists, "never went live")
        // Kept on the first live read; a moment for it to reach the disk.
        pause(3)
        func shown() -> [String] {
            (0..<min(rows.count, 12)).map { rows.element(boundBy: $0) }.filter { $0.frame.minY > 0 && $0.frame.maxY < app.frame.height * 0.8 }.map(\.identifier)
        }
        let live = shown()
        let firstFrame = rows.element(boundBy: 0).frame
        capture("offline-before")
        print("HAPPY_STOP_DAEMON")
        pause(8)
        app.terminate()
        app.launch()
        let first = rows.firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 3), "nothing showed offline")
        pause(1)
        XCTAssertTrue(connecting.exists, "the computer should be out of reach")
        let offline = shown()
        XCTAssertEqual(offline, live, "the kept sidebar is not the one last shown")
        XCTAssertFalse(app.staticTexts["Models not configured"].exists, "the model chips were not kept")
        capture("offline-launch")
        pause(3)
        print("HAPPY_START_DAEMON")
        let back = Date().addingTimeInterval(120)
        var moved: [String] = []
        while Date() < back, connecting.exists {
            pause(0.25)
            let now = shown()
            if now != offline { moved = now }
        }
        XCTAssertFalse(connecting.exists, "the computer never came back")
        pause(2)
        XCTAssertEqual(shown(), offline, "rows moved when the live sidebar came")
        XCTAssertTrue(moved.isEmpty, "rows moved on the way back: \(moved)")
        XCTAssertEqual(rows.element(boundBy: 0).frame, firstFrame)
        capture("offline-back")
    }

    /// Closes the settings sheet with a pull down from its top.
    /// Settings is a push: back goes home.
    private func closeSettings() {
        app.tapBack()
        pause(1.5)
    }

    /// The header: the computer's picture at the left opens settings; the
    /// name in the middle; search at the right (`testInlineSearch`).
    func testHeader() {
        home()
        pause(1.5)
        capture("header")
        app.descendants(matching: .any)["settings-mark"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["settings-qr"].waitForExistence(timeout: 3))
        pause(1.5)
        capture("settings")
        closeSettings()
    }

    /// Settings from the picture: the QR sheet and its Scan, the Profile
    /// row and the agent's two asks, Prioritizing's switch, and "+"
    /// opening the link sheet. Every row, the push and the sheet's
    /// relay and pairing: SettingsUITests.
    func testSettings() {
        home()
        pause(1)
        app.descendants(matching: .any)["settings-mark"].tap()
        let qr = app.descendants(matching: .any)["settings-qr"]
        XCTAssertTrue(qr.waitForExistence(timeout: 3))
        pause(1.5)
        capture("settings")

        // The QR sheet: nothing to share, so Scan comes first.
        qr.tap()
        let scan = app.buttons["qr-scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 3))
        pause(1.5)
        capture("settings-qr")
        scan.tap()
        let closeScanner = app.buttons["Close"]
        XCTAssertTrue(closeScanner.waitForExistence(timeout: 5), "Scan opened no camera")
        pause(1.5)
        capture("settings-scan")
        closeScanner.tap()
        pause(1)

        // No rename in place: the agent is asked to change its own name and
        // picture, and the person's own profile has a page of its own.
        XCTAssertTrue(app.descendants(matching: .any)["settings-name"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["settings:edit-name"].exists, "Edit name is still there")
        XCTAssertFalse(app.descendants(matching: .any)["settings:change-agent-name"].exists, "Change agent name is still a row")
        XCTAssertFalse(app.descendants(matching: .any)["settings:status"].exists, "Status is still there")
        XCTAssertTrue(app.descendants(matching: .any)["settings-agent-menu"].exists, "no agent picture on the page")
        XCTAssertTrue(app.descendants(matching: .any)["settings:profile"].exists, "no Profile row")
        capture("settings-asks")

        // Prioritizing's switch, off and on again.
        let prioritizing = app.switches["settings-toggle:prioritizing"]
        XCTAssertTrue(prioritizing.waitForExistence(timeout: 3))
        let was = prioritizing.value as? String
        prioritizing.tap()
        pause(1.5)
        XCTAssertNotEqual(prioritizing.value as? String, was)
        capture("settings-prioritizing")
        prioritizing.tap()
        pause(1.5)
        XCTAssertEqual(prioritizing.value as? String, was)

        // A tapped circle switches and goes home: InstanceSwitchUITests.

        // "+" opens the link sheet; its Scan opens the scanner.
        app.descendants(matching: .any)["profile-add"].tap()
        let scanCode = app.buttons["Scan QR code"]
        XCTAssertTrue(scanCode.waitForExistence(timeout: 3), "+ offered no way to add a computer")
        XCTAssertTrue(app.descendants(matching: .any)["link-paste"].exists)
        pause(1)
        capture("settings-add-computer")
        scanCode.tap()
        XCTAssertTrue(closeScanner.waitForExistence(timeout: 5))
        pause(1)
        closeScanner.tap()
        pause(1)
        app.descendants(matching: .any)["glass-close"].tap()
        pause(1)

        closeSettings()
        XCTAssertTrue(app.descendants(matching: .any)["settings-mark"].waitForExistence(timeout: 3))
        capture("settings-closed")
    }

    /// A row of the menu that is up, by the start of its label (a
    /// submenu's label goes on with its value).
    private func menuRow(_ label: String) -> XCUIElement {
        app.collectionViews.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", label, label + ",")).firstMatch
    }

    /// A panel of the model control: `v2-picker-models`, `-efforts` or `-accounts`.
    private func panel(_ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    /// `label`'s line in the open panels.
    private func panelRow(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "picker-row:", label)).firstMatch
    }

    /// The picked line of `panel`: in view from the panel's first frame.
    private func assertPickedShows(_ panel: XCUIElement, _ name: String) {
        let picked = panel.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND selected == true", "picker-row:")).firstMatch
        XCTAssertTrue(picked.waitForExistence(timeout: 2), "\(name) checks nothing")
        let frame = picked.frame
        XCTAssertTrue(panel.frame.insetBy(dx: -1, dy: -1).contains(frame), "\(name)'s picked line \(frame) isn't in view in \(panel.frame)")
    }

    /// `control`'s own list, opened on its picked line.
    private func open(_ control: XCUIElement, _ id: String) {
        XCTAssertTrue(control.waitForExistence(timeout: 5), "no \(control)")
        control.tap()
        XCTAssertTrue(panel(id).waitForExistence(timeout: 3), "\(control) opened no \(id)")
        assertPickedShows(panel(id), id)
    }

    /// `label`'s line, scrolled to in short drags inside its panel.
    @discardableResult
    private func revealRow(_ label: String, in id: String) -> XCUIElement {
        let row = panelRow(label)
        let list = panel(id)
        // Vertically inside the panel: a line spans its panel's width.
        func shown() -> Bool { row.exists && row.frame.minY >= list.frame.minY + 4 && row.frame.maxY <= list.frame.maxY - 4 }
        for _ in 0..<16 where !shown() {
            let from = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: list.frame.midX, dy: list.frame.midY))
            let up = row.exists && row.frame.midY < list.frame.midY
            from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: up ? 80 : -80)))
            pause(0.5)
        }
        return row
    }

    private func pickIn(_ control: XCUIElement, _ id: String, _ label: String, shot: String) {
        open(control, id)
        let row = revealRow(label, in: id)
        XCTAssertTrue(row.exists, "\(id) has no \(label)")
        pause(1.5)
        capture(shot)
        row.tap()
        XCTAssertTrue(until(2) { !self.panel(id).exists }, "a pick left \(id) up")
        pause(1)
    }

    /// The model chip opens the model list and the effort chip the effort
    /// list, each opened on its checked line; a service's heading stacks its
    /// accounts over the model list in place; a touch outside closes the top
    /// panel only.
    func testPickerPanels() {
        home()
        pause(1.5)
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model: ")).firstMatch
        let effort = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Effort: ")).firstMatch
        open(model, "picker-models")
        XCTAssertFalse(panel("picker-efforts").exists)
        pause(1.5)
        capture("panel-models")
        let models = panel("picker-models").frame
        XCTAssertLessThan(models.maxY, model.frame.minY, "the list isn't over its chip")
        XCTAssertLessThanOrEqual(models.width, 250, "the list is wider than a menu")
        // A service's heading: its accounts over the list, where it stands.
        // The picked model's service, in view with it.
        let heading = app.descendants(matching: .any)["picker-heading:claude"]
        XCTAssertTrue(heading.exists, "the list has no service heading")
        heading.tap()
        let accounts = panel("picker-accounts")
        XCTAssertTrue(accounts.waitForExistence(timeout: 2), "a heading opened no accounts")
        XCTAssertEqual(accounts.frame.maxY, models.maxY, accuracy: 1, "the accounts aren't stacked over the list")
        // Wider than the room left of the list's trailing edge, they keep
        // the screen's 8pt margin.
        XCTAssertEqual(accounts.frame.minX, max(8, models.maxX - accounts.frame.width), accuracy: 1)
        assertPickedShows(accounts, "accounts")
        pause(1.5)
        capture("panel-accounts")
        // Outside the accounts, the list stays.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        XCTAssertTrue(until(2) { !accounts.exists }, "a tap away left the accounts up")
        XCTAssertTrue(panel("picker-models").exists, "a tap away from the accounts closed the list")
        pause(1)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        XCTAssertTrue(until(2) { !self.panel("picker-models").exists }, "a tap away left the list up")
        pause(1)
        open(effort, "picker-efforts")
        XCTAssertFalse(panel("picker-models").exists, "the effort chip opened the models")
        pause(1.5)
        capture("panel-efforts")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        XCTAssertTrue(until(2) { !self.panel("picker-efforts").exists })
        pause(1)
        // A pick far down the list: opened again, it shows from the start.
        pickIn(model, "picker-models", "Opus 5.5 1M", shot: "panel-pick-opus")
        XCTAssertTrue(model.label.contains("Opus 5.5 1M"), "the chip says \(model.label)")
        open(model, "picker-models")
        pause(1.5)
        capture("panel-models-opus")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        pause(1)
        // iOS's own menu, the + sheet's permission, to set these beside.
        openSheet()
        app.descendants(matching: .any)["attach-permission"].tap()
        XCTAssertTrue(menuRow("Read only").waitForExistence(timeout: 5), "no permission menu")
        pause(1.5)
        capture("native-menu")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap()
        let close = app.buttons["attach-close"]
        XCTAssertTrue(until(3) { !self.menuRow("Read only").exists && close.isHittable }, "the menu stayed")
        close.tap()
        pause(1)
    }

    /// The pickers: the dock's model chip before new work exists (the same
    /// composer new work opens on), then in its conversation's bar; each
    /// send goes with what was picked. The driver reads the modes back from
    /// the daemon.
    func testPickers() {
        home()
        pause(1.5)
        capture("dock-pickers")
        // Home holds one composer: its model chip, whatever it says now.
        let dock = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model: ")).firstMatch
        let dockEffort = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Effort: ")).firstMatch
        pickIn(dock, "picker-models", "Haiku 5.5", shot: "picker-model")
        pickIn(dockEffort, "picker-efforts", "Low", shot: "picker-effort")
        pause(1)
        capture("dock-picked")

        app.descendants(matching: .any)["new-work"].tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        XCTAssertTrue(app.buttons["Model: Haiku 5.5"].waitForExistence(timeout: 5), "new work lost the dock's model")
        XCTAssertTrue(app.buttons["Effort: Low"].exists, "new work lost the dock's effort")
        pause(1)
        capture("new-work-chips")
        composer.typeText("Say which model you are in five words or fewer. No tools.")
        app.buttons["Send"].tap()
        let messages = app.descendants(matching: .any).matching(identifier: "message")
        let working = app.descendants(matching: .any)["working"]
        var deadline = Date().addingTimeInterval(120)
        while Date() < deadline, messages.count < 2 || working.exists { pause(1) }
        pause(1.5)
        print("HAPPY_FIRST_ANSWERED")

        app.swipeDown(velocity: .slow)
        pause(1)
        pickIn(app.buttons["Model: Haiku 5.5"], "picker-models", "Sonnet 5", shot: "chat-picker-model")
        // A new model starts on its own default effort.
        XCTAssertTrue(app.buttons["Effort: Medium"].waitForExistence(timeout: 3))
        pickIn(app.buttons["Effort: Medium"], "picker-efforts", "High", shot: "chat-picker-effort")
        XCTAssertTrue(app.buttons["Effort: High"].waitForExistence(timeout: 3))
        composer.tap()
        composer.typeText("And now? Five words or fewer.")
        app.buttons["Send"].tap()
        deadline = Date().addingTimeInterval(120)
        pause(2)
        while Date() < deadline, messages.count < 4 || working.exists { pause(1) }
        pause(2)
        capture("chat-picked")
        app.tapBack()
        pause(2)
        // The dock keeps its own pick for the next new work.
        XCTAssertTrue(dock.label.contains("Haiku 5.5"))
    }

    /// Rows nested under a row as desktop has them, against the computer's
    /// side played by `family_driver.py`. A fold is the document's: one made
    /// on the computer shows here live, and one made here reaches the
    /// computer (`DRIVER_DOC`). Siblings reorder among themselves, a
    /// subtask's own subtasks show and fold, one is archived, a task set
    /// under a row renames in place, and a section's heading is deleted
    /// with its rows left where they were.
    func testFamily() {
        home()
        pause(1.5)
        let parent = "Refactor billing service"
        let task = row("space", parent)
        // Prioritizing may have filed it under a folded section.
        if !task.waitForExistence(timeout: 3) { openFoldedSections() }
        XCTAssertTrue(task.waitForExistence(timeout: 5))
        bringIntoView(task)
        pause(1)
        // One read: a row may go between two questions about it.
        func shows(_ element: XCUIElement) -> Bool {
            guard let shot = try? element.snapshot() else { return false }
            return shot.frame.height > 0 && shot.frame.minY < app.frame.height && shot.frame.maxY > 0
        }
        func until(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
            let deadline = Date().addingTimeInterval(seconds)
            while Date() < deadline { if condition() { return true }; pause(0.2) }
            return condition()
        }
        /// A tap on a row's chevron, at its trailing end.
        func fold(_ row: XCUIElement) {
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: row.frame.maxX - 25, dy: row.frame.midY)).tap()
        }
        let plan = row("session", "Billing test plan")
        let deps = row("session", "Invoice deps")
        if !shows(plan) { fold(task) }
        XCTAssertTrue(until(5) { shows(plan) && shows(deps) }, "the task's subtasks aren't under it")
        capture("family-open")

        // Folded and unfolded on the computer: live here.
        print("HAPPY_FAMILY_FOLD false \(parent)")
        XCTAssertTrue(until(8) { !shows(plan) }, "a fold made on the computer didn't show")
        capture("family-folded-there")
        pause(1)
        print("HAPPY_FAMILY_FOLD true \(parent)")
        XCTAssertTrue(until(8) { shows(plan) }, "an unfold made on the computer didn't show")
        pause(1)

        // Folded here: at once, and the computer has it.
        fold(task)
        XCTAssertTrue(until(0.6) { !shows(plan) }, "the fold didn't happen at once")
        capture("family-folded-here")
        pause(1.5)
        print("HAPPY_FAMILY_READ folded-here")
        pause(1)
        fold(task)
        XCTAssertTrue(until(0.6) { shows(plan) }, "the unfold didn't happen at once")
        pause(1.5)
        print("HAPPY_FAMILY_READ unfolded-here")

        // A subtask's own subtasks, shown under it and folded with it: the
        // family the run keeps for itself (`family_fixture.py` makes
        // whatever a run used up: Family fixture › Fixture plan › Fixture leaf).
        let fixture = row("space", "Family fixture")
        let holder = row("session", "Fixture plan")
        let leaf = row("session", "Fixture leaf")
        /// Its subtasks shown by its chevron, whether folded or not yet in the sidebar.
        func reveal(_ owner: XCUIElement, _ name: String) {
            bringIntoView(owner)
            pause(1)
            fold(owner)
        }
        XCTAssertTrue(fixture.waitForExistence(timeout: 5), "no Family fixture task (run family_fixture.py)")
        bringIntoView(fixture)
        if !until(1, { shows(holder) }) { reveal(fixture, "the fixture task") }
        XCTAssertTrue(until(6) { shows(holder) }, "the fixture task's subtask didn't show under it")
        if !until(1, { shows(leaf) }) { reveal(holder, "a subtask with subtasks") }
        XCTAssertTrue(until(6) { shows(leaf) }, "a subtask's subtasks didn't show under it")
        XCTAssertGreaterThan(leaf.frame.minY, holder.frame.minY, "the subtask's subtask isn't under it")
        pause(1)
        capture("family-nested")
        fold(holder)
        XCTAssertTrue(until(0.6) { !shows(leaf) }, "a subtask didn't fold")
        pause(1.5)
        fold(holder)
        XCTAssertTrue(until(2) { shows(leaf) })
        pause(1.5)

        // Siblings: the upper one carried down past the
        // lower one. Clear of the dock, and away from the menu over the row.
        bringIntoView(plan)
        pause(1)
        let (upper, lower) = plan.frame.minY < deps.frame.minY ? (plan, deps) : (deps, plan)
        capture("family-drag-before")
        upper.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.7, thenDragTo: lower.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 3.2)), withVelocity: .slow, thenHoldForDuration: 0.8)
        pause(1.5)
        capture("family-drag-after")
        XCTAssertGreaterThan(upper.frame.minY, lower.frame.minY, "the subtask didn't move past its sibling")
        XCTAssertGreaterThan(lower.frame.minY, task.frame.minY, "the subtask left its family")
        pause(1.5)
        print("HAPPY_FAMILY_READ dragged")
        pause(1)

        // A subtask's subtask archived from its menu: gone once the computer says.
        bringIntoView(leaf)
        pause(1)
        if shows(leaf) {
            let id = leaf.identifier
            leaf.press(forDuration: 1.0)
            let archive = app.buttons["Archive subtask"]
            XCTAssertTrue(archive.waitForExistence(timeout: 3), "a subtask offered no archive")
            XCTAssertFalse(app.buttons["Rename"].exists || app.buttons["Rename task"].exists, "a subtask offered a rename")
            capture("family-subtask-leaf-menu")
            archive.tap()
            XCTAssertTrue(until(10) { !shows(app.descendants(matching: .any)[id]) }, "the archived subtask stayed")
            capture("family-archived")
        } else {
            XCTFail("the fixture's leaf isn't on screen to archive")
        }

        // A task set under a row renames in place, as at the top.
        let (from, to) = row("space", "Compare home insurance").waitForExistence(timeout: 2) ? ("Compare home insurance", "Compare insurance quotes") : ("Compare insurance quotes", "Compare home insurance")
        // Back to the task: the fixture steps left the list at the top.
        bringIntoView(task)
        pause(1)
        print("HAPPY_FAMILY_NEST \(from) | \(parent)")
        let nested = row("space", from)
        XCTAssertTrue(until(8) { shows(nested) && nested.frame.minY > task.frame.minY && nested.frame.minX >= task.frame.minX }, "the task wasn't set under the row")
        pause(1)
        bringIntoView(nested)
        nested.press(forDuration: 1.0)
        let rename = app.buttons["Rename task"]
        XCTAssertTrue(rename.waitForExistence(timeout: 3), "a nested task offered no rename")
        capture("family-nested-menu")
        rename.tap()
        let field = app.textFields["rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.typeText(to + "\n")
        XCTAssertTrue(row("space", to).waitForExistence(timeout: 2), "the nested rename didn't show")
        capture("family-nested-renamed")
        pause(2)
        print("HAPPY_FAMILY_UNNEST \(to)")
        pause(3)

        // A section's heading deleted: its rows stay, under the one above.
        print("HAPPY_FAMILY_SECTION_ADD Scratch")
        let section = row("section", "Scratch")
        XCTAssertTrue(section.waitForExistence(timeout: 8), "the computer's section didn't show")
        bringIntoView(section)
        pause(1)
        let meals = row("space", "Meals this week")
        let mealsY = meals.frame.minY
        section.press(forDuration: 1.0)
        let delete = app.buttons["Delete section"]
        XCTAssertTrue(delete.waitForExistence(timeout: 3), "a section offered no delete")
        capture("family-section-menu")
        delete.tap()
        XCTAssertTrue(until(0.8) { !section.exists }, "the heading didn't go at once")
        XCTAssertTrue(shows(meals), "the section's rows went with it")
        XCTAssertLessThan(meals.frame.minY, mealsY, "its rows didn't close up under the block above")
        capture("family-section-deleted")
        pause(2)
        print("HAPPY_FAMILY_READ section-deleted")
        pause(1)
    }


    /// A collaborator's report ("Collaborator <id> finished working…"),
    /// as desktop's AgentMessageActivity: one line naming who it came from
    /// and what it said it is, with a chevron; a tap opens the message under
    /// it and another closes it. The fixture is collab_fixture.py's task.
    func testCollaborator() {
        home()
        let task = row("space", "Collaborator fixture")
        XCTAssertTrue(task.waitForExistence(timeout: 10), "collab_fixture.py's task is missing")
        bringIntoView(task)
        task.tap()
        let message = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Finished: final answer")).firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 15), "no collaborator row")
        XCTAssertFalse(message.label.contains("Banana"), "the message shows before it is opened")
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "finished working. Its answer follows")).firstMatch.exists, "the report shows as plain text")
        pause(1)
        capture("collaborator-closed")
        // The line itself opens it.
        let line = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: message.frame.minX + 80, dy: message.frame.minY + 16))
        line.tap()
        XCTAssertTrue(until(3) { message.label.contains("Banana") }, "a tap didn't open the message")
        pause(1)
        capture("collaborator-open")
        // Where the line is now: the message opened under it may have lifted it.
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: message.frame.minX + 80, dy: message.frame.minY + 16)).tap()
        XCTAssertTrue(until(3) { !message.label.contains("Banana") }, "a second tap didn't close it")
        pause(1)
        capture("collaborator-closed-again")
    }

    /// The composer with nothing in between: new work opens straight on its
    /// composer, + goes straight to the library, and a long press's Paste
    /// attaches a copied picture, sent with the message. A copied recording
    /// offers no Paste: a message carries only text and pictures.
    func testPaste() {
        home()
        pause(1)
        app.descendants(matching: .any)["new-work"].tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertFalse(app.alerts.firstMatch.exists || app.sheets.firstMatch.exists, "something stood between new work and its composer")
        pause(1)
        capture("paste-new-work")

        // The "+" sheet's Photos opens the shared library sheet; a photo picked there waits in the composer.
        openLibrary()
        let library = app.descendants(matching: .any)["library-picker"]
        XCTAssertTrue(library.waitForExistence(timeout: 5), "Photos didn't open the library")
        XCTAssertFalse(app.alerts.firstMatch.exists, "+ asked first")
        let first = app.descendants(matching: .any)["library-cell:0"]
        XCTAssertTrue(first.waitForExistence(timeout: 5), "the library shows no photo")
        pause(1)
        first.tap()
        pause(0.5)
        capture("paste-plus-library")
        app.descendants(matching: .any)["library-add"].tap()
        let attachments = app.descendants(matching: .any).matching(identifier: "composer-attachment")
        XCTAssertTrue(attachments.firstMatch.waitForExistence(timeout: 8), "the picked photo didn't attach")
        pause(1)
        capture("paste-library-attached")

        // A copied picture: a long press, Paste, and it waits in the composer.
        let size = CGSize(width: 240, height: 160)
        let picture = UIGraphicsImageRenderer(size: size).image { context in
            UIColor.systemOrange.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
        UIPasteboard.general.image = picture
        composer.press(forDuration: 1.0)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 3), "a copied picture offered no Paste")
        capture("paste-menu")
        paste.tap()
        XCTAssertTrue(until(5) { attachments.count == 2 }, "the pasted picture didn't attach")
        let attachment = attachments.firstMatch
        pause(1)
        capture("paste-attached")
        composer.typeText("What colour is the plain picture? One word, no tools.")
        app.buttons["Send"].tap()
        XCTAssertTrue(until(4) { !attachment.exists }, "the picture stayed in the composer")
        let messages = app.descendants(matching: .any).matching(identifier: "message")
        let working = app.descendants(matching: .any)["working"]
        let deadline = Date().addingTimeInterval(120)
        pause(2)
        while Date() < deadline, messages.count < 2 || working.exists { pause(1) }
        pause(1.5)
        capture("paste-sent")
        let answer = messages.allElementsBoundByIndex.map(\.label).joined(separator: " ").lowercased()
        print("HAPPY_PASTE_ANSWER \(answer.suffix(200))")
        XCTAssertTrue(answer.contains("orange"), "the agent didn't see the pasted picture: \(answer.suffix(200))")

        // A copied recording: no Paste, nothing attached.
        UIPasteboard.general.items = [["public.mpeg-4": Data(repeating: 0, count: 64)]]
        composer.tap()
        pause(0.5)
        composer.press(forDuration: 1.0)
        pause(1)
        capture("paste-video")
        XCTAssertFalse(app.menuItems["Paste"].exists, "a recording offered Paste")
        XCTAssertFalse(attachment.exists)
    }

    /// Home's dock is new work's own composer, in the same place: its "+"
    /// goes to new work with the library coming up over it, and what is
    /// picked waits in that composer.
    func testDockAdd() {
        home()
        pause(1.5)
        let field = app.descendants(matching: .any)["new-work"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "no dock")
        let dockFrame = field.frame
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model: ")).firstMatch.exists, "the dock has no model chip")
        capture("dock-home")
        app.buttons["Add a picture"].tap()
        allowPhotos()
        let sheet = app.descendants(matching: .any)["attach-sheet"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 5), "the dock's + didn't open the + sheet")
        pause(1)
        capture("dock-add-sheet")
        let first = app.descendants(matching: .any)["attach-photo:0"]
        XCTAssertTrue(first.waitForExistence(timeout: 5), "the strip shows no photo")
        first.tap()
        pause(0.5)
        app.buttons["attach-photos"].tap()
        let attachments = app.descendants(matching: .any).matching(identifier: "composer-attachment")
        XCTAssertTrue(attachments.firstMatch.waitForExistence(timeout: 8), "the picked photo didn't attach")
        XCTAssertTrue(app.textViews["composer"].exists, "the library didn't open over new work")
        pause(1.5)
        capture("dock-add-attached")
        app.tapBack()
        pause(1.5)
        // Back home, the dock is where it was.
        XCTAssertEqual(field.frame.minY, dockFrame.minY, accuracy: 1)
        // Put away: never sent, it would wait in the sidebar as "New".
        let made = app.descendants(matching: .any)["row:space:New"].firstMatch
        if made.waitForExistence(timeout: 3) {
            made.press(forDuration: 1.0)
            let close = app.buttons["Close new work"]
            if close.waitForExistence(timeout: 3) { close.tap() }
            pause(1.5)
        }
    }

    /// The composer's "+" is Claude's "Add to session": the dock's opens it
    /// over new work with the keyboard down; two photos picked in its strip
    /// attach in order; Paste from clipboard puts text in at the cursor and
    /// attaches a picture; Add files takes a picture from Files and says a
    /// text file can't go; Permission sets the mode the next message runs
    /// with (checked against the daemon after the run).
    func testAttachSheet() {
        home()
        pause(1)
        UIPasteboard.general.string = "Pasted from the clipboard."
        app.buttons["Add a picture"].tap()
        allowPhotos()
        let sheet = app.descendants(matching: .any)["attach-sheet"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 5), "the dock's + didn't open the + sheet")
        let first = app.descendants(matching: .any)["attach-photo:0"]
        XCTAssertTrue(first.waitForExistence(timeout: 5), "no photos in the strip")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the keyboard came up under the sheet")
        let camera = app.descendants(matching: .any)["attach-camera"]
        XCTAssertTrue(camera.exists, "no camera tile")
        XCTAssertFalse(camera.isEnabled, "a camera on the simulator")
        for id in ["attach-paste", "attach-files", "attach-permission"] {
            XCTAssertTrue(app.descendants(matching: .any)[id].exists, "no \(id) row")
        }
        let photos = app.buttons["attach-photos"]
        XCTAssertEqual(photos.label, "Photos")
        pause(1)
        capture("attach-sheet")

        // Two photos, picked in order: Photos turns into Add 2.
        first.tap()
        app.descendants(matching: .any)["attach-photo:1"].tap()
        pause(0.5)
        XCTAssertEqual(photos.label, "Add 2")
        XCTAssertEqual(first.label, "Photo, picked 1")
        capture("attach-picked")
        photos.tap()
        let attachments = app.descendants(matching: .any).matching(identifier: "composer-attachment")
        XCTAssertTrue(until(8) { attachments.count == 2 }, "the two photos didn't attach")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3), "adding didn't bring the keyboard up")
        let composer = app.textViews["composer"]
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }

        // Text on the clipboard goes in where the cursor is.
        openSheet()
        app.descendants(matching: .any)["attach-paste"].tap()
        allowPaste()
        XCTAssertTrue(until(5) { (composer.value as? String)?.contains("Pasted from the clipboard.") == true }, "the copied text didn't go in")
        pause(1)
        capture("attach-pasted-text")

        // A copied picture attaches.
        let size = CGSize(width: 240, height: 160)
        UIPasteboard.general.image = UIGraphicsImageRenderer(size: size).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
        openSheet()
        app.descendants(matching: .any)["attach-paste"].tap()
        allowPaste()
        XCTAssertTrue(until(8) { attachments.count == 3 }, "the copied picture didn't attach")
        pause(1)
        capture("attach-pasted-picture")

        // Files: a picture goes through.
        openSheet()
        app.descendants(matching: .any)["attach-files"].tap()
        XCTAssertTrue(pickInFiles("attach-swatch"), "Files didn't offer the picture")
        XCTAssertTrue(until(8) { attachments.count == 4 }, "the picture from Files didn't attach")
        pause(1)
        capture("attach-file-picture")
        // The photos start where the text does, as far down from the box's
        // top as that is in from its side, and every remove button is inside.
        let box = app.descendants(matching: .any)["input"].frame
        let text = app.textViews["composer"].frame
        let photo = attachments.element(boundBy: 0).frame
        XCTAssertEqual(photo.minX, text.minX, accuracy: 0.5, "the photos don't start where the text does")
        XCTAssertEqual(photo.minY - box.minY, text.minX - box.minX, accuracy: 0.5, "the photos' top inset isn't the text's left one")
        let removes = app.descendants(matching: .any).matching(identifier: "composer-attachment-remove")
        XCTAssertEqual(removes.count, 4)
        for index in 0..<removes.count {
            let remove = removes.element(boundBy: index).frame
            XCTAssertTrue(box.contains(remove), "remove button \(index) at \(remove) is cut by \(box)")
            XCTAssertGreaterThan(remove.minY, box.minY)
        }
        // A text file is said, not sent.
        openSheet()
        app.descendants(matching: .any)["attach-files"].tap()
        XCTAssertTrue(pickInFiles("attach-notes"), "Files didn't offer the text file")
        let refused = app.alerts["attach-notes.txt wasn't attached"]
        XCTAssertTrue(refused.waitForExistence(timeout: 8), "the text file wasn't said")
        XCTAssertTrue(refused.staticTexts["A message to an agent carries text and pictures only for now."].exists)
        capture("attach-file-refused")
        refused.buttons["Done"].tap()
        XCTAssertTrue(until(3) { !refused.exists })
        pause(0.8)
        XCTAssertEqual(attachments.count, 4)

        // Permission: Read only for the next message.
        let typing = app.keyboards.firstMatch.exists
        openSheet()
        let permission = app.descendants(matching: .any)["attach-permission"]
        let before = permission.value as? String
        permission.tap()
        let readOnly = menuRow("Read only")
        XCTAssertTrue(readOnly.waitForExistence(timeout: 5), "no permission menu")
        pause(1)
        capture("attach-permission-picker")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the keyboard came up over the sheet with its menu")
        readOnly.tap()
        XCTAssertTrue(until(4) { permission.value as? String == "Read only" }, "the row still says \(before ?? "nothing")")
        XCTAssertTrue(sheet.exists, "picking the permission closed the sheet")
        pause(1)
        capture("attach-permission-read-only")
        app.buttons["attach-close"].tap()
        XCTAssertTrue(until(3) { !sheet.exists }, "the close circle didn't close the sheet")
        // The keyboard the sheet put down comes back with it gone.
        if typing { XCTAssertTrue(until(3) { app.keyboards.firstMatch.exists }, "the keyboard didn't come back") }

        // Sent: the daemon runs it Read only (checked from outside after the run).
        composer.tap()
        composer.typeText(" Say in five words what these pictures show. No tools.")
        app.buttons["Send"].tap()
        let messages = app.descendants(matching: .any).matching(identifier: "message")
        let working = app.descendants(matching: .any)["working"]
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, messages.count < 2 || working.exists { pause(1) }
        XCTAssertGreaterThanOrEqual(messages.count, 2, "the agent never answered")
        pause(1)
        capture("attach-sent")
        app.tapBack()
        pause(1)
    }

    private func openSheet() {
        app.buttons["Add a picture"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["attach-sheet"].waitForExistence(timeout: 5), "+ didn't open its sheet")
        pause(0.8)
    }

    /// The "+" sheet's Photos: the whole library.
    private func openLibrary() {
        app.buttons["Add a picture"].tap()
        allowPhotos()
        let photos = app.buttons["attach-photos"]
        XCTAssertTrue(photos.waitForExistence(timeout: 5), "+ didn't open its sheet")
        photos.tap()
        allowPhotos()
    }

    private func allowPhotos() {
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Full Access"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
    }

    /// Reading another app's copy is the system's to allow.
    private func allowPaste() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Paste"]
        let here = app.buttons["Allow Paste"]
        let deadline = Date().addingTimeInterval(6)
        var seen = false
        while Date() < deadline {
            let shown = springboard.exists ? springboard : here.exists ? here : nil
            if let shown {
                seen = true
                // Taken only once it has finished coming up.
                pause(0.6)
                if shown.exists, shown.isHittable { shown.tap() }
            } else if seen {
                return
            }
            pause(0.3)
        }
    }

    /// `name` in Files' picker, found in On My iPhone if it isn't already
    /// shown, and opened.
    private func pickInFiles(_ name: String) -> Bool {
        let item = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        if !item.waitForExistence(timeout: 4) {
            let browse = app.buttons["Browse"]
            if browse.waitForExistence(timeout: 2) {
                browse.tap()
                pause(0.8)
                if !item.exists { browse.tap(); pause(0.8) }
            }
            let local = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "On My iPhone")).firstMatch
            if !item.exists, local.waitForExistence(timeout: 3) {
                local.tap()
                pause(1)
            }
        }
        guard item.waitForExistence(timeout: 5) else { return false }
        pause(0.8)
        capture("attach-files-\(name)")
        item.tap()
        let open = app.buttons["Open"]
        if open.waitForExistence(timeout: 2), open.isEnabled { open.tap() }
        return true
    }

    /// A conversation's header is its own glass, the system bar gone: a
    /// back circle and the name in a capsule over the transcript. A swipe
    /// back let go halfway leaves it as it was; a whole one goes home.
    func testGlassHeader() {
        home()
        pause(1)
        let task = row("space", "Collaborator fixture")
        if !task.waitForExistence(timeout: 3) { openFoldedSections() }
        bringIntoView(task)
        task.tap()
        let back = app.buttons["chat-back"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), "no glass back button")
        XCTAssertTrue(app.descendants(matching: .any)["chat-title"].exists, "no name in the header")
        pause(1.5)
        XCTAssertFalse(app.navigationBars.firstMatch.exists && app.navigationBars.firstMatch.isHittable, "the system bar shows over the glass header")
        capture("glass-header")
        // Let go a third of the way: still here, still glass.
        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)), withVelocity: .slow, thenHoldForDuration: 0.3)
        pause(1.5)
        XCTAssertTrue(back.isHittable, "a cancelled swipe left the conversation")
        XCTAssertFalse(app.navigationBars.firstMatch.exists && app.navigationBars.firstMatch.isHittable, "a cancelled swipe brought the system bar back")
        capture("glass-header-after-cancelled-swipe")
        // All the way: home.
        edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)), withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(until(4) { !back.exists }, "the swipe didn't go back")
        XCTAssertTrue(app.descendants(matching: .any)["new-work"].waitForExistence(timeout: 3), "not home after the swipe")
        pause(1)
        capture("glass-header-swiped-home")
    }

    /// New work from the dock isn't a screen pushed over home: the
    /// composer stays where it is and rides up on the keyboard while new
    /// work fades in around it. The back circle and an edge swipe fade it
    /// out again, the keyboard going down with the composer to the dock.
    func testDockTransition() {
        home()
        pause(1.5)
        let field = app.descendants(matching: .any)["new-work"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "no dock")
        let dockFrame = field.frame
        let back = app.buttons["chat-back"]
        for leaving in ["button", "swipe"] {
            field.tap()
            let composer = app.textViews["composer"]
            XCTAssertTrue(composer.waitForExistence(timeout: 3), "no new work")
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3), "no keyboard")
            if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
            XCTAssertTrue(back.waitForExistence(timeout: 3), "no back circle")
            pause(1)
            XCTAssertEqual(composer.frame.minX, dockFrame.minX, accuracy: 1, "the composer moved sideways")
            XCTAssertEqual(composer.frame.width, dockFrame.width, accuracy: 1, "the composer changed width")
            capture("dock-transition-open-\(leaving)")
            if leaving == "button" {
                back.tap()
            } else {
                // Let go a fifth of the way: still new work, the keyboard back up.
                let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.4))
                edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.4)), withVelocity: .slow, thenHoldForDuration: 0.3)
                pause(1.5)
                XCTAssertTrue(back.isHittable, "a swipe let go of left new work")
                XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3), "the keyboard didn't come back after a swipe let go of")
                XCTAssertEqual(composer.frame.minX, dockFrame.minX, accuracy: 1)
                capture("dock-transition-swipe-cancelled")
                edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.4)), withVelocity: .fast, thenHoldForDuration: 0)
            }
            XCTAssertTrue(until(4) { !back.exists }, "the \(leaving) didn't go back")
            XCTAssertTrue(until(3) { !app.keyboards.firstMatch.exists }, "the keyboard stayed after the \(leaving)")
            pause(1)
            XCTAssertEqual(field.frame.minY, dockFrame.minY, accuracy: 1, "the dock isn't where it was")
            capture("dock-transition-closed-\(leaving)")
        }
        // Put away: never sent, they would wait in the sidebar as "New".
        for _ in 0..<2 {
            let made = app.descendants(matching: .any)["row:space:New"].firstMatch
            guard made.waitForExistence(timeout: 3) else { break }
            made.press(forDuration: 1.0)
            let close = app.buttons["Close new work"]
            if close.waitForExistence(timeout: 3) { close.tap() }
            pause(1.5)
        }
    }

    private func until(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline { if condition() { return true }; pause(0.2) }
        return condition()
    }
}

extension XCUIApplication {
    /// Back: a conversation's glass circle or settings', else the bar's
    /// own button.
    func tapBack() {
        for id in ["chat-back", "glass-back"] {
            let glass = buttons[id].firstMatch
            if glass.exists, glass.isHittable { return glass.tap() }
        }
        navigationBars.buttons.element(boundBy: 0).tap()
    }
}

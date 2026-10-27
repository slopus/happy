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

/// Stem Cells against a real throwaway Happy Agent on this Mac. A driver
/// outside the test opens the daemon's pairing link on this simulator,
/// confirms the pairing on the daemon's side and records the screen; the
/// test is the person's finger. Nothing here holds a credential.
@MainActor
final class StemCellsUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        print("StemCellsUITests skips quiescence: \(skipsQuiescence)")
        // Direct connection is an experiment, off on a fresh install.
        app.launchEnvironment["STEM_DIRECT"] = "1"
        app.launch()
    }

    /// Pairs if this simulator has no computer yet, then waits for its sidebar.
    private func home() {
        // Any row: Prioritizing may have filed Happy's under a folded section.
        let happy = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:")).firstMatch
        if happy.waitForExistence(timeout: 8) { return }
        print("STEM_PAIR_READY")
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
        app.descendants(matching: .any)["stem-row:\(kind):\(label)"]
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
        }
    }

    /// A tap on a row's chevron, at its trailing end: its centre half the
    /// row's height in from the row's end.
    private func tapChevron(_ row: XCUIElement) {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: row.frame.maxX - row.frame.height / 2, dy: row.frame.midY)).tap()
    }

    /// Opens every folded section, top to bottom.
    private func openFoldedSections() {
        let sections = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:section:"))
        for id in sections.allElementsBoundByIndex.map(\.identifier) {
            let section = app.descendants(matching: .any)[id]
            bringIntoView(section)
            pause(0.5)
            let under = rowUnder(section)
            if under == nil || under!.identifier.hasPrefix("stem-row:section:") || under!.identifier.hasPrefix("stem-row:separator") {
                tapChevron(section)
                pause(1)
            }
        }
    }

    /// The row drawn right under `row`, if any.
    private func rowUnder(_ row: XCUIElement) -> XCUIElement? {
        let bottom = row.frame.maxY
        guard let under = shownRows("stem-row:").filter({ $0.frame.minY >= bottom - 1 }).min(by: { $0.frame.minY < $1.frame.minY }) else { return nil }
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
        XCTAssertTrue(app.buttons["stem-search"].exists)
        pause(2)
        capture("sidebar")
        let sections = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:section:"))
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
        app.descendants(matching: .any)["stem-new-work"].tap()
        let intro = app.staticTexts["Say what it is — it’ll find its place."]
        XCTAssertTrue(intro.waitForExistence(timeout: 3))
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        pause(1.5)
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        capture("new-work-intro")
        composer.typeText("Write a four-line poem about a pineapple that wants to be a cactus. No tools, just answer.")
        pause(1)
        app.buttons["Send"].tap()
        // The simulator's first keyboard explains swipe typing once.
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        let messages = app.descendants(matching: .any).matching(identifier: "stem-message")
        let working = app.descendants(matching: .any)["stem-working"]
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
        app.descendants(matching: .any)["stem-new-work"].tap()
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        pause(1.5)
        let intro = app.descendants(matching: .any)["stem-intro"]
        let back = app.buttons["stem-chat-back"]
        let input = app.descendants(matching: .any)["stem-input"]
        let top = intro.frame.minY
        XCTAssertGreaterThanOrEqual(top, back.frame.maxY - 1, "the intro is under the bar's row")
        XCTAssertLessThan(top - back.frame.maxY, 16, "the intro isn't pinned under the bar")
        capture("layout-intro")
        // Claude's week is spent on the e2e computer: a model that answers.
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model: ")).firstMatch
        if !model.label.contains("GPT-6.1 Sol") { pickIn(model, "stem-picker-models", "GPT-6.1 Sol", shot: "layout-model") }
        XCTAssertEqual(intro.frame.minY, top, accuracy: 1, "picking a model moved the intro")
        composer.tap()
        composer.typeText("Plan a long weekend in Lisbon for the four of us. Two lines, no tools.")
        app.buttons["Send"].tap()
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        let messages = app.descendants(matching: .any).matching(identifier: "stem-message")
        XCTAssertTrue(until(5) { messages.count >= 1 }, "the send never showed")
        pause(1)
        XCTAssertEqual(intro.frame.minY, top, accuracy: 1, "the first send moved the intro")
        XCTAssertEqual(messages.element(boundBy: 0).frame.minY, intro.frame.maxY, accuracy: 1, "the first message isn't right under the intro")
        let introLine = intro.frame.height
        capture("layout-first")
        // The agent done with it, answered or not.
        let working = app.descendants(matching: .any)["stem-working"]
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
        let line = min(max((viewport * 0.3).rounded(), introLine), (viewport * 0.5).rounded())
        XCTAssertEqual(sent.frame.minY - top, line, accuracy: 1.5, "the follow-up isn't lifted to the line (viewport \(viewport))")
        XCTAssertGreaterThan(input.frame.minY - sent.frame.maxY, 40, "no room held for the reply")
        capture("layout-follow-up")
        let deadlineReply = Date().addingTimeInterval(120)
        while Date() < deadlineReply, messages.count < before + 2 || working.exists { pause(1) }
        pause(2)
        capture("layout-follow-up-answered")
    }

    /// New work left with nothing in it goes: the sidebar comes back without
    /// its row, never showing it on the way, and the computer drops it too
    /// (it isn't there after a fresh launch either).
    func testEmptyNewWorkGoes() {
        home()
        pause(1.5)
        let untitled = app.descendants(matching: .any).matching(identifier: "stem-row:space:New")
        let before = untitled.count
        app.descendants(matching: .any)["stem-new-work"].tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 3))
        pause(1)
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        capture("empty-new-work")
        app.tapBack()
        var most = 0
        for _ in 0..<6 {
            most = max(most, untitled.count)
            pause(0.25)
        }
        XCTAssertEqual(most, before, "the empty new work's row showed as the sidebar came back")
        capture("empty-new-work-gone")
        pause(2)
        app.terminate()
        app.launch()
        home()
        pause(2)
        XCTAssertEqual(untitled.count, before, "the computer kept the empty new work")
    }

    /// New work, then back to the sidebar to watch its stem cell hatch into
    /// the picture Prioritizing gives it.
    func testHatch() {
        home()
        pause(1)
        let cells = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND value == %@", "stem-row:space:", "stem cell"))
        let before = cells.count
        app.descendants(matching: .any)["stem-new-work"].tap()
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        composer.typeText("Plan a weekend of bouldering in Fontainebleau. One line, no tools.")
        app.buttons["Send"].tap()
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        pause(2)
        app.tapBack()
        XCTAssertGreaterThan(cells.count, before, "no stem cell row")
        capture("hatch-waiting")
        let deadline = Date().addingTimeInterval(150)
        while Date() < deadline, cells.count > before { pause(0.5) }
        // The hatch plays for 2.5 s.
        pause(1.2)
        capture("hatching")
        pause(4)
        capture("hatched")
        XCTAssertLessThan(Date(), deadline, "the stem cell never hatched")
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
        let field = app.textFields["stem-rename"]
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
        let preview = app.descendants(matching: .any)["stem-preview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 3), "a hold showed no preview")
        XCTAssertTrue(preview.descendants(matching: .any)["stem-preview-title"].exists, "the preview has no name")
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
        let menu = app.descendants(matching: .any)["stem-hold-menu"]
        XCTAssertTrue(menu.exists, "no menu under the preview")
        XCTAssertEqual(menu.frame.minY, preview.frame.maxY + 10, accuracy: 0.5)
        XCTAssertEqual(menu.frame.maxX, preview.frame.maxX, accuracy: 0.5)
        // Only what changes the row: its name, its place, putting it away.
        XCTAssertTrue(menu.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Rename")).count == 1, "no Rename in the menu")
        XCTAssertTrue(menu.buttons["Reorder"].exists, "no Reorder in the menu")
        for gone in ["Open", "Show subtasks", "Hide subtasks", "Collapse", "Expand", "Mark as read", "Mark as unread"] {
            XCTAssertFalse(menu.buttons[gone].exists, "the menu still offers \(gone)")
        }
        pause(1.5)
        capture("hold-preview")
        // Let go, it stayed; a tap on it opens the conversation.
        preview.tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 4), "tapping the preview didn't open the conversation")
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
        let field = app.textFields["stem-rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 3), "Rename didn't edit the row")
        XCTAssertFalse(app.descendants(matching: .any)["stem-preview"].exists)
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
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-swipe")).count, 0, "a pull still uncovers actions")
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

    /// A hold lifts a row with its menu; moving carries it (the menu goes),
    /// its peers glide aside, and the drop lands where the gap was. A
    /// section carries its rows.
    func testReorder() {
        home()
        pause(1)
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:space:"))
        func order() -> [String] {
            // Rows named alike (two "Trip notes") can't be told apart by name: left out.
            let ids = shownRows("stem-row:space:").sorted { $0.frame.minY < $1.frame.minY }.map { $0.identifier }
            return ids.filter { id in ids.filter { $0 == id }.count == 1 }
        }
        // A task a few rows down, carried up two rows.
        let all = order()
        guard all.count > 5 else { return XCTFail("too few rows to reorder: \(all)") }
        let moving = app.descendants(matching: .any)[all[4]]
        let target = app.descendants(matching: .any)[all[2]]
        _ = (moving.frame, target.frame)
        capture("reorder-before")
        // Held: the menu shows first.
        moving.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.2, thenDragTo: target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)), withVelocity: .slow, thenHoldForDuration: 0.8)
        pause(2)
        capture("reorder-after")
        let after = order()
        // Just over the row it was let go on (a section heading may stand between).
        let landed = after.firstIndex(of: all[4]) ?? -1
        XCTAssertTrue(landed < after.firstIndex(of: all[2])! && landed > after.firstIndex(of: all[0])!, "the row did not land over \(all[2]): \(after)")
        // Released without moving: the preview and menu stay open.
        moving.press(forDuration: 1.2)
        XCTAssertTrue(app.descendants(matching: .any)["stem-hold-menu"].waitForExistence(timeout: 2), "the menu did not stay")
        pause(1)
        capture("reorder-menu-stays")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        pause(1)
        // A section, carried with its rows to the top.
        let sections = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:section:"))
        // A section, carried over the section above it (past its whole block,
        // as desktop asks: a neighbour is passed by half its height).
        // Twice desktop's size, two open sections rarely share the screen:
        // the upper one folded brings the lower up under it.
        let heads = sections.allElementsBoundByIndex.filter { $0.frame.height > 0 }.sorted { $0.frame.minY < $1.frame.minY }
        if heads.count > 1 {
            // By identifier: an element bound by index is another row once the order changes.
            let section = app.descendants(matching: .any)[heads[heads.count - 1].identifier]
            let top = app.descendants(matching: .any)[heads[heads.count - 2].identifier]
            bringIntoView(top)
            pause(1)
            let folded = rowUnder(top)?.identifier != section.identifier
            if folded { tapChevron(top); pause(1.5) }
            bringIntoView(section)
            pause(1)
            capture("reorder-section-before")
            section.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.2, thenDragTo: top.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)), withVelocity: .slow, thenHoldForDuration: 0.8)
            capture("reorder-section-held")
            pause(1)
            // Checked at once: Prioritizing may tidy the sidebar again after.
            capture("reorder-section")
            XCTAssertLessThan(section.frame.minY, top.frame.minY, "the section did not land over the one above")
            // Opened again, as the run found it.
            if folded { tapChevron(top); pause(1) }
        } else {
            XCTFail("no two sections")
        }
    }

    /// Reorder from the menu: the menu goes and the row stays lifted where
    /// it was; a finger put down anywhere then carries it, and where it's
    /// let go it stays. A tap instead puts it back.
    func testReorderFromMenu() {
        home()
        pause(1)
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:space:"))
        func order() -> [String] {
            let screen = app.frame.height
            let ids = shownRows("stem-row:space:").filter { $0.frame.minY > screen * 0.12 && $0.frame.maxY < screen * 0.8 }.sorted { $0.frame.minY < $1.frame.minY }.map { $0.identifier }
            return ids.filter { id in ids.filter { $0 == id }.count == 1 }
        }
        let all = order()
        guard all.count > 4 else { return XCTFail("too few rows to reorder: \(all)") }
        let moving = app.descendants(matching: .any)[all[3]]
        let target = app.descendants(matching: .any)[all[1]]
        let from = moving.frame
        let to = target.frame

        // A tap puts it back where it was.
        moving.press(forDuration: 1.0)
        let reorder = app.buttons["Reorder"]
        XCTAssertTrue(reorder.waitForExistence(timeout: 3), "no Reorder in the menu")
        reorder.tap()
        XCTAssertTrue(until(2) { !app.descendants(matching: .any)["stem-hold-menu"].exists }, "the menu stayed")
        XCTAssertTrue(app.descendants(matching: .any)["stem-lifted"].waitForExistence(timeout: 2), "Reorder lifted nothing")
        pause(0.8)
        capture("reorder-armed")
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: from.midX, dy: from.midY)).tap()
        pause(1)
        XCTAssertEqual(order(), all, "a tap moved the lifted row")

        // Lifted again: a finger down on it, moved up two rows, let go.
        moving.press(forDuration: 1.0)
        XCTAssertTrue(reorder.waitForExistence(timeout: 3))
        reorder.tap()
        XCTAssertTrue(app.descendants(matching: .any)["stem-lifted"].waitForExistence(timeout: 2), "Reorder lifted nothing")
        pause(1)
        let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: from.midX, dy: from.midY))
        let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: to.midX, dy: to.minY + to.height * 0.2))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.5)
        pause(2)
        capture("reorder-menu-dropped")
        let after = order()
        let landed = after.firstIndex(of: all[3]) ?? -1
        XCTAssertTrue(landed >= 0 && landed < (after.firstIndex(of: all[1]) ?? -1) && landed > (after.firstIndex(of: all[0]) ?? -1), "the row didn't stay where it was let go: \(after)")
        pause(3)
        XCTAssertEqual(order().firstIndex(of: all[3]), landed, "the row went back")
    }

    /// A section's "+" makes new work right under its heading.
    func testSectionAdd() {
        home()
        pause(1)
        let sections = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:section:"))
        guard let shown = sections.allElementsBoundByIndex.filter({ $0.frame.height > 0 }).min(by: { $0.frame.minY < $1.frame.minY }) else {
            return XCTFail("no section")
        }
        let section = app.descendants(matching: .any)[shown.identifier]
        bringIntoView(section)
        pause(1)
        // Open, so what's made under it shows.
        if let under = rowUnder(section), under.identifier.hasPrefix("stem-row:section:") || under.frame.minY > section.frame.maxY + 40 { tapChevron(section); pause(1) }
        capture("section-add-before")
        // The "+" stands one square before the chevron: its centre 70 in from the row's end.
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: section.frame.maxX - 70, dy: section.frame.midY)).tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 6), "the + opened no new work")
        pause(1)
        capture("section-add-opened")
        app.tapBack()
        pause(1.5)
        let made = rowUnder(section)
        XCTAssertEqual(made?.identifier, "stem-row:space:New", "the new work isn't right under its section")
        capture("section-add-made")
        // Put away again.
        if let made {
            made.press(forDuration: 1.0)
            let close = app.buttons["Close new work"]
            XCTAssertTrue(close.waitForExistence(timeout: 3), "new work offered no close")
            close.tap()
            pause(2)
        }
    }

    /// Search over every row.
    func testSearch() {
        home()
        app.buttons["stem-search"].tap()
        pause(1)
        app.typeText("happy")
        pause(2)
        capture("search")
        app.tapBack()
        pause(1)
    }

    /// New work makes only new work: its intro offers no todo list,
    /// document, calendar, chat or bot to make instead.
    func testNoOffers() {
        home()
        pause(1.5)
        app.descendants(matching: .any)["stem-new-work"].tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 5))
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        XCTAssertTrue(app.staticTexts["Say what it is — it’ll find its place."].waitForExistence(timeout: 5))
        pause(1.5)
        capture("no-offers")
        XCTAssertFalse(app.staticTexts["Or start one of these:"].exists, "new work still offers things to start")
        let offers = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-offer"))
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
        app.descendants(matching: .any)["stem-new-work"].tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 5))
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

    /// An unread conversation opened and left reads as read: its row's
    /// title is no longer bold, here and on the computer (the harness
    /// checks the daemon after).
    func testUnreadClears() {
        home()
        pause(1.5)
        capture("unread-before")
        row("space", "Pasted from").firstMatch.tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 8))
        pause(3)
        app.tapBack()
        pause(2)
        capture("unread-after")
    }

    /// A row that folds, selected: its mark and its fold each centred
    /// half the row in from its ends, folded and open (the frames are
    /// pinned in StemCellsLayoutTests; this is how it looks).
    func testRowBalance() {
        home()
        pause(1.5)
        let happy = row("space", "Happy")
        XCTAssertTrue(happy.waitForExistence(timeout: 5))
        happy.tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 8))
        pause(1)
        app.tapBack()
        pause(1.5)
        capture("balance-closed")
        // The fold, at the row's end.
        let rowsClosed = shownRows("stem-row:").count
        tapChevron(happy)
        XCTAssertTrue(until(3) { self.shownRows("stem-row:").count != rowsClosed }, "the fold didn't open")
        pause(1.5)
        capture("balance-open")
        tapChevron(happy)
        XCTAssertTrue(until(3) { self.shownRows("stem-row:").count == rowsClosed }, "the fold didn't close")
        pause(1)
    }

    /// Into a conversation from the sidebar and back, slowly enough to
    /// watch its header come in (the harness slows the recording).
    func testOpenFromSidebar() {
        // UIKit's own slow motion, the simulator's Slow Animations: 4 is 0.25x.
        if let drag = ProcessInfo.processInfo.environment["STEM_ANIMATION_DRAG"] {
            app.launchEnvironment["UIAnimationDragCoefficient"] = drag
            app.launch()
        }
        home()
        pause(1.5)
        let target = row("space", "Pasted from").firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        target.tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 8))
        pause(2)
        app.tapBack()
        pause(1.5)
        target.tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 8))
        pause(2)
        app.tapBack()
        pause(1.5)
    }

    /// Conversations read ahead open drawn: several sidebar rows, each
    /// pushed with its transcript on the push's first frame, timed from
    /// the tap until it was on screen. `STEM_WARM=0` is the cold "before",
    /// timed the same way.
    func testWarmOpens() {
        let warm = ProcessInfo.processInfo.environment["STEM_WARM"] != "0"
        if !warm { app.launchEnvironment["STEM_WARM"] = "0" }
        // Slowed for the recording, the screens take that much longer.
        var slow = 1.0
        if let drag = ProcessInfo.processInfo.environment["STEM_ANIMATION_DRAG"] {
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
        let dock = app.descendants(matching: .any)["stem-new-work"].frame.minY
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:space:")).allElementsBoundByIndex
            .filter { $0.frame.minY > 100 && $0.frame.maxY < dock - 30 }
            .sorted { $0.frame.minY < $1.frame.minY }
        var labels: [String] = []
        for element in rows {
            let label = String(element.identifier.dropFirst("stem-row:space:".count))
            if !labels.contains(label) { labels.append(label) }
        }
        for label in labels {
            let target = row("space", label).firstMatch
            guard target.exists, target.isHittable else { continue }
            target.tap()
            let transcript = app.scrollViews["stem-transcript"]
            XCTAssertTrue(transcript.waitForExistence(timeout: 8), "\(label) didn't open")
            var value = ""
            let deadline = Date().addingTimeInterval(10)
            while Date() < deadline {
                value = transcript.value as? String ?? ""
                if !value.isEmpty { break }
                pause(0.1)
            }
            print("STEM_TIMING \(warm ? "warm" : "cold") \(label): \(value)")
            XCTAssertTrue(value.contains("rows="), "\(label) never showed its transcript")
            if warm {
                XCTAssertTrue(value.hasPrefix("first=true"), "\(label) opened without its transcript: \(value)")
                // An empty one (a bot just made) is drawn too, with nothing in it.
                if !value.hasSuffix("rows=0") {
                    XCTAssertTrue(app.descendants(matching: .any)["stem-message"].firstMatch.exists, "\(label) has no message")
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
            let transcript = app.scrollViews["stem-transcript"]
            XCTAssertTrue(transcript.waitForExistence(timeout: 8))
            var value = ""
            for _ in 0..<100 where value.isEmpty {
                value = transcript.value as? String ?? ""
                if value.isEmpty { pause(0.1) }
            }
            print("STEM_TIMING warm \(first) again: \(value)")
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
        let title = app.descendants(matching: .any)["stem-chat-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        pause(1)
        capture("detail-header")
        // The capsule's far right, well past the name, still opens it.
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.width - 30, dy: title.frame.midY)).tap()
        let detail = app.descendants(matching: .any)["stem-detail"]
        XCTAssertTrue(detail.waitForExistence(timeout: 5), "the capsule's right end didn't open the detail")
        XCTAssertFalse(app.textFields["stem-chat-title-field"].exists, "the header renamed")
        XCTAssertEqual(app.staticTexts["stem-detail-name"].label, "Research Assistant")
        assertTiles()
        // At the top level: no section, no siblings.
        let family = app.descendants(matching: .any)["stem-detail-family"]
        if family.exists {
            let tops = family.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:space:")).allElementsBoundByIndex.map(\.identifier)
            XCTAssertEqual(tops, ["stem-row:space:Research Assistant"], "a top-level conversation showed siblings")
        }
        XCTAssertFalse(family.exists && family.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:section:")).firstMatch.exists, "a top-level conversation showed its section")
        // What it shared: its media first, a grid.
        let cells = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-detail-media:"))
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
        let more = app.descendants(matching: .any)["stem-detail-media-more"]
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
        XCTAssertTrue(app.images["stem-picture-viewer"].waitForExistence(timeout: 5), "the picture didn't open")
        pause(2)
        capture("detail-viewer")
        app.swipeLeft()
        pause(1.5)
        capture("detail-viewer-next")
        app.buttons["Close"].tap()
        XCTAssertTrue(until(3) { !self.app.images["stem-picture-viewer"].exists })
        pause(1)
        // Then its links, each a title over its address.
        let link = app.descendants(matching: .any)["stem-detail-link:https://telegram.org/blog/shared-media"]
        XCTAssertTrue(link.waitForExistence(timeout: 10), "no shared links")
        XCTAssertEqual(link.label, "Telegram's shared media")
        XCTAssertEqual(link.value as? String, "telegram.org/blog/shared-media")
        XCTAssertTrue(app.descendants(matching: .any)["stem-detail-link:https://crdt.tech/"].exists)
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
        for (id, what) in [("stem-row:space:Plan Lisbon trip", "its parent"), ("stem-row:session:Day Trips", "itself"), ("stem-row:session:Neighbourhoods", "its sibling"), ("stem-row:session:Best train day trip", "its child")] {
            XCTAssertTrue(family.descendants(matching: .any)[id].exists, "the family lacks \(what)")
        }
        XCTAssertTrue(cells.firstMatch.waitForExistence(timeout: 10), "the subtask's pictures aren't shared")
        XCTAssertEqual(cells.count, 3)
        XCTAssertTrue(app.descendants(matching: .any)["stem-detail-link:https://www.visitcascais.com/en"].waitForExistence(timeout: 5))
        pause(1.5)
        capture("detail-nested-top")
        bringIntoView(app.descendants(matching: .any)["stem-detail-links"])
        pause(1)
        capture("detail-nested-shared")
        bringIntoView(family)
        pause(1)
        capture("detail-nested-family")
        // A sibling opens its own conversation; back comes back here.
        family.descendants(matching: .any)["stem-row:session:Neighbourhoods"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "stem-chat-title", "Neighbourhoods")).firstMatch.waitForExistence(timeout: 8), "the sibling didn't open")
        pause(1.5)
        app.tapBack()
        XCTAssertTrue(detail.waitForExistence(timeout: 5), "back didn't come back to the detail")
        pause(1)
        app.tapBack()
        pause(1)
        app.tapBack()
    }

    /// Model, effort and when it started; nothing else counted.
    private func assertTiles() {
        let started = app.descendants(matching: .any)["stem-detail-tile:started"]
        XCTAssertTrue(started.waitForExistence(timeout: 5), "no Started tile")
        XCTAssertTrue(until(8) { (started.value as? String) != "—" }, "when it started never came")
        for id in ["model", "effort", "started"] {
            let tile = app.descendants(matching: .any)["stem-detail-tile:\(id)"]
            print("STEM_DETAIL \(id) = \(tile.value as? String ?? "")")
            XCTAssertNotEqual(tile.value as? String, "—", "\(id) never came")
        }
        for id in ["tokens", "messages", "subagents", "age"] {
            XCTAssertFalse(app.descendants(matching: .any)["stem-detail-tile:\(id)"].exists, "\(id) is still counted")
        }
    }

    /// Every modal sheet closes from a button at its top right, as far
    /// from the top as from the side: settings' QR sheet, the link sheet
    /// "+" opens and the attach sheet. The link sheet's
    /// Relay | Direct switch runs across the screen just above what it
    /// switches (the scan), tagged Beta.
    func testSheetsClose() {
        home()
        app.descendants(matching: .any)["stem-settings-mark"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["stem-settings-qr"].waitForExistence(timeout: 5))
        pause(1)

        app.descendants(matching: .any)["stem-settings-qr"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["stem-qr"].waitForExistence(timeout: 3))
        pause(1)
        capture("sheet-qr")
        assertCloses(app.descendants(matching: .any)["stem-qr-close"], in: app.descendants(matching: .any)["stem-qr-sheet"], "the QR sheet")
        closeSheet(app.descendants(matching: .any)["stem-qr-close"], app.descendants(matching: .any)["stem-qr"])
        XCTAssertTrue(app.descendants(matching: .any)["stem-profile-add"].waitForExistence(timeout: 3))

        app.descendants(matching: .any)["stem-profile-add"].tap()
        let link = app.descendants(matching: .any)["stem-link"]
        XCTAssertTrue(link.waitForExistence(timeout: 5), "+ didn't open the link sheet")
        let control = app.segmentedControls["stem-link-method"]
        if !control.buttons["Direct"].isSelected { control.buttons["Direct"].tap() }
        let scan = app.buttons["Scan QR code"]
        XCTAssertTrue(scan.waitForExistence(timeout: 3))
        pause(1)
        // What to do on the computer, in numbered steps, the scan last.
        for (index, step) in ["Install Happy on your computer", "Open Happy and choose Link Mobile App", "Scan the QR code"].enumerated() {
            let row = app.descendants(matching: .any)["stem-link-step-\(index + 1)"]
            XCTAssertTrue(row.exists, "no step \(index + 1)")
            // The localized lines may hold no-break spaces.
            XCTAssertEqual(row.label.replacingOccurrences(of: "\u{00A0}", with: " "), "\(index + 1). \(step)")
        }
        XCTAssertTrue(app.descendants(matching: .any)["stem-link-paste"].exists, "the paste link is gone")
        capture("sheet-link-direct")
        let close = app.buttons["stem-glass-close"]
        assertCloses(close, in: link, "the link sheet")
        XCTAssertEqual(control.frame.width, scan.frame.width * 0.6, accuracy: 1, "the switch isn't 60% of the scan's width")
        XCTAssertEqual(control.frame.midX, scan.frame.midX, accuracy: 1, "the switch isn't centred over the scan")
        XCTAssertTrue(app.staticTexts["Link your computer"].exists, "the title isn't Link your computer")
        XCTAssertGreaterThan(control.frame.minY, link.frame.midY, "the switch isn't down over the scan")
        XCTAssertLessThan(control.frame.maxY, scan.frame.minY, "the switch isn't above the scan")
        XCTAssertTrue(app.descendants(matching: .any)["stem-link-beta"].exists, "no Beta tag")
        XCTAssertFalse(app.staticTexts["EXPERIMENTAL"].exists, "the tag still says Experimental")
        let switchOnDirect = control.frame
        control.buttons["Relay"].tap()
        XCTAssertTrue(app.buttons["Create account"].waitForExistence(timeout: 5), "Relay didn't show Welcome")
        pause(1)
        capture("sheet-link-relay")
        XCTAssertEqual(control.frame.minY, switchOnDirect.minY, accuracy: 0.5, "the switch moved between Direct and Relay")
        XCTAssertLessThan(control.frame.maxY, app.buttons["Create account"].frame.minY, "the switch isn't above Relay's buttons")
        control.buttons["Direct"].tap()
        pause(0.8)
        closeSheet(close, link)
        app.tapBack()
        pause(1.5)

        // The attach sheet, over new work.
        app.descendants(matching: .any)["stem-new-work"].tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 5))
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
        let field = app.textFields["stem-todo-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        let todos = app.descendants(matching: .any).matching(identifier: "stem-todo")
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
        XCTAssertTrue(app.descendants(matching: .any)["stem-document"].waitForExistence(timeout: 10))
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
        app.descendants(matching: .any)["stem-new-work"].tap()
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(1)
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        composer.typeText("Plan a weekend hiking trip to Sintra: a short packing list and two trails. A few lines, no tools.")
        pause(0.5)
        app.buttons["Send"].tap()
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        let messages = app.descendants(matching: .any).matching(identifier: "stem-message")
        let working = app.descendants(matching: .any)["stem-working"]
        var deadline = Date().addingTimeInterval(120)
        while Date() < deadline, messages.count < 2 || working.exists { pause(1) }
        XCTAssertGreaterThanOrEqual(messages.count, 2, "the agent never answered")
        pause(2)
        capture("prioritizing-chat")
        app.tapBack()
        // The sidebar, untouched, while Prioritizing works: the stem cell
        // grows its icon and name at once, and the batch moves the row once
        // Prioritizing's turn ends.
        let fresh = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND value == %@", "stem-row:space:New", "stem cell"))
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
        pause(Double(ProcessInfo.processInfo.environment["STEM_WATCH_SECONDS"] ?? "") ?? 150)
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
                return shownRows("stem-row:session:").contains { $0.frame.minY >= below.maxY - 1 && $0.frame.minY < below.maxY + below.height * 3 }
            }
            if open(task) { tapChevron(task); XCTAssertTrue(until(2) { !open(task) }, "\(label) didn't fold") }
            tapChevron(task)
            XCTAssertTrue(until(5) { open(task) }, "\(label)'s chevron showed no subtasks")
            pause(1.5)
        }
        let sessions = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:session:"))
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
        let bot = row("space", ProcessInfo.processInfo.environment["STEM_MEDIA_ROW"] ?? "Research Assistant")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(3)
        let tiles = app.descendants(matching: .any).matching(identifier: "stem-media")
        let videos = tiles.matching(NSPredicate(format: "label ENDSWITH %@", ".mp4"))
        let pictures = tiles.matching(NSPredicate(format: "label ENDSWITH %@", ".png"))
        let working = app.descendants(matching: .any)["stem-working"]
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
        XCTAssertTrue(app.images["stem-picture-viewer"].waitForExistence(timeout: 5))
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
        let sent = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label ENDSWITH %@", "stem-media", "Picture"))
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
        let bot = row("space", ProcessInfo.processInfo.environment["STEM_LAYOUT_ROW"] ?? "Chef")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(3)
        let tiles = app.descendants(matching: .any).matching(identifier: "stem-media")
        let cards = app.descendants(matching: .any).matching(identifier: "stem-card")
        let artifact = cards.matching(NSPredicate(format: "label == %@", "Open Pantry notes")).firstMatch
        let file = cards.matching(NSPredicate(format: "label ENDSWITH %@", ".csv")).firstMatch
        let working = app.descendants(matching: .any)["stem-working"]
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
            print("STEM_TILE \(index) \(tile.label) \(tile.frame)")
        }
        print("STEM_CARD file \(file.frame) artifact \(artifact.frame)")
        bringIntoView(tiles.element(boundBy: tiles.count - 1))
        pause(1.5)
        capture("layout-block")

        bringIntoView(artifact)
        pause(1)
        artifact.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.descendants(matching: .any)["stem-artifact-document"].waitForExistence(timeout: 15), "the artifact never opened")
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
    /// every picture fails at first (`STEM_MEDIA_FAIL_UNTIL_RETRY`), the
    /// driver stops the daemon and starts it again, and the reconnect asks
    /// for them once more.
    func testMediaRetry() {
        app.terminate()
        app.launchEnvironment["STEM_MEDIA_FAIL_UNTIL_RETRY"] = "1"
        app.launch()
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["STEM_LAYOUT_ROW"] ?? "Chef")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let tiles = app.descendants(matching: .any).matching(identifier: "stem-media")
        let failed = tiles.matching(NSPredicate(format: "value == %@", "failed"))
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline, failed.count == 0 { pause(0.5) }
        XCTAssertGreaterThan(failed.count, 0, "nothing failed")
        app.swipeDown(velocity: .slow)
        bringIntoView(failed.firstMatch)
        pause(1.5)
        capture("retry-failed")
        print("STEM_STOP_DAEMON")
        pause(6)
        print("STEM_START_DAEMON")
        let back = Date().addingTimeInterval(90)
        while Date() < back, failed.count > 0 { pause(0.5) }
        XCTAssertEqual(failed.count, 0, "pictures stayed failed after the computer came back")
        pause(2)
        capture("retry-loaded")
    }

    /// A long recording plays while it streams, a range at a time; the run
    /// reads the ranges from the app's log (`stem-media`). The file is the
    /// one the driver made (`STEM_VIDEO_PATH`).
    func testStreaming() {
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["STEM_LAYOUT_ROW"] ?? "Chef")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(3)
        let video = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label ENDSWITH %@", "stem-media", "countdown.mp4"))
        let working = app.descendants(matching: .any)["stem-working"]
        if video.count == 0 {
            let path = ProcessInfo.processInfo.environment["STEM_VIDEO_PATH"] ?? ""
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
        print("STEM_PLAY")
        tile.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        pause(8)
        capture("streaming-playing")
        // Halfway along: the player asks for a range far ahead.
        let scrubber = app.sliders.firstMatch
        if !scrubber.exists { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        if scrubber.waitForExistence(timeout: 3) {
            print("STEM_SEEK")
            scrubber.adjust(toNormalizedSliderPosition: 0.75)
            pause(6)
            capture("streaming-seeked")
        }
    }

    /// A file larger than one answer may hold (8 MiB) opens in Quick Look,
    /// read a range at a time. The file is the one the driver made
    /// (`STEM_FILE_PATH`).
    func testLargeFile() {
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["STEM_LAYOUT_ROW"] ?? "Chef")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(3)
        let path = ProcessInfo.processInfo.environment["STEM_FILE_PATH"] ?? ""
        let name = (path as NSString).lastPathComponent
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "stem-card", "Open \(name)"))
        let working = app.descendants(matching: .any)["stem-working"]
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
        print("STEM_FILE_OPENED \(String(format: "%.1f", Date().timeIntervalSince(start)))s")
        pause(3)
        capture("large-file")
    }

    /// A task's name renamed from its conversation's detail, where the name
    /// stands: the detail, the bar and the sidebar row wear it at once and
    /// the computer keeps it (`STEM_RENAMED`, read back by the run). Renamed
    /// back after, so the test can run again.
    func testRenameTitle() {
        home()
        pause(1.5)
        let old = ProcessInfo.processInfo.environment["STEM_RENAME_ROW"] ?? "Renew passport"
        let new = old + " by May"
        let titled = { (name: String) in self.app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "stem-chat-title", name)).firstMatch }
        let field = app.textFields["stem-detail-rename"]
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
            XCTAssertTrue(app.descendants(matching: .any)["stem-detail"].waitForExistence(timeout: 5), "the capsule didn't open the detail")
            app.descendants(matching: .any)["stem-settings:rename"].tap()
            XCTAssertTrue(field.waitForExistence(timeout: 3), "the name never became a field")
            pause(0.8)
            if to == new { capture("rename-editing") }
            // The field opens with its name selected: typing replaces it.
            field.typeText(to + "\n")
            XCTAssertEqual(app.staticTexts["stem-detail-name"].label, to, "the detail never showed \(to)")
            XCTAssertFalse(field.exists)
            app.tapBack()
            XCTAssertTrue(titled(to).waitForExistence(timeout: 3), "the bar never showed \(to)")
            pause(1)
            if to == new {
                capture("rename-after")
                print("STEM_RENAMED \(to)")
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
    /// ("Keep mine"); each prints `STEM_PROPOSAL` with how it ended, so the
    /// run can read the sidebar back.
    func testProposal() {
        home()
        pause(1.5)
        // The first ask flips what the last run's took, so the test runs again.
        let asks = [
            ProcessInfo.processInfo.environment["STEM_PROPOSAL_ASK"] ?? "Please propose a sidebar with propose_sidebar (don't apply anything yourself). If there is a Distractions section, move its rows to the end of the Travel section and drop the Distractions section. If there isn't, take the last two rows of the Travel section into a new section called Distractions, folded, right after Travel. Only propose it.",
            "Please propose one more sidebar with propose_sidebar (don't apply anything yourself): move the Bots section to the very end. Only propose it.",
        ]
        let open = row("space", "Prioritizing")
        for _ in 0..<3 where !open.exists { app.swipeDown(); pause(0.3) }
        XCTAssertTrue(open.waitForExistence(timeout: 5), "no Prioritizing row")
        bringIntoView(open)
        open.tap()
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        for (round, ask) in asks.enumerated() {
            let take = round == 0
            let answers = app.buttons.matching(identifier: take ? "stem-proposal-use" : "stem-proposal-keep")
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
            let cards = app.descendants(matching: .any).matching(identifier: "stem-proposal")
            let card = cards.element(boundBy: cards.count - 1)
            let folded = card.descendants(matching: .any)["stem-row:section:Travel"]
            if take, folded.exists {
                let shown = card.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:space:")).count
                bringIntoView(folded)
                folded.tap()
                pause(1.5)
                capture("proposal-1-unfolded")
                let opened = card.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:space:")).count
                print("STEM_PROPOSAL_FOLD \(shown) -> \(opened)")
                folded.tap()
                pause(1)
                bringIntoView(answer)
            }
            answer.tap()
            let said = take ? "You use this sidebar now." : "You kept your own sidebar."
            let status = app.staticTexts.matching(NSPredicate(format: "identifier == %@ AND label == %@", "stem-proposal-status", said)).firstMatch
            XCTAssertTrue(status.waitForExistence(timeout: 30), "the card never said \(said)")
            pause(1)
            bringIntoView(status)
            pause(1)
            capture("proposal-\(round + 1)-answered")
            print("STEM_PROPOSAL \(take ? "accepted" : "declined")")
            pause(1)
        }
        app.tapBack()
        pause(2)
        capture("proposal-sidebar")
    }

    /// Opening a conversation with pictures twice: cold, read over the
    /// paired connection, then warm, from what the first open kept. Each
    /// open prints how long its pictures took (`STEM_OPEN`).
    func testMediaColdWarm() {
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["STEM_LAYOUT_ROW"] ?? "Chef")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        let loaded = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND value == %@", "stem-media", "loaded"))
        let tiles = app.descendants(matching: .any).matching(identifier: "stem-media")
        for pass in ["cold", "warm"] {
            let start = Date()
            bot.tap()
            let deadline = Date().addingTimeInterval(30)
            while Date() < deadline, tiles.count == 0 || loaded.count < tiles.count { pause(0.1) }
            print("STEM_OPEN \(pass) \(String(format: "%.2f", Date().timeIntervalSince(start)))s \(loaded.count)/\(tiles.count)")
            XCTAssertGreaterThan(loaded.count, 0)
            pause(2)
            capture("open-\(pass)")
            app.tapBack()
            pause(2)
        }
    }

    /// The working line through a real turn: the loader, the clock and the
    /// phase as the agent's status moves, each change printed with its
    /// time (`STEM_PHASE <seconds> <line>`) for desktop's side of the video.
    func testWorking() {
        home()
        pause(1.5)
        let bot = row("space", ProcessInfo.processInfo.environment["STEM_MEDIA_ROW"] ?? "Research Assistant")
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bringIntoView(bot)
        bot.tap()
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(2)
        composer.tap()
        composer.typeText("Think for a moment about what a good haiku needs. Then run `sleep 5` with your shell tool, one call and nothing else. Then write me a haiku about waiting.")
        pause(0.5)
        let working = app.descendants(matching: .any)["stem-working"]
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
                print(String(format: "STEM_PHASE %.2f %@", Date().timeIntervalSince(start), line))
                last = line
            }
            pause(0.1)
        }
        print("STEM_PHASES \(seen.joined(separator: " > "))")
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
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:"))
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
        print("STEM_STOP_DAEMON")
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
        print("STEM_START_DAEMON")
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
    /// name in the middle; search beside the filter at the right.
    func testHeader() {
        home()
        pause(1.5)
        capture("header")
        app.descendants(matching: .any)["stem-settings-mark"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["stem-settings-qr"].waitForExistence(timeout: 3))
        pause(1.5)
        capture("settings")
        closeSettings()
        app.buttons["stem-search"].tap()
        pause(1)
        app.typeText("lisbon")
        pause(2)
        capture("header-search")
        app.tapBack()
        pause(1.5)
    }

    /// Settings from the picture: the QR sheet and its Scan, Edit name
    /// renaming the computer in place, Prioritizing's switch, and "+"
    /// opening the link sheet. Every row, the push and the sheet's
    /// relay and pairing: SettingsUITests.
    func testSettings() {
        home()
        pause(1)
        app.descendants(matching: .any)["stem-settings-mark"].tap()
        let qr = app.descendants(matching: .any)["stem-settings-qr"]
        XCTAssertTrue(qr.waitForExistence(timeout: 3))
        pause(1.5)
        capture("settings")

        // The QR sheet: nothing to share, so Scan comes first.
        qr.tap()
        let scan = app.buttons["stem-qr-scan"]
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

        // Edit name renames the computer in place; Return keeps it.
        let name = app.descendants(matching: .any)["stem-settings-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 3))
        let from = name.label
        let to = from == "Studio Mac" ? "Mac Studio" : "Studio Mac"
        app.descendants(matching: .any)["stem-settings:edit-name"].tap()
        let field = app.textFields["stem-settings-rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        pause(1)
        capture("settings-edit")
        field.typeText(to)
        pause(0.8)
        field.typeText("\n")
        XCTAssertTrue(app.descendants(matching: .any)["stem-settings-name"].waitForExistence(timeout: 2))
        pause(2)
        XCTAssertEqual(app.descendants(matching: .any)["stem-settings-name"].label, to, "the name went back")
        capture("settings-renamed")
        print("STEM_RENAMED \(from) -> \(to)")

        // Prioritizing's switch, off and on again.
        let prioritizing = app.switches["stem-settings-toggle:prioritizing"]
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
        app.descendants(matching: .any)["stem-profile-add"].tap()
        let scanCode = app.buttons["Scan QR code"]
        XCTAssertTrue(scanCode.waitForExistence(timeout: 3), "+ offered no way to add a computer")
        XCTAssertTrue(app.descendants(matching: .any)["stem-link-paste"].exists)
        pause(1)
        capture("settings-add-computer")
        scanCode.tap()
        XCTAssertTrue(closeScanner.waitForExistence(timeout: 5))
        pause(1)
        closeScanner.tap()
        pause(1)
        app.descendants(matching: .any)["stem-glass-close"].tap()
        pause(1)

        // Back to the first name, so the next run starts the same.
        name.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.typeText(from + "\n")
        pause(2)
        closeSettings()
        XCTAssertTrue(app.descendants(matching: .any)["stem-settings-mark"].waitForExistence(timeout: 3))
        capture("settings-closed")
    }

    /// A row of the menu that is up, by the start of its label (a
    /// submenu's label goes on with its value).
    private func menuRow(_ label: String) -> XCUIElement {
        app.collectionViews.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", label, label + ",")).firstMatch
    }

    /// A panel of the model control: `stem-picker-models`, `-efforts` or `-accounts`.
    private func panel(_ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    /// `label`'s line in the open panels.
    private func panelRow(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "stem-picker-row:", label)).firstMatch
    }

    /// The picked line of `panel`: in view from the panel's first frame.
    private func assertPickedShows(_ panel: XCUIElement, _ name: String) {
        let picked = panel.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND selected == true", "stem-picker-row:")).firstMatch
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
        open(model, "stem-picker-models")
        XCTAssertFalse(panel("stem-picker-efforts").exists)
        pause(1.5)
        capture("panel-models")
        let models = panel("stem-picker-models").frame
        XCTAssertLessThan(models.maxY, model.frame.minY, "the list isn't over its chip")
        XCTAssertLessThanOrEqual(models.width, 250, "the list is wider than a menu")
        // A service's heading: its accounts over the list, where it stands.
        // The picked model's service, in view with it.
        let heading = app.descendants(matching: .any)["stem-picker-heading:claude"]
        XCTAssertTrue(heading.exists, "the list has no service heading")
        heading.tap()
        let accounts = panel("stem-picker-accounts")
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
        XCTAssertTrue(panel("stem-picker-models").exists, "a tap away from the accounts closed the list")
        pause(1)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        XCTAssertTrue(until(2) { !self.panel("stem-picker-models").exists }, "a tap away left the list up")
        pause(1)
        open(effort, "stem-picker-efforts")
        XCTAssertFalse(panel("stem-picker-models").exists, "the effort chip opened the models")
        pause(1.5)
        capture("panel-efforts")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        XCTAssertTrue(until(2) { !self.panel("stem-picker-efforts").exists })
        pause(1)
        // A pick far down the list: opened again, it shows from the start.
        pickIn(model, "stem-picker-models", "Opus 5.5 1M", shot: "panel-pick-opus")
        XCTAssertTrue(model.label.contains("Opus 5.5 1M"), "the chip says \(model.label)")
        open(model, "stem-picker-models")
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
        pickIn(dock, "stem-picker-models", "Haiku 5.5", shot: "picker-model")
        pickIn(dockEffort, "stem-picker-efforts", "Low", shot: "picker-effort")
        pause(1)
        capture("dock-picked")

        app.descendants(matching: .any)["stem-new-work"].tap()
        let composer = app.textViews["stem-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        XCTAssertTrue(app.buttons["Model: Haiku 5.5"].waitForExistence(timeout: 5), "new work lost the dock's model")
        XCTAssertTrue(app.buttons["Effort: Low"].exists, "new work lost the dock's effort")
        pause(1)
        capture("new-work-chips")
        composer.typeText("Say which model you are in five words or fewer. No tools.")
        app.buttons["Send"].tap()
        let messages = app.descendants(matching: .any).matching(identifier: "stem-message")
        let working = app.descendants(matching: .any)["stem-working"]
        var deadline = Date().addingTimeInterval(120)
        while Date() < deadline, messages.count < 2 || working.exists { pause(1) }
        pause(1.5)
        print("STEM_FIRST_ANSWERED")

        app.swipeDown(velocity: .slow)
        pause(1)
        pickIn(app.buttons["Model: Haiku 5.5"], "stem-picker-models", "Sonnet 5", shot: "chat-picker-model")
        // A new model starts on its own default effort.
        XCTAssertTrue(app.buttons["Effort: Medium"].waitForExistence(timeout: 3))
        pickIn(app.buttons["Effort: Medium"], "stem-picker-efforts", "High", shot: "chat-picker-effort")
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
        print("STEM_FAMILY_FOLD false \(parent)")
        XCTAssertTrue(until(8) { !shows(plan) }, "a fold made on the computer didn't show")
        capture("family-folded-there")
        pause(1)
        print("STEM_FAMILY_FOLD true \(parent)")
        XCTAssertTrue(until(8) { shows(plan) }, "an unfold made on the computer didn't show")
        pause(1)

        // Folded here: at once, and the computer has it.
        fold(task)
        XCTAssertTrue(until(0.6) { !shows(plan) }, "the fold didn't happen at once")
        capture("family-folded-here")
        pause(1.5)
        print("STEM_FAMILY_READ folded-here")
        pause(1)
        fold(task)
        XCTAssertTrue(until(0.6) { shows(plan) }, "the unfold didn't happen at once")
        pause(1.5)
        print("STEM_FAMILY_READ unfolded-here")

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
        print("STEM_FAMILY_READ dragged")
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
        print("STEM_FAMILY_NEST \(from) | \(parent)")
        let nested = row("space", from)
        XCTAssertTrue(until(8) { shows(nested) && nested.frame.minY > task.frame.minY && nested.frame.minX >= task.frame.minX }, "the task wasn't set under the row")
        pause(1)
        bringIntoView(nested)
        nested.press(forDuration: 1.0)
        let rename = app.buttons["Rename task"]
        XCTAssertTrue(rename.waitForExistence(timeout: 3), "a nested task offered no rename")
        capture("family-nested-menu")
        rename.tap()
        let field = app.textFields["stem-rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.typeText(to + "\n")
        XCTAssertTrue(row("space", to).waitForExistence(timeout: 2), "the nested rename didn't show")
        capture("family-nested-renamed")
        pause(2)
        print("STEM_FAMILY_UNNEST \(to)")
        pause(3)

        // A section's heading deleted: its rows stay, under the one above.
        print("STEM_FAMILY_SECTION_ADD Scratch")
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
        print("STEM_FAMILY_READ section-deleted")
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
        app.descendants(matching: .any)["stem-new-work"].tap()
        let composer = app.textViews["stem-composer"]
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
        let messages = app.descendants(matching: .any).matching(identifier: "stem-message")
        let working = app.descendants(matching: .any)["stem-working"]
        let deadline = Date().addingTimeInterval(120)
        pause(2)
        while Date() < deadline, messages.count < 2 || working.exists { pause(1) }
        pause(1.5)
        capture("paste-sent")
        let answer = messages.allElementsBoundByIndex.map(\.label).joined(separator: " ").lowercased()
        print("STEM_PASTE_ANSWER \(answer.suffix(200))")
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
        let field = app.descendants(matching: .any)["stem-new-work"]
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
        XCTAssertTrue(app.textViews["stem-composer"].exists, "the library didn't open over new work")
        pause(1.5)
        capture("dock-add-attached")
        app.tapBack()
        pause(1.5)
        // Back home, the dock is where it was.
        XCTAssertEqual(field.frame.minY, dockFrame.minY, accuracy: 1)
        // Put away: never sent, it would wait in the sidebar as "New".
        let made = app.descendants(matching: .any)["stem-row:space:New"].firstMatch
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
        let composer = app.textViews["stem-composer"]
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
        let box = app.descendants(matching: .any)["stem-input"].frame
        let text = app.textViews["stem-composer"].frame
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
        let messages = app.descendants(matching: .any).matching(identifier: "stem-message")
        let working = app.descendants(matching: .any)["stem-working"]
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
        let back = app.buttons["stem-chat-back"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), "no glass back button")
        XCTAssertTrue(app.descendants(matching: .any)["stem-chat-title"].exists, "no name in the header")
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
        XCTAssertTrue(app.descendants(matching: .any)["stem-new-work"].waitForExistence(timeout: 3), "not home after the swipe")
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
        let field = app.descendants(matching: .any)["stem-new-work"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "no dock")
        let dockFrame = field.frame
        let back = app.buttons["stem-chat-back"]
        for leaving in ["button", "swipe"] {
            field.tap()
            let composer = app.textViews["stem-composer"]
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
            let made = app.descendants(matching: .any)["stem-row:space:New"].firstMatch
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
        for id in ["stem-chat-back", "stem-glass-back"] {
            let glass = buttons[id].firstMatch
            if glass.exists, glass.isHittable { return glass.tap() }
        }
        navigationBars.buttons.element(boundBy: 0).tap()
    }
}

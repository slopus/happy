import ObjectiveC
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
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(4)
        capture("sidebar-after-new-work")
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
        app.navigationBars.buttons.element(boundBy: 0).tap()
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
        app.navigationBars.buttons.element(boundBy: 0).tap()
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

    /// A row pulled sideways shows Rename and how it's put away; Rename
    /// edits in place, a tap outside keeps it; Archive puts a bot away.
    func testSwipe() {
        home()
        let (from, to) = row("space", "Weekly meal plan").waitForExistence(timeout: 3) ? ("Weekly meal plan", "Meals this week") : ("Meals this week", "Weekly meal plan")
        let task = row("space", from)
        bringIntoView(task)
        pause(1)
        pull(task)
        let rename = app.buttons["stem-swipe:rename"]
        XCTAssertTrue(rename.waitForExistence(timeout: 3))
        pause(1)
        capture("swipe-open")
        rename.tap()
        let field = app.textFields["stem-rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.typeText(to)
        pause(0.8)
        capture("swipe-rename-typed")
        // A tap on empty list below the rows keeps it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        XCTAssertTrue(row("space", to).waitForExistence(timeout: 2))
        pause(3)
        XCTAssertTrue(row("space", to).exists, "the name went back")
        capture("swipe-renamed")

        // Happy has no actions.
        let happy = row("space", "Happy")
        bringIntoView(happy)
        pull(happy)
        pause(1)
        XCTAssertFalse(app.buttons["stem-swipe:rename"].exists)

        // A throwaway bot the run made, archived from its row.
        let bot = row("space", "Swipe Me")
        if bot.waitForExistence(timeout: 2) {
            do {
                bringIntoView(bot)
                pull(bot)
                let archive = app.buttons["stem-swipe:archive"]
                XCTAssertTrue(archive.waitForExistence(timeout: 3))
                pause(1)
                capture("swipe-archive")
                archive.tap()
                let deadline = Date().addingTimeInterval(10)
                while Date() < deadline, bot.exists { pause(0.5) }
                XCTAssertFalse(bot.exists, "the archived bot stayed")
                pause(1)
                capture("swipe-archived")
            }
        }
    }

    /// A leftward pull across a row.
    private func pull(_ element: XCUIElement) {
        let start = element.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
        start.press(forDuration: 0.01, thenDragTo: element.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)), withVelocity: .fast, thenHoldForDuration: 0)
    }

    /// A hold lifts a row with its menu; moving carries it (the menu goes),
    /// its peers glide aside, and the drop lands where the gap was. A
    /// section carries its rows.
    func testReorder() {
        home()
        pause(1)
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:space:"))
        func order() -> [String] {
            rows.allElementsBoundByIndex.filter { $0.frame.height > 0 }.sorted { $0.frame.minY < $1.frame.minY }.map { $0.identifier }
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
        // Released without moving: the menu stays open.
        moving.press(forDuration: 1.2)
        XCTAssertTrue(app.collectionViews.firstMatch.waitForExistence(timeout: 2) || app.buttons["Open"].exists, "the menu did not stay")
        pause(1)
        capture("reorder-menu-stays")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        pause(1)
        // A section, carried with its rows to the top.
        let sections = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:section:"))
        // A section, carried over the section above it (past its whole block,
        // as desktop asks: a neighbour is passed by half its height).
        let shown = sections.allElementsBoundByIndex.filter { $0.frame.minY > app.frame.height * 0.12 && $0.frame.maxY < app.frame.height * 0.75 }.sorted { $0.frame.minY < $1.frame.minY }
        // Far enough apart that the hold turns into a carry (a small move keeps the menu).
        if let index = shown.indices.dropFirst().first(where: { shown[$0].frame.minY - shown[$0 - 1].frame.minY > 100 }) {
            // By identifier: an element bound by index is another row once the order changes.
            let section = app.descendants(matching: .any)[shown[index].identifier]
            let top = app.descendants(matching: .any)[shown[index - 1].identifier]
            capture("reorder-section-before")
            section.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.2, thenDragTo: top.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)), withVelocity: .slow, thenHoldForDuration: 0.8)
            capture("reorder-section-held")
            pause(1)
            // Checked at once: Prioritizing may tidy the sidebar again after.
            capture("reorder-section")
            XCTAssertLessThan(section.frame.minY, top.frame.minY, "the section did not land over the one above")
        } else {
            XCTFail("no two sections on screen far enough apart")
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
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1)
    }

    /// New work's offers make the real thing: a todo list that takes a todo
    /// and joins the sidebar, a document with its heading, and a bot whose
    /// conversation opens. The untouched new work is closed after.
    func testOffers() {
        home()
        pause(1.5)
        app.descendants(matching: .any)["stem-new-work"].tap()
        XCTAssertTrue(app.staticTexts["Or start one of these:"].waitForExistence(timeout: 5))
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap(); pause(0.5) }
        pause(1.5)
        capture("offers")

        offer("New todo list", name: "Weekend errands")
        let field = app.textFields["stem-todo-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        pause(1)
        field.tap()
        field.typeText("Buy oranges\n")
        XCTAssertTrue(app.descendants(matching: .any)["stem-todo"].waitForExistence(timeout: 10))
        field.tap()
        field.typeText("Water the cactus\n")
        pause(2)
        capture("todo-list")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1)

        offer("New document", name: "Trip notes")
        XCTAssertTrue(app.descendants(matching: .any)["stem-document"].waitForExistence(timeout: 10))
        pause(2)
        capture("document")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1)

        app.descendants(matching: .any)["stem-offer:New bot"].tap()
        XCTAssertTrue(app.textViews["stem-composer"].waitForExistence(timeout: 20))
        pause(2)
        capture("new-bot")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(row("space", "Weekend errands").waitForExistence(timeout: 15), "the todo list never joined the sidebar")
        XCTAssertTrue(row("space", "Trip notes").waitForExistence(timeout: 15), "the document never joined the sidebar")
        pause(2)
        capture("sidebar-with-surfaces")
        let fresh = row("space", "New")
        if fresh.exists {
            fresh.press(forDuration: 1.0)
            let close = app.buttons["Close new work"]
            if close.waitForExistence(timeout: 3) { close.tap() }
            pause(2)
        }
        row("space", "Weekend errands").tap()
        XCTAssertTrue(app.descendants(matching: .any)["stem-todo"].waitForExistence(timeout: 10))
        pause(2)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1)
    }

    private func offer(_ label: String, name: String) {
        let button = app.descendants(matching: .any)["stem-offer:\(label)"]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
        let field = app.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.buttons["Clear text"].firstMatch.tap()
        field.typeText(name)
        pause(0.5)
        app.alerts.buttons["Create"].tap()
    }

    /// Prioritizing turned on from the banner, then new work: live over the
    /// events stream the row grows its icon and its name, Prioritizing puts
    /// its own row in, and its batch moves the new row where it belongs.
    func testPrioritizing() {
        home()
        let turnOn = app.buttons["Turn on"]
        if turnOn.waitForExistence(timeout: 5) {
            pause(2)
            capture("prioritizing-off")
            turnOn.tap()
            pause(2)
        }
        XCTAssertFalse(app.buttons["Turn on"].exists)
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
        app.navigationBars.buttons.element(boundBy: 0).tap()
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
            XCTAssertTrue(task.waitForExistence(timeout: 5))
            // Into the middle of the screen, clear of the dock, and still.
            bringIntoView(task)
            task.press(forDuration: 1.0)
            let show = app.buttons["Show subtasks"]
            // Already shown from an earlier run: hide them, then show them again.
            if !show.waitForExistence(timeout: 2), app.buttons["Hide subtasks"].exists {
                pause(1)
                app.buttons["Hide subtasks"].tap()
                pause(2)
                task.press(forDuration: 1.0)
            }
            XCTAssertTrue(show.waitForExistence(timeout: 3), "\(label) offered no subtasks")
            pause(1)
            show.tap()
            pause(2)
        }
        let sessions = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:session:"))
        XCTAssertTrue(sessions.firstMatch.waitForExistence(timeout: 5), "no subtask showed under its task")
        pause(1.5)
        capture("subtasks")
        sessions.firstMatch.tap()
        pause(4)
        capture("subtask-chat")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1.5)
        for _ in 0..<3 { app.swipeDown(); pause(0.3) }
        let prioritizing = row("space", "Prioritizing")
        if prioritizing.waitForExistence(timeout: 3) {
            prioritizing.tap()
            pause(4)
            capture("prioritizing-notes")
            app.navigationBars.buttons.element(boundBy: 0).tap()
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
        app.buttons["Add a picture"].tap()
        let library = app.alerts.buttons["Photo Library"]
        XCTAssertTrue(library.waitForExistence(timeout: 3))
        library.tap()
        let photos = app.images.matching(NSPredicate(format: "label BEGINSWITH %@", "Photo"))
        XCTAssertTrue(photos.firstMatch.waitForExistence(timeout: 10), "the photo picker never showed the library")
        pause(1)
        capture("media-library")
        // Newest first.
        photos.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        pause(0.8)
        for name in ["Add", "Done"] where app.buttons[name].exists {
            app.buttons[name].tap()
            break
        }
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
        app.navigationBars.buttons.firstMatch.tap()
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

    /// A task's name renamed where it stands in its conversation's bar: the
    /// bar and the sidebar row wear it at once and the computer keeps it
    /// (`STEM_RENAMED`, read back by the run). Renamed back after, so the
    /// test can run again.
    func testRenameTitle() {
        home()
        pause(1.5)
        let old = ProcessInfo.processInfo.environment["STEM_RENAME_ROW"] ?? "Renew passport"
        let new = old + " by May"
        let titled = { (name: String) in self.app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "stem-chat-title", name)).firstMatch }
        let field = app.textFields["stem-chat-title-field"]
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
            XCTAssertTrue(field.waitForExistence(timeout: 3), "the name never became a field")
            pause(0.8)
            if to == new { capture("rename-editing") }
            // The field opens with its name selected: typing replaces it.
            field.typeText(to + "\n")
            XCTAssertTrue(titled(to).waitForExistence(timeout: 3), "the bar never showed \(to)")
            XCTAssertFalse(field.exists)
            pause(1)
            if to == new {
                capture("rename-after")
                print("STEM_RENAMED \(to)")
            }
            app.navigationBars.buttons.element(boundBy: 0).tap()
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
        app.navigationBars.buttons.element(boundBy: 0).tap()
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
            app.navigationBars.buttons.element(boundBy: 0).tap()
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
        app.navigationBars.buttons.element(boundBy: 0).tap()
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
    private func closeSettings() {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).press(
            forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)),
            withVelocity: .fast, thenHoldForDuration: 0
        )
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
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1.5)
    }

    /// Settings from the picture: the QR sheet and its Scan, Edit renaming
    /// the computer in place, Prioritizing's switch, the profiles' circles
    /// (choosing one turns the page and makes it active), "+", and More.
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

        // Edit renames the computer in place; Return keeps it.
        let name = app.staticTexts["stem-settings-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 3))
        let from = name.label
        let to = from == "Studio Mac" ? "Mac Studio" : "Studio Mac"
        app.buttons["stem-settings-edit"].tap()
        let field = app.textFields["stem-settings-rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        pause(1)
        capture("settings-edit")
        field.typeText(to)
        pause(0.8)
        field.typeText("\n")
        XCTAssertTrue(app.staticTexts["stem-settings-name"].waitForExistence(timeout: 2))
        pause(2)
        XCTAssertEqual(app.staticTexts["stem-settings-name"].label, to, "the name went back")
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

        // The other computer's circle: the page turns to it, then back.
        // By place in the strip, not name: a computer paired twice wears one name.
        let first = app.descendants(matching: .any)["stem-profile:0"]
        let second = app.descendants(matching: .any)["stem-profile:1"]
        if second.exists {
            let (mine, other) = first.isSelected ? (first, second) : (second, first)
            XCTAssertTrue(mine.isSelected, "the shown profile isn't the chosen circle")
            other.tap()
            pause(2.5)
            XCTAssertTrue(other.isSelected, "the tapped circle didn't come to the middle")
            capture("settings-other-profile")
            mine.tap()
            pause(2.5)
            XCTAssertTrue(mine.isSelected)
            XCTAssertEqual(app.staticTexts["stem-settings-name"].label, to)
        }

        // "+" opens the scanner.
        app.descendants(matching: .any)["stem-profile-add"].tap()
        XCTAssertTrue(closeScanner.waitForExistence(timeout: 5))
        pause(1)
        closeScanner.tap()
        pause(1)

        // More holds the status and Happy's settings.
        app.descendants(matching: .any)["stem-settings:more"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["stem-settings-more"].waitForExistence(timeout: 3))
        pause(1.5)
        capture("settings-more")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1)

        // Back to the first name, so the next run starts the same.
        app.buttons["stem-settings-edit"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.typeText(from + "\n")
        pause(2)
        closeSettings()
        XCTAssertTrue(app.descendants(matching: .any)["stem-settings-mark"].waitForExistence(timeout: 3))
        capture("settings-closed")
    }

    private func pickIn(_ opener: XCUIElement, _ id: String, shot: String) {
        XCTAssertTrue(opener.waitForExistence(timeout: 5), "no \(opener)")
        opener.tap()
        let row = app.descendants(matching: .any)["stem-pick:\(id)"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the picker has no \(id)")
        pause(1.5)
        capture(shot)
        if !row.isHittable { app.descendants(matching: .any)["stem-picker"].swipeUp(); pause(1) }
        row.tap()
        pause(1.5)
    }

    /// The pickers: on the dock before new work exists, then in its
    /// conversation; each send goes with what was picked. The driver reads
    /// the modes back from the daemon.
    func testPickers() {
        home()
        pause(1.5)
        capture("dock-pickers")
        // The provider sheet shows each account's usage; it is looked at and closed.
        app.descendants(matching: .any)["stem-dock-provider"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["stem-pick:claude"].waitForExistence(timeout: 5))
        pause(3)
        capture("picker-provider")
        app.descendants(matching: .any)["stem-picker"].swipeDown(velocity: .fast)
        pause(1.5)
        pickIn(app.descendants(matching: .any)["stem-dock-model"], "claude:anthropic/haiku-5-5", shot: "picker-model")
        pickIn(app.descendants(matching: .any)["stem-dock-effort"], "low", shot: "picker-effort")
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
        pickIn(app.buttons["Model: Haiku 5.5"], "claude:anthropic/sonnet-5", shot: "chat-picker-model")
        // A new model starts on its own default effort.
        XCTAssertTrue(app.buttons["Effort: Medium"].waitForExistence(timeout: 3))
        pickIn(app.buttons["Effort: Medium"], "high", shot: "chat-picker-effort")
        XCTAssertTrue(app.buttons["Effort: High"].waitForExistence(timeout: 3))
        composer.tap()
        composer.typeText("And now? Five words or fewer.")
        app.buttons["Send"].tap()
        deadline = Date().addingTimeInterval(120)
        pause(2)
        while Date() < deadline, messages.count < 4 || working.exists { pause(1) }
        pause(2)
        capture("chat-picked")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(2)
        // The dock keeps its own pick for the next new work.
        XCTAssertTrue(app.descendants(matching: .any)["stem-dock-model"].label.contains("Haiku 5.5"))
    }
}

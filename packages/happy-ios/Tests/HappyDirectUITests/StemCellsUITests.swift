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
        for _ in 0..<8 {
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

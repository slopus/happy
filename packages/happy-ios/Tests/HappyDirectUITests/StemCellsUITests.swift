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
        app.launch()
    }

    /// Pairs if this simulator has no computer yet, then waits for its sidebar.
    private func home() {
        let happy = row("space", "Happy")
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

    /// Renaming a task from its row's menu: the new name shows at once and stays.
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
        let field = app.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.buttons["Clear text"].firstMatch.tap()
        field.typeText(to)
        pause(0.5)
        app.alerts.buttons["Save"].tap()
        let renamed = row("space", to)
        XCTAssertTrue(renamed.waitForExistence(timeout: 2))
        pause(4)
        XCTAssertTrue(renamed.exists, "the name went back")
        capture("renamed")
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

        // A photo from the clipboard, with a question about it.
        UIPasteboard.general.image = Self.swatch()
        app.buttons["Add a picture"].tap()
        let paste = app.alerts.buttons["Paste from Clipboard"]
        XCTAssertTrue(paste.waitForExistence(timeout: 3))
        paste.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Allow Paste"].waitForExistence(timeout: 3) { springboard.buttons["Allow Paste"].tap() }
        pause(2)
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

    /// A picture to paste: a blue-to-orange band with words on it.
    private static func swatch() -> UIImage {
        let size = CGSize(width: 900, height: 600)
        return UIGraphicsImageRenderer(size: size, format: { let format = UIGraphicsImageRendererFormat(); format.scale = 1; return format }()).image { context in
            let colors = [UIColor.systemBlue.cgColor, UIColor.systemOrange.cgColor] as CFArray
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            let text = NSAttributedString(string: "Hello from the phone", attributes: [.font: UIFont.boldSystemFont(ofSize: 64), .foregroundColor: UIColor.white])
            text.draw(at: CGPoint(x: 90, y: 260))
        }
    }

    /// The header: the Happy mark opens settings, where the accounts are;
    /// search is beside the filter at the right.
    func testHeader() {
        home()
        pause(1.5)
        capture("header")
        app.descendants(matching: .any)["stem-settings-mark"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["stem-settings-accounts"].waitForExistence(timeout: 3))
        pause(1.5)
        capture("settings")
        app.descendants(matching: .any)["stem-settings-accounts"].tap()
        pause(2)
        capture("settings-accounts")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1.5)
        app.buttons["stem-search"].tap()
        pause(1)
        app.typeText("lisbon")
        pause(2)
        capture("header-search")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1.5)
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

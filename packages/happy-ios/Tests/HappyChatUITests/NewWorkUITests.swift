import XCTest

/// New work's screen on the grouped home (`-screen groupedHome`), traced
/// (`HAPPY_COMPOSE_TRACE`): the keyboard comes up with the push and is up
/// as it ends; a swipe back let go of keeps it up and in the composer; a
/// finished swipe and Back leave alike; Task or Bot, named or not, is what
/// the first message makes; and what it will be sits in the middle of the
/// room between the bar and the composer, keyboard up or down. The legacy
/// account's compose (`-screen home`) is the same screen: the same push,
/// swipe and Back, with its computer (only when there are two) and folder
/// in the middle instead.
@MainActor
final class NewWorkUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
    }

    /// The grouped home, or the legacy account's (`-screen home`), with one
    /// computer or two.
    private enum Home: Equatable { case grouped, legacy(machines: Int) }
    private var home = Home.grouped

    private func launch(_ home: Home = .grouped) {
        self.home = home
        switch home {
        case .grouped: app.launchArguments = ["-screen", "groupedHome"]
        case .legacy(let machines): app.launchArguments = ["-screen", "home", "-freshSettings"] + (machines > 1 ? ["-secondMachine"] : [])
        }
        app.launchEnvironment["HAPPY_COMPOSE_TRACE"] = "1"
        app.launch()
        addTeardownBlock { [app] in app.terminate() }
        XCTAssertTrue(atHome(timeout: 20))
    }

    /// Home is showing: its first row, or on the legacy one its Settings.
    private func atHome(timeout: TimeInterval = 10) -> Bool {
        home == .grouped ? row("Fix login crash").waitForExistence(timeout: timeout) : app.buttons["Settings"].waitForExistence(timeout: timeout)
    }

    private func row(_ label: String) -> XCUIElement { app.descendants(matching: .any)["row:space:\(label)"] }
    private func rows(_ label: String) -> Int { app.descendants(matching: .any).matching(identifier: "row:space:\(label)").count }
    /// The composer: on legacy's empty compose, its only text view.
    private var composer: XCUIElement { home == .grouped ? app.textViews["composer"] : app.textViews.firstMatch }
    private var trace: XCUIElement { app.otherElements["compose-trace"] }

    /// The trace's numbers, by name.
    private func traced() -> [String: String] {
        let value = trace.value as? String ?? ""
        var fields: [String: String] = [:]
        for part in value.split(separator: " ") {
            let pair = part.split(separator: "=", maxSplits: 1)
            if pair.count == 2 { fields[String(pair[0])] = String(pair[1]) }
        }
        return fields
    }

    /// Typed on the keyboard's own keys: `typeText` puts the simulator in
    /// its hardware keyboard's mode, which takes the on-screen keyboard
    /// down, as a person's typing never does.
    private func tapKeys(_ text: String) {
        for character in text {
            let key = app.keyboards.firstMatch.keys[character == " " ? "space" : String(character)]
            XCTAssertTrue(key.waitForExistence(timeout: 3), "no key \(character)")
            key.tap()
        }
    }

    /// Send, once the keyboard has settled: a tap on a button still
    /// riding the keyboard lands where it was.
    private func sendWhenStill() {
        let send = app.buttons["Send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        sleep(1)
        send.tap()
    }

    private func compose() {
        let compose = app.buttons["compose"]
        XCTAssertTrue(compose.waitForExistence(timeout: 5))
        compose.tap()
        XCTAssertTrue(trace.waitForExistence(timeout: 10))
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
    }

    /// A swipe from the left edge across `fraction` of the screen, let go
    /// of at rest there.
    private func swipeBack(to fraction: CGFloat, hold: TimeInterval) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.45))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: fraction, dy: 0.45))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: hold)
    }

    func testTheKeyboardComesUpWithThePush() throws {
        launch()
        try assertTheKeyboardComesUpWithThePush("new-work-open")
    }

    func testLegacyTheKeyboardComesUpWithThePush() throws {
        launch(.legacy(machines: 1))
        try assertTheKeyboardComesUpWithThePush("legacy-new-work-open")
    }

    private func assertTheKeyboardComesUpWithThePush(_ name: String) throws {
        compose()
        sleep(1)
        let fields = traced()
        capture(name)
        // On screen as the push ended, and on screen for part of it.
        let appeared = try XCTUnwrap(fields["appearKeyboard"].flatMap(Double.init), "the keyboard wasn't up as the push ended: \(fields)")
        XCTAssertLessThan(appeared, Double(app.windows.firstMatch.frame.height) - 200, "the keyboard was still coming up as the push ended: \(fields)")
        let pushFrames = Int(fields["pushFrames"] ?? "") ?? 0
        let keyboardFrames = Int(fields["pushKeyboardFrames"] ?? "") ?? 0
        XCTAssertGreaterThan(pushFrames, 5, "the push wasn't traced: \(fields)")
        XCTAssertGreaterThan(keyboardFrames, pushFrames / 4, "the keyboard came after the push: \(fields)")
        XCTAssertEqual(fields["responder"], "composer")
    }

    func testACancelledSwipeBackKeepsTheKeyboardAndTheFocus() {
        launch()
        assertACancelledSwipeBackKeepsTheKeyboardAndTheFocus("new-work-swipe-cancelled")
    }

    func testLegacyACancelledSwipeBackKeepsTheKeyboardAndTheFocus() {
        launch(.legacy(machines: 1))
        assertACancelledSwipeBackKeepsTheKeyboardAndTheFocus("legacy-new-work-swipe-cancelled")
    }

    private func assertACancelledSwipeBackKeepsTheKeyboardAndTheFocus(_ name: String) {
        compose()
        sleep(1)
        tapKeys("Kept")
        swipeBack(to: 0.3, hold: 0.4)
        sleep(1)
        XCTAssertTrue(composer.exists, "the swipe went back")
        let fields = traced()
        capture(name)
        XCTAssertGreaterThan(Int(fields["swipeFrames"] ?? "") ?? 0, 0, "no swipe was traced: \(fields)")
        XCTAssertEqual(fields["swipeDrops"], "0", "the keyboard went or lost the composer during the swipe: \(fields)")
        XCTAssertEqual(fields["responder"], "composer", "the composer lost the keyboard: \(fields)")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        // Back over the keyboard, not under it.
        let keyboardTop = app.keyboards.firstMatch.frame.minY
        XCTAssertLessThanOrEqual(composer.frame.maxY, keyboardTop + 1, "the keyboard covers the composer: \(fields)")
        tapKeys(" on")
        XCTAssertEqual(composer.value as? String, "Kept on")
    }

    func testASwipeBackAndBackLeaveAlike() {
        launch()
        compose()
        sleep(1)
        tapKeys("Swiped")
        swipeBack(to: 0.95, hold: 0)
        XCTAssertTrue(row("Fix login crash").waitForExistence(timeout: 10), "the swipe didn't go back")
        sleep(1)
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the keyboard stayed up on home after the swipe")
        XCTAssertFalse(trace.exists)
        capture("new-work-swiped-home")

        compose()
        sleep(1)
        XCTAssertEqual(composer.value as? String, "Swiped", "the draft didn't come back")
        XCTAssertEqual(traced()["responder"], "composer", "reopened, the composer didn't take the keyboard")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(row("Fix login crash").waitForExistence(timeout: 10))
        sleep(1)
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the keyboard stayed up on home after Back")
        XCTAssertFalse(trace.exists)
        XCTAssertEqual(rows("New Task"), 0, "leaving made a task")
        XCTAssertEqual(rows("Swiped"), 0)
        capture("new-work-back-home")
    }

    /// Legacy's compose leaves the same way by either path; neither starts
    /// a session.
    func testLegacyASwipeBackAndBackLeaveAlike() {
        launch(.legacy(machines: 1))
        compose()
        sleep(1)
        tapKeys("Swiped")
        swipeBack(to: 0.95, hold: 0)
        XCTAssertTrue(atHome(), "the swipe didn't go back")
        sleep(1)
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the keyboard stayed up on home after the swipe")
        XCTAssertFalse(trace.exists)
        capture("legacy-new-work-swiped-home")

        compose()
        sleep(1)
        XCTAssertEqual(composer.value as? String, "Swiped", "the draft didn't come back")
        XCTAssertEqual(traced()["responder"], "composer", "reopened, the composer didn't take the keyboard")
        tapKeys(" and")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(atHome())
        sleep(1)
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the keyboard stayed up on home after Back")
        XCTAssertFalse(trace.exists)
        XCTAssertFalse(app.staticTexts["Swiped"].exists, "leaving started a session")
        XCTAssertFalse(app.staticTexts["Swiped and"].exists, "leaving started a session")
        capture("legacy-new-work-back-home")
    }

    /// One computer: nothing to choose there, so only the folder shows.
    func testLegacyOneMachineAsksOnlyTheFolder() {
        launch(.legacy(machines: 1))
        compose()
        sleep(1)
        let folder = app.buttons["new-work-folder"]
        XCTAssertTrue(folder.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["new-work-machine"].exists, "one computer, and it was asked for")
        capture("legacy-new-work-one-machine")
        let fields = traced()
        XCTAssertEqual(Double(fields["panelOffset"] ?? "") ?? .nan, 0, accuracy: 0.5, "off centre: \(fields)")
        assertCentredOnScreen()
    }

    /// Two computers: the computer is asked for, and the folder follows it.
    func testLegacyTwoMachinesAskTheMachineAndTheFolderFollows() {
        launch(.legacy(machines: 2))
        compose()
        sleep(1)
        let machine = app.buttons["new-work-machine"]
        let folder = app.buttons["new-work-folder"]
        XCTAssertTrue(machine.waitForExistence(timeout: 5))
        XCTAssertTrue(folder.exists)
        capture("legacy-new-work-two-machines")
        let fields = traced()
        XCTAssertEqual(Double(fields["panelOffset"] ?? "") ?? .nan, 0, accuracy: 0.5, "off centre: \(fields)")
        assertCentredOnScreen()
        machine.tap()
        let studio = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Studio Mac'")).firstMatch
        XCTAssertTrue(studio.waitForExistence(timeout: 5), "the computers weren't offered")
        studio.tap()
        let followed = NSPredicate(format: "label CONTAINS 'site'")
        expectation(for: followed, evaluatedWith: folder)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(machine.label.contains("Studio Mac"), machine.label)
        capture("legacy-new-work-studio")
    }

    func testTaskOrBotIsMadeAsChosen() {
        launch()
        // A task asks no name: its first message names it.
        compose()
        let name = app.textFields["new-work-name"]
        XCTAssertTrue(app.segmentedControls["new-work-kind"].waitForExistence(timeout: 5))
        XCTAssertFalse(name.exists, "a task asks no name")
        XCTAssertEqual(traced()["responder"], "composer")
        composer.typeText("Audit the exports")
        sendWhenStill()
        XCTAssertTrue(app.navigationBars.staticTexts["Audit the exports"].waitForExistence(timeout: 10), "the task wasn't named by its first message")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "the keyboard went down with the first message")
        XCTAssertFalse(app.segmentedControls["new-work-kind"].isHittable, "the panel stayed up")
        capture("new-work-task")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(row("Audit the exports").waitForExistence(timeout: 10))

        // A bot, unnamed: its first message names it.
        compose()
        app.segmentedControls["new-work-kind"].buttons["Bot"].tap()
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        XCTAssertEqual(name.value as? String, name.placeholderValue, "the next new work kept the last one's name")
        capture("new-work-bot")
        composer.tap()
        composer.typeText("Watch the release")
        sendWhenStill()
        XCTAssertTrue(app.navigationBars.staticTexts["Watch the release"].waitForExistence(timeout: 10), "the bot wasn't named by its first message")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(row("Watch the release").waitForExistence(timeout: 10))
        XCTAssertEqual(rows("Watch the release"), 1)

        // A bot, named; Bot and the name are kept as compose is left and opened again.
        compose()
        app.segmentedControls["new-work-kind"].buttons["Bot"].tap()
        name.tap()
        name.typeText("Newsletter")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(row("Fix login crash").waitForExistence(timeout: 10))
        compose()
        XCTAssertEqual(name.value as? String, "Newsletter", "the name wasn't kept")
        XCTAssertTrue(app.segmentedControls["new-work-kind"].buttons["Bot"].isSelected, "Bot wasn't kept")
        composer.tap()
        composer.typeText("Draft the newsletter")
        sendWhenStill()
        XCTAssertTrue(app.navigationBars.staticTexts["Newsletter"].waitForExistence(timeout: 10), "the bot wasn't named as given")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(row("Newsletter").waitForExistence(timeout: 10))
        XCTAssertEqual(rows("New Task"), 0)
        XCTAssertEqual(rows("New Bot"), 0)
        capture("new-work-home")
    }

    /// Centred in the room between the bar and the composer, with the
    /// keyboard up and once it is down.
    func testThePanelIsCentredWithAndWithoutTheKeyboard() throws {
        launch()
        compose()
        sleep(1)
        let up = traced()
        capture("new-work-centred-keyboard")
        XCTAssertEqual(try XCTUnwrap(Double(up["panelOffset"] ?? "")), 0, accuracy: 0.5, "off centre with the keyboard up: \(up)")
        assertCentredOnScreen()

        // Down: dragged away over the empty transcript.
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: app.keyboards.firstMatch)
        waitForExpectations(timeout: 5)
        sleep(1)
        let down = traced()
        capture("new-work-centred")
        XCTAssertEqual(down["responder"], "none")
        XCTAssertEqual(try XCTUnwrap(Double(down["panelOffset"] ?? "")), 0, accuracy: 0.5, "off centre with the keyboard down: \(down)")
        XCTAssertGreaterThan(Int(down["composerTop"] ?? "") ?? 0, Int(up["composerTop"] ?? "") ?? 0, "the composer didn't go down")
        assertCentredOnScreen()
    }

    /// The panel's middle against the bar's foot and the composer's top,
    /// as the screen shows them.
    private func assertCentredOnScreen(line: UInt = #line) {
        // A task's block is its picture, where there is room, over the kind,
        // then a bot's room left empty: the screen shows only the first two.
        let panel = home == .grouped
            ? [app.descendants(matching: .any)["new-work-art"], app.segmentedControls["new-work-kind"]].filter(\.exists).map(\.frame).reduce(CGRect.null) { $0.union($1) }
            : [app.buttons["new-work-machine"], app.buttons["new-work-folder"]].filter(\.exists).map(\.frame).reduce(CGRect.null) { $0.union($1) }
        let bar = app.navigationBars.firstMatch.frame
        // Legacy's card is the composer text view's: its edge is the room's.
        let input = home == .grouped ? app.otherElements["input"].frame : composer.frame
        XCTAssertGreaterThan(panel.minY, bar.maxY, line: line)
        XCTAssertLessThan(panel.maxY, input.minY, line: line)
        // A legacy block's note runs under its rows, so the block's middle
        // is a little below theirs.
        let room = (bar.maxY + input.minY) / 2
        // The empty room isn't seen; `panelOffset` says the whole block is centred.
        guard home != .grouped else { return }
        XCTAssertEqual(panel.midY, room, accuracy: 40, "the panel isn't in the middle: \(panel) between \(bar.maxY) and \(input.minY)", line: line)
    }

    private func capture(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
}

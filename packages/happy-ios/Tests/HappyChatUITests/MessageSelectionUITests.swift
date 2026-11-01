import XCTest

/// A message held in either chat lifts over the dimmed conversation with
/// its menu, as Telegram's does; Select puts handles on its words, a
/// dragged handle moves the selection, and Copy puts exactly what is
/// selected on the pasteboard. The harness's probe (`ChatScrollProbe`)
/// reports the lifted message (`MessageLiftOverlay.probe`), the rows that
/// hide for it, and the pasteboard.
///
/// With `TEST_RUNNER_SELECTION_SHOTS=<folder>` the screenshots are also
/// written there, light and dark.
final class MessageSelectionUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        print("MessageSelectionUITests skips quiescence: \(skipsQuiescence)")
    }

    // MARK: Probe

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = arguments
        app.launch()
        return app
    }

    private func probe(_ app: XCUIApplication) -> [String: Any] {
        let element = app.otherElements["chat-scroll-probe"]
        guard element.exists, let value = element.value as? String,
              let object = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else { return [:] }
        return object
    }

    private func probe(_ app: XCUIApplication, timeout: TimeInterval = 15, until condition: ([String: Any]) -> Bool) -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        var last = probe(app)
        while !condition(last), Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
            last = probe(app)
        }
        return last
    }

    private func lift(_ probe: [String: Any]) -> [String: Any]? { probe["lift"] as? [String: Any] }

    private func number(_ value: Any?) -> CGFloat { CGFloat((value as? NSNumber)?.doubleValue ?? .nan) }

    private func frame(_ value: Any?) -> CGRect? {
        guard let values = value as? [NSNumber], values.count == 4 else { return nil }
        return CGRect(x: values[0].doubleValue, y: values[1].doubleValue, width: values[2].doubleValue, height: values[3].doubleValue)
    }

    private func range(_ lift: [String: Any]?) -> Range<Int>? {
        guard let values = lift?["range"] as? [NSNumber], values.count == 2 else { return nil }
        return values[0].intValue..<values[1].intValue
    }

    private func point(_ app: XCUIApplication, _ point: CGPoint) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y))
    }

    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["SELECTION_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }

    // MARK: Chats

    private enum Chat: String {
        case agent, session

        var arguments: [String] { self == .agent ? ["-screen", "agentChat", "-hideKeyboardButton"] : ["-fixture", "long", "-hideKeyboardButton"] }
        /// The newest person's message.
        var outgoing: String {
            self == .agent ? "label BEGINSWITH 'Question 39:'" : "label CONTAINS '(#1500)'"
        }
        /// The newest answer: the fixtures' last (`FixtureScenarios.long`
        /// starts turn 1500's with `filler[1499 % 7]`).
        var incoming: String {
            self == .agent ? "label BEGINSWITH 'Answer 39.'" : "label BEGINSWITH 'I re-ran the suite'"
        }
    }

    private func open(_ chat: Chat, dark: Bool = false) -> XCUIApplication {
        let app = launch(chat.arguments + [dark ? "-chatDark" : "-chatLight"])
        let ready = probe(app, timeout: 30) { number($0["rows"]) > 3 && $0["chat"] as? String == chat.rawValue }
        XCTAssertGreaterThan(number(ready["rows"]), 3, "the chat never filled: \(ready)")
        return app
    }

    /// A point in the lowest message on screen that `format` matches: on
    /// the first line near its leading edge, or for a person's bubble
    /// halfway down near its trailing edge.
    private func message(_ app: XCUIApplication, _ format: String, trailing: Bool = false) -> XCUICoordinate {
        let window = app.windows.firstMatch.frame
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            let frames = app.descendants(matching: .any).matching(NSPredicate(format: format)).allElementsBoundByIndex.map { $0.frame }
                .filter { $0.minY > 100 && $0.minY < window.maxY - 120 }
            if let lowest = frames.max(by: { $0.minY < $1.minY }) {
                return point(app, trailing ? CGPoint(x: lowest.maxX - 40, y: lowest.midY) : CGPoint(x: lowest.minX + 40, y: lowest.minY + 32))
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        XCTFail("no message matching \(format) on screen")
        return point(app, CGPoint(x: 60, y: 600))
    }

    private func incoming(_ app: XCUIApplication, _ chat: Chat) -> XCUICoordinate { message(app, chat.incoming) }

    /// Holds `target` until the message lifts with its menu.
    @discardableResult
    private func hold(_ app: XCUIApplication, _ target: XCUICoordinate) -> [String: Any] {
        target.press(forDuration: 0.8)
        let lifted = probe(app) { (lift($0)?["menu"] as? [Any])?.count == 4 && number($0["liftedRows"]) == 1 }
        if lift(lifted) == nil { screenshot("nothing-lifted") }
        XCTAssertNotNil(lift(lifted), "nothing lifted: \(lifted)")
        XCTAssertEqual(number(lifted["liftedRows"]), 1, "the row under the lifted copy still shows")
        XCTAssertTrue(app.otherElements["hold-menu"].buttons["Copy"].exists)
        XCTAssertTrue(app.otherElements["hold-menu"].buttons["Select"].exists)
        Thread.sleep(forTimeInterval: 0.5)
        return probe(app)
    }

    private func dismissed(_ app: XCUIApplication) -> [String: Any] {
        let gone = probe(app) { lift($0) == nil && number($0["liftedRows"]) == 0 }
        XCTAssertNil(lift(gone), "the lifted message never went back: \(gone)")
        XCTAssertEqual(number(gone["liftedRows"]), 0, "a row is still hidden: \(gone)")
        return gone
    }

    // MARK: Tests

    func testAgentChatSelectDragAndCopy() throws { try selectDragAndCopy(.agent) }

    func testSessionChatSelectDragAndCopy() throws { try selectDragAndCopy(.session) }

    func testAgentChatLiftsAPersonsMessageToo() throws { try liftsOutgoing(.agent) }

    func testSessionChatLiftsAPersonsMessageToo() throws { try liftsOutgoing(.session) }

    func testAgentChatPutsTheRowBackWhenTappedAway() throws { try putsTheRowBack(.agent) }

    func testSessionChatPutsTheRowBackWhenTappedAway() throws { try putsTheRowBack(.session) }

    func testScreenshotsLightAndDark() throws {
        for chat in [Chat.agent, .session] {
            for dark in [false, true] {
                let app = open(chat, dark: dark)
                let style = dark ? "dark" : "light"
                hold(app, incoming(app, chat))
                screenshot("\(chat.rawValue)-menu-\(style)")
                app.otherElements["hold-menu"].buttons["Select"].tap()
                let all = probe(app) { self.range(self.lift($0)) != nil }
                if let start = frame(lift(all)?["start"]) {
                    // A word, then its end dragged a line down.
                    point(app, CGPoint(x: start.midX + 40, y: start.maxY - 10)).tap()
                    point(app, CGPoint(x: start.midX + 40, y: start.maxY - 10)).press(forDuration: 0.6)
                    let word = probe(app) { self.range(self.lift($0)) != nil }
                    if let end = frame(lift(word)?["end"]) {
                        point(app, CGPoint(x: end.midX, y: end.maxY - 4)).press(forDuration: 0.05, thenDragTo: point(app, CGPoint(x: end.midX + 60, y: end.maxY + 18)))
                    }
                }
                Thread.sleep(forTimeInterval: 0.8)
                screenshot("\(chat.rawValue)-selection-\(style)")
                app.terminate()
            }
        }
    }

    // MARK: Flows

    private func selectDragAndCopy(_ chat: Chat) throws {
        let app = open(chat)
        let lifted = hold(app, incoming(app, chat))
        let length = Int(number(lift(lifted)?["length"]))
        XCTAssertGreaterThan(length, 20)

        // Select: the whole message, between two handles.
        app.otherElements["hold-menu"].buttons["Select"].tap()
        let all = probe(app) { self.range(self.lift($0)) == 0..<length }
        XCTAssertEqual(range(lift(all)), 0..<length, "Select didn't select it all: \(all)")
        let whole = try XCTUnwrap(lift(all)?["selected"] as? String)
        let start = try XCTUnwrap(frame(lift(all)?["start"]), "no start handle")
        XCTAssertNotNil(frame(lift(all)?["end"]), "no end handle")
        // The menu steps aside while there is a selection.
        XCTAssertEqual((lift(all)?["menu"] as? [Any])?.count ?? 0, 0)

        // A tap lets go of it; a press on a word selects that word.
        let first = CGPoint(x: start.midX + 30, y: start.maxY - 10)
        point(app, first).tap()
        _ = probe(app) { self.range(self.lift($0)) == nil }
        point(app, first).press(forDuration: 0.6)
        let word = probe(app) { (self.range(self.lift($0))?.count ?? 0) > 0 }
        let picked = try XCTUnwrap(range(lift(word)), "the press selected nothing: \(word)")
        XCTAssertLessThan(picked.count, 16, "more than a word: \(word)")
        XCTAssertEqual(lift(word)?["selected"] as? String, substring(whole, picked))

        // The end handle dragged a line down takes the selection with it.
        let end = try XCTUnwrap(frame(lift(word)?["end"]))
        point(app, CGPoint(x: end.midX, y: end.maxY - 4)).press(forDuration: 0.05, thenDragTo: point(app, CGPoint(x: end.midX + 60, y: end.maxY + 18)))
        let dragged = probe(app) { (self.range(self.lift($0))?.upperBound ?? 0) > picked.upperBound + 5 }
        let extended = try XCTUnwrap(range(lift(dragged)))
        XCTAssertEqual(extended.lowerBound, picked.lowerBound, "the start moved: \(dragged)")
        XCTAssertGreaterThan(extended.upperBound, picked.upperBound + 5, "the end didn't follow the handle: \(dragged)")
        let selected = try XCTUnwrap(lift(dragged)?["selected"] as? String)
        // Within one paragraph the copy is the substring; across them
        // the paragraphs' breaks come back, as they are in the whole.
        let words = try XCTUnwrap(lift(word)?["selected"] as? String)
        XCTAssertTrue(selected.hasPrefix(words), "\(selected) doesn't start at \(words)")
        XCTAssertTrue(whole.contains(selected), "\(selected) isn't part of the message")
        if !selected.contains("\n") { XCTAssertEqual(selected, substring(whole, extended)) }

        // Copy, from the menu over the selection: exactly that, and the
        // message goes back.
        let copy = editMenuCopy(app)
        XCTAssertTrue(copy.waitForExistence(timeout: 5), "no Copy over the selection")
        copy.tap()
        let gone = dismissed(app)
        XCTAssertEqual(gone["pasteboard"] as? String, selected)
    }

    private func liftsOutgoing(_ chat: Chat) throws {
        let app = open(chat)
        let lifted = hold(app, message(app, chat.outgoing, trailing: true))
        // Copy in the hold menu copies all of it.
        let length = Int(number(lift(lifted)?["length"]))
        app.otherElements["hold-menu"].buttons["Copy"].tap()
        let gone = dismissed(app)
        let copied = try XCTUnwrap(gone["pasteboard"] as? String)
        XCTAssertEqual(copied.utf16.count, length)
        if chat == .agent { XCTAssertEqual(copied, "Question 39: why does the cache test fail?") }
        else { XCTAssertTrue(copied.hasSuffix("(#1500)"), copied) }
    }

    /// Going back, the copy over the row is taken away in the same frame
    /// the row shows again: never both hidden, never both shown.
    private func putsTheRowBack(_ chat: Chat) throws {
        let app = open(chat)
        hold(app, incoming(app, chat))
        app.descendants(matching: .any)["lift-dismiss"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        let deadline = Date().addingTimeInterval(5)
        var samples = 0
        while Date() < deadline {
            let now = probe(app)
            samples += 1
            let rows = number(now["liftedRows"])
            if let lifted = lift(now) {
                XCTAssertEqual(rows, 1, "the row showed under its lifted copy: \(lifted)")
            } else {
                XCTAssertEqual(rows, 0, "the row was hidden with no copy over it")
                break
            }
        }
        XCTAssertGreaterThan(samples, 0)
        dismissed(app)
    }

    // MARK: Helpers

    private func substring(_ text: String, _ range: Range<Int>) -> String {
        (text as NSString).substring(with: NSRange(location: range.lowerBound, length: range.count))
    }

    /// The edit menu's Copy, not the hold menu's.
    private func editMenuCopy(_ app: XCUIApplication) -> XCUIElement {
        let item = app.menuItems["Copy"]
        if item.waitForExistence(timeout: 2) { return item }
        return app.collectionViews.buttons["Copy"].exists ? app.collectionViews.buttons["Copy"] : app.buttons.matching(NSPredicate(format: "label == 'Copy'")).element(boundBy: 0)
    }
}

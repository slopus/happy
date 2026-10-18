import ObjectiveC
import XCTest

/// XCUITest waits for the app to be idle before and after every action, and
/// gives up only after a minute. The harness's chat never goes idle for it,
/// so each action would wait out the minute. Best effort: the wait is
/// private API, replaced where it is found and left alone where it isn't
/// (the tests are only slower then).
let skipsQuiescence: Bool = {
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

/// The chat list driven by a finger, in `HappyChatHarness`: an interactive
/// keyboard dismiss, and a long press at the edge where an indicator would
/// be. The harness's probe (`ChatScrollProbe`) reports the list and what
/// each finger did.
final class ChatScrollUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        print("ChatScrollUITests skips quiescence: \(skipsQuiescence)")
    }

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

    /// The probe once `condition` holds, or the last one read.
    private func probe(_ app: XCUIApplication, timeout: TimeInterval = 15, until condition: ([String: Any]) -> Bool) -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        var last = probe(app)
        while !condition(last), Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
            last = probe(app)
        }
        return last
    }

    private func number(_ value: Any?) -> CGFloat {
        CGFloat((value as? NSNumber)?.doubleValue ?? .nan)
    }

    private func frame(_ value: Any?) -> CGRect? {
        guard let values = value as? [NSNumber], values.count == 4 else { return nil }
        return CGRect(x: values[0].doubleValue, y: values[1].doubleValue, width: values[2].doubleValue, height: values[3].doubleValue)
    }

    private func point(_ app: XCUIApplication, _ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }

    private func attach(_ name: String, _ value: Any) {
        let attachment = XCTAttachment(string: "\(value)")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        print("ChatScrollUITests \(name): \(value)")
    }

    private func filled(_ probe: [String: Any]) -> Bool {
        number(probe["rows"]) > 20 && number(probe["maxDistance"]) > number((probe["listSize"] as? [NSNumber])?.last)
    }

    // MARK: Keyboard

    /// The finger starts on the list above the dock and drags slowly to the
    /// bottom of the screen; the keyboard follows it down. While it does,
    /// the conversation moves as far as the finger, not as far as the finger
    /// and the keyboard together.
    func testAnInteractiveDismissKeepsTheConversationUnderTheFinger() throws {
        try interactiveDismiss(ultra: false)
    }

    func testUltraListInteractiveDismissKeepsTheConversationUnderTheFinger() throws {
        try interactiveDismiss(ultra: true)
    }

    private func interactiveDismiss(ultra: Bool) throws {
        let app = launch(["-fixture", "long", "-keyboard"] + (ultra ? ["-chatUltraList"] : []))
        var state = probe(app) { self.filled($0) && self.number($0["keyboardTop"]) < self.number(($0["window"] as? [NSNumber])?.last) - 150 }
        XCTAssertEqual(state["renderer"] as? String, ultra ? "UltraList" : "UICollectionView")
        guard number(state["keyboardTop"]) < number((state["window"] as? [NSNumber])?.last) - 150 else {
            throw XCTSkip("no software keyboard on this simulator (hardware keyboard connected)")
        }
        Thread.sleep(forTimeInterval: 1)
        state = probe(app)
        attach("before", state)
        let window = try XCTUnwrap(state["window"] as? [NSNumber]).map { CGFloat($0.doubleValue) }
        let dockMinY = number(state["dockMinY"])
        let start = point(app, window[0] / 2, dockMinY - 120)
        let end = point(app, window[0] / 2, window[1] - 4)
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: 250, thenHoldForDuration: 0.3)
        state = probe(app, timeout: 3) { (($0["lastTouch"] as? [String: Any])?["index"] as? NSNumber) != nil }
        attach("events", state["events"] ?? [])
        let touch = try XCTUnwrap(state["lastTouch"] as? [String: Any])
        attach("touch", touch)
        let keyboardTravel = number(touch["keyboardTravel"])
        let finger = number(touch["fingerTravelWithKeyboard"])
        let content = number(touch["offsetTravelWithKeyboard"])
        XCTAssertGreaterThan(keyboardTravel, 80, "the keyboard followed the finger")
        XCTAssertGreaterThan(finger, 80)
        // 1 to 1, give or take the frames where the two sample apart.
        XCTAssertEqual(content / finger, 1, accuracy: 0.15, "content \(content) for a finger's \(finger) while the keyboard moved")
    }

    // MARK: Keyboard show, return, dismiss and hide

    /// UltraList moves the keyboard with UltraView's own controller; the
    /// same script on UICollectionView, which keeps the system's
    /// interactive dismissal and the layout guide, is the comparison. The
    /// keyboard shows on a tap; a drag a third of the way down, held still
    /// and let go, returns it; a slow drag to the bottom dismisses it with
    /// the conversation under the finger; a quick drag let go partway
    /// dismisses it; a tap on the harness's button puts it away. The dock
    /// sits on the keyboard all the while, and moves frame by frame after
    /// each finger lifts.
    func testUltraListKeyboardShowReturnDismissAndHide() throws {
        try keyboardShowReturnDismissAndHide(ultra: true)
    }

    func testKeyboardShowReturnDismissAndHide() throws {
        try keyboardShowReturnDismissAndHide(ultra: false)
    }

    /// An empty chat has no rows to move: the dock and the placeholder
    /// still ride the keyboard on the list's inset motion.
    func testUltraListEmptyChatKeyboardShowReturnDismissAndHide() throws {
        try keyboardShowReturnDismissAndHide(ultra: true, empty: true)
    }

    private func keyboardShowReturnDismissAndHide(ultra: Bool, empty: Bool = false) throws {
        let app = launch(["-fixture", empty ? "empty" : "long", "-hideKeyboardButton"] + (ultra ? ["-chatUltraList"] : []))
        var state = probe(app) { empty ? $0["renderer"] != nil : self.filled($0) }
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 10), "the composer is there")
        XCTAssertEqual(state["renderer"] as? String, ultra ? "UltraList" : "UICollectionView")
        let window = try XCTUnwrap(state["window"] as? [NSNumber]).map { CGFloat($0.doubleValue) }
        let width = window[0], height = window[1]
        let resting = height - number((state["safeArea"] as? [NSNumber])?[2])
        let x = width / 2
        Thread.sleep(forTimeInterval: 0.5)

        func touches(_ state: [String: Any]) -> Int { ((state["lastTouch"] as? [String: Any])?["index"] as? NSNumber)?.intValue ?? 0 }
        func release(_ state: [String: Any]) -> [String: Any] { (state["lastTouch"] as? [String: Any])?["release"] as? [String: Any] ?? [:] }
        func isUp(_ state: [String: Any]) -> Bool { number(state["keyboardTop"]) < height - 150 }
        /// After a finger lifted: its release sampled, and a moment more.
        func settled(after count: Int) -> [String: Any] {
            _ = probe(app, timeout: 5) { touches($0) > count && !release($0).isEmpty }
            Thread.sleep(forTimeInterval: 0.5)
            return probe(app)
        }
        func assertDocked(_ state: [String: Any], _ label: String) {
            XCTAssertEqual(number(state["dockMaxY"]), min(resting, number(state["keyboardTop"])), accuracy: 1, "\(label): the dock sits on the keyboard")
        }
        func assertDown(_ state: [String: Any], _ label: String) {
            XCTAssertGreaterThanOrEqual(number(state["keyboardTop"]), resting - 1, "\(label): the keyboard is down")
            XCTAssertEqual(number(state["dockMaxY"]), resting, accuracy: 1, "\(label): the dock rests on the safe area")
        }
        func assertDriver(_ state: [String: Any], _ label: String) {
            XCTAssertEqual(state["keyboard"] as? String, ultra ? "controller" : "guide", "\(label): who moves the keyboard")
        }
        func assertAnimated(_ state: [String: Any], _ label: String) {
            let sampled = release(state)
            attach("\(label) release", sampled)
            XCTAssertGreaterThanOrEqual((sampled["dockFramesMoved"] as? NSNumber)?.intValue ?? 0, 3, "\(label): the dock animates, frame by frame")
        }
        /// UltraView's controller owned the finger's keyboard and its
        /// release; on UICollectionView nothing did.
        func assertDriven(_ state: [String: Any], _ label: String) {
            let touch = state["lastTouch"] as? [String: Any] ?? [:]
            XCTAssertEqual(touch["keyboardDriven"] as? Bool, ultra, "\(label): the controller tracked the finger")
            XCTAssertEqual(release(state)["driving"] as? Bool, ultra, "\(label): the controller played the release")
        }
        func show(_ label: String) throws -> [String: Any] {
            let before = touches(probe(app))
            let field = app.textViews.firstMatch.frame
            point(app, field.midX, field.midY).tap()
            var state = probe(app, timeout: 5) { isUp($0) }
            guard isUp(state) else { throw XCTSkip("no software keyboard (hardware keyboard connected)") }
            state = settled(after: before)
            attach(label, state)
            assertDriver(state, label)
            assertDocked(state, label)
            assertAnimated(state, label)
            return state
        }

        // Show.
        state = try show("show")
        let shownTop = number(state["keyboardTop"])
        var dockTop = number(state["dockMinY"])
        let dock = shownTop - dockTop
        // A third of the way to where the dock's bottom meets the screen's.
        let partial = max(dockTop - 40, shownTop + (height - dock - shownTop) / 3 - dock)

        // Partial drag, held still and let go: the keyboard returns.
        var count = touches(state)
        point(app, x, dockTop - 110).press(forDuration: 0.05, thenDragTo: point(app, x, partial), withVelocity: 300, thenHoldForDuration: 0.4)
        state = settled(after: count)
        attach("return", state)
        var touch = state["lastTouch"] as? [String: Any] ?? [:]
        XCTAssertGreaterThan(number(touch["keyboardTravel"]), 20, "return: the keyboard followed the finger down")
        XCTAssertEqual(number(state["keyboardTop"]), shownTop, accuracy: 2, "return: the keyboard came back")
        assertDocked(state, "return")
        assertDriven(state, "return")
        assertAnimated(state, "return")

        // Slow drag to the bottom: dismissed, the conversation under the finger.
        count = touches(state)
        dockTop = number(state["dockMinY"])
        point(app, x, dockTop - 110).press(forDuration: 0.05, thenDragTo: point(app, x, height - 4), withVelocity: 250, thenHoldForDuration: 0.3)
        state = settled(after: count)
        attach("dismiss", state)
        touch = state["lastTouch"] as? [String: Any] ?? [:]
        let finger = number(touch["fingerTravelWithKeyboard"]), content = number(touch["offsetTravelWithKeyboard"])
        XCTAssertGreaterThan(number(touch["keyboardTravel"]), 80, "dismiss: the keyboard followed the finger")
        XCTAssertGreaterThan(finger, 80)
        if !empty {
            XCTAssertEqual(content / finger, 1, accuracy: 0.15, "dismiss: content \(content) for a finger's \(finger) while the keyboard moved")
        }
        XCTAssertEqual(touch["keyboardDriven"] as? Bool, ultra, "dismiss: the controller tracked the finger")
        assertDown(state, "dismiss")

        // A quick drag let go partway: dismissed by its speed.
        state = try show("show again")
        count = touches(state)
        dockTop = number(state["dockMinY"])
        point(app, x, dockTop - 110).press(forDuration: 0.05, thenDragTo: point(app, x, partial), withVelocity: 1500, thenHoldForDuration: 0)
        state = settled(after: count)
        attach("quick dismiss", state)
        assertDown(state, "quick dismiss")
        assertDriven(state, "quick dismiss")
        assertAnimated(state, "quick dismiss")

        // Put away without a gesture.
        state = try show("show a third time")
        count = touches(state)
        let button = app.buttons["harness-end-editing"].frame
        point(app, button.midX, button.midY).tap()
        state = settled(after: count)
        attach("hide", state)
        assertDown(state, "hide")
        XCTAssertEqual(release(state)["driving"] as? Bool, false, "hide: an ordinary hide, nothing driven")
        assertAnimated(state, "hide")
    }

    // MARK: The edge

    /// The list shows no scroll indicator, so there is none to grab. A long
    /// press at the right edge, where UIKit's rested above the dock at the
    /// newest message, then a drag up, pulls the conversation past its
    /// newest message as any drag does, and it springs back. With the
    /// indicator the same press scrubbed back through the history: on the
    /// iOS 26.5 simulator a drag of 259 points took the reader 3,488 points
    /// back.
    func testALongPressAtTheEdgeDragsTheConversationLikeAnyFinger() throws {
        let app = launch(["-fixture", "long"])
        var state = probe(app) { self.filled($0) }
        Thread.sleep(forTimeInterval: 0.5)
        state = probe(app)
        attach("before", state)
        XCTAssertEqual(number(state["visibleMinY"]), 0, accuracy: 1, "at the newest message")
        let list = try XCTUnwrap(frame(state["list"]))
        let dockMinY = number(state["dockMinY"])
        // 4 points in from where UIKit drew its indicator's middle (3 thick,
        // 3 from the side): where a press on it reached the app.
        let x = list.maxX - 8.5
        point(app, x, dockMinY - 24).press(forDuration: 0.8, thenDragTo: point(app, x, dockMinY - 224), withVelocity: 200, thenHoldForDuration: 0.5)
        state = probe(app, timeout: 3) { (($0["lastTouch"] as? [String: Any])?["index"] as? NSNumber) != nil && !(($0["decelerating"] as? Bool) ?? true) }
        Thread.sleep(forTimeInterval: 0.5)
        state = probe(app)
        attach("events", state["events"] ?? [])
        let touch = try XCTUnwrap(state["lastTouch"] as? [String: Any])
        attach("touch", touch)
        attach("after", state)
        let finger = number(touch["fingerTravel"])
        let content = number(touch["offsetTravel"])
        XCTAssertLessThan(finger, -150, "the finger went up")
        XCTAssertEqual(touch["recognizers"] as? [String], ["UIScrollViewPanGestureRecognizer"], "the list's own pan")
        // Past the newest message the list gives less than the finger, as
        // a pull past any end does, and springs back.
        XCTAssertLessThan(abs(content), abs(finger), "content \(content) for a finger's \(finger)")
        XCTAssertEqual(number(state["visibleMinY"]), 0, accuracy: 1, "back at the newest message")
    }
}

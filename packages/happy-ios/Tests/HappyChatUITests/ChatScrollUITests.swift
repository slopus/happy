import ObjectiveC
import XCTest

/// XCUITest waits for the app to be idle before and after every action, and
/// gives up only after a minute. The harness's chat never goes idle for it,
/// so each action would wait out the minute. Best effort: the wait is
/// private API, replaced where it is found and left alone where it isn't
/// (the tests are only slower then).
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
        let app = launch(["-fixture", "long", "-keyboard"])
        var state = probe(app) { self.filled($0) && self.number($0["keyboardTop"]) < self.number(($0["window"] as? [NSNumber])?.last) - 150 }
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

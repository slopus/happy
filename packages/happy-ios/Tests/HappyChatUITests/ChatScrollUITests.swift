import ObjectiveC
import XCTest

/// XCUITest waits for the app to be idle before and after every action, and
/// gives up only after a minute. The harness keeps the scroll indicator
/// flashing with `-flash`, so it is never idle then. Best effort: the wait is
/// private API, replaced where it is found and left alone where it isn't (the
/// tests are only slower then).
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

/// UIKit's indicator: 3 from the track's ends (`ChatScrollIndicatorLayout`).
private enum ChatIndicatorStyle {
    static let endInset: CGFloat = 3
}

/// The chat list driven by a finger, in `HappyChatHarness`: an interactive
/// keyboard dismiss, and a long press and drag on the scroll indicator. The
/// harness's probe (`ChatScrollProbe`) reports the list, UIKit's indicator
/// and where `ChatScrollIndicatorLayout` says it must be, and what each
/// finger did.
final class ChatScrollUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        print("ChatScrollUITests skips quiescence: \(skipsQuiescence)")
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
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

    /// UIKit's indicator where the layout says, at rest.
    private func assertIndicatorMatches(_ probe: [String: Any], _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        guard let actual = frame(probe["actual"]), let expected = frame(probe["expected"]) else {
            XCTFail("\(label): no indicator in \(probe)", file: file, line: line)
            return
        }
        XCTAssertEqual(actual.minX, expected.minX, accuracy: 0.5, "\(label): side", file: file, line: line)
        XCTAssertEqual(actual.minY, expected.minY, accuracy: 0.5, "\(label): top", file: file, line: line)
        XCTAssertEqual(actual.height, expected.height, accuracy: 0.5, "\(label): length", file: file, line: line)
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

        // After the keyboard has gone, the indicator rests on the dock.
        state = probe(app, timeout: 3) { self.number($0["keyboardTop"]) >= window[1] - 60 && !(($0["decelerating"] as? Bool) ?? true) }
        Thread.sleep(forTimeInterval: 1)
        state = probe(app)
        attach("after", state)
        let insets = try XCTUnwrap(state["indicatorInsets"] as? [NSNumber]).map { CGFloat($0.doubleValue) }
        // On a phone the list runs under the dock; docked, on an iPad, it
        // stops above it and nothing covers it.
        let list = try XCTUnwrap(frame(state["list"]))
        XCTAssertEqual(insets[0], max(0, list.maxY - number(state["dockMinY"])), accuracy: 0.5)
    }

    // MARK: Dragging the indicator

    /// A long press on the indicator, then a drag up its track and a hold:
    /// the reader goes back through the history, and the indicator stays
    /// under the finger, older rows joining included. `fraction` is how far
    /// up the track, 1 at its top, under the header.
    private func dragIndicator(to fraction: CGFloat, hold: TimeInterval, label: String, expectsOlderRows: Bool = false) throws {
        let app = launch(["-fixture", "long", "-flash"])
        var state = probe(app) { self.filled($0) && self.number($0["actualAlpha"]) > 0.5 }
        Thread.sleep(forTimeInterval: 0.5)
        state = probe(app) { self.number($0["actualAlpha"]) > 0.5 }
        attach("\(label) before", state)
        assertIndicatorMatches(state, "\(label) at rest")
        let indicator = try XCTUnwrap(frame(state["actualInWindow"]))
        let list = try XCTUnwrap(frame(state["list"]))
        func touches(_ state: [String: Any]) -> Int {
            ((state["lastTouch"] as? [String: Any])?["index"] as? NSNumber)?.intValue ?? 0
        }
        // First a press the app must see: a short pull past the newest
        // message, mid-list, which bounces back.
        point(app, list.midX, list.midY).press(forDuration: 0.05, thenDragTo: point(app, list.midX, list.midY - 40), withVelocity: 400, thenHoldForDuration: 0)
        state = probe(app, timeout: 3) { touches($0) > 0 && !(($0["decelerating"] as? Bool) ?? true) }
        let seen = touches(state)
        attach("\(label) mid-list events", state["events"] ?? [])
        XCTAssertGreaterThan(seen, 0, "a press mid-list never reached the app's window")
        // A short pull right on the indicator's line: whether a touch that
        // near the edge reaches the app at all.
        point(app, indicator.midX, list.midY).press(forDuration: 0.05, thenDragTo: point(app, indicator.midX, list.midY - 40), withVelocity: 400, thenHoldForDuration: 0)
        state = probe(app, timeout: 3) { touches($0) > seen && !(($0["decelerating"] as? Bool) ?? true) }
        attach("\(label) edge events", "\(touches(state) > seen ? "reached" : "never reached") the app: \(state["events"] ?? [])")
        let edge = touches(state)
        state = probe(app, timeout: 3) { self.number($0["actualAlpha"]) > 0.5 }
        // On the iOS 26.5 simulator a long press on the drawn indicator's
        // middle, 4.5 from the screen's edge, never reached the app; 4 points
        // in, on the indicator still, it does.
        let start = point(app, indicator.midX - 4, indicator.midY)
        // `fraction` of the way from where it is to the top of its track:
        // past that, the finger runs ahead of an indicator that can't follow.
        let insets = try XCTUnwrap(state["indicatorInsets"] as? [NSNumber]).map { CGFloat($0.doubleValue) }
        let topMidY = list.minY + insets[1] + ChatIndicatorStyle.endInset + indicator.height / 2
        let targetY = indicator.midY - fraction * (indicator.midY - topMidY)
        let end = point(app, indicator.midX - 4, targetY)
        start.press(forDuration: 0.8, thenDragTo: end, withVelocity: 300, thenHoldForDuration: hold)
        state = probe(app, timeout: 3) { touches($0) > edge }
        attach("\(label) events", state["events"] ?? [])
        let touch = try XCTUnwrap(state["lastTouch"] as? [String: Any])
        XCTAssertGreaterThan(touches(state), edge, "the press on the indicator never reached the app's window, though one mid-list did")
        attach("\(label) touch", touch)
        attach("\(label) after", state)
        XCTAssertGreaterThan(number(state["visibleMinY"]), 100, "dragging the indicator up goes back through the history")
        // Against where it sat under the finger at the press: on the iOS
        // 26.5 simulator it moved 10 once UIKit took hold of it, and never
        // strayed further while the rows stayed.
        XCTAssertLessThan(number(touch["maxIndicatorGap"]), 16, "the indicator kept up with the finger")
        let joined = number(touch["rowsEnd"]) > number(touch["rowsStart"])
        let fingerOnIt = abs(number(touch["endFingerFromIndicator"])) <= number(touch["endIndicatorLength"]) / 2 + 4
        let assertFingerOnIt = {
            XCTAssertTrue(fingerOnIt, "the finger ended on the indicator: \(touch["endFingerFromIndicator"] ?? "?") from its middle, \(touch["endIndicatorLength"] ?? "?") long")
        }
        if expectsOlderRows {
            XCTAssertTrue(joined, "older rows joined while the indicator was held")
            // UIKit's own indicator: the same offset is a smaller share of
            // more content, so it drops below a finger held still.
            XCTExpectFailure("UIKit's indicator drops away from a still finger as older rows join", options: .nonStrict(), failingBlock: assertFingerOnIt)
        } else {
            assertFingerOnIt()
        }
        state = probe(app, timeout: 3) { !(($0["decelerating"] as? Bool) ?? true) && self.number($0["actualAlpha"]) > 0.5 }
        assertIndicatorMatches(state, "\(label) after the drag")
    }

    func testDraggingTheIndicatorKeepsItUnderTheFinger() throws {
        try dragIndicator(to: 0.5, hold: 0.5, label: "halfway")
    }

    func testHoldingTheIndicatorAtTheTopAsOlderRowsJoin() throws {
        try dragIndicator(to: 1, hold: 3, label: "top", expectsOlderRows: true)
    }

    func testOnItsSideTheIndicatorClearsTheSafeArea() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = launch(["-fixture", "long", "-flash"])
        let state = probe(app) { self.filled($0) && self.number($0["actualAlpha"]) > 0.5 && (self.number(($0["window"] as? [NSNumber])?.first) > self.number(($0["window"] as? [NSNumber])?.last)) }
        attach("landscape", state)
        let safe = try XCTUnwrap(state["safeArea"] as? [NSNumber]).map { CGFloat($0.doubleValue) }
        let insets = try XCTUnwrap(state["indicatorInsets"] as? [NSNumber]).map { CGFloat($0.doubleValue) }
        XCTAssertEqual(insets[2], safe[3], accuracy: 0.5, "the indicator's side clears the safe area")
        assertIndicatorMatches(state, "landscape at rest")
    }
}

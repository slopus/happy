#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
@testable import HappyUI
import Darwin
import UIKit

/// QA only (`-qaScript keyboard`): drags the keyboard down with a finger
/// made inside the app, for a device where UI automation can't start. The
/// finger is a digitizer event put on UIKit's own event queue, so hit
/// testing, the list's gestures, the system's interactive dismissal and
/// UltraView's keyboard controller all see it as they would a person's.
///
/// Each gesture starts on the list above the dock, moves at a fixed speed
/// and lets go: a slow drag to the bottom, a quick flick and a medium one
/// let go partway, and a drag held a third of the way down. Every tick
/// goes to `Documents/qa/<run>-keyboard.csv`: the finger, the keyboard as
/// drawn (its host view's presentation), the dock as drawn, the list's
/// offset, and whether the list had the system's hidden keyboard input.
/// Marks go to `<run>-script.jsonl`.
///
/// The finger moves on a 120 Hz timer, not a display link, so the script
/// asks nothing of the display: the rate a drag is drawn at is the app's
/// own, for a trace to read.
@MainActor
final class ChatKeyboardScript: NSObject {
    private weak var chat: LegacyChatViewController?
    private let marks: URL?
    private let frames: URL?
    private var rows: [String] = []
    private var timer: DispatchSourceTimer?
    private var finger: Finger?
    private var task: Task<Void, Never>?
    private var gesture = ""

    /// A finger moving from `from` to `to` at `speed`, held `hold` seconds,
    /// then lifted.
    private struct Finger {
        var x: CGFloat
        var from: CGFloat
        var to: CGFloat
        var speed: CGFloat
        var hold: Double
        var start: Double
        var down = false
        var lifted = false
        var y: CGFloat
        var done: CheckedContinuation<Void, Never>?
    }

    init(chat: LegacyChatViewController, run: String) {
        self.chat = chat
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appendingPathComponent("qa")
        if let directory { try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        marks = directory?.appendingPathComponent("\(run)-script.jsonl")
        frames = directory?.appendingPathComponent("\(run)-keyboard.csv")
        if let marks { try? Data().write(to: marks) }
        super.init()
        rows = ["t,gesture,phase,fingerY,keyboardTop,keyboardModelTop,dockMinY,offset,driving,systemInput"]
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .nanoseconds(8_333_333), leeway: .nanoseconds(0))
        timer.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.tick() } }
        timer.resume()
        self.timer = timer
        for name in [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardWillHideNotification,
                     UIResponder.keyboardDidHideNotification, UIResponder.keyboardWillShowNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardNotified(_:)), name: name, object: nil)
        }
        task = Task { [weak self] in await self?.run() }
    }

    /// The system's own account of the keyboard's motion.
    @objc private func keyboardNotified(_ notification: Notification) {
        let info = notification.userInfo ?? [:]
        let begin = (info[UIResponder.keyboardFrameBeginUserInfoKey] as? CGRect)?.minY ?? .nan
        let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect)?.minY ?? .nan
        let duration = info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? .nan
        let curve = info[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int ?? -1
        let name = notification.name.rawValue.replacingOccurrences(of: "UIKeyboard", with: "").replacingOccurrences(of: "Notification", with: "")
        mark(String(format: "kb-%@ %@ from=%.1f to=%.1f duration=%.3f curve=%d", name, gesture, begin, end, duration, curve))
    }

    private func mark(_ event: String) {
        guard let marks, let handle = try? FileHandle(forWritingTo: marks) else { return }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data(String(format: "{\"t\":%.6f,\"event\":\"%@\"}\n", CACurrentMediaTime(), event).utf8))
        try? handle.close()
    }

    private func sleep(_ seconds: Double) async { try? await Task.sleep(for: .milliseconds(Int(seconds * 1000))) }

    private func view<T: UIView>(_ type: T.Type) -> T? {
        guard let root = chat?.view else { return nil }
        var stack = [root]
        while let view = stack.popLast() {
            if let match = view as? T { return match }
            stack.append(contentsOf: view.subviews)
        }
        return nil
    }

    private func run() async {
        for _ in 0..<300 {
            if let list = view(ChatListView.self), list.isDisplayReady, !list.plans.isEmpty { break }
            await sleep(0.1)
        }
        await sleep(1.5)
        mark("ready")
        // Which delivery runs and what of it was found, should a system
        // update take the private pieces away.
        mark("touch-\(SyntheticTouch.diagnostics)")
        guard let card = view(AgentInputCardView.self), let window = chat?.view.window,
              let list = view(ChatListView.self) else { return mark("no-composer") }
        let height = window.bounds.height
        // The list's middle, including beside an iPad sidebar.
        let listFrame = list.convert(list.bounds, to: window)
        mark(String(format: "window %.0fx%.0f list %.0f,%.0f %.0fx%.0f", window.bounds.width, height,
                    listFrame.minX, listFrame.minY, listFrame.width, listFrame.height))
        for round in 1...3 {
            // Each gesture moves the keyboard the same way on both renderers:
            // the finger starts on the list 110 points above the dock, reaches
            // the point where it takes the keyboard (the dock's top under
            // UltraView's controller, the keyboard's own top in the system's
            // dismissal), moves it `travel` points (nil: to the bottom) and
            // lets go.
            for (name, speed, travel, hold) in [("slow", 250.0, nil, 0.3), ("flick", 1500.0, 100.0, 0.0),
                                                ("medium", 800.0, 150.0, 0.0), ("return", 300.0, 80.0, 0.4)] as [(String, CGFloat, CGFloat?, Double)] {
                card.textView.becomeFirstResponder()
                await sleep(1.5)
                guard let dock = view(ChatDockView.self), let keyboard = keyboardFrame()?.presented else { mark("no-keyboard"); continue }
                let dockTop = dock.convert(dock.bounds, to: window).minY
                let takes = chat?.ultraKeyboard?.isAvailable == true ? dockTop : keyboard.minY
                // On its side the list shows little above the keyboard's dock.
                let start = max(listFrame.minY + 4, (chat?.view.safeAreaInsets.top ?? 0) + 4, dockTop - 110)
                let end = takes + (travel ?? (height - 4 - keyboard.minY))
                gesture = "\(name)\(round)"
                let touched = window.hitTest(CGPoint(x: listFrame.midX, y: start), with: nil).map { NSStringFromClass(type(of: $0)) } ?? "nil"
                mark(String(format: "%@-down y=%.1f dock=%.1f on=%@", gesture, start, dockTop, touched))
                await drag(x: listFrame.midX, from: start, to: end, speed: speed, hold: hold)
                mark("\(gesture)-up")
                await sleep(1.2)
                gesture = ""
                flush()
            }
        }
        card.textView.resignFirstResponder()
        await sleep(1)
        mark("done")
        flush()
        timer?.cancel()
        timer = nil
    }

    private func drag(x: CGFloat, from: CGFloat, to: CGFloat, speed: CGFloat, hold: Double) async {
        await withCheckedContinuation { continuation in
            finger = Finger(x: x, from: from, to: to, speed: speed, hold: hold, start: CACurrentMediaTime(), y: from, done: continuation)
        }
    }

    private func tick() {
        let now = CACurrentMediaTime()
        if var finger {
            // The finger lands where it starts, and its motion is timed
            // from there.
            if !finger.down { finger.start = now }
            let travel = abs(finger.to - finger.from), moving = travel / finger.speed
            let elapsed = now - finger.start
            let progress = min(1, CGFloat(elapsed) / max(moving, 0.001))
            finger.y = finger.from + (finger.to - finger.from) * progress
            if !finger.down {
                finger.down = true
                SyntheticTouch.send(.began, at: CGPoint(x: finger.x, y: finger.y), in: chat?.view.window)
            } else if elapsed < Double(moving) + finger.hold {
                SyntheticTouch.send(.moved, at: CGPoint(x: finger.x, y: finger.y), in: chat?.view.window)
            } else {
                finger.lifted = true
                SyntheticTouch.send(.ended, at: CGPoint(x: finger.x, y: finger.y), in: chat?.view.window)
            }
            self.finger = finger.lifted ? nil : finger
            if finger.lifted { finger.done?.resume() }
            record(now, phase: finger.lifted ? "up" : "down", fingerY: finger.y)
        } else if !gesture.isEmpty {
            record(now, phase: "after", fingerY: .nan)
        }
    }

    private func record(_ time: Double, phase: String, fingerY: CGFloat) {
        guard let chat, let window = chat.view.window else { return }
        let keyboard = keyboardFrame()
        let dock = view(ChatDockView.self).map { dock -> CGFloat in
            let shown = (dock.layer.presentation() ?? dock.layer).frame.minY
            return dock.superview?.convert(CGPoint(x: 0, y: shown), to: window).y ?? .nan
        } ?? .nan
        let offset = view(ChatListView.self)?.scrollOffset ?? .nan
        let driving = chat.ultraKeyboard?.isDriving ?? false
        let systemInput = view(ChatListView.self)?.ultra.list.hasKeyboardInput ?? false
        rows.append(String(format: "%.6f,%@,%@,%.2f,%.2f,%.2f,%.2f,%.2f,%d,%d", time, gesture, phase, fingerY,
                           keyboard?.presented.minY ?? .nan, keyboard?.model.minY ?? .nan, dock, offset, driving ? 1 : 0, systemInput ? 1 : 0))
        if rows.count >= 600 { flush() }
    }

    private func flush() {
        guard let frames, !rows.isEmpty else { return }
        let text = rows.joined(separator: "\n") + "\n"
        rows.removeAll()
        if let handle = try? FileHandle(forWritingTo: frames) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(text.utf8))
            try? handle.close()
        } else {
            try? Data(text.utf8).write(to: frames)
        }
    }

    /// The keyboard's host view in the app's window, as drawn and as laid out.
    private func keyboardFrame() -> (presented: CGRect, model: CGRect)? {
        guard let window = chat?.view.window, let scene = window.windowScene else { return nil }
        func named(_ view: UIView, _ suffixes: [String]) -> Bool {
            let name = NSStringFromClass(type(of: view))
            return name.hasPrefix("UI") && suffixes.contains(where: name.hasSuffix)
        }
        func host(in view: UIView) -> UIView? {
            if named(view, ["InputSetHostView"]), !view.isHidden, view.bounds.height > 0 { return view }
            for child in view.subviews { if let found = host(in: child) { return found } }
            return nil
        }
        var windows = scene.windows
        if let delegate = scene.value(forKey: "keyboardSceneDelegate") as? NSObject,
           let keyboardWindow = delegate.value(forKey: "keyboardWindow") as? UIWindow, !windows.contains(keyboardWindow) {
            windows.insert(keyboardWindow, at: 0)
        }
        for keyboardWindow in windows where keyboardWindow !== window && !keyboardWindow.isHidden {
            guard let host = host(in: keyboardWindow) else { continue }
            // Where the host's content is drawn: UltraView's controller
            // moves its bounds' origin, the system its frame.
            // The keyboard's window is in its own scene, and converting
            // between two scenes' windows gives a null rectangle on iOS 27:
            // both windows are untransformed, so offset by their frames.
            let size = host.bounds.size
            func inWindow(_ point: CGPoint) -> CGPoint {
                CGPoint(x: point.x + keyboardWindow.frame.minX - window.frame.minX, y: point.y + keyboardWindow.frame.minY - window.frame.minY)
            }
            let model = CGRect(origin: inWindow(host.convert(CGPoint.zero, to: keyboardWindow)), size: size)
            guard let shown = host.layer.presentation(), let root = keyboardWindow.layer.presentation() else { return (model, model) }
            let presented = CGRect(origin: inWindow(shown.convert(CGPoint.zero, to: root)), size: size)
            return (presented, model)
        }
        if !reportedMissing {
            reportedMissing = true
            mark("no-host-" + windows.map { "\(NSStringFromClass(type(of: $0)))(hidden=\($0.isHidden))" }.joined(separator: ","))
        }
        return nil
    }
    private var reportedMissing = false
}

/// One finger as the digitizer reports it, put on UIKit's event queue
/// (IOKit's HID event functions and UIApplication's `_enqueueHIDEvent:`,
/// both private, found at run time).
@MainActor
enum SyntheticTouch {
    enum Phase { case began, moved, ended }

    private typealias CreateHand = @convention(c) (CFAllocator?, UInt64, UInt32, UInt32, UInt32, UInt32, UInt32,
                                                   Double, Double, Double, Double, Double, UInt8, UInt8, UInt32) -> OpaquePointer?
    private typealias CreateFinger = @convention(c) (CFAllocator?, UInt64, UInt32, UInt32, UInt32, Double, Double, Double, Double, Double,
                                                     Double, Double, Double, Double, Double, UInt8, UInt8, UInt32) -> OpaquePointer?
    private typealias Append = @convention(c) (OpaquePointer, OpaquePointer, UInt32) -> Void
    private typealias SetInteger = @convention(c) (OpaquePointer, UInt32, Int) -> Void
    private typealias SetSender = @convention(c) (OpaquePointer, UInt64) -> Void

    private static let iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW)
    private static func symbol<T>(_ name: String, _ type: T.Type) -> T? {
        dlsym(iokit, name).map { unsafeBitCast($0, to: type) }
    }
    private static let createHand = symbol("IOHIDEventCreateDigitizerEvent", CreateHand.self)
    private static let createFinger = symbol("IOHIDEventCreateDigitizerFingerEventWithQuality", CreateFinger.self)
    private static let append = symbol("IOHIDEventAppendEvent", Append.self)
    private static let setInteger = symbol("IOHIDEventSetIntegerValue", SetInteger.self)
    private static let setSender = symbol("IOHIDEventSetSenderID", SetSender.self)

    // IOHIDEventTypes.h: the digitizer event type, its fields and masks.
    private static let isDisplayIntegrated: UInt32 = (11 << 16) | 25
    private static let range: UInt32 = 1, touch: UInt32 = 2, position: UInt32 = 4
    private static let hand: UInt32 = 3

    /// `-qaTouch hid` puts the event on UIKit's queue; otherwise a touch is
    /// made here and sent through `UIApplication.sendEvent(_:)` with the
    /// event attached, as the gesture system needs.
    private static let enqueues = ProcessInfo.processInfo.arguments.contains("hid")
    private static var current: UITouch?

    static var diagnostics: String {
        let app = UIApplication.shared
        return "\(enqueues ? "hid" : "uitouch") symbols=\([createHand != nil, createFinger != nil, append != nil, setInteger != nil, setSender != nil].map { $0 ? 1 : 0 })"
            + " enqueue=\(app.responds(to: NSSelectorFromString("_enqueueHIDEvent:"))) touchesEvent=\(app.responds(to: NSSelectorFromString("_touchesEvent")))"
    }

    private static func hidEvent(_ phase: Phase, at point: CGPoint) -> AnyObject? {
        guard let createHand, let createFinger, let append, let setInteger, let setSender else { return nil }
        let time = mach_absolute_time()
        let touching: UInt8 = phase == .ended ? 0 : 1
        let mask = phase == .moved ? position : range | touch
        guard let handEvent = createHand(kCFAllocatorDefault, time, hand, 0, 0, mask, 0, 0, 0, 0, 0, 0, 0, touching, 0),
              let fingerEvent = createFinger(kCFAllocatorDefault, time, 1, 2, mask, Double(point.x), Double(point.y), 0, 0, 0,
                                             5, 5, 1, 1, 1, touching, touching, 0) else { return nil }
        setInteger(handEvent, isDisplayIntegrated, 1)
        setSender(handEvent, 0x0000_0001_2345_6789)
        append(handEvent, fingerEvent, 0)
        _ = Unmanaged<AnyObject>.fromOpaque(UnsafeRawPointer(fingerEvent)).takeRetainedValue()
        return Unmanaged<AnyObject>.fromOpaque(UnsafeRawPointer(handEvent)).takeRetainedValue()
    }

    static func send(_ phase: Phase, at point: CGPoint, in window: UIWindow?) {
        guard let window else { return }
        if enqueues {
            guard let event = hidEvent(phase, at: window.convert(point, to: nil)) else { return }
            UIApplication.shared.perform(NSSelectorFromString("_enqueueHIDEvent:"), with: event)
            return
        }
        guard let hid = hidEvent(phase, at: point) else { return }
        let touch: UITouch
        if phase == .began || current == nil {
            touch = UITouch()
            let view = window.hitTest(point, with: nil)
            touch.setValue(window, forKey: "window")
            touch.setValue(view, forKey: "view")
            call(touch, "setTapCount:", int: 1)
            call(touch, "_setIsFirstTouchForView:", bool: true)
            current = touch
        } else {
            touch = current!
        }
        call(touch, "_setLocationInWindow:resetPrevious:", point: point, bool: phase == .began)
        call(touch, "setPhase:", int: phase == .began ? UITouch.Phase.began.rawValue : phase == .moved ? UITouch.Phase.moved.rawValue : UITouch.Phase.ended.rawValue)
        call(touch, "setTimestamp:", double: ProcessInfo.processInfo.systemUptime)
        touch.perform(NSSelectorFromString("_setHidEvent:"), with: hid)
        guard let event = UIApplication.shared.perform(NSSelectorFromString("_touchesEvent"))?.takeUnretainedValue() as? UIEvent else { return }
        event.perform(NSSelectorFromString("_clearTouches"))
        event.perform(NSSelectorFromString("_setHIDEvent:"), with: hid)
        call(event, "_addTouch:forDelayedDelivery:", object: touch, bool: false)
        UIApplication.shared.sendEvent(event)
        if phase == .ended { current = nil }
    }

    private static func call(_ target: NSObject, _ name: String, int value: Int) {
        let selector = NSSelectorFromString(name)
        guard target.responds(to: selector) else { return }
        typealias Function = @convention(c) (NSObject, Selector, Int) -> Void
        unsafeBitCast(target.method(for: selector), to: Function.self)(target, selector, value)
    }
    private static func call(_ target: NSObject, _ name: String, bool value: Bool) {
        let selector = NSSelectorFromString(name)
        guard target.responds(to: selector) else { return }
        typealias Function = @convention(c) (NSObject, Selector, Bool) -> Void
        unsafeBitCast(target.method(for: selector), to: Function.self)(target, selector, value)
    }
    private static func call(_ target: NSObject, _ name: String, double value: Double) {
        let selector = NSSelectorFromString(name)
        guard target.responds(to: selector) else { return }
        typealias Function = @convention(c) (NSObject, Selector, Double) -> Void
        unsafeBitCast(target.method(for: selector), to: Function.self)(target, selector, value)
    }
    private static func call(_ target: NSObject, _ name: String, point: CGPoint, bool: Bool) {
        let selector = NSSelectorFromString(name)
        guard target.responds(to: selector) else { return }
        typealias Function = @convention(c) (NSObject, Selector, CGPoint, Bool) -> Void
        unsafeBitCast(target.method(for: selector), to: Function.self)(target, selector, point, bool)
    }
    private static func call(_ target: NSObject, _ name: String, object: AnyObject, bool: Bool) {
        let selector = NSSelectorFromString(name)
        guard target.responds(to: selector) else { return }
        typealias Function = @convention(c) (NSObject, Selector, AnyObject, Bool) -> Void
        unsafeBitCast(target.method(for: selector), to: Function.self)(target, selector, object, bool)
    }
}
#endif

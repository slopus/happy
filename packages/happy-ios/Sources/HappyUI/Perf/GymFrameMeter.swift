#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Darwin
import QuartzCore
import UIKit
import UltraView

/// The iOS performance gym's meter (`V2_GYM_METER=1`, never in the shipped
/// app): every display frame's interval and the main thread's busy time
/// since the last reset, and the app's memory. It reads as the
/// accessibility value of a near-invisible button in the window's corner,
/// `v2-gym-meter`, which a tap resets; the gym's UI tests
/// (`ScrollPerfGymTests`) tap it before a workload and read it after.
///
/// A frame is late when it comes more than half an interval after it was
/// due; the frames it skipped are dropped, and the time past its due is
/// hitch time, as Instruments' Animation Hitches counts it. Like XCTest's
/// scroll metrics, these count only frames while a scroll view moves
/// (`noteScroll()`), so the UI test's own reads of the screen, which hold
/// the main thread between gestures, don't count; `all*` count every frame.
@MainActor
public final class GymFrameMeter: NSObject {
    public static func installIfAsked(in window: UIWindow) {
        guard ProcessInfo.processInfo.environment["HAPPY_GYM_METER"] == "1", shared == nil else { return }
        let meter = GymFrameMeter(window: window)
        shared = meter
    }

    private(set) static var shared: GymFrameMeter?

    private let button = MeterButton()
    private let run = UIButton()
    private var script: GymScroll?
    private var link: CADisplayLink?
    private var observer: CFRunLoopObserver?
    private var intervals: [Double] = []
    private var allIntervals: [Double] = []
    private var lastScroll: CFTimeInterval = 0
    /// Transcript applies (`noteApply`): when the one waiting for its frame
    /// started, and each one's time until that frame.
    private var applyStart: CFTimeInterval?
    private var applies: [Double] = []
    private var applyRows = 0
    /// A scroll view moved during the frame before this one.
    private var moving = false
    private var busyPerFrame: [Double] = []
    private var budget: Double = 1.0 / 60
    private var last: CFTimeInterval?
    private var busyStart: CFTimeInterval?
    private var busy: Double = 0
    private var longestBusy: Double = 0
    private var started = CACurrentMediaTime()
    private var peakFootprint: Double = 0
    private var scriptPoints: Double = 0

    private init(window: UIWindow) {
        super.init()
        button.meter = self
        button.accessibilityIdentifier = "gym-meter"
        button.alpha = 0.02
        button.backgroundColor = .black
        button.addTarget(self, action: #selector(reset), for: .touchUpInside)
        window.addSubview(button)
        button.frame = CGRect(x: 0, y: window.bounds.height - 8, width: 8, height: 8)
        button.autoresizingMask = [.flexibleTopMargin, .flexibleRightMargin]
        run.accessibilityIdentifier = "gym-run"
        run.alpha = 0.02
        run.backgroundColor = .black
        run.addTarget(self, action: #selector(runScript), for: .touchUpInside)
        window.addSubview(run)
        run.frame = CGRect(x: 0, y: window.bounds.height - 20, width: 8, height: 8)
        run.autoresizingMask = [.flexibleTopMargin, .flexibleRightMargin]
        keepOnTop(window)
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { [weak self] _, activity in
            MainActor.assumeIsolated { self?.runLoop(activity) }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        self.observer = observer
        // The gym's driver on the Mac posts these (`notifyutil -p` in the
        // simulator): no touch, nothing read off the screen.
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        for name in [Self.resetNotification, Self.runNotification] {
            CFNotificationCenterAddObserver(center, nil, { _, _, name, _, _ in
                let name = name?.rawValue as String?
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        if name == GymFrameMeter.runNotification { GymFrameMeter.shared?.runScript() } else { GymFrameMeter.shared?.reset() }
                    }
                }
            }, name as CFString, nil, .deliverImmediately)
        }
    }

    nonisolated static let resetNotification = "com.slopus.happy.gym.reset"
    nonisolated static let runNotification = "com.slopus.happy.gym.run"

    private func keepOnTop(_ window: UIWindow) {
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self, weak window] _ in
            MainActor.assumeIsolated {
                guard let self, let window else { return }
                if window.subviews.last !== self.button {
                    window.bringSubviewToFront(self.run)
                    window.bringSubviewToFront(self.button)
                }
            }
        }
    }

    private func runLoop(_ activity: CFRunLoopActivity) {
        let now = CACurrentMediaTime()
        if activity == .afterWaiting {
            busyStart = now
        } else if let start = busyStart {
            busy += now - start
            longestBusy = max(longestBusy, now - start)
            busyStart = nil
        }
    }

    @objc private func tick(_ link: CADisplayLink) {
        if let script, !script.step(link) { self.script = nil }
        Self.scrolling = script?.moving ?? false
        let interval = link.targetTimestamp - link.timestamp
        if interval > 0 { budget = interval }
        // The busy time up to this frame, the current turn's so far included.
        let now = CACurrentMediaTime()
        let open = busyStart.map { now - $0 } ?? 0
        if let start = applyStart {
            applies.append(now - start)
            applyStart = nil
        }
        if let last {
            let interval = link.timestamp - last
            allIntervals.append(interval)
            // In motion when this frame was due: scrolled during the frame
            // before. The first frame of a gesture, after the screen sat
            // still, doesn't count.
            if moving {
                intervals.append(interval)
                busyPerFrame.append(busy + open)
            }
            moving = lastScroll > last
        }
        last = link.timestamp
        busy = -open
    }

    /// The transcript is about to apply new rows (`rows` of them now):
    /// timed until the frame that shows them, its layout, drawing and
    /// commit included.
    public static func noteApply(rows: Int, changed: Int) {
        guard let shared else { return }
        if shared.applyStart == nil { shared.applyStart = CACurrentMediaTime() }
        shared.applyRows = rows
        shared.applyChanged.append(changed)
    }
    private var applyChanged: [Int] = []

    /// The scripted scroll is moving the transcript: it stands for a glide,
    /// so the screen lets it go where it takes it, as it would a finger's.
    public private(set) static var scrolling = false

    /// A scroll view moved: this frame and the next count.
    public static func noteScroll() {
        shared?.lastScroll = CACurrentMediaTime()
    }

    /// Resets, then scrolls the transcript as `V2_GYM_SCRIPT` says
    /// (`GymScroll`), frame by frame on the display link: the gestures
    /// without XCUITest reading the screen between them.
    @objc private func runScript() {
        reset()
        guard let window = button.window, let scroll = Self.find("transcript", in: window),
              scroll is UIScrollView || scroll is UltraListView else {
            NSLog("GYM_SCRIPT no transcript")
            return
        }
        NSLog("GYM_SCRIPT start %@", ProcessInfo.processInfo.environment["HAPPY_GYM_SCRIPT"] ?? "default")
        script = GymScroll(scroll, ProcessInfo.processInfo.environment["HAPPY_GYM_SCRIPT"] ?? "up*6 down*6") { [weak self] in self?.reset() }
    }

    /// The frontmost view named `id` that shows.
    private static func find(_ id: String, in view: UIView) -> UIView? {
        guard !view.isHidden, view.alpha > 0.01 else { return nil }
        for sub in view.subviews.reversed() { if let found = find(id, in: sub) { return found } }
        return view.accessibilityIdentifier == id ? view : nil
    }

    private static func count(_ view: UIView) -> (views: Int, layers: Int) {
        func layers(_ layer: CALayer) -> Int { 1 + (layer.sublayers ?? []).reduce(0) { $0 + layers($1) } }
        func views(_ view: UIView) -> Int { 1 + view.subviews.reduce(0) { $0 + views($1) } }
        return (views(view), layers(view.layer))
    }

    @objc private func reset() {
        intervals.removeAll(keepingCapacity: true)
        allIntervals.removeAll(keepingCapacity: true)
        applies.removeAll(keepingCapacity: true)
        applyChanged.removeAll(keepingCapacity: true)
        busyPerFrame.removeAll(keepingCapacity: true)
        last = nil
        moving = false
        busy = 0
        longestBusy = 0
        started = CACurrentMediaTime()
        peakFootprint = Self.footprint()
        scriptPoints = 0
    }

    /// `key=value` pairs, milliseconds unless named otherwise.
    fileprivate func summary() -> String {
        let footprint = Self.footprint()
        peakFootprint = max(peakFootprint, footprint)
        let elapsed = CACurrentMediaTime() - started
        var dropped = 0
        var hitch: Double = 0
        var late = 0
        for interval in intervals where interval > budget * 1.5 {
            late += 1
            dropped += Int((interval / budget).rounded()) - 1
            hitch += interval - budget
        }
        func percentile(_ values: [Double], _ p: Double) -> Double {
            guard !values.isEmpty else { return 0 }
            let sorted = values.sorted()
            return sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))]
        }
        let scrolled = intervals.reduce(0, +)
        var allHitch: Double = 0
        var allLate = 0
        for interval in allIntervals where interval > budget * 1.5 {
            allLate += 1
            allHitch += interval - budget
        }
        let pairs: [(String, String)] = [
            ("frames", "\(intervals.count)"),
            ("scriptPoints", String(format: "%.1f", scriptPoints)),
            ("seconds", String(format: "%.2f", elapsed)),
            ("budget", String(format: "%.2f", budget * 1000)),
            ("late", "\(late)"),
            ("dropped", "\(dropped)"),
            ("hitchMs", String(format: "%.1f", hitch * 1000)),
            ("scrollSeconds", String(format: "%.2f", scrolled)),
            // Apple's hitch time ratio: ms of hitch per second of scrolling.
            ("hitchRatio", String(format: "%.2f", scrolled > 0 ? hitch * 1000 / scrolled : 0)),
            ("p50", String(format: "%.2f", percentile(intervals, 0.5) * 1000)),
            ("p95", String(format: "%.2f", percentile(intervals, 0.95) * 1000)),
            ("p99", String(format: "%.2f", percentile(intervals, 0.99) * 1000)),
            ("max", String(format: "%.2f", (intervals.max() ?? 0) * 1000)),
            ("mainP50", String(format: "%.2f", percentile(busyPerFrame, 0.5) * 1000)),
            ("mainP95", String(format: "%.2f", percentile(busyPerFrame, 0.95) * 1000)),
            ("mainMax", String(format: "%.2f", longestBusy * 1000)),
            ("applies", "\(applies.count)"),
            ("applyMax", String(format: "%.1f", (applies.max() ?? 0) * 1000)),
            ("applyTotal", String(format: "%.1f", applies.reduce(0, +) * 1000)),
            ("rows", "\(applyRows)"),
            ("changed", applyChanged.map(String.init).joined(separator: ",")),
            ("allFrames", "\(allIntervals.count)"),
            ("allLate", "\(allLate)"),
            ("allHitchMs", String(format: "%.1f", allHitch * 1000)),
            ("allMax", String(format: "%.2f", (allIntervals.max() ?? 0) * 1000)),
            ("memMB", String(format: "%.1f", footprint)),
            ("peakMB", String(format: "%.1f", peakFootprint)),
        ]
        var extra: [(String, String)] = [("scripting", script == nil ? "0" : "1")]
        if let window = button.window, let transcript = Self.find("transcript", in: window) {
            let counted = Self.count(transcript)
            extra += [("views", "\(counted.views)"), ("layers", "\(counted.layers)")]
        }
        return (pairs + extra).map { "\($0.0)=\($0.1)" }.joined(separator: " ")
    }

    /// The app's physical footprint in MB, as Xcode's memory gauge shows it.
    static func footprint() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Double(info.phys_footprint) / 1_048_576
    }

    /// A scripted scroll: `up` flings back into history, `down` towards
    /// the newest message (from 5000 pt/s, slowing as UIScrollView's normal
    /// deceleration does, until it stops or meets an end), `dragup` and
    /// `dragdown` move 300 pt/s for a second, `top` runs at 40,000 pt/s to
    /// the top, `wait` sits still half a second, `mark` resets the meter;
    /// `x*N` repeats. Every step ends with a quarter second still.
    private final class GymScroll {
        private weak var scroll: UIScrollView?
        private weak var ultra: UltraListView?
        private var translation: Double = 0
        private var steps: [String]
        private var velocity: CGFloat = 0
        private var remaining: CFTimeInterval = 0
        private var still: CFTimeInterval = 0
        private var drag = false
        private var last: CFTimeInterval?
        private let mark: () -> Void
        var moving: Bool { velocity != 0 }

        init(_ scroll: UIView, _ text: String, mark: @escaping () -> Void) {
            self.scroll = scroll as? UIScrollView
            ultra = scroll as? UltraListView
            self.mark = mark
            steps = text.split(separator: " ").flatMap { token -> [String] in
                let parts = token.split(separator: "*")
                let count = parts.count > 1 ? Int(parts[1]) ?? 1 : 1
                return Array(repeating: String(parts[0]), count: count)
            }
        }

        /// One frame; false once the script is over.
        @MainActor func step(_ link: CADisplayLink) -> Bool {
            guard scroll != nil || ultra != nil else { return false }
            // By the clock, as UIScrollView glides: a late frame moves further.
            let dt = min(0.25, last.map { link.timestamp - $0 } ?? link.targetTimestamp - link.timestamp)
            last = link.timestamp
            if still > 0 { still -= dt; return true }
            if velocity == 0 {
                guard !steps.isEmpty else { return false }
                let next = steps.removeFirst()
                switch next {
                case "up": velocity = -5000; drag = false
                case "down": velocity = 5000; drag = false
                case "dragup": velocity = -300; drag = true; remaining = 1
                case "dragdown": velocity = 300; drag = true; remaining = 1
                // Straight up to the first message read, for priming.
                case "top": velocity = -40000; drag = true; remaining = 30
                // What comes before is unmeasured.
                case "mark": mark(); return true
                default: still = 0.5; return true
                }
                translation = 0
                ultra?.receiveScrollInput(.init(time: link.timestamp, phase: .began))
            }
            if let ultra {
                // The list owns a measured window, not a contentSize. Its
                // public input seam moves that window and reports real
                // scrolls to the meter, including newly loaded history.
                let inverted = ultra.contentView.transform.d < 0
                let index = ultra.loadedIndexRange.lowerBound + ultra.loadedIndexRange.count / 2
                let before = ultra.settledFrame(at: index)
                translation += Double(velocity) * dt * (inverted ? 1 : -1)
                GymFrameMeter.scrolling = true
                ultra.receiveScrollInput(.init(time: link.timestamp, phase: .changed,
                                               translation: .init(x: 0, y: translation)))
                if let before, let after = ultra.settledFrame(at: index) {
                    GymFrameMeter.shared?.scriptPoints += abs(after.minY - before.minY)
                }
                let older = velocity < 0
                let hit = inverted ? (older ? ultra.reachedBottom : ultra.reachedTop)
                                   : (older ? ultra.reachedTop : ultra.reachedBottom)
                if drag {
                    remaining -= dt
                    if remaining <= 0 || hit { velocity = 0 }
                } else {
                    velocity *= pow(0.998, CGFloat(dt * 1000))
                    if abs(velocity) < 20 || hit { velocity = 0 }
                }
                if velocity == 0 {
                    ultra.receiveScrollInput(.init(time: link.timestamp, phase: .ended))
                    still = 0.25
                    GymFrameMeter.scrolling = false
                }
                return true
            }
            guard let scroll else { return false }
            let top = -scroll.adjustedContentInset.top
            let bottom = max(top, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
            let previousY = scroll.contentOffset.y
            var y = previousY + velocity * CGFloat(dt)
            let hit = y <= top || y >= bottom
            y = min(max(y, top), bottom)
            // Gliding from its first frame: a run that meets the top at once
            // still asks for the page before, as a glide there does.
            GymFrameMeter.scrolling = true
            scroll.contentOffset.y = y
            GymFrameMeter.shared?.scriptPoints += abs(Double(scroll.contentOffset.y - previousY))
            if drag {
                remaining -= dt
                if remaining <= 0 || hit { velocity = 0 }
            } else {
                velocity *= pow(0.998, CGFloat(dt * 1000))
                if abs(velocity) < 20 || hit { velocity = 0 }
            }
            if velocity == 0 {
                still = 0.25
                // At rest, as a glide ends.
                GymFrameMeter.scrolling = false
                scroll.delegate?.scrollViewDidEndDecelerating?(scroll)
            }
            return true
        }
    }

    private final class MeterButton: UIButton {
        weak var meter: GymFrameMeter?
        override var accessibilityValue: String? {
            get { MainActor.assumeIsolated { meter?.summary() } }
            set {}
        }
    }
}
#endif

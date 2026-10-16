#if canImport(UIKit)
import Foundation
import HappyCore
@testable import HappyUI
import QuartzCore
import UIKit

/// What's New (`-screen whatsnew`) under a navigation controller, timed on
/// the main thread: opening it, and a scroll through it and back.
///
/// - Opening: the screen is pushed three times (the first one cold), each
///   timed from making the controller to the end of `layoutIfNeeded` and
///   then to the end of `CATransaction.flush()`, which draws and commits.
/// - `-autoscroll [points per second]` (4000 by default) then moves the
///   list by its offset on every display frame, to the bottom and back to
///   the top. Each frame times `layoutIfNeeded` alone and then the commit.
///
/// Once done it prints one line, `WHATSNEW_REPORT {json}`, and writes the
/// same JSON to `tmp/whatsnew-report.json` in the app's container. The
/// accessibility element `whatsnew-probe` reads `done` once it is.
@MainActor
final class WhatsNewProbe: NSObject {
    private let window: UIWindow
    private let navigation: UINavigationController
    private let speed: CGFloat?
    private var screen: ChangelogViewController?
    private var link: CADisplayLink?
    private var report: [String: Any] = [:]
    private var opens: [[String: Any]] = []
    private var openStart: CFTimeInterval = 0
    private let element = UIView(frame: CGRect(x: 0, y: 0, width: 2, height: 2))

    // The scroll.
    private var offset: CGFloat = 0
    private var direction: CGFloat = 1
    private var lastTimestamp: CFTimeInterval = 0
    private var nominal: Double = 0
    private var layoutMs: [Double] = []
    private var frameMs: [Double] = []
    private var intervals: [Double] = []
    private var plannedBeforeScroll = 0
    /// How long the main thread ran between waits, while scrolling: every
    /// block, the display link's ticks and the bitmaps landing alike.
    private var busyMs: [Double] = []
    private var busyStart: CFTimeInterval?
    private var observer: CFRunLoopObserver?
    private var offsets: [Double] = []

    init(window: UIWindow, arguments: [String]) {
        self.window = window
        let home = UIViewController()
        home.title = "Settings"
        home.view.backgroundColor = .systemBackground
        navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        if let index = arguments.firstIndex(of: "-autoscroll") {
            let value = arguments.indices.contains(index + 1) ? Double(arguments[index + 1]) : nil
            speed = CGFloat(value ?? 4000)
        } else {
            speed = nil
        }
        super.init()
        window.rootViewController = navigation
        element.isAccessibilityElement = true
        element.accessibilityIdentifier = "whatsnew-probe"
        element.accessibilityValue = "opening"
        element.alpha = 0.02
        window.addSubview(element)
        report["contentSizeCategory"] = window.traitCollection.preferredContentSizeCategory.rawValue
        report["screen"] = [window.bounds.width, window.bounds.height, window.traitCollection.displayScale]
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.open(times: 3) }
    }

    private var list: GroupedListView? {
        screen?.view as? GroupedListView
    }

    /// Pushes the screen `times` times, popping in between.
    private func open(times: Int) {
        if screen != nil {
            navigation.popToRootViewController(animated: false)
            window.layoutIfNeeded()
            CATransaction.flush()
            screen = nil
        }
        #if DEBUG
        MeasureCounters.reset()
        #endif
        let start = CACurrentMediaTime()
        let screen = ChangelogViewController(readMarker: ChangelogReadMarker(storage: InMemoryKeyValueStore()))
        navigation.pushViewController(screen, animated: false)
        window.layoutIfNeeded()
        let laidOut = CACurrentMediaTime()
        CATransaction.flush()
        let committed = CACurrentMediaTime()
        self.screen = screen
        var open: [String: Any] = [
            "layoutMs": (laidOut - start) * 1000,
            "commitMs": (committed - laidOut) * 1000,
            "totalMs": (committed - start) * 1000,
        ]
        #if DEBUG
        for (site, count) in MeasureCounters.snapshot() { open["count." + site] = count }
        #endif
        opens.append(open)
        timePlans(of: screen, pushedAt: start, open: opens.count - 1)
        if times > 1 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.open(times: times - 1) }
        } else {
            report["opens"] = opens
            if let list {
                report["contentHeight"] = list.contentSize.height
                report["sections"] = list.sections.count
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.startScrolling() }
        }
    }

    /// The plan landing after the push: when, and what applying it,
    /// laying out and committing cost on the main thread.
    private func timePlans(of screen: ChangelogViewController, pushedAt start: CFTimeInterval, open index: Int) {
        guard !screen.entryViews.isEmpty else { return }
        #if DEBUG
        let plannedBefore = ChangelogPlan.planned.value
        #endif
        let original = screen.plans.onApply
        var applies: [[String: Double]] = []
        screen.plans.onApply = { [weak self, weak screen] in
            guard let self, let screen else { return }
            let began = CACurrentMediaTime()
            original?()
            screen.view.layoutIfNeeded()
            let laidOut = CACurrentMediaTime()
            CATransaction.flush()
            let committed = CACurrentMediaTime()
            applies.append([
                "sincePushMs": (began - start) * 1000,
                "applyAndLayoutMs": (laidOut - began) * 1000,
                "commitMs": (committed - laidOut) * 1000,
                "planned": Double(screen.entryViews.filter { $0.plan != nil }.count),
            ])
            self.opens[index]["applies"] = applies
            if screen.entryViews.allSatisfy({ $0.plan != nil }) {
                self.opens[index]["allContentMs"] = (committed - start) * 1000
                #if DEBUG
                self.opens[index]["entriesPlanned"] = ChangelogPlan.planned.value - plannedBefore
                #endif
            }
        }
    }

    private func startScrolling() {
        guard speed != nil else { return finish() }
        #if DEBUG
        MeasureCounters.reset()
        plannedBeforeScroll = ChangelogPlan.planned.value
        #endif
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { [weak self] _, activity in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = CACurrentMediaTime()
                if activity == .afterWaiting {
                    self.busyStart = now
                } else if let start = self.busyStart {
                    self.busyMs.append((now - start) * 1000)
                    self.busyStart = nil
                }
            }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        self.observer = observer
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick(_ link: CADisplayLink) {
        guard let list, let speed else { return }
        if nominal == 0 { nominal = (link.targetTimestamp - link.timestamp) * 1000 }
        let elapsed = lastTimestamp == 0 ? link.targetTimestamp - link.timestamp : link.timestamp - lastTimestamp
        if lastTimestamp != 0 { intervals.append(elapsed * 1000) }
        lastTimestamp = link.timestamp
        let maxOffset = max(0, list.contentSize.height - list.bounds.height)
        offset += direction * speed * CGFloat(elapsed)
        var done = false
        if offset >= maxOffset {
            offset = maxOffset
            direction = -1
        } else if offset <= 0, direction < 0 {
            offset = 0
            done = true
        }
        let start = CACurrentMediaTime()
        list.contentOffset.y = offset
        list.layoutIfNeeded()
        let laidOut = CACurrentMediaTime()
        CATransaction.flush()
        let committed = CACurrentMediaTime()
        layoutMs.append((laidOut - start) * 1000)
        frameMs.append((committed - start) * 1000)
        offsets.append(Double(offset))
        if done {
            link.invalidate()
            self.link = nil
            finish()
        }
    }

    private func finish() {
        if let observer {
            CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes)
            self.observer = nil
        }
        report["opens"] = opens
        if let list {
            report["contentHeight"] = list.contentSize.height
            report["sectionHeights"] = list.sections.map { Double($0.frame.height) }
        }
        if !layoutMs.isEmpty {
            report["scroll"] = [
                "speed": Double(speed ?? 0),
                "frames": layoutMs.count,
                "nominalFrameMs": nominal,
                "layoutMs": Self.stats(layoutMs),
                "frameMs": Self.stats(frameMs),
                "intervalMs": Self.stats(intervals),
                // A frame that took longer than one and a half display frames.
                "hitches": intervals.filter { $0 > nominal * 1.5 }.count,
                "framesOverBudget4_2ms": frameMs.filter { $0 > 4.2 }.count,
                "mainBusyMs": Self.stats(busyMs),
                "mainBlocks": busyMs.count,
                "mainBlocksOver4_2ms": busyMs.filter { $0 > 4.2 }.count,
                "mainBlocksOver4_2": busyMs.filter { $0 > 4.2 }.prefix(40).map { ($0 * 10).rounded() / 10 },
                "slowFrames": zip(frameMs, zip(layoutMs, offsets)).filter { $0.0 > 4.2 }.prefix(40).map { [$0.0, $0.1.0, $0.1.1] },
            ] as [String: Any]
        }
        #if DEBUG
        var counters: [String: Int] = MeasureCounters.snapshot()
        counters["entriesPlanned"] = ChangelogPlan.planned.value - plannedBeforeScroll
        counters["drawnEntries"] = screen?.entryViews.filter(\.drawsText).count ?? -1
        report["scrollCounters"] = counters
        #endif
        let data = (try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])) ?? Data()
        let json = String(decoding: data, as: UTF8.self)
        print("WHATSNEW_REPORT \(json)")
        try? data.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("whatsnew-report.json"))
        element.accessibilityValue = "done"
    }

    private static func stats(_ values: [Double]) -> [String: Double] {
        guard !values.isEmpty else { return [:] }
        let sorted = values.sorted()
        func percentile(_ p: Double) -> Double {
            sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))]
        }
        return [
            "median": percentile(0.5),
            "p95": percentile(0.95),
            "max": sorted.last ?? 0,
            "mean": values.reduce(0, +) / Double(values.count),
            "total": values.reduce(0, +),
        ]
    }
}
#endif

#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Desktop's ShimmerText on every surface that has it: one band on one
/// clock, running only where the work runs, stopping off screen, in the
/// background and under Reduce Motion. The last test photographs each
/// surface, light and dark, with the band frozen mid-line.
@MainActor
final class HostedShimmerLabelTests: XCTestCase {
    private var window: UIWindow!
    private var root: UIViewController!

    override func setUp() async throws {
        LegacyFonts.registerBundledFonts()
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        root = UIViewController()
        root.view.backgroundColor = UIColor(Palette.surface)
        window = hostedKeyWindow(in: scene, root: root)
        addTeardownBlock { @MainActor [window] in window?.isHidden = true; previous?.makeKey() }
    }

    override func tearDown() {
        ShimmerClock.shared.reduceMotionOverride = nil
        ShimmerClock.shared.frozenPhase = nil
    }

    private static func all<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
        view.subviews.flatMap { child in ((child as? T).map { [$0] } ?? []) + all(type, in: child) }
    }

    private func label(_ text: String, frame: CGRect) -> ShimmerLabel {
        let label = ShimmerLabel(frame: frame)
        root.view.addSubview(label)
        label.attributedText = NSAttributedString(string: text, attributes: [.font: UIFont.systemFont(ofSize: 17)])
        label.layoutIfNeeded()
        return label
    }

    func testPlainTitleSkipsBandLayoutAndShimmerCanStillStartLater() throws {
        let label = label("A title", frame: CGRect(x: 0, y: 100, width: 300, height: 48))
        XCTAssertNil(label.band.layer.mask?.bounds.nonZero, "a plain title must not measure an unused shimmer band")
        XCTAssertTrue(label.band.isHidden)
        XCTAssertNil(label.sweepBegan)

        label.shimmering = true
        label.layoutIfNeeded()
        XCTAssertFalse(label.band.isHidden)
        let span = try XCTUnwrap(label.band.sweepSpan)
        // The ramp travels two runs: from half a run before the text to half after.
        let run = label.textLabel.textRect(forBounds: label.bounds, limitedToNumberOfLines: 1).width
        XCTAssertEqual(span.from, -run / 2, accuracy: 0.01)
        XCTAssertEqual(span.to, run * 1.5, accuracy: 0.01)
        let began = label.sweepBegan
        label.attributedText = NSAttributedString(string: "A title", attributes: [.font: UIFont.systemFont(ofSize: 17)])
        label.layoutIfNeeded()
        XCTAssertEqual(label.sweepBegan, began, "an equal title must not restart the shimmer")

        label.shimmering = false
        XCTAssertNil(label.sweepBegan)
        XCTAssertTrue(label.band.isHidden)
    }

    func testNeighbouringLabelsKeepOneClock() {
        let first = label("Thinking", frame: CGRect(x: 0, y: 100, width: 300, height: 24))
        let second = label("A much longer title for the same clock", frame: CGRect(x: 0, y: 140, width: 300, height: 24))
        first.shimmering = true
        first.layoutIfNeeded()
        second.shimmering = true
        second.layoutIfNeeded()
        XCTAssertNotNil(first.sweepBegan)
        XCTAssertEqual(first.sweepBegan, second.sweepBegan)
        XCTAssertEqual(first.band.layer.mask?.animation(forKey: "sweep")?.duration, Shimmer.duration)
    }

    func testOffScreenBackgroundAndReduceMotionStopTheBand() {
        let label = label("Working", frame: CGRect(x: 0, y: 100, width: 300, height: 24))
        label.shimmering = true
        label.layoutIfNeeded()
        XCTAssertNotNil(label.sweepBegan)
        label.onScreen = false
        XCTAssertNil(label.sweepBegan)
        label.onScreen = true
        XCTAssertNotNil(label.sweepBegan)
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        XCTAssertNil(label.sweepBegan)
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertNotNil(label.sweepBegan)
        ShimmerClock.shared.reduceMotionOverride = true
        XCTAssertNil(label.sweepBegan)
        XCTAssertTrue(label.band.isHidden)
        ShimmerClock.shared.reduceMotionOverride = false
        XCTAssertNotNil(label.sweepBegan)
        label.removeFromSuperview()
        XCTAssertNil(label.sweepBegan)
    }

    /// `lift` dims the resting letters only while the band can run: asked
    /// for less motion the text is exactly its own colour.
    func testLiftRestsDimmedOnlyWhileItSweeps() throws {
        let label = label("Starting a new chat…", frame: CGRect(x: 0, y: 100, width: 300, height: 24))
        label.textColor = .black
        label.ground = .white
        label.sweep = .lift
        label.shimmering = true
        func ink() throws -> RGBA {
            let color = try XCTUnwrap(label.textLabel.attributedText?.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor)
            return RGBA(color.resolvedColor(with: label.traitCollection))
        }
        XCTAssertEqual(try ink().red, 0.62, accuracy: 0.001)
        ShimmerClock.shared.reduceMotionOverride = true
        XCTAssertEqual(try ink().red, 0, accuracy: 0.001)
    }

    func testTheHeaderStatusShimmersOnlyWhileWorkGoes() {
        let header = ChatHeaderView()
        header.frame = CGRect(x: 0, y: 60, width: 393, height: ChatHeaderLayout.Metrics.height)
        root.view.addSubview(header)
        header.titleView.text = "Fix the login"
        header.status = Strings.HeaderStatus.all[3]
        header.layoutIfNeeded()
        XCTAssertFalse(header.statusSweeps)
        header.statusShimmers = true
        header.layoutIfNeeded()
        XCTAssertTrue(header.statusSweeps)
        header.status = Strings.HeaderStatus.text(.online)
        header.statusShimmers = false
        XCTAssertFalse(header.statusSweeps)
    }

    func testABusyTabShimmersAndAnIdleOneDoesNot() async throws {
        let strip = ChatWorktreeTabStrip(frame: CGRect(x: 0, y: 100, width: 393, height: WorktreeTabStripLayout.Metrics.height))
        root.view.addSubview(strip)
        strip.update(items: [
            .init(id: "a", title: "Busy chat", shimmers: true, blocked: false, unread: false, pending: false),
            .init(id: "b", title: "Idle chat", shimmers: false, blocked: false, unread: false, pending: false),
        ], selectedId: "a")
        func labels() -> [String: ShimmerLabel] {
            Dictionary(Self.all(ShimmerLabel.self, in: strip).map { ($0.string, $0) }, uniquingKeysWith: { $1 })
        }
        for _ in 0..<300 where labels()["Busy chat"]?.band.sweeps != true {
            strip.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(labels()["Busy chat"]?.band.sweeps, true)
        XCTAssertEqual(labels()["Idle chat"]?.band.sweeps, false)
    }

    func testTheWorkingLineShimmersButNotOnAQuestionOrAWait() throws {
        let line = WorkingView(frame: CGRect(x: 16, y: 100, width: 360, height: 24))
        root.view.addSubview(line)
        line.show(Activity(phase: .thinking, startedAt: Date().timeIntervalSince1970 * 1000))
        line.layoutIfNeeded()
        let phase = try XCTUnwrap(Self.all(ShimmerLabel.self, in: line).first)
        XCTAssertTrue(phase.band.sweeps)
        line.show(Activity(phase: .awaitingAnswer, startedAt: nil))
        XCTAssertFalse(phase.band.sweeps)
        line.show(nil)
        XCTAssertFalse(phase.band.sweeps)
    }

    /// Home's rows are bitmaps (UltraView): a working title gets a live band
    /// over it in the overlay, an idle one none.
    func testAWorkingHomeRowGetsABandOverItsDrawnTitle() async throws {
        let environment = await HomeTextEnvironment.make(TextEnvironment(scale: .standard, displayScale: 3))
        func overlay(working: Bool) async -> HomeUltraOverlay {
            let row = Self.session(working: working)
            // Plans are made off the main thread, as home makes them.
            let plan = await Task.detached { HomeRowDrawing.make(.flat(.session(row)), width: 393, grouped: false, selected: false, carded: true, environment: environment, dark: false) }.value
            let overlay = HomeUltraOverlay(plan: plan, style: .brutalist, monochrome: false, pictures: nil)
            root.view.addSubview(overlay)
            return overlay
        }
        let busy = await overlay(working: true)
        let band = try XCTUnwrap(Self.all(ShimmerBand.self, in: busy).first)
        XCTAssertTrue(band.sweeps)
        XCTAssertGreaterThan(band.run.width, 0)
        XCTAssertLessThanOrEqual(band.run.width, band.bounds.width)
        let still = await overlay(working: false)
        XCTAssertTrue(Self.all(ShimmerBand.self, in: still).isEmpty)
    }

    static func session(working: Bool) -> SessionRow {
        SessionRow(
            id: working ? "busy" : "idle", title: working ? "Fix the login redirect" : "Write the release notes",
            projectName: "happy", workspaceName: nil, changes: nil, avatar: SessionAvatar(seed: working ? "busy" : "idle"),
            timestamp: "12:55 PM", lastActivityAt: 0, state: working ? .thinking : .waiting, corner: .timestamp,
            shimmersTitle: working, faded: false, archived: false, isBot: false, showsDivider: true
        )
    }

    // MARK: Evidence

    /// Every surface, light and dark, at three points of one sweep, written
    /// to `TEST_RUNNER_SHIMMER_EVIDENCE` (else the temporary directory).
    func testEvidence() async throws {
        let directory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHIMMER_EVIDENCE"] ?? NSTemporaryDirectory())
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let environment = await HomeTextEnvironment.make(TextEnvironment(scale: .standard, displayScale: 3))
        for dark in [false, true] {
            window.overrideUserInterfaceStyle = dark ? .dark : .light
            for view in root.view.subviews { view.removeFromSuperview() }
            let page = root.view!
            var y: CGFloat = 70

            // Agent home rows: a working task and subtask, an idle task.
            let sidebar = SidebarView(frame: CGRect(x: 0, y: y, width: 393, height: 150))
            page.addSubview(sidebar)
            var task = Row(id: "space:t", nodeId: "t", kind: .space, label: "Voice mode polish", mark: .clay("waveform"), status: .working)
            task.targetKind = "task"
            let sub = Row(id: "session:s", nodeId: "s", kind: .session, depth: 1, label: "Record the waveform", status: .working)
            var idle = Row(id: "space:i", nodeId: "i", kind: .space, label: "Microphone permission copy", mark: .clay("microphone"))
            idle.targetKind = "task"
            _ = sidebar.apply([task, sub, idle])
            y += 160

            // Legacy home (UltraView bitmap + overlay band), busy then idle.
            for working in [true, false] {
                let row = Self.session(working: working)
                let plan = await Task.detached { HomeRowDrawing.make(.flat(.session(row)), width: 393, grouped: false, selected: false, environment: environment, dark: dark) }.value
                let drawn = UIImageView(frame: CGRect(origin: CGPoint(x: 0, y: y), size: plan.size))
                let format = UIGraphicsImageRendererFormat(); format.scale = 3
                drawn.image = UIGraphicsImageRenderer(size: plan.size, format: format).image { plan.draw(in: $0.cgContext) }
                let overlay = HomeUltraOverlay(plan: plan, style: .brutalist, monochrome: false, pictures: nil)
                overlay.frame.origin = .zero
                drawn.addSubview(overlay)
                page.addSubview(drawn)
                y += plan.size.height
            }
            y += 12

            // The chat's header capsule, "Thinking".
            let header = ChatHeaderView()
            header.frame = CGRect(x: 0, y: y, width: 393, height: ChatHeaderLayout.Metrics.height)
            page.addSubview(header)
            header.titleView.text = "Fix the login redirect"
            header.status = Strings.HeaderStatus.all[3]
            header.statusShimmers = true
            y += ChatHeaderLayout.Metrics.height + 12

            // The worktree tab strip: busy open tab, busy tab, idle tab.
            let strip = ChatWorktreeTabStrip(frame: CGRect(x: 0, y: y, width: 393, height: WorktreeTabStripLayout.Metrics.height))
            page.addSubview(strip)
            strip.update(items: [
                .init(id: "a", title: "Fix login", shimmers: true, blocked: false, unread: false, pending: false),
                .init(id: "b", title: "Release notes", shimmers: true, blocked: false, unread: false, pending: false),
                .init(id: "c", title: "Idle chat", shimmers: false, blocked: false, unread: false, pending: false),
            ], selectedId: "a")
            y += WorktreeTabStripLayout.Metrics.height + 16

            // The working line.
            let line = WorkingView(frame: CGRect(x: 16, y: y, width: 360, height: 24))
            page.addSubview(line)
            line.show(Activity(phase: .thinking, startedAt: Date().timeIntervalSince1970 * 1000 - 12_000))
            y += 40

            // The pending chat's "Starting a new chat…" (lift).
            let pending = ShimmerLabel(style: TextStyles.pendingChatTitle)
            pending.sweep = .lift
            pending.string = "Starting a new chat…"
            pending.shimmering = true
            pending.frame = CGRect(x: 16, y: y, width: 360, height: 26)
            page.addSubview(pending)
            y += 40

            // A pending "Submit" (lift, inherit) on its button.
            let button = UIView(frame: CGRect(x: 16, y: y, width: 140, height: 44))
            button.backgroundColor = UIColor(Palette.surfaceHighest)
            button.layer.cornerRadius = 8
            page.addSubview(button)
            let submit = ShimmerLabel()
            submit.sweep = .lift
            submit.textColor = UIColor(Palette.text)
            submit.ground = UIColor(Palette.surfaceHighest)
            submit.alignment = .center
            submit.attributedText = NSAttributedString(string: "Submit", attributes: [.font: UIFont.systemFont(ofSize: 15, weight: .semibold)])
            submit.shimmering = true
            submit.frame = button.bounds
            button.addSubview(submit)

            for _ in 0..<100 {
                page.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(10))
            }
            for phase in [0.35, 0.5, 0.65] {
                ShimmerClock.shared.frozenPhase = phase
                page.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(150))
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let name = "shimmer-\(dark ? "dark" : "light")-\(Int(phase * 100)).png"
                try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent(name))
                let attachment = XCTAttachment(image: image)
                attachment.name = name
                attachment.lifetime = .keepAlways
                add(attachment)
            }
            ShimmerClock.shared.frozenPhase = nil
        }
        print("SHIMMER_EVIDENCE \(directory.path)")
    }
}

private extension CGRect {
    var nonZero: CGRect? { self == .zero ? nil : self }
}
#endif

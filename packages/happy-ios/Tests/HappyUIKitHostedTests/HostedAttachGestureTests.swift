#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import UIKit.UIGestureRecognizerSubclass
import XCTest

/// A pan whose finger the test moves: the sheet's own handler reads it as
/// it reads a real one, translation, speed and all, and what it resets.
private final class ScriptedPan: UIPanGestureRecognizer {
    var y: CGFloat = 0
    var speed: CGFloat = 0
    var point: CGPoint = .zero
    private var scripted: UIGestureRecognizer.State = .possible

    override var state: UIGestureRecognizer.State {
        get { scripted }
        set { scripted = newValue }
    }

    override func translation(in view: UIView?) -> CGPoint { CGPoint(x: 0, y: y) }
    override func setTranslation(_ translation: CGPoint, in view: UIView?) { y = translation.y }
    override func velocity(in view: UIView?) -> CGPoint { CGPoint(x: 0, y: speed) }
    override func location(in view: UIView?) -> CGPoint { point }
}

/// The "+" menu's gestures, Telegram's, driven through the sheet's own
/// handlers frame by frame: rest to expanded and back, away, the grid and
/// the sheet sharing a finger, drag-select over five pictures, the circle
/// against the picture, the guard on picks; the tab bar's frames and its
/// ink in the dark; a fling over 2,000 pictures inside the frame budget.
///
/// `HAPPY_RECORD_PACE` slows the drags for a screen recording.
@MainActor
final class HostedAttachGestureTests: XCTestCase {
    private var window: UIWindow?
    private var root: UIViewController!
    private var gone = 0

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private var pace: Double { ProcessInfo.processInfo.environment["HAPPY_RECORD_PACE"].flatMap(Double.init) ?? 0 }

    /// `plus` stands in for the composer's "+": the sheet grows out of it.
    private func present(_ library: FixtureAttachLibrary = FixtureAttachLibrary(access: .authorized, count: 60), style: UIUserInterfaceStyle = .unspecified, plus: Bool = false) async throws -> AttachSheetViewController {
        root = UIViewController()
        root.view.backgroundColor = .systemBackground
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: root)
        window.overrideUserInterfaceStyle = style
        self.window = window
        let sheet = AttachSheetViewController(limit: 10, library: library, camera: true)
        sheet.onGone = { [weak self] in self?.gone += 1 }
        if plus {
            let button = UIView(frame: CGRect(x: 16, y: window.bounds.height - 34 - 44 - 8, width: 44, height: 44))
            button.backgroundColor = .systemGray5
            button.layer.cornerRadius = 22
            root.view.addSubview(button)
            sheet.button = { [weak button] in button }
        }
        root.present(sheet, animated: false)
        try await Task.sleep(for: .milliseconds(700) + .seconds(pace))
        sheet.view.layoutIfNeeded()
        return sheet
    }

    private func grid(_ sheet: AttachSheetViewController) throws -> UICollectionView {
        try XCTUnwrap(views(sheet.view).first { $0.accessibilityIdentifier == "attach-grid" } as? UICollectionView)
    }

    private func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(views) }

    private func wait(_ seconds: Double = 5, _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "never reached the expected state")
    }

    /// One frame of a finger: `before` runs first, as a scroll view under
    /// the finger would move.
    private func drag(_ sheet: AttachSheetViewController, at point: CGPoint, by steps: [CGFloat], speed: CGFloat, before: ((Int) -> Void)? = nil, each: ((Int) -> Void)? = nil) async throws {
        let pan = ScriptedPan()
        pan.point = point
        pan.state = .began
        sheet.panned(pan)
        for (index, step) in steps.enumerated() {
            before?(index)
            pan.y += step
            pan.state = .changed
            sheet.panned(pan)
            if pan.state != .changed { return }
            each?(index)
            try await Task.sleep(for: .milliseconds(16) + .seconds(pace / 20))
        }
        pan.speed = speed
        pan.state = .ended
        sheet.panned(pan)
    }

    private func middle(_ sheet: AttachSheetViewController) throws -> CGPoint {
        let grid = try grid(sheet)
        let frame = grid.convert(grid.bounds, to: sheet.view)
        return CGPoint(x: frame.midX, y: max(frame.minY, sheet.view.bounds.minY) + 300)
    }

    // MARK: The sheet's drag

    /// At rest a flick up expands it on the spring; a slow pull past half
    /// way down from expanded brings it back to rest.
    func testAFlickUpExpandsAndAPullPastHalfCollapses() async throws {
        let sheet = try await present()
        let layout = try XCTUnwrap(sheet.sheet)
        XCTAssertFalse(sheet.expanded)
        XCTAssertEqual(sheet.top, layout.restTop)
        try await drag(sheet, at: try middle(sheet), by: [-12, -12, -12], speed: -900)
        XCTAssertTrue(sheet.expanded)
        try await Task.sleep(for: .milliseconds(600) + .seconds(pace))
        XCTAssertEqual(sheet.top, layout.expandedTop)
        XCTAssertEqual(sheet.drop, 0)

        // Down 150 of 217 slowly: past half, so to rest.
        try await drag(sheet, at: try middle(sheet), by: Array(repeating: 15, count: 10), speed: 0, each: { [unowned sheet] index in
            XCTAssertEqual(sheet.top, layout.expandedTop + CGFloat(index + 1) * 15, accuracy: 0.5, "the top doesn't follow the finger")
        })
        XCTAssertFalse(sheet.expanded)
        try await Task.sleep(for: .milliseconds(600) + .seconds(pace))
        XCTAssertEqual(sheet.top, layout.restTop)

        // A short pull from rest that isn't past half stays expanded-or-not as it was.
        try await drag(sheet, at: try middle(sheet), by: [8, 8], speed: 0)
        XCTAssertFalse(sheet.expanded)
        XCTAssertEqual(gone, 0)
    }

    /// Down past rest the whole sheet drops; 60 lets it go, with the
    /// finger's speed. A flick down from expanded with nothing dropped also does.
    func testDraggedDownPastRestItGoes() async throws {
        let sheet = try await present()
        let layout = try XCTUnwrap(sheet.sheet)
        try await drag(sheet, at: try middle(sheet), by: Array(repeating: 10, count: 7), speed: 200, each: { [unowned sheet] index in
            XCTAssertEqual(sheet.top, layout.restTop)
            XCTAssertEqual(sheet.drop, CGFloat(index + 1) * 10, accuracy: 0.5, "the sheet doesn't drop with the finger")
        })
        try await wait { self.root.presentedViewController == nil }
        XCTAssertEqual(gone, 1)
    }

    func testABarelyDroppedSheetComesBack() async throws {
        let sheet = try await present()
        let layout = try XCTUnwrap(sheet.sheet)
        try await drag(sheet, at: try middle(sheet), by: [10, 10, 10, 10], speed: 50)
        XCTAssertEqual(sheet.drop, 0)
        XCTAssertEqual(sheet.top, layout.restTop)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertNotNil(root.presentedViewController)
    }

    func testAHardFlickDownFromExpandedGoes() async throws {
        let sheet = try await present()
        sheet.setExpanded(true)
        try await Task.sleep(for: .milliseconds(600))
        try await drag(sheet, at: try middle(sheet), by: [6, 6], speed: 2000)
        try await wait { self.root.presentedViewController == nil }
        XCTAssertEqual(gone, 1)
    }

    /// Expanded over a scrolled grid, a pull down scrolls the grid back to
    /// its top first while the sheet stays; from there the sheet takes the
    /// finger and the grid is held at its top.
    func testTheGridHandsTheFingerToTheSheetAtItsTop() async throws {
        let sheet = try await present()
        let layout = try XCTUnwrap(sheet.sheet)
        sheet.setExpanded(true)
        try await Task.sleep(for: .milliseconds(600))
        let grid = try grid(sheet)
        let top = -grid.adjustedContentInset.top
        grid.contentOffset.y = top + 40
        var trail: [(scrolled: CGFloat, inset: CGFloat)] = []
        try await drag(sheet, at: try middle(sheet), by: Array(repeating: 10, count: 9), speed: 0, before: { _ in
            // The grid's own pan scrolls back up under the finger.
            grid.contentOffset.y = max(top, grid.contentOffset.y - 10)
        }, each: { [unowned sheet] _ in
            trail.append((grid.contentOffset.y - top, sheet.top - layout.expandedTop))
        })
        XCTAssertEqual(trail.map(\.scrolled), [30, 20, 10, 0, 0, 0, 0, 0, 0])
        XCTAssertEqual(trail.map(\.inset), [0, 0, 0, 10, 20, 30, 40, 50, 60], "the sheet moved while the grid scrolled, or jumped when it took over")
        XCTAssertTrue(grid.bounces, "the grid was left not bouncing")
        XCTAssertTrue(sheet.expanded, "a short pull collapsed it")
    }

    /// With pictures picked, a pull that would let the sheet go asks first.
    func testWithPicksAPullAsks() async throws {
        let sheet = try await present()
        sheet.toggle("fixture-0")
        try await drag(sheet, at: try middle(sheet), by: Array(repeating: 10, count: 8), speed: 900)
        try await wait { self.root.presentedViewController?.presentedViewController is UIAlertController }
        XCTAssertNotNil(root.presentedViewController as? AttachSheetViewController, "it went without asking")
        let alert = try XCTUnwrap(root.presentedViewController?.presentedViewController as? UIAlertController)
        XCTAssertEqual(alert.message, Strings.AttachMenu.cancelSelection)
        alert.dismiss(animated: false)
        XCTAssertEqual(sheet.picked, ["fixture-0"])
    }

    /// Escape and close with nothing picked go at once and say so.
    func testCloseWithoutPicksGoesAtOnce() async throws {
        let sheet = try await present()
        _ = sheet.accessibilityPerformEscape()
        try await wait { self.root.presentedViewController == nil }
        XCTAssertEqual(gone, 1)
    }

    /// The sheet's clip as drawn, each frame, in the window's space.
    private func film(_ sheet: AttachSheetViewController, for seconds: Double, while act: () async throws -> Void) async throws -> [CGRect] {
        var frames: [CGRect] = []
        let clip = try XCTUnwrap(views(sheet.view).first { $0.accessibilityIdentifier == "attach-sheet" })
        let recorder = TickRecorder { _ in
            guard let window = clip.window else { return }
            let layer = clip.layer.presentation() ?? clip.layer
            frames.append(layer.convert(layer.bounds, to: window.layer.presentation() ?? window.layer))
        }
        try await act()
        try await Task.sleep(for: .seconds(seconds))
        recorder.stop()
        return frames
    }

    /// Dragged away, the glass sheet goes on from where the finger left it
    /// into the "+": its first frame after the finger lifts is the dropped
    /// one, then it shrinks over frames onto the button.
    func testDraggedAwayItShrinksIntoThePlusFromTheFinger() async throws {
        let sheet = try await present(plus: true)
        let layout = try XCTUnwrap(sheet.sheet)
        let button = try XCTUnwrap(sheet.button?()).frame
        let clip = try XCTUnwrap(views(sheet.view).first { $0.accessibilityIdentifier == "attach-sheet" })
        let start = point(sheet)
        var lifted: CGFloat = 0
        // The "+" and the morph's picture of it, as drawn each frame.
        let plus = try XCTUnwrap(sheet.button?())
        let glyph = try XCTUnwrap(views(sheet.view).first { $0.accessibilityIdentifier == "attach-morph-glyph" })
        var hands: [(plus: Float, glyph: Float, offset: CGFloat)] = []
        let watcher = TickRecorder { _ in
            let plusOpacity = (plus.layer.presentation() ?? plus.layer).opacity
            guard let window = glyph.window else { return hands.append((plusOpacity, 0, 0)) }
            var opacity: Float = 1
            var current: UIView? = glyph
            while let one = current {
                let layer = one.layer.presentation() ?? one.layer
                // The presentation tree only: every view from the same committed frame.
                opacity *= layer.isHidden ? 0 : layer.opacity
                current = one.superview
            }
            let layer = glyph.layer.presentation() ?? glyph.layer
            let frame = layer.convert(layer.bounds, to: window.layer.presentation() ?? window.layer)
            hands.append((plusOpacity, opacity, hypot(frame.midX - button.midX, frame.midY - button.midY)))
        }
        defer { watcher.stop() }
        let frames = try await film(sheet, for: 0.8) {
            try await drag(sheet, at: start, by: Array(repeating: 10, count: 8), speed: 600, each: { _ in
                lifted = clip.convert(clip.bounds, to: nil).minY
            })
        }
        XCTAssertGreaterThan(lifted, layout.restTop + 70, "the sheet didn't follow the finger down")
        try await wait { self.root.presentedViewController == nil }
        let after = frames.drop { $0.minY < lifted - 1 }
        let first = try XCTUnwrap(after.first)
        XCTAssertEqual(first.minY, lifted, accuracy: 30, "the way out didn't start where the finger left it")
        let shrinking = after.filter { $0.width > button.width + 4 && $0.width < first.width - 4 }
        XCTAssertGreaterThanOrEqual(shrinking.count, 4, "it didn't shrink over frames: \(after.prefix(12).map { Int($0.width) })")
        let last = try XCTUnwrap(frames.last)
        XCTAssertEqual(last.midX, button.midX, accuracy: 12)
        XCTAssertEqual(last.midY, button.midY, accuracy: 12)
        XCTAssertEqual(gone, 1)
        // The hand-back: from the frame the morph's "+" is whole, exactly
        // one "+" every frame; the last frame of the morph's is on the
        // button's pixels.
        let whole = try XCTUnwrap(hands.firstIndex { $0.glyph > 0.98 }, "the morph's + never came back whole")
        for (index, hand) in hands[whole...].enumerated() {
            XCTAssertEqual([hand.plus, hand.glyph].filter { $0 > 0.02 }.count, 1, "frame \(index): plus \(hand.plus), morph \(hand.glyph)")
            XCTAssertGreaterThan(max(hand.plus, hand.glyph), 0.98, "frame \(index): the + is faded")
        }
        let handOver = try XCTUnwrap(hands.last { $0.glyph > 0.02 })
        XCTAssertLessThan(handOver.offset, 0.5, "the morph's + is \(handOver.offset) off the button at the hand-over")
        XCTAssertGreaterThan(try XCTUnwrap(hands.last).plus, 0.98)
    }

    private func point(_ sheet: AttachSheetViewController) -> CGPoint {
        CGPoint(x: sheet.view.bounds.midX, y: (sheet.sheet?.restTop ?? 300) + 300)
    }

    // MARK: The grid

    /// Telegram's drag-select: sideways off a picture, then over four more,
    /// down a row and back, picks all five in the order passed; the grid
    /// doesn't scroll meanwhile. From a picked one, the same drag unpicks.
    func testDragSelectPicksFivePicturesInOrder() async throws {
        let sheet = try await present()
        sheet.setExpanded(true)
        try await Task.sleep(for: .milliseconds(600))
        let grid = try grid(sheet)
        func centre(_ index: Int) throws -> CGPoint {
            let frame = try XCTUnwrap(grid.layoutAttributesForItem(at: IndexPath(item: index, section: 0))).frame
            return CGPoint(x: frame.midX, y: frame.midY)
        }
        // Pictures 4, 5, 6 are the third row (under the camera); 7, 8, 9 the fourth.
        let path = [try centre(4), try centre(5), try centre(6), try centre(9), try centre(8)]
        let recognizer = sheet.picking
        recognizer.touched(at: path[0])
        var points: [CGPoint] = []
        for (from, to) in zip(path, path.dropFirst()) {
            for step in 1...6 {
                let t = CGFloat(step) / 6
                points.append(CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
            }
        }
        for point in points {
            recognizer.moved(to: point)
            try await Task.sleep(for: .milliseconds(16) + .seconds(pace / 20))
        }
        XCTAssertFalse(grid.isScrollEnabled, "the grid scrolls under the drag")
        XCTAssertEqual(sheet.picked, ["fixture-4", "fixture-5", "fixture-6", "fixture-9", "fixture-8"])
        recognizer.state = .ended
        try await Task.sleep(for: .milliseconds(100))
        recognizer.reset()
        XCTAssertTrue(grid.isScrollEnabled, "the grid stayed stopped")

        recognizer.touched(at: path[0])
        for point in points.prefix(12) { recognizer.moved(to: point) }
        recognizer.reset()
        XCTAssertEqual(sheet.picked, ["fixture-9", "fixture-8"], "the drag from a picked one didn't unpick")
    }

    /// A drag that goes up or down first is the grid's scroll, and one from
    /// the left edge is the system's.
    func testAnUpDownDragNeverPicks() async throws {
        let sheet = try await present()
        let grid = try grid(sheet)
        let frame = try XCTUnwrap(grid.layoutAttributesForItem(at: IndexPath(item: 4, section: 0))).frame
        let recognizer = sheet.picking
        recognizer.touched(at: CGPoint(x: frame.midX, y: frame.midY))
        recognizer.moved(to: CGPoint(x: frame.midX + 2, y: frame.midY + 8))
        recognizer.moved(to: CGPoint(x: frame.midX + 40, y: frame.midY + 8))
        recognizer.reset()
        recognizer.touched(at: CGPoint(x: 20, y: frame.midY))
        recognizer.moved(to: CGPoint(x: 120, y: frame.midY))
        recognizer.reset()
        XCTAssertEqual(sheet.picked, [])
    }

    /// The circle picks and leaves the preview shut; the picture opens the
    /// preview and picks nothing.
    func testTheCirclePicksAndThePictureOpens() async throws {
        let sheet = try await present()
        let grid = try grid(sheet)
        try await wait { grid.visibleCells.count > 4 }
        let cell = try XCTUnwrap(grid.cellForItem(at: IndexPath(item: 2, section: 0)) as? AttachGridCell)
        cell.check.sendActions(for: .touchUpInside)
        XCTAssertEqual(sheet.picked, ["fixture-2"])
        XCTAssertNil(sheet.presentedViewController)
        let other = try XCTUnwrap(grid.cellForItem(at: IndexPath(item: 3, section: 0)) as? AttachGridCell)
        let open = try XCTUnwrap(other.accessibilityCustomActions?.first { $0.name == Strings.AttachMenu.preview })
        _ = open.actionHandler?(open)
        try await wait { sheet.presentedViewController is AttachPreviewViewController }
        XCTAssertEqual(sheet.picked, ["fixture-2"])
        sheet.presentedViewController?.dismiss(animated: false)
    }

    // MARK: The tab bar

    /// Each tab's glyph and name on its middle to the pixel, the name 15
    /// and two pixels under the glyph's middle; the lens under the chosen
    /// tab, and on the other once it's chosen.
    func testTheTabsAreCentredAndTheLensFollowsTheChoice() async throws {
        let sheet = try await present()
        let panel = sheet.panel
        let pixel = 1 / (window?.screen.scale ?? 3)
        for index in 0..<2 {
            let parts = try XCTUnwrap(panel.tabParts(index))
            XCTAssertEqual(parts.icon.midX, parts.frame.midX, accuracy: pixel, "tab \(index) glyph off centre")
            XCTAssertEqual(parts.title.midX, parts.frame.midX, accuracy: pixel, "tab \(index) name off centre")
            XCTAssertEqual(parts.icon.size, CGSize(width: 30, height: 30))
            XCTAssertEqual(parts.title.minY, parts.icon.midY + 15 + 2 * pixel, accuracy: 0.001)
            XCTAssertLessThanOrEqual(parts.title.maxY, panel.bounds.maxY - 3)
        }
        let gallery = try XCTUnwrap(panel.tabParts(0)).frame
        XCTAssertEqual(panel.lensFrame.midX, gallery.midX, accuracy: 0.5)
        let files = try XCTUnwrap(views(sheet.view).first { $0.accessibilityIdentifier == "attach-tab-files" })
        _ = files.accessibilityActivate()
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(sheet.page, .files)
        XCTAssertEqual(panel.lensFrame.midX, try XCTUnwrap(panel.tabParts(1)).frame.midX, accuracy: 0.5)
    }

    /// As drawn over the sheet's own ground, dark then light: each name
    /// against the glass behind it. In the dark the other tab's white name
    /// reads at 4.5 : 1 or better and the chosen one's accent (Telegram's
    /// #3E88F7 on its lens) at 4 or better; by day the names at 4.5 and the
    /// chosen accent (#0088FF) at 3, as Telegram's own do.
    func testTheTabNamesReadInTheDarkAndByDay() async throws {
        for style in [UIUserInterfaceStyle.dark, .light] {
            let sheet = try await present(FixtureAttachLibrary(access: .authorized, count: 0), style: style)
            let window = try XCTUnwrap(window)
            try await Task.sleep(for: .milliseconds(300))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            let name = style == .dark ? "dark" : "light"
            if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
                try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("attach-tabbar-\(name).png"))
            }
            for index in 0..<2 {
                let title = try XCTUnwrap(sheet.panel.tabParts(index)).title
                let ratio = try contrast(in: image, rect: sheet.panel.convert(title, to: window), scale: window.screen.scale)
                print("attach-contrast: \(name) tab \(index) \(String(format: "%.2f", ratio)):1")
                let floor: CGFloat = index == sheet.panel.selected ? (style == .dark ? 4 : 3) : 4.5
                XCTAssertGreaterThanOrEqual(ratio, floor, "\(name): tab \(index)'s name is \(ratio):1 on its glass")
            }
            sheet.dismiss(animated: false)
            window.isHidden = true
        }
    }

    /// The text's ink against its ground inside `rect`: the luminance most
    /// unlike the median, against the median.
    private func contrast(in image: UIImage, rect: CGRect, scale: CGFloat) throws -> CGFloat {
        let cg = try XCTUnwrap(image.cgImage)
        let pixels = CGRect(x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale).integral
        let crop = try XCTUnwrap(cg.cropping(to: pixels))
        let width = crop.width, height = crop.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(crop, in: CGRect(x: 0, y: 0, width: width, height: height))
        func linear(_ c: UInt8) -> CGFloat {
            let v = CGFloat(c) / 255
            return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        var lums: [CGFloat] = []
        for i in stride(from: 0, to: data.count, by: 4) {
            lums.append(0.2126 * linear(data[i]) + 0.7152 * linear(data[i + 1]) + 0.0722 * linear(data[i + 2]))
        }
        // The ground is most of the box; the ink is whichever end is
        // further from it.
        let sorted = lums.sorted()
        let ground = sorted[sorted.count / 2]
        func ratio(_ ink: CGFloat) -> CGFloat { (max(ground, ink) + 0.05) / (min(ground, ink) + 0.05) }
        return max(ratio(sorted.first ?? ground), ratio(sorted.last ?? ground))
    }

    // MARK: Screens

    /// With `HAPPY_PREVIEW_DIR` set: at rest, expanded and scrolled, three
    /// picked, light and dark.
    func testTheMenusStatesForReview() async throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { throw XCTSkip("no HAPPY_PREVIEW_DIR") }
        for style in [UIUserInterfaceStyle.light, .dark] {
            let name = style == .dark ? "dark" : "light"
            let sheet = try await present(style: style)
            let window = try XCTUnwrap(window)
            func keep(_ state: String) async throws {
                try await Task.sleep(for: .milliseconds(700))
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("attach-\(state)-\(name).png"))
            }
            try await keep("rest")
            sheet.setExpanded(true)
            try await keep("expanded")
            let grid = try grid(sheet)
            grid.contentOffset.y = -grid.adjustedContentInset.top + 160
            try await keep("expanded-scrolled")
            grid.contentOffset.y = -grid.adjustedContentInset.top
            for id in ["fixture-0", "fixture-3", "fixture-1"] { sheet.toggle(id) }
            try await keep("selection")
            sheet.dismiss(animated: false)
            window.isHidden = true
        }
    }

    // MARK: The scroll budget

    /// A fling over 2,000 pictures, with 40 more arriving mid-fling and 3
    /// going: the grid's own work (a batch, a cell, a scroll step) never
    /// takes over 4.2 ms, nor do 99% of the main run loop's passes; the odd
    /// pass the simulator stretches stays inside one 120 Hz frame.
    func testAFlingOverTwoThousandPicturesStaysInBudget() async throws {
        let library = FixtureAttachLibrary(access: .authorized, count: 2000)
        let sheet = try await present(library)
        sheet.setExpanded(true)
        try await Task.sleep(for: .milliseconds(600))
        let grid = try grid(sheet)
        try await wait { grid.numberOfItems(inSection: 0) == 2000 }
        let top = -grid.adjustedContentInset.top
        // Warm the cell pool: a screen down and back.
        grid.contentOffset.y = top + grid.bounds.height
        grid.layoutIfNeeded()
        grid.contentOffset.y = top
        grid.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(300))

        var passes: [CFTimeInterval] = []
        var began: CFTimeInterval = 0
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { _, activity in
            let now = CACurrentMediaTime()
            if activity == .afterWaiting { began = now } else if began > 0 { passes.append(now - began) }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        AttachMenuSignpost.longest = 0
        AttachMenuSignpost.longestByName = [:]
        let batches = grid.numberOfItems(inSection: 0)
        // A fling: 15,000 points a second, slowing as UIKit's does.
        var speed: CGFloat = 15000
        var frame = 0
        var last = CACurrentMediaTime()
        var scrollWorst: CFTimeInterval = 0
        while speed > 300 {
            try await Task.sleep(for: .milliseconds(8))
            let now = CACurrentMediaTime()
            let dt = now - last
            last = now
            speed *= pow(0.999, CGFloat(dt * 1000))
            let maxY = grid.contentSize.height - grid.bounds.height + grid.adjustedContentInset.bottom
            let scrollStart = CACurrentMediaTime()
            grid.contentOffset.y = min(maxY, grid.contentOffset.y + speed * dt)
            grid.layoutIfNeeded()
            scrollWorst = max(scrollWorst, CACurrentMediaTime() - scrollStart)
            frame += 1
            if frame == 40 { library.arrive(40) }
            if frame == 80 { library.remove([5, 6, 7]) }
        }
        try await Task.sleep(for: .milliseconds(300))
        CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes)
        _ = batches
        XCTAssertEqual(grid.numberOfItems(inSection: 0), 2037)
        // The first pass after the observer joins is its own start; skip it.
        let worst = passes.dropFirst().max() ?? 0
        let sorted = passes.sorted()
        let p99 = sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.99))]
        print("attach-fling: frames \(frame), passes \(passes.count), worst \(String(format: "%.2f", worst * 1000)) ms, p99 \(String(format: "%.2f", p99 * 1000)) ms, grid work \(AttachMenuSignpost.longestByName.mapValues { Int($0 * 1_000_000) }) us, batches \(sheet.feed.batches), scroll worst \(String(format: "%.2f", scrollWorst * 1000)) ms, over budget \(passes.filter { $0 > 0.0042 }.map { Int($0 * 1_000_000) }) us")
        XCTAssertLessThanOrEqual(AttachMenuSignpost.longest, TestTime.budget(0.0042), "a grid batch or cell took \(AttachMenuSignpost.longest * 1000) ms")
        XCTAssertLessThanOrEqual(scrollWorst, TestTime.budget(0.0042), "a scroll step took \(scrollWorst * 1000) ms")
        XCTAssertLessThanOrEqual(p99, TestTime.budget(0.0042), "1% of run loop passes took over \(p99 * 1000) ms")
        XCTAssertLessThanOrEqual(worst, TestTime.budget(1.0 / 120), "a run loop pass took \(worst * 1000) ms")
    }
}
#endif

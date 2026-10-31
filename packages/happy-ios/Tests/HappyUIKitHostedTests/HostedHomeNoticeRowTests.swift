#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// "The computer did not answer." is the first row of a computer's home,
/// never a card over its top: it comes in with the list's own animation,
/// the rows under it moving down through the frames between and never
/// covered, and goes the same way. Read further down, the rows on screen
/// don't move at all as it comes or goes above them. VoiceOver reads it.
/// Pictures, light and dark, go to the repository's
/// `.context/evidence/home-notice-row`.
@MainActor
final class HostedHomeNoticeRowTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let evidence: URL? = HostedHomeInsetsTests.evidence.map {
        let folder = $0.deletingLastPathComponent().appendingPathComponent("home-notice-row")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private struct Sample {
        var row: CGRect
        var notice: CGRect?
    }

    func testTheNoticeComesAndGoesAsTheListsFirstRow() async throws {
        let app = try await HomeApp.computer(self)
        defer { withExtendedLifetime(app.coordinator) {} }
        let sidebar = try XCTUnwrap(app.sidebar)
        let home = try XCTUnwrap(app.root.children.compactMap { $0 as? HomeViewController }.first)
        let top = try XCTUnwrap(app.frame(of: "space:0")).minY
        XCTAssertEqual(top, sidebar.contentInsets.top + GroupedSidebarMetrics.contentTop, accuracy: 0.5)
        capture(app.window, "1-without")

        // It comes: the rows move down to make its room, through frames between.
        let arriving = try await watch(sidebar, app.window) { home.applyConnection(Self.snapshot(error: "")) }
        let notice = try XCTUnwrap(noticeView(sidebar))
        XCTAssertEqual(notice.title.text, Strings.unanswered)
        let height = try XCTUnwrap(sidebar.list.settledFrame(at: 0)).height
        XCTAssertEqual(height, notice.item.notice.layout.size.height)
        XCTAssertGreaterThan(height, 40)
        let shown = try XCTUnwrap(app.frame(of: "space:0"))
        XCTAssertEqual(shown.minY, top + height, accuracy: 0.5, "the rows start under the notice")
        let card = notice.convert(notice.item.notice.layout.card, to: app.window)
        XCTAssertEqual(card.minY, sidebar.contentInsets.top, accuracy: 0.5, "the notice stands where the rows started")
        XCTAssertLessThanOrEqual(card.maxY, shown.minY, "the notice covers the first row")
        assertMoves(arriving, from: top, to: top + height, "coming")
        // VoiceOver reads it as the list's first thing.
        XCTAssertTrue(notice.isAccessibilityElement)
        XCTAssertEqual(notice.accessibilityLabel, Strings.unanswered)
        capture(app.window, "2-with-notice")

        // It goes: the rows move back up.
        let leaving = try await watch(sidebar, app.window) { home.applyConnection(Self.snapshot(error: nil)) }
        XCTAssertNil(noticeView(sidebar))
        XCTAssertEqual(try XCTUnwrap(app.frame(of: "space:0")).minY, top, accuracy: 0.5)
        assertMoves(leaving, from: top + height, to: top, "going")

        // Read further down: what is on screen stays exactly where it is.
        sidebar.setContentOffsetY(900)
        try await Task.sleep(for: .milliseconds(200))
        let reading = try XCTUnwrap(sidebar.visibleRows.dropFirst(2).first?.id)
        let before = try XCTUnwrap(app.frame(of: reading))
        for (error, name) in [("The computer refused: no space left.", "above"), (nil, "gone above")] as [(String?, String)] {
            var moved: [CGFloat] = []
            let recorder = TickRecorder { _ in
                if let frame = self.presented(reading, sidebar, app.window) { moved.append(frame.minY - before.minY) }
            }
            home.applyConnection(Self.snapshot(error: error))
            await sidebar.settle()
            try await Task.sleep(for: .milliseconds(450))
            recorder.stop()
            XCTAssertFalse(moved.isEmpty, name)
            XCTAssertLessThanOrEqual(moved.map(abs).max() ?? 0, 0.5, "\(name): the rows on screen moved \(moved)")
            XCTAssertEqual(try XCTUnwrap(app.frame(of: reading)).minY, before.minY, accuracy: 0.5, name)
        }

        // Back at the top with a notice that came while away: it heads the list.
        home.applyConnection(Self.snapshot(error: "The computer refused: no space left."))
        await sidebar.settle()
        try await Task.sleep(for: .milliseconds(400))
        sidebar.setContentOffsetY(-sidebar.contentInsets.top)
        try await Task.sleep(for: .milliseconds(200))
        let longer = try XCTUnwrap(noticeView(sidebar))
        XCTAssertEqual(longer.title.text, "The computer refused: no space left.")
        XCTAssertLessThanOrEqual(longer.convert(longer.item.notice.layout.card, to: app.window).maxY, try XCTUnwrap(app.frame(of: "space:0")).minY)
        capture(app.window, "3-refusal-at-top")
    }

    func testTheNoticeInDark() async throws {
        let app = try await HomeApp.computer(self, style: .dark)
        defer { withExtendedLifetime(app.coordinator) {} }
        let sidebar = try XCTUnwrap(app.sidebar)
        let home = try XCTUnwrap(app.root.children.compactMap { $0 as? HomeViewController }.first)
        capture(app.window, "1-without")
        let arriving = try await watch(sidebar, app.window) { home.applyConnection(Self.snapshot(error: "")) }
        XCTAssertGreaterThan(arriving.count, 3)
        XCTAssertNotNil(noticeView(sidebar))
        capture(app.window, "2-with-notice")
    }

    // MARK: Reading

    private static func snapshot(error: String?) -> HomeSnapshot {
        var snapshot = HomeSnapshot()
        snapshot.loaded = true
        snapshot.rows = HostedHomeInsetsTests.rows
        snapshot.allRows = HostedHomeInsetsTests.rows
        snapshot.error = error
        return snapshot
    }

    private func noticeView(_ sidebar: SidebarList) -> SidebarNoticeView? {
        sidebar.list.loadedItemViews.compactMap { $0 as? SidebarNoticeView }.first
    }

    /// A row's box in the window as it is drawn now, mid-animation too.
    private func presented(_ id: String, _ sidebar: SidebarList, _ window: UIWindow) -> CGRect? {
        guard let index = sidebar.list.items.firstIndex(where: { $0.identity == id }),
              let frame = sidebar.list.presentedFrame(at: index), let view = sidebar.view(for: id) else { return nil }
        return sidebar.list.convert(view.box.offsetBy(dx: frame.minX, dy: frame.minY), to: window)
    }

    /// The notice's card as drawn now, on the list or leaving it (a ghost
    /// the list fades out); nil once nothing of it shows.
    private func presentedNotice(_ sidebar: SidebarList, _ window: UIWindow) -> CGRect? {
        func find(_ view: UIView, _ match: (UIView) -> Bool) -> UIView? {
            if match(view) { return view }
            for child in view.subviews { if let found = find(child, match) { return found } }
            return nil
        }
        guard let windowLayer = window.layer.presentation() else { return nil }
        let card = BannerLayout(width: sidebar.bounds.width, title: .fixed(width: 0, height: 0), detail: nil, button: nil).card
        let drawn = find(sidebar.edge) { ($0 as? SidebarNoticeView).map { !$0.isLeaving } ?? false } as? SidebarNoticeView
        let view = drawn ?? find(sidebar.edge) { $0.accessibilityIdentifier == SidebarNoticeView.leavingIdentifier }
        guard let view, let layer = view.layer.presentation(), layer.opacity > 0.01 else { return nil }
        // The card's own rectangle, whichever draws it: the row or its picture.
        let rect = drawn?.item.notice.layout.card ?? CGRect(x: card.minX, y: 0, width: card.width, height: view.bounds.height - BannerLayout.Metrics.bottom)
        return layer.convert(rect, to: windowLayer)
    }

    /// The first row and the notice on every frame while `change` lands.
    private func watch(_ sidebar: SidebarList, _ window: UIWindow, _ change: () -> Void) async throws -> [Sample] {
        var samples: [Sample] = []
        let recorder = TickRecorder { _ in
            guard let row = self.presented("space:0", sidebar, window) else { return }
            samples.append(Sample(row: row, notice: self.presentedNotice(sidebar, window)))
        }
        change()
        await sidebar.settle()
        try await Task.sleep(for: .milliseconds(450))
        recorder.stop()
        return samples
    }

    /// The first row went from `from` to `to` through frames between, and
    /// the notice never lay over it.
    private func assertMoves(_ samples: [Sample], from: CGFloat, to: CGFloat, _ name: String, line: UInt = #line) {
        let ys = samples.map(\.row.minY)
        XCTAssertEqual(ys.last ?? .nan, to, accuracy: 0.5, "\(name): \(ys)", line: line)
        let between = ys.filter { $0 > min(from, to) + 1 && $0 < max(from, to) - 1 }
        XCTAssertGreaterThanOrEqual(between.count, 3, "\(name): the rows jumped: \(ys)", line: line)
        let sorted = from < to ? ys.sorted() : ys.sorted(by: >)
        XCTAssertEqual(ys, sorted, "\(name): the rows went back and forth: \(ys)", line: line)
        let covered = samples.filter { ($0.notice?.maxY ?? -.infinity) > $0.row.minY + 0.5 }
        XCTAssertTrue(covered.isEmpty, "\(name): the notice lay over the first row: \(covered.map { "\($0.notice!) over \($0.row)" })", line: line)
    }

    private func capture(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let file = "\(name)-\(window.overrideUserInterfaceStyle == .dark ? "dark" : "light")"
        let attachment = XCTAttachment(image: image)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(file).png"))
        }
    }
}
#endif

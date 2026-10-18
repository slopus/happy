#if canImport(UIKit)
@testable import HappyCore
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

@MainActor
private final class ArchiveCaptureView: HomeUltraListView {
    var snapshots: [[HomeUltraRow]] = []
    var archiveTransitions: [Bool] = []
    var waiting: CheckedContinuation<Void, Never>?
    override func apply(rows: [HomeUltraRow]? = nil, top: CGFloat, bottom: CGFloat, archiveToggle: Bool = false) {
        guard let rows else { return }
        archiveTransitions.append(archiveToggle)
        snapshots.append(rows); waiting?.resume(); waiting = nil
    }
    func next() async { await withCheckedContinuation { waiting = $0 } }
}

@MainActor
final class HomeArchiveVisibilityTests: XCTestCase {
    override func setUp() { super.setUp(); Fonts.registerBundledFonts() }

    func testArchiveAppearanceStartsVisibleAndRapidReinsertRestoresFullOpacity() async throws {
        let environment = await HomeTextEnvironment.make(.init(scale: .standard, displayScale: 2))
        let model = models().shown
        let plans = await Task.detached {
            model.rows.map { HomeRowDrawing.make($0, width: 320, grouped: false, selected: false, environment: environment, dark: false) }
        }.value
        let bitmaps = await Task.detached { plans.map(HomeArchiveBitmap.draw) }.value
        let rows = zip(plans, bitmaps).enumerated().map { index, pair in
            HomeUltraRow(identity: "appearance-\(index)", revision: 1, plan: pair.0, makeOverlay: { UIView() }, usesArchiveBitmap: true, archiveBitmap: pair.1)
        }
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 700))
        let controller = UIViewController(); window.rootViewController = controller
        let view = HomeUltraListView(); view.frame = window.bounds; controller.view.addSubview(view)
        window.isHidden = false; view.layoutIfNeeded()
        defer { view.deactivate(); window.isHidden = true }
        view.apply(rows: [rows[0]], top: 0, bottom: 0)
        view.apply(rows: rows, top: 0, bottom: 0, archiveToggle: true)
        let entering = try XCTUnwrap(view.list.loadedItemView(at: 2)?.subviews.last)
        XCTAssertEqual(entering.layer.opacity, 1)
        let fade = try XCTUnwrap(entering.layer.animation(forKey: "home.archive.appear") as? CABasicAnimation)
        XCTAssertEqual((fade.fromValue as? NSNumber)?.doubleValue, 0.12)
        view.apply(rows: [rows[0]], top: 0, bottom: 0, archiveToggle: true)
        XCTAssertLessThan(entering.layer.opacity, 1)
        view.apply(rows: rows, top: 0, bottom: 0, archiveToggle: true)
        let reinserted = try XCTUnwrap(view.list.loadedItemView(at: 2)?.subviews.last)
        XCTAssertEqual(reinserted.layer.opacity, 1, "a rapid reinsert must not retain its departure's dimmed model opacity")
    }

    private func settings(_ hidden: Bool, version: Int = 10, pending: Bool = false) -> HomeArchiveSettings {
        HomeArchiveSettings(SettingsSnapshot(synced: AccountSettingsRecord(version: version, cipher: nil, settings: .object(["hideInactiveSessions": .bool(hidden)])), pending: pending ? ["hideInactiveSessions": .bool(hidden)] : [:]))
    }

    private func models(title: String = "Archived fixture") -> HomeArchiveModels {
        var archived = HomeRowMeasurerTests.session("archived", workspace: nil)
        archived.title = title; archived.archived = true; archived.faded = true
        let hidden = HomeListModel(ids: [.archiveToggle], rows: [.flat(.archiveToggle(hidden: true))], avatarStyle: .gradient, avatarMonochrome: false, grouped: false, offline: nil)
        let shown = HomeListModel(ids: [.archiveToggle, .day(0), .session(archived.id)], rows: [.flat(.archiveToggle(hidden: false)), .flat(.dayHeader(.today)), .flat(.session(archived))], avatarStyle: .gradient, avatarMonochrome: false, grouped: false, offline: nil)
        return HomeArchiveModels(hidden: hidden, shown: shown)
    }

    func testPreparedToggleIsSynchronousAndStaleABAFeedCannotReverseLatestIntent() async throws {
        let environment = await HomeTextEnvironment.make(.init(scale: .standard, displayScale: 3))
        let view = ArchiveCaptureView()
        let adapter = HomeUltraListAdapter(view: view, pictures: nil)
        var models = models()
        adapter.receiveArchiveSettings(settings(true))
        adapter.update(.init(model: models.hidden, width: 393, environment: environment, dark: false, selected: nil, archiveModels: models, viewportHeight: 844))
        await view.next()
        XCTAssertEqual(view.archiveTransitions.last, false)
        let before = view.snapshots.count
        let first = ArchiveVisibilityWriter.Intent(generation: 1, hidden: false)
        let latest = ArchiveVisibilityWriter.Intent(generation: 3, hidden: false)
        adapter.showArchiveIntent(first)
        XCTAssertEqual(view.archiveTransitions.last, true)
        XCTAssertEqual(view.snapshots.count, before + 1, "the tap publishes without awaiting a worker or SQLite")
        let opened = try XCTUnwrap(view.snapshots.last)
        XCTAssertEqual(opened.count, 3)
        XCTAssertTrue(opened[0].selectsOnRelease)
        XCTAssertFalse(opened[1].selectsOnRelease)
        XCTAssertFalse(opened[2].selectsOnRelease)
        for row in opened {
            XCTAssertFalse(row.measuresAsynchronously, "toggle and day header must not hold the mutation for a measurement")
            XCTAssertTrue(row.makeView().isDisplayReady, "the first viewport's actual bitmap is ready in the tap transaction")
        }
        adapter.showArchiveIntent(.init(generation: 2, hidden: true))
        XCTAssertEqual(view.archiveTransitions.last, true)
        adapter.showArchiveIntent(latest)
        adapter.receiveArchiveReceipt(.init(intent: first, baseline: 10, drained: true))
        adapter.receiveArchiveSettings(settings(false, version: 11))
        adapter.receiveArchiveSettings(settings(true, version: 12))
        XCTAssertEqual(adapter.archiveHidden, false, "an older equal-valued A receipt cannot release A→B→A's latest override")
        models = self.models(title: "Newest archived title")
        adapter.update(.init(model: models.hidden, width: 393, environment: environment, dark: false, selected: nil, archiveModels: models, viewportHeight: 844))
        await view.next()
        XCTAssertEqual(adapter.displayedModel, models.shown, "live model changes still land while visibility has a pending intent")
        XCTAssertEqual(view.archiveTransitions.last, false, "ordinary model updates retain the list's normal transition")
        adapter.receiveArchiveReceipt(.init(intent: latest, baseline: 12, drained: true))
        adapter.receiveArchiveSettings(settings(false, version: 13, pending: true))
        adapter.receiveArchiveSettings(settings(true, version: 14))
        XCTAssertEqual(adapter.archiveHidden, false, "a pending delta is not a server acknowledgement")
        adapter.receiveArchiveSettings(settings(false, version: 15))
        adapter.receiveArchiveSettings(settings(true, version: 16))
        XCTAssertEqual(adapter.archiveHidden, true, "after a strong acknowledgement, new remote choices apply normally")
        adapter.deactivate()
    }

    func testTapBeforePreparationRetainsIntentAndFailedLatestWriteRollsBack() async {
        let environment = await HomeTextEnvironment.make(.init(scale: .standard, displayScale: 2))
        let view = ArchiveCaptureView()
        let adapter = HomeUltraListAdapter(view: view, pictures: nil)
        let models = models()
        adapter.receiveArchiveSettings(settings(true))
        let intent = ArchiveVisibilityWriter.Intent(generation: 7, hidden: false)
        adapter.showArchiveIntent(intent)
        adapter.update(.init(model: models.hidden, width: 320, environment: environment, dark: false, selected: nil, archiveModels: models, viewportHeight: 700))
        await view.next()
        XCTAssertEqual(adapter.displayedModel, models.shown)
        var failures = 0
        adapter.onArchivePersistenceFailure = { failures += 1 }
        adapter.receiveArchiveReceipt(.init(intent: intent, baseline: nil, drained: true))
        XCTAssertEqual(failures, 1)
        XCTAssertEqual(adapter.displayedModel, models.hidden)
        adapter.deactivate()
    }

    func testBitmapCacheStaysOneViewportWhenArchivedRowsReorder() async throws {
        let environment = await HomeTextEnvironment.make(.init(scale: .standard, displayScale: 2))
        let view = ArchiveCaptureView()
        let adapter = HomeUltraListAdapter(view: view, pictures: nil)
        let hidden = models().hidden
        let sessions = (0..<50).map { index -> SessionRow in
            var row = HomeRowMeasurerTests.session("archive-\(index)", workspace: nil)
            row.archived = true; row.faded = true; return row
        }
        var firstWarm: HomeUltraRow?
        for offset in [0, 10, 20, 30, 40] {
            let ordered = Array(sessions.dropFirst(offset)) + Array(sessions.prefix(offset))
            var shown = models().shown
            shown.ids = [.archiveToggle, .day(0)] + ordered.map { .session($0.id) }
            shown.rows = [.flat(.archiveToggle(hidden: false)), .flat(.dayHeader(.today))] + ordered.map { .flat(.session($0)) }
            let pair = HomeArchiveModels(hidden: hidden, shown: shown)
            adapter.receiveArchiveSettings(settings(false))
            adapter.update(.init(model: shown, width: 320, environment: environment, dark: false, selected: nil, archiveModels: pair, viewportHeight: 100))
            await view.next()
            XCTAssertLessThanOrEqual(adapter.archiveBitmapCacheCount, 4, "only two controls, a day header and the first archived row fit this warm viewport")
            let rows = try XCTUnwrap(view.snapshots.last)
            if offset == 0 { firstWarm = rows.first { $0.identity == "session:archive-0" } }
            else if let firstWarm, let moved = rows.first(where: { $0.identity == firstWarm.identity }) {
                XCTAssertNil(moved.archiveBitmap, "off-viewport cached owners release their old warm images")
                XCTAssertTrue(moved.isEqual(to: firstWarm), "releasing a cache entry must not reconfigure a still-mounted valid bitmap")
            }
        }
        adapter.deactivate()
        XCTAssertEqual(adapter.archiveBitmapCacheCount, 0)
    }
}
#endif

#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A daemon whose System Monitor reads a busy machine: two minutes of
/// history, eight cores, two volumes, a GPU and a dozen processes, a new
/// sample every read. It can be told to go away, or that the Surface is gone.
actor MonitorDaemon: AgentTransport {
    enum Mode { case live, away, missing }
    let surfaceId: String
    var mode = Mode.live
    private(set) var reads = 0

    init(surfaceId: String) { self.surfaceId = surfaceId }

    func set(_ mode: Mode) { self.mode = mode }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard path == "/v0/surfaces/system-monitor/\(surfaceId)" else { return HTTP1Response(status: 200, body: Data("{}".utf8)) }
        switch mode {
        case .away: throw URLError(.cannotConnectToHost)
        case .missing: return HTTP1Response(status: 404, body: Data(#"{"error":"not_found"}"#.utf8))
        case .live: break
        }
        reads += 1
        return HTTP1Response(status: 200, body: Data(Self.sample(tick: reads).utf8))
    }

    func browserConnection() async throws -> any BrowserStream { throw URLError(.unsupportedURL) }
    func close() async {}

    static func sample(tick: Int) -> String {
        let now = 1_761_998_400_000.0 + Double(tick) * 1000
        func wave(_ i: Int, _ base: Double, _ swing: Double, _ period: Double) -> Double {
            (base + swing * sin(Double(i) / period)).rounded(toPlaces: 1)
        }
        let history = (0..<120).map { i -> String in
            let t = tick + i
            return #"{"sampledAt":\#(now - Double(119 - i) * 1000),"cpuPercent":\#(wave(t, 38, 22, 6)),"memoryUsedBytes":\#(Int(22e9 + 2e9 * sin(Double(t) / 20))),"gpuPercent":\#(wave(t, 18, 12, 9)),"diskReadBytesPerSecond":\#(Int(3e6 + 2.5e6 * sin(Double(t) / 4))),"diskWriteBytesPerSecond":\#(Int(1.2e6 + 1e6 * cos(Double(t) / 5)))}"#
        }
        let cores = (0..<8).map { String(wave(tick + $0 * 3, 40, 38, 3)) }
        let names = [("WindowServer", "_windowserver", 14.2, 1.1e9), ("node", "steve", 9.8, 6.4e8), ("Safari", "steve", 6.1, 2.2e9), ("kernel_task", "root", 4.4, 3.1e9), ("Xcode", "steve", 3.9, 4.6e9), ("swift-frontend", "steve", 3.2, 9e8), ("happy-agent", "steve", 2.7, 3.8e8), ("Finder", "steve", 0.8, 2.1e8), ("mds_stores", "root", 0.6, 1.4e8), ("zsh", "steve", 0, 6e6), ("Slack Helper (Renderer)", "steve", 1.4, 7.7e8), ("launchd", "root", nil, 2.4e7)] as [(String, String, Double?, Double)]
        let processes = names.enumerated().map { index, item -> String in
            let cpu = item.2.map { String(($0 + Double((tick + index) % 3)).rounded(toPlaces: 1)) } ?? "null"
            return #"{"pid":\#(100 + index * 37),"parentPid":1,"name":"\#(item.0)","user":"\#(item.1)","state":"\#(index == 9 ? "sleeping" : "running")","cpuPercent":\#(cpu),"memoryBytes":\#(Int(item.3)),"threads":\#(4 + index * 3),"startedAt":null}"#
        }
        return #"""
        {"sampledAt":\#(now),"intervalMs":1000,
         "host":{"hostname":"Steves-MacBook-Pro","platform":"darwin","arch":"arm64","osName":"macOS 27.0","uptimeSeconds":\#(302_400 + tick)},
         "cpu":{"model":"Apple M3 Max","logicalCores":8,"usagePercent":\#(wave(tick + 119, 38, 22, 6)),"perCoreUsagePercent":[\#(cores.joined(separator: ","))],"loadAverage":[3.1,2.8,2.4],"speedMhz":4050,"temperatureCelsius":null},
         "memory":{"totalBytes":38654705664,"usedBytes":\#(Int(22e9 + 2e9 * sin(Double(tick + 119) / 20))),"availableBytes":14000000000,"cachedBytes":5600000000,"swapTotalBytes":2147483648,"swapUsedBytes":402653184},
         "gpus":[{"name":"Apple M3 Max","vendor":"apple","usagePercent":\#(wave(tick + 119, 18, 12, 9)),"memoryTotalBytes":null,"memoryUsedBytes":null,"temperatureCelsius":null,"powerWatts":7.4}],
         "disks":[{"mountPoint":"/","device":"/dev/disk3s1","fileSystem":"apfs","totalBytes":994662584320,"usedBytes":612000000000,"availableBytes":382662584320},{"mountPoint":"/Volumes/Archive","device":"/dev/disk5s1","fileSystem":"exfat","totalBytes":2000398934016,"usedBytes":1800000000000,"availableBytes":200398934016}],
         "diskIo":{"readBytesPerSecond":3400000,"writeBytesPerSecond":1250000},
         "processes":{"total":612,"threads":2841,"items":[\#(processes.joined(separator: ","))]},
         "history":[\#(history.joined(separator: ","))]}
        """#
    }
}

private extension Double {
    func rounded(toPlaces places: Int) -> Double {
        let scale = pow(10, Double(places))
        return (self * scale).rounded() / scale
    }
}

/// The System Monitor screen over a live machine: its cards and charts,
/// the processes filtered and sorted, a snapshot a second only while it
/// shows, the last sample kept when the computer goes away, a monitor
/// that is gone, and a main thread that never hitches while it runs.
/// Pictures, light and dark, go to `.context/evidence/monitor`.
@MainActor
final class HostedSystemMonitorTests: XCTestCase {
    private var teardown: [() -> Void] = []
    private let surfaceId = "smonitor0000000000000001"

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    override func tearDown() async throws {
        for step in teardown { step() }
        teardown = []
    }

    static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/monitor")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func capture(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "-ipad" : ""
        let file = "\(name)\(device)-\(window.traitCollection.userInterfaceStyle == .dark ? "dark" : "light")"
        let attachment = XCTAttachment(image: image)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(file).png"))
        }
    }

    private func wait(_ what: String, timeout: Duration = .seconds(10), _ done: () async -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !(await done()) {
            guard ContinuousClock.now < deadline else {
                XCTFail("timed out waiting for \(what)")
                throw CancellationError()
            }
            try await Task.sleep(for: .milliseconds(30))
        }
    }

    private struct Opened {
        let window: UIWindow
        let navigation: UINavigationController
        let screen: MonitorViewController
    }

    private func open(_ daemon: MonitorDaemon, style: UIUserInterfaceStyle = .light) async throws -> Opened {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "monitor-test", credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in daemon })
        await account.agentConnections.setForeground(false)
        let connection = try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"monitor-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"native-secret"}"#.utf8)), name: "Studio Mac")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        let screen = try XCTUnwrap(SurfaceScreens.make(session: session, surface: AgentWire.Surface(id: surfaceId, type: "system_monitor", name: "Studio Mac")) as? MonitorViewController)
        let navigation = UINavigationController(rootViewController: UIViewController())
        HeaderBar.apply(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        window.overrideUserInterfaceStyle = style
        navigation.pushViewController(screen, animated: false)
        teardown.append {
            window.isHidden = true
            Session.forget(connection.id)
            Task { try? await account.agentConnections.remove(connection.id) }
        }
        return Opened(window: window, navigation: navigation, screen: screen)
    }

    private func ids(_ screen: MonitorViewController) -> [String] { screen.list.items.map(\.id) }

    private func item(_ screen: MonitorViewController, _ id: String) -> CardItem? { screen.list.items.first { $0.id == id } }

    private func processes(_ screen: MonitorViewController) -> [String] {
        screen.list.items.filter { $0.id.hasPrefix("monitor:process:") }.map(\.accessibilityLabel)
    }

    func testTheMachineLiveInCardsLightAndDark() async throws {
        let daemon = MonitorDaemon(surfaceId: surfaceId)
        let opened = try await open(daemon)
        let screen = opened.screen
        try await wait("a live sample") { self.item(screen, "monitor:host")?.accessibilityValue?.hasPrefix("Live") == true }
        XCTAssertEqual(item(screen, "monitor:host")?.accessibilityLabel, "Steves-MacBook-Pro")
        XCTAssertEqual(item(screen, "monitor:host")?.accessibilityValue?.contains("macOS 27.0 · arm64 · Uptime 3d 12h"), true)
        for id in ["monitor:cpu", "monitor:gpu", "monitor:memory", "monitor:disk", "monitor:processes", "monitor:footer"] {
            XCTAssertNotNil(item(screen, id), id)
        }
        XCTAssertEqual(item(screen, "monitor:cpu")?.accessibilityValue?.hasSuffix(", Apple M3 Max"), true)
        XCTAssertEqual(item(screen, "monitor:memory")?.accessibilityLabel, "Memory")
        XCTAssertEqual(item(screen, "monitor:memory:0")?.accessibilityLabel, "Physical memory used")
        XCTAssertEqual(item(screen, "monitor:disk:2")?.accessibilityLabel, "/")
        XCTAssertEqual(item(screen, "monitor:disk:3")?.accessibilityValue, "186.6 GB free, exfat · 1.8 TB")
        XCTAssertEqual(item(screen, "monitor:processes")?.accessibilityValue, "612 processes · 2,841 threads")
        XCTAssertEqual(processes(screen).count, 12)
        XCTAssertEqual(processes(screen).last, "launchd", "unknown CPU last")
        // A card's rows: its reading first and its last detail last.
        XCTAssertEqual(item(screen, "monitor:cpu")?.place, CardPlace(first: true, last: false))
        XCTAssertEqual(item(screen, "monitor:cpu:2")?.place, CardPlace(first: false, last: true))
        // The charts and bars are drawn, not views: nothing over the reading.
        let cpuDrawing = try XCTUnwrap(item(screen, "monitor:cpu")?.drawing)
        XCTAssertTrue(cpuDrawing.marks.contains { if case .chart(let lines, _) = $0 { return lines[0].values.count == 120 }; return false })
        XCTAssertTrue(cpuDrawing.marks.contains { if case .bars(let values, _, _) = $0 { return values.count == 8 }; return false })

        // Each second the numbers move, and only the rows that changed are new.
        let before = Dictionary(screen.list.items.map { ($0.id, $0.revision) }, uniquingKeysWith: { a, _ in a })
        let reads = await daemon.reads
        try await wait("the next sample") { await daemon.reads > reads + 1 }
        try await Task.sleep(for: .milliseconds(100))
        let after = Dictionary(screen.list.items.map { ($0.id, $0.revision) }, uniquingKeysWith: { a, _ in a })
        XCTAssertNotEqual(before["monitor:cpu"], after["monitor:cpu"])
        XCTAssertEqual(before["monitor:cpu:0"], after["monitor:cpu:0"], "Logical cores didn't change")
        XCTAssertEqual(before["monitor:overview"], after["monitor:overview"])

        capture(opened.window, "monitor")
        opened.window.overrideUserInterfaceStyle = .dark
        try await wait("the dark drawing") { screen.list.items.first?.drawing.dark == true }
        try await Task.sleep(for: .milliseconds(300))
        capture(opened.window, "monitor")

        // The processes' card.
        screen.list.scroll(to: "monitor:processes", animated: false)
        try await Task.sleep(for: .milliseconds(400))
        capture(opened.window, "monitor-processes")
        opened.window.overrideUserInterfaceStyle = .light
        try await wait("the light drawing") { screen.list.items.first?.drawing.dark == false }
        try await Task.sleep(for: .milliseconds(300))
        capture(opened.window, "monitor-processes")
    }

    func testTheProcessesFilterAndSort() async throws {
        let opened = try await open(MonitorDaemon(surfaceId: surfaceId))
        let screen = opened.screen
        try await wait("the processes") { self.processes(screen).count == 12 }
        XCTAssertEqual(processes(screen).first, "WindowServer")

        screen.choose(.name)
        try await wait("by name") { self.processes(screen).first == "Finder" }
        XCTAssertEqual(processes(screen).prefix(3), ["Finder", "happy-agent", "kernel_task"])
        XCTAssertEqual(screen.sortItem.title, "Name ↑")
        XCTAssertEqual(screen.navigationItem.rightBarButtonItem, screen.sortItem)
        XCTAssertNotNil(screen.navigationItem.searchController, "the bar filters")
        screen.choose(.name)
        try await wait("Z to A") { self.processes(screen).first == "zsh" }

        screen.searchController.searchBar.text = "root"
        screen.updateSearchResults(for: screen.searchController)
        try await wait("root's processes") { Set(self.processes(screen)) == ["kernel_task", "mds_stores", "launchd"] }

        screen.searchController.searchBar.text = "nothing-like-this"
        screen.updateSearchResults(for: screen.searchController)
        try await wait("no matches") { self.item(screen, "monitor:processes:none:0")?.accessibilityLabel == Strings.Monitor.noMatches }
        XCTAssertTrue(processes(screen).isEmpty)
    }

    /// Nothing is read while another screen covers it, or the app is away.
    func testItReadsOnlyWhileItShows() async throws {
        let daemon = MonitorDaemon(surfaceId: surfaceId)
        let opened = try await open(daemon)
        try await wait("two reads") { await daemon.reads >= 2 }
        opened.navigation.pushViewController(UIViewController(), animated: false)
        try await Task.sleep(for: .milliseconds(300))
        let hidden = await daemon.reads
        try await Task.sleep(for: .milliseconds(2300))
        let still = await daemon.reads
        XCTAssertEqual(still, hidden, "covered, it reads nothing")
        opened.navigation.popViewController(animated: false)
        try await wait("reading again") { await daemon.reads > hidden }

        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        try await Task.sleep(for: .milliseconds(300))
        let away = await daemon.reads
        try await Task.sleep(for: .milliseconds(2300))
        let awayStill = await daemon.reads
        XCTAssertEqual(awayStill, away, "in the background, it reads nothing")
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        try await wait("back") { await daemon.reads > away }
    }

    /// The computer goes away: the last sample stays, said to be the last.
    func testAComputerAwayKeepsTheLastSample() async throws {
        let daemon = MonitorDaemon(surfaceId: surfaceId)
        let opened = try await open(daemon, style: .dark)
        let screen = opened.screen
        try await wait("a live sample") { self.item(screen, "monitor:host")?.accessibilityValue?.hasPrefix("Live") == true }
        await daemon.set(.away)
        try await wait("reconnecting") { self.item(screen, "monitor:host")?.accessibilityValue?.hasPrefix(Strings.Monitor.status(.reconnecting)) == true }
        XCTAssertEqual(item(screen, "monitor:unreachable")?.accessibilityLabel, Strings.Monitor.unreachable)
        XCTAssertEqual(item(screen, "monitor:processes")?.accessibilityValue, "612 processes · 2,841 threads · Last sample")
        XCTAssertEqual(processes(screen).count, 12)
        try await Task.sleep(for: .milliseconds(300))
        capture(opened.window, "monitor-away")
    }

    func testAMonitorThatIsGoneSaysSo() async throws {
        let daemon = MonitorDaemon(surfaceId: surfaceId)
        await daemon.set(.missing)
        let opened = try await open(daemon)
        try await wait("the note") { self.ids(opened.screen) == ["monitor:note"] }
        XCTAssertEqual(opened.screen.list.items.first?.accessibilityLabel, Strings.Monitor.status(.missing))
    }

    private static func find(_ id: String, in view: UIView) -> UIView? {
        if view.accessibilityIdentifier == id { return view }
        for child in view.subviews { if let found = find(id, in: child) { return found } }
        return nil
    }

    /// A sample a second for four seconds with the list still, then the
    /// frame meter's flings and drags through it while the samples keep
    /// coming: the charts redraw off the main thread, so neither drops
    /// frames for them.
    func testTheMainThreadNeverHitches() async throws {
        setenv("HAPPY_GYM_METER", "1", 1)
        let opened = try await open(MonitorDaemon(surfaceId: surfaceId))
        let screen = opened.screen
        try await wait("the processes") { self.processes(screen).count == 12 }
        var stamps: [CFTimeInterval] = []
        let ticks = TickRecorder { stamps.append($0) }
        try await Task.sleep(for: .seconds(4))
        ticks.stop()
        let idle = zip(stamps.dropFirst(), stamps).map { ($0 - $1) * 1000 }
        let worst = idle.max() ?? 0
        print("MONITOR_PERF idle frames=\(idle.count) worst=\(String(format: "%.1f", worst)) longestApply=\(String(format: "%.2f", screen.longestApply))")
        XCTAssertGreaterThan(idle.count, TestTime.sampled(180))
        XCTAssertLessThan(worst, TestTime.budget(34), "a frame waited \(worst) ms while the samples came in")
        XCTAssertLessThan(screen.longestApply, TestTime.budget(8))

        GymFrameMeter.installIfAsked(in: opened.window)
        let meter = try XCTUnwrap(GymFrameMeter.shared)
        screen.list.list.accessibilityIdentifier = "transcript"
        let button = try XCTUnwrap(Self.find("gym-meter", in: opened.window))
        setenv("HAPPY_GYM_SCRIPT", "down*3 up*3 dragdown*2 dragup*2", 1)
        meter.perform(NSSelectorFromString("runScript"))
        let deadline = ContinuousClock.now + .seconds(60)
        try await Task.sleep(for: .milliseconds(300))
        while button.accessibilityValue?.contains("scripting=1") == true, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        let summary = button.accessibilityValue ?? ""
        print("MONITOR_PERF scroll \(summary)")
        let values = Dictionary(summary.split(separator: " ").compactMap { pair -> (String, Double)? in
            let parts = pair.split(separator: "=")
            guard parts.count == 2, let value = Double(parts[1]) else { return nil }
            return (String(parts[0]), value)
        }, uniquingKeysWith: { a, _ in a })
        XCTAssertGreaterThan(values["frames"] ?? 0, 100, "the list scrolled")
        XCTAssertLessThan(values["allMax"] ?? .infinity, TestTime.budget(50), summary)
        // Apple's "good": under 5 ms of hitch per second of scrolling.
        XCTAssertLessThan(values["hitchRatio"] ?? .infinity, TestTime.budget(5), summary)
        unsetenv("HAPPY_GYM_METER")
    }
}
#endif

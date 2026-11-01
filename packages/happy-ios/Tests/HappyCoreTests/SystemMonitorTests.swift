import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// The API's own example snapshot, with `sampledAt` and a process list
/// the tests choose.
func systemMonitorJSON(sampledAt: Double = 1_760_943_600_000, processes: String? = nil, cpu: Double = 26.05) -> String {
    let items = processes ?? #"[{"pid":1234,"parentPid":1,"name":"node","user":"steve","state":"running","cpuPercent":12.5,"memoryBytes":268435456,"threads":12,"startedAt":1760940000000}]"#
    return #"""
    {"sampledAt":\#(sampledAt),"intervalMs":1000,
     "host":{"hostname":"build-box","platform":"linux","arch":"x64","osName":"Ubuntu 24.04.1 LTS","uptimeSeconds":123456},
     "cpu":{"model":"AMD Ryzen 9 7950X","logicalCores":2,"usagePercent":\#(cpu),"perCoreUsagePercent":[12,40.1],"loadAverage":[1.2,0.9,0.7],"speedMhz":4500,"temperatureCelsius":null},
     "memory":{"totalBytes":34359738368,"usedBytes":8589934592,"availableBytes":25769803776,"cachedBytes":2147483648,"swapTotalBytes":0,"swapUsedBytes":0},
     "gpus":[{"name":"NVIDIA GeForce RTX 4090","vendor":"nvidia","usagePercent":12,"memoryTotalBytes":null,"memoryUsedBytes":null,"temperatureCelsius":45,"powerWatts":60.5}],
     "disks":[{"mountPoint":"/","device":"/dev/nvme0n1p2","fileSystem":"ext4","totalBytes":1000000000000,"usedBytes":400000000000,"availableBytes":600000000000}],
     "diskIo":{"readBytesPerSecond":0,"writeBytesPerSecond":0},
     "processes":{"total":123,"threads":456,"items":\#(items)},
     "history":[{"sampledAt":\#(sampledAt),"cpuPercent":\#(cpu),"memoryUsedBytes":8589934592,"gpuPercent":12,"diskReadBytesPerSecond":0,"diskWriteBytesPerSecond":0}]}
    """#
}

func systemMonitorSample(sampledAt: Double = 1_760_943_600_000, processes: String? = nil, cpu: Double = 26.05) -> SystemMonitorSample {
    try! JSONDecoder().decode(SystemMonitorSample.self, from: Data(systemMonitorJSON(sampledAt: sampledAt, processes: processes, cpu: cpu).utf8))
}

private func process(_ pid: Int, _ name: String, cpu: Double?, memory: Double = 100, user: String? = "steve", state: String? = "running") -> SystemMonitorSample.Process {
    SystemMonitorSample.Process(pid: pid, parentPid: 1, name: name, user: user, state: state, cpuPercent: cpu, memoryBytes: memory, threads: 1, startedAt: nil)
}

final class SystemMonitorTests: XCTestCase {
    func testTheAPIsExampleDecodes() {
        let sample = systemMonitorSample()
        XCTAssertEqual(sample.host.hostname, "build-box")
        XCTAssertEqual(sample.cpu.perCoreUsagePercent, [12, 40.1])
        XCTAssertNil(sample.cpu.temperatureCelsius)
        XCTAssertEqual(sample.gpuPercent, 12)
        XCTAssertNil(sample.gpus[0].memoryTotalBytes)
        XCTAssertEqual(sample.diskUsed, 400_000_000_000)
        XCTAssertEqual(sample.processes?.items.first?.name, "node")
        XCTAssertEqual(sample.history.count, 1)
    }

    /// What a daemon without a measurement sends: nulls, empty lists.
    func testUnmeasuredReadingsAreNil() throws {
        let json = #"{"sampledAt":1,"intervalMs":1000,"host":{"hostname":"h","platform":"win32","arch":"arm64","osName":"Windows","uptimeSeconds":0},"cpu":{"model":"x","logicalCores":0,"usagePercent":null,"perCoreUsagePercent":null,"loadAverage":null,"speedMhz":null,"temperatureCelsius":null},"memory":{"totalBytes":1,"usedBytes":0,"availableBytes":1,"cachedBytes":null,"swapTotalBytes":null,"swapUsedBytes":null},"gpus":[],"disks":[],"diskIo":null,"processes":null,"history":[]}"#
        let sample = try JSONDecoder().decode(SystemMonitorSample.self, from: Data(json.utf8))
        XCTAssertNil(sample.cpu.usagePercent)
        XCTAssertNil(sample.gpuPercent)
        XCTAssertNil(sample.diskIo)
        XCTAssertNil(sample.processes)
        XCTAssertEqual(sample.diskTotal, 0)
    }

    func testTheDesktopsNumbers() {
        XCTAssertEqual(MonitorFormat.bytes(nil), "—")
        XCTAssertEqual(MonitorFormat.bytes(0), "0 B")
        XCTAssertEqual(MonitorFormat.bytes(500), "500 B")
        XCTAssertEqual(MonitorFormat.bytes(1536), "1.5 KB")
        XCTAssertEqual(MonitorFormat.bytes(8_589_934_592), "8 GB")
        XCTAssertEqual(MonitorFormat.bytes(1_073_741_824 * 1.25), "1.3 GB")
        XCTAssertEqual(MonitorFormat.bytes(1_000_000_000_000), "931.3 GB")
        XCTAssertEqual(MonitorFormat.rate(1024), "1 KB/s")
        XCTAssertEqual(MonitorFormat.rate(nil), "—")
        XCTAssertEqual(MonitorFormat.percent(26.05), "26.1%")
        XCTAssertEqual(MonitorFormat.percent(nil), "—")
        XCTAssertEqual(MonitorFormat.temperature(44.6), "45 °C")
        XCTAssertEqual(MonitorFormat.watts(60.5), "60.5 W")
        XCTAssertEqual(MonitorFormat.gigahertz(4500), "4.50 GHz")
        XCTAssertEqual(MonitorFormat.uptime(123_456), "1d 10h")
        XCTAssertEqual(MonitorFormat.uptime(3700), "1h 1m")
        XCTAssertEqual(MonitorFormat.count(12345), "12,345")
        XCTAssertEqual(MonitorFormat.share(1, of: 4), 25)
        XCTAssertNil(MonitorFormat.share(1, of: 0))
    }

    func testLevels() {
        XCTAssertEqual(MonitorLevel.of(nil), .unavailable)
        XCTAssertEqual(MonitorLevel.of(59.9), .calm)
        XCTAssertEqual(MonitorLevel.of(60), .warm)
        XCTAssertEqual(MonitorLevel.of(85), .hot)
    }
}

final class ProcessTableTests: XCTestCase {
    private let items = [
        process(3, "Safari", cpu: 5, memory: 900),
        process(1, "kernel_task", cpu: 20, memory: 10, user: "root"),
        process(2, "node", cpu: nil, memory: 500),
        process(4, "zsh", cpu: 5, memory: 1, state: "sleeping"),
    ]

    func testSortingPutsUnknownLastAndBreaksTiesByPid() {
        let cpu = ProcessTable.sorted(items, by: .standard).map(\.pid)
        XCTAssertEqual(cpu, [1, 3, 4, 2])
        XCTAssertEqual(ProcessTable.sorted(items, by: .init(column: .cpu, descending: false)).map(\.pid), [3, 4, 1, 2])
        XCTAssertEqual(ProcessTable.sorted(items, by: .init(column: .memory, descending: true)).map(\.pid), [3, 2, 1, 4])
        XCTAssertEqual(ProcessTable.sorted(items, by: .init(column: .name, descending: false)).map(\.pid), [1, 2, 3, 4])
        XCTAssertEqual(ProcessTable.sorted(items, by: .init(column: .pid, descending: true)).map(\.pid), [4, 3, 2, 1])
    }

    func testChoosingAColumn() {
        let standard = ProcessTable.Sort.standard
        XCTAssertEqual(standard.choosing(.cpu), .init(column: .cpu, descending: false))
        XCTAssertEqual(standard.choosing(.name), .init(column: .name, descending: false))
        XCTAssertEqual(standard.choosing(.memory), .init(column: .memory, descending: true))
    }

    func testTheFilterMatchesNameUserStateOrPid() {
        XCTAssertEqual(ProcessTable.matching("SAF", in: items).map(\.pid), [3])
        XCTAssertEqual(ProcessTable.matching("root", in: items).map(\.pid), [1])
        XCTAssertEqual(ProcessTable.matching("sleeping", in: items).map(\.pid), [4])
        XCTAssertEqual(ProcessTable.matching("4", in: items).map(\.pid), [4])
        XCTAssertEqual(ProcessTable.matching("steve running", in: items).map(\.pid), [3, 2])
        XCTAssertEqual(ProcessTable.matching(" ", in: items).count, 4)
    }

    /// The order holds while the numbers move, for five seconds; a new
    /// sort or filter applies at once; newcomers go last meanwhile.
    func testTheOrderHoldsForFiveSeconds() {
        var table = ProcessTable()
        XCTAssertEqual(table.rows(items, filter: "", sort: .standard, now: 100).map(\.process.pid), [1, 3, 4, 2])
        var busier = items
        busier[3].cpuPercent = 90
        busier.append(process(9, "new", cpu: 99))
        XCTAssertEqual(table.rows(busier, filter: "", sort: .standard, now: 103).map(\.process.pid), [1, 3, 4, 2, 9])
        XCTAssertEqual(table.rows(Array(busier.dropFirst()), filter: "", sort: .standard, now: 104).map(\.process.pid), [1, 4, 2, 9], "a process gone leaves")
        XCTAssertEqual(table.rows(busier, filter: "", sort: .standard, now: 105).map(\.process.pid), [9, 4, 1, 3, 2])
        XCTAssertEqual(table.rows(busier, filter: "", sort: .init(column: .pid, descending: false), now: 106).map(\.process.pid), [1, 2, 3, 4, 9])
        XCTAssertEqual(table.rows(busier, filter: "sleeping", sort: .init(column: .pid, descending: false), now: 106.5).map(\.process.pid), [4])
    }

    func testEachProcessKeepsAMinuteOfCPU() {
        var table = ProcessTable()
        for second in 0..<70 {
            table.record(systemMonitorSample(sampledAt: Double(second) * 1000, processes: #"[{"pid":7,"parentPid":1,"name":"a","user":null,"state":null,"cpuPercent":\#(second),"memoryBytes":1,"threads":null,"startedAt":null}]"#))
        }
        XCTAssertEqual(table.histories[7]?.count, 60)
        XCTAssertEqual(table.histories[7]?.first, 10)
        XCTAssertEqual(table.histories[7]?.last, 69)
        // The same sample twice counts once; a process gone is forgotten.
        table.record(systemMonitorSample(sampledAt: 69_000, processes: "[]"))
        XCTAssertEqual(table.histories[7]?.count, 60)
        table.record(systemMonitorSample(sampledAt: 70_000, processes: "[]"))
        XCTAssertNil(table.histories[7])
    }

    func testContinuingKeepsTheOrderShownWithNewHistories() {
        var shown = ProcessTable()
        _ = shown.rows(items, filter: "", sort: .standard, now: 10)
        var fresh = ProcessTable()
        fresh.record(systemMonitorSample(sampledAt: 1))
        let table = fresh.continuing(shown)
        XCTAssertEqual(table.order, shown.order)
        XCTAssertEqual(table.orderedAt, 10)
        XCTAssertEqual(table.histories, fresh.histories)
    }
}

final class SystemMonitorFeedTests: XCTestCase {
    private actor Daemon {
        enum Answer { case sample(SystemMonitorSample), fail(Error) }
        var answers: [Answer] = []
        var reads = 0
        var kept: JSONValue?
        func answer(_ list: [Answer]) { answers = list }
        func read() throws -> SystemMonitorSample {
            reads += 1
            let next = answers.count > 1 ? answers.removeFirst() : answers.first ?? .fail(URLError(.cannotConnectToHost))
            switch next {
            case .sample(let sample): return sample
            case .fail(let error): throw error
            }
        }
        func keep(_ value: JSONValue) { kept = value }
    }

    private final class Last: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [SystemMonitorFeed.State] = []
        func add(_ state: SystemMonitorFeed.State) { lock.withLock { all.append(state) } }
        var states: [SystemMonitorFeed.State] { lock.withLock { all } }
        var state: SystemMonitorFeed.State? { states.last }
    }

    private func make(_ daemon: Daemon, kept: JSONValue? = nil) -> SystemMonitorFeed {
        SystemMonitorFeed(
            fetch: { try await daemon.read() },
            sleep: { _ in try await Task.sleep(for: .milliseconds(5)) },
            keep: { await daemon.keep($0) },
            kept: { kept }
        )
    }

    private func watch(_ feed: SystemMonitorFeed) async -> Last {
        let last = Last()
        let states = await feed.states()
        Task { for await state in states { last.add(state) } }
        return last
    }

    private func eventually(_ condition: @escaping () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { return XCTFail("timed out", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    func testItReadsWhileResumedAndStopsWhenPaused() async throws {
        let daemon = Daemon()
        await daemon.answer([.sample(systemMonitorSample())])
        let feed = make(daemon)
        let last = await watch(feed)
        await feed.resume()
        try await eventually { await daemon.reads >= 3 }
        XCTAssertEqual(last.state?.status, .ready)
        XCTAssertEqual(last.state?.sample?.host.hostname, "build-box")
        await feed.pause()
        let paused = await daemon.reads
        try await Task.sleep(for: .milliseconds(80))
        let after = await daemon.reads
        XCTAssertEqual(after, paused, "nothing is read while paused")
        let kept = await daemon.kept
        XCTAssertEqual(kept?["host"]?["hostname"]?.stringValue, "build-box", "the last sample is written down")
        await feed.resume()
        try await eventually { await daemon.reads > paused }
        await feed.stop()
    }

    func testAComputerAwayKeepsTheLastSampleAndRetries() async throws {
        let daemon = Daemon()
        await daemon.answer([.fail(URLError(.cannotConnectToHost)), .sample(systemMonitorSample()), .fail(URLError(.timedOut))])
        let feed = make(daemon)
        let last = await watch(feed)
        await feed.resume()
        try await eventually { last.states.contains { $0.status == .loading && $0.failed } }
        try await eventually { last.state?.status == .reconnecting }
        XCTAssertEqual(last.state?.failed, true)
        XCTAssertEqual(last.state?.sample?.host.hostname, "build-box")
        await feed.stop()
    }

    func testAMissingOrUnsupportedMonitorStopsReading() async throws {
        for (code, status) in [(404, SystemMonitorFeed.Status.missing), (501, .unsupported)] {
            let daemon = Daemon()
            await daemon.answer([.fail(AgentClientError.status(code, code: nil, message: nil))])
            let feed = make(daemon)
            let last = await watch(feed)
            await feed.resume()
            try await eventually { last.state?.status == status }
            try await Task.sleep(for: .milliseconds(50))
            let reads = await daemon.reads
            XCTAssertEqual(reads, 1)
            await feed.stop()
        }
    }

    func testItOpensOnTheSampleKept() async throws {
        let daemon = Daemon()
        await daemon.answer([.fail(URLError(.cannotConnectToHost))])
        let kept = try JSONDecoder().decode(JSONValue.self, from: Data(systemMonitorJSON().utf8))
        let feed = make(daemon, kept: kept)
        let last = await watch(feed)
        await feed.resume()
        try await eventually { last.state?.sample != nil }
        XCTAssertEqual(last.state?.status, .reconnecting)
        await feed.stop()
    }
}

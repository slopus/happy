#if canImport(UIKit)
import Foundation
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What the System Monitor's list derives from: the feed's state and what
/// the screen decides (its width, text size and theme, the filter and sort).
struct MonitorInput: Sendable {
    var state = SystemMonitorFeed.State()
    var filter = ""
    var sort = ProcessTable.Sort.standard
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
    /// Seconds, for the processes' five-second order.
    var now: Double = 0
}

/// The machine overview as card rows, worked out off the main thread from
/// one snapshot: the machine, CPU, graphics, memory and disk, each a
/// reading with its history and its details, then the processes.
enum MonitorListItems {
    private struct Context {
        let input: MonitorInput
        var items: [CardItem] = []
        var hairline: CGFloat { 1 / max(1, input.displayScale) }
        var text: CardFont { CardFont(.regular, MonitorMetrics.textSize, scale: input.scale) }
        var small: CardFont { CardFont(.regular, MonitorMetrics.smallSize, scale: input.scale) }

        func measurable(_ text: String, _ font: CardFont, lines: Int = 1) -> Measurable {
            CardText.measurable(text, font: font, maxLines: lines, scale: input.displayScale)
        }

        func size(_ text: String, _ font: CardFont) -> CGSize {
            CardText.measure(text, font: font, width: 10_000, maxLines: 1, scale: input.displayScale)
        }

        func drawing() -> CardDrawing { CardDrawing(dark: input.dark, displayScale: input.displayScale) }
    }

    nonisolated static func items(_ input: MonitorInput, table: inout ProcessTable) -> [CardItem] {
        guard input.width > 0 else { return [] }
        var context = Context(input: input)
        let state = input.state
        if state.status == .missing || state.status == .unsupported {
            context.items.append(note("monitor:note", Strings.Monitor.status(state.status), input))
            return context.items
        }
        context.items.append(CardItems.heading("monitor:overview", Strings.Monitor.overview, width: input.width, maxWidth: input.maxWidth, afterCard: false, dark: input.dark, displayScale: input.displayScale))
        host(&context)
        if state.failed {
            context.items.append(note("monitor:unreachable", Strings.Monitor.unreachable, input, size: MonitorMetrics.smallSize, padding: 10))
        }
        let sample = state.sample
        cpu(&context, sample)
        gpu(&context, sample)
        memory(&context, sample)
        disk(&context, sample)
        processes(&context, sample, table: &table)
        footer(&context, sample)
        return context.items
    }

    // MARK: Pieces

    private nonisolated static func note(_ id: String, _ text: String, _ input: MonitorInput, size: CGFloat = CardListMetrics.noteSize, padding: CGFloat = 24) -> CardItem {
        CardItems.note(id, text, size: size, padding: padding, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)
    }

    private nonisolated static func gap(_ context: inout Context, _ id: String) {
        let height = GroupedSidebarMetrics.cardGap
        context.items.append(CardItem(id: id, kind: .note, size: CGSize(width: context.input.width, height: height), drawing: context.drawing()))
    }

    private nonisolated static func host(_ context: inout Context) {
        let input = context.input
        let sample = input.state.sample
        let titleFont = CardFont(.semiBold, MonitorMetrics.hostTitleSize, scale: input.scale)
        let title = sample?.host.hostname ?? Strings.Monitor.title
        let meta = sample.map { Strings.Monitor.host(os: $0.host.osName, arch: $0.host.arch, uptime: MonitorFormat.uptime($0.host.uptimeSeconds)) } ?? Strings.Monitor.waitingHost
        let status = Strings.Monitor.shortStatus(input.state.status)
        let layout = MonitorHostLayout(
            width: input.width, maxWidth: input.maxWidth,
            title: context.measurable(title, titleFont, lines: 2), titleLine: CardText.line(titleFont, scale: input.displayScale),
            meta: context.measurable(meta, context.small, lines: 2), status: context.size(status, context.small), scale: input.displayScale
        )
        var drawing = context.drawing()
        drawing.text(title, titleFont, Palette.text, layout.title, wraps: true)
        drawing.text(meta, context.small, Palette.settingsSecondary, layout.meta, wraps: true)
        let live = input.state.status == .ready
        drawing.marks.append(.tile(layout.dot, radius: layout.dot.width / 2, live ? Palette.monitorLive : input.state.status == .loading ? Palette.settingsSecondary : Palette.monitorWarm))
        drawing.text(status, context.small, live ? Palette.monitorLive : Palette.settingsSecondary, layout.status)
        var item = CardItem(id: "monitor:host", kind: .row, size: layout.size, card: layout.card, drawing: drawing)
        item.accessibilityLabel = title
        item.accessibilityValue = "\(Strings.Monitor.status(input.state.status)), \(meta)"
        context.items.append(item)
    }

    /// A resource's reading, opening its card.
    private nonisolated static func summary(_ context: inout Context, id: String, icon: String, tint: (ColorToken, ColorToken), title: String, value: String, subtitle: String, lines: [CardDrawing.ChartLine]?, bars: [Double?]?, last: Bool) {
        let input = context.input
        let titleFont = CardFont(.semiBold, MonitorMetrics.titleSize, scale: input.scale)
        let valueFont = CardFont(.semiBold, MonitorMetrics.valueSize, scale: input.scale)
        let layout = MonitorSummaryLayout(
            width: input.width, maxWidth: input.maxWidth, place: CardPlace(first: true, last: last),
            title: context.measurable(title, titleFont), value: context.measurable(value, valueFont), subtitle: context.measurable(subtitle, context.small),
            chart: lines != nil, bars: bars?.isEmpty == false, hairline: context.hairline, scale: input.displayScale
        )
        var drawing = context.drawing()
        drawing.marks.append(.tile(layout.tile, radius: CardListMetrics.tileRadius, tint.1))
        drawing.icon(.ionicons(icon), size: MonitorMetrics.tileGlyph, tint.0, in: layout.tile)
        drawing.text(title, titleFont, Palette.text, layout.title)
        drawing.text(value, valueFont, Palette.text, layout.value)
        drawing.text(subtitle, context.small, Palette.settingsSecondary, layout.subtitle)
        if let lines, let frame = layout.chart { drawing.marks.append(.chart(lines, frame)) }
        if let bars, let frame = layout.bars { drawing.marks.append(.bars(bars, frame, gap: MonitorMetrics.barGap)) }
        drawing.rule(layout.separator)
        var item = CardItem(id: id, kind: .row, size: layout.size, card: layout.card, place: CardPlace(first: true, last: last), drawing: drawing)
        item.accessibilityLabel = title
        item.accessibilityValue = "\(value), \(subtitle)"
        context.items.append(item)
    }

    private struct Detail {
        var label: String
        var value: String
        var meter: Double?? = nil
        var note: String?
        var dot: ColorToken?
        var quiet = false
    }

    /// A card's details after its reading.
    private nonisolated static func details(_ context: inout Context, id: String, _ details: [Detail]) {
        let input = context.input
        for (index, detail) in details.enumerated() {
            let place = CardPlace(first: false, last: index == details.count - 1)
            let layout = MonitorDetailLayout(
                width: input.width, maxWidth: input.maxWidth, place: place, dot: detail.dot != nil,
                label: context.measurable(detail.label, context.text, lines: detail.quiet ? 0 : 1), value: context.measurable(detail.value, context.text),
                meter: detail.meter != nil, note: detail.note.map { context.measurable($0, context.small) },
                hairline: context.hairline, scale: input.displayScale
            )
            var drawing = context.drawing()
            if let dot = detail.dot, let frame = layout.dot { drawing.marks.append(.tile(frame, radius: frame.width / 2, dot)) }
            drawing.text(detail.label, context.text, detail.quiet ? Palette.settingsSecondary : Palette.text, layout.label, wraps: detail.quiet)
            drawing.text(detail.value, context.text, Palette.settingsSecondary, layout.value)
            if let meter = detail.meter, let frame = layout.meter { drawing.marks.append(.meter(meter, frame)) }
            if let note = detail.note, let frame = layout.note { drawing.text(note, context.small, Palette.settingsSecondary, frame) }
            drawing.rule(layout.separator)
            var item = CardItem(id: "\(id):\(index)", kind: .row, size: layout.size, card: layout.card, place: place, drawing: drawing)
            item.accessibilityLabel = detail.label
            item.accessibilityValue = [detail.value, detail.note].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
            context.items.append(item)
        }
    }

    private nonisolated static func history(_ sample: SystemMonitorSample?, _ value: (SystemMonitorSample.Point) -> Double?, maximum: Double) -> [Double?] {
        (sample?.history ?? []).map { point in value(point).map { $0 / max(1, maximum) } }
    }

    private nonisolated static func cpu(_ context: inout Context, _ sample: SystemMonitorSample?) {
        gap(&context, "monitor:gap:cpu")
        let usage = sample?.cpu.usagePercent
        let line = CardDrawing.ChartLine(values: history(sample, { $0.cpuPercent }, maximum: 100), color: CardDrawing.level(usage))
        let cores = sample?.cpu.perCoreUsagePercent?.map { Optional($0) }
        summary(&context, id: "monitor:cpu", icon: "hardware-chip-outline", tint: (Palette.tileBlue, Palette.tileBlueFill), title: Strings.Monitor.cpu,
                value: sample == nil ? "—" : MonitorFormat.percent(usage), subtitle: sample?.cpu.model ?? Strings.Monitor.waitingCPU, lines: [line], bars: cores, last: false)
        details(&context, id: "monitor:cpu", [
            Detail(label: Strings.Monitor.logicalCores, value: sample.map { String($0.cpu.logicalCores) } ?? "—"),
            Detail(label: Strings.Monitor.frequency, value: MonitorFormat.gigahertz(sample?.cpu.speedMhz)),
            Detail(label: Strings.Monitor.temperature, value: MonitorFormat.temperature(sample?.cpu.temperatureCelsius)),
        ])
    }

    private nonisolated static func gpu(_ context: inout Context, _ sample: SystemMonitorSample?) {
        gap(&context, "monitor:gap:gpu")
        let usage = sample?.gpuPercent
        let names = sample.map { $0.gpus.isEmpty ? Strings.Monitor.noGPU : $0.gpus.map(\.name).joined(separator: " · ") } ?? Strings.Monitor.waitingGPU
        let line = CardDrawing.ChartLine(values: history(sample, { $0.gpuPercent }, maximum: 100), color: CardDrawing.level(usage))
        summary(&context, id: "monitor:gpu", icon: "cube-outline", tint: (Palette.tilePurple, Palette.tilePurpleFill), title: Strings.Monitor.gpu,
                value: MonitorFormat.percent(usage), subtitle: names, lines: [line], bars: nil, last: false)
        var rows: [Detail] = []
        let gpus = sample?.gpus ?? []
        for gpu in gpus {
            if gpus.count > 1 { rows.append(Detail(label: gpu.name, value: MonitorFormat.percent(gpu.usagePercent))) }
            let memory = gpu.memoryTotalBytes == nil ? "—" : "\(MonitorFormat.bytes(gpu.memoryUsedBytes)) / \(MonitorFormat.bytes(gpu.memoryTotalBytes))"
            rows.append(Detail(label: Strings.Monitor.videoMemory, value: memory))
            rows.append(Detail(label: Strings.Monitor.temperature, value: MonitorFormat.temperature(gpu.temperatureCelsius)))
            rows.append(Detail(label: Strings.Monitor.power, value: MonitorFormat.watts(gpu.powerWatts)))
        }
        if rows.isEmpty { rows.append(Detail(label: sample == nil ? Strings.Monitor.gpuWaiting : Strings.Monitor.gpuUnavailable, value: "", quiet: true)) }
        details(&context, id: "monitor:gpu", rows)
    }

    private nonisolated static func memory(_ context: inout Context, _ sample: SystemMonitorSample?) {
        gap(&context, "monitor:gap:memory")
        let memory = sample?.memory
        let used = MonitorFormat.share(memory?.usedBytes, of: memory?.totalBytes)
        let line = CardDrawing.ChartLine(values: history(sample, { $0.memoryUsedBytes }, maximum: memory?.totalBytes ?? 1), color: CardDrawing.level(used))
        summary(&context, id: "monitor:memory", icon: "layers-outline", tint: (Palette.tileIndigo, Palette.tileIndigoFill), title: Strings.Monitor.memory,
                value: MonitorFormat.bytes(memory?.usedBytes), subtitle: memory.map { Strings.Monitor.memorySubtitle(MonitorFormat.bytes($0.totalBytes)) } ?? Strings.Monitor.waitingMemory,
                lines: [line], bars: nil, last: false)
        var rows = [
            Detail(label: Strings.Monitor.physicalUsed, value: used.map { "\(Int($0.rounded()))%" } ?? "—", meter: .some(used)),
            Detail(label: Strings.Monitor.available, value: MonitorFormat.bytes(memory?.availableBytes)),
        ]
        if let memory, let cached = memory.cachedBytes {
            rows.append(Detail(label: Strings.Monitor.cached, value: MonitorFormat.bytes(cached), meter: .some(MonitorFormat.share(cached, of: memory.totalBytes))))
        }
        let swapTotal = memory?.swapTotalBytes
        let swap = swapTotal == nil ? "—" : "\(MonitorFormat.bytes(memory?.swapUsedBytes)) / \(MonitorFormat.bytes(swapTotal))"
        rows.append(Detail(label: Strings.Monitor.swap, value: swap, meter: swapTotal == nil || memory?.swapUsedBytes == nil ? nil : .some(MonitorFormat.share(memory?.swapUsedBytes, of: swapTotal) ?? 0)))
        details(&context, id: "monitor:memory", rows)
    }

    private nonisolated static func disk(_ context: inout Context, _ sample: SystemMonitorSample?) {
        gap(&context, "monitor:gap:disk")
        let disks = sample?.disks ?? []
        let used = disks.isEmpty ? nil : MonitorFormat.share(sample?.diskUsed, of: sample?.diskTotal)
        let peak = (sample?.history ?? []).flatMap { [$0.diskReadBytesPerSecond ?? 0, $0.diskWriteBytesPerSecond ?? 0] }.max() ?? 0
        let lines = [
            CardDrawing.ChartLine(values: history(sample, { $0.diskReadBytesPerSecond }, maximum: peak), color: Palette.monitorCalm),
            CardDrawing.ChartLine(values: history(sample, { $0.diskWriteBytesPerSecond }, maximum: peak), color: Palette.monitorWarm, fills: false),
        ]
        let subtitle = disks.isEmpty ? Strings.Monitor.noVolumes : Strings.Monitor.diskSubtitle(used: MonitorFormat.bytes(sample?.diskUsed), total: MonitorFormat.bytes(sample?.diskTotal))
        summary(&context, id: "monitor:disk", icon: "server-outline", tint: (Palette.tileTeal, Palette.tileTealFill), title: Strings.Monitor.disk,
                value: MonitorFormat.percent(used), subtitle: subtitle, lines: lines, bars: nil, last: false)
        var rows = [
            Detail(label: Strings.Monitor.readIO, value: MonitorFormat.rate(sample?.diskIo?.readBytesPerSecond), dot: Palette.monitorCalm),
            Detail(label: Strings.Monitor.writeIO, value: MonitorFormat.rate(sample?.diskIo?.writeBytesPerSecond), dot: Palette.monitorWarm),
        ]
        for volume in disks {
            rows.append(Detail(
                label: volume.mountPoint, value: Strings.Monitor.free(MonitorFormat.bytes(volume.availableBytes)),
                meter: .some(MonitorFormat.share(volume.usedBytes, of: volume.totalBytes)),
                note: "\(volume.fileSystem ?? Strings.Monitor.unknownFileSystem) · \(MonitorFormat.bytes(volume.totalBytes))"
            ))
        }
        details(&context, id: "monitor:disk", rows)
    }

    private nonisolated static func processes(_ context: inout Context, _ sample: SystemMonitorSample?, table: inout ProcessTable) {
        let input = context.input
        let processes = sample?.processes
        var count = processes.map { Strings.Monitor.processCount(total: $0.total, threads: $0.threads) } ?? ""
        if processes != nil, input.state.status != .ready { count += " · \(Strings.Monitor.lastSample)" }
        context.items.append(CardItems.heading("monitor:processes", Strings.Monitor.processes, trailing: count, width: input.width, maxWidth: input.maxWidth, afterCard: true, dark: input.dark, displayScale: input.displayScale))
        guard let processes else {
            let title = sample == nil ? Strings.Monitor.waitingProcesses : Strings.Monitor.processesUnavailable
            details(&context, id: "monitor:processes:empty", [Detail(label: title, value: "", note: sample == nil ? nil : Strings.Monitor.processesUnavailableNote, quiet: true)])
            context.items[context.items.count - 1].place = .alone
            return
        }
        let rows = table.rows(processes.items, filter: input.filter, sort: input.sort, now: input.now)
        if rows.isEmpty {
            details(&context, id: "monitor:processes:none", [Detail(label: input.filter.trimmingCharacters(in: .whitespaces).isEmpty ? Strings.Monitor.noProcesses : Strings.Monitor.noMatches, value: "", quiet: true)])
            context.items[context.items.count - 1].place = .alone
        }
        let total = processes.total
        let cpuWidth = context.size("100.0%", context.text).width
        for (row, place) in zip(rows, CardPlace.run(rows.count)) {
            let process = row.process
            let cpu = MonitorFormat.percent(process.cpuPercent)
            let memory = MonitorFormat.bytes(process.memoryBytes)
            let meta = Strings.Monitor.processMeta(process)
            let layout = MonitorProcessLayout(
                width: input.width, maxWidth: input.maxWidth, place: place,
                name: context.measurable(process.name, context.text), cpu: context.size(cpu, context.text), cpuWidth: cpuWidth,
                meta: context.measurable(meta, context.small), memory: context.size(memory, context.small),
                hairline: context.hairline, scale: input.displayScale
            )
            var drawing = context.drawing()
            drawing.text(process.name, context.text, Palette.text, layout.name)
            drawing.text(cpu, context.text, Palette.text, layout.cpu)
            drawing.text(meta, context.small, Palette.settingsSecondary, layout.meta)
            drawing.text(memory, context.small, Palette.settingsSecondary, layout.memory)
            let peak = max(1, row.cpuHistory.compactMap { $0 }.max() ?? 0)
            drawing.marks.append(.chart([CardDrawing.ChartLine(values: row.cpuHistory.map { $0.map { $0 / peak } }, color: CardDrawing.level(process.cpuPercent))], layout.spark))
            drawing.rule(layout.separator)
            var item = CardItem(id: "monitor:process:\(process.pid)", kind: .row, size: layout.size, card: layout.card, place: place, drawing: drawing)
            item.accessibilityLabel = process.name
            item.accessibilityValue = "\(Strings.Monitor.cpu) \(cpu), \(Strings.Monitor.memory) \(memory), \(meta)"
            context.items.append(item)
        }
        context.items.append(note("monitor:processes:footer", Strings.Monitor.shown(rows.count, of: max(total, processes.items.count)), input, size: MonitorMetrics.smallSize, padding: 10))
    }

    nonisolated static func sortLabel(_ sort: ProcessTable.Sort) -> String {
        "\(Strings.Monitor.column(sort.column)) \(sort.descending ? "↓" : "↑")"
    }

    private nonisolated static func footer(_ context: inout Context, _ sample: SystemMonitorSample?) {
        let history = sample?.history ?? []
        let seconds = history.count > 1 ? Int((((history.last?.sampledAt ?? 0) - (history.first?.sampledAt ?? 0)) / 1000).rounded()) : nil
        let time = sample.map { sample -> String in
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US")
            formatter.dateFormat = "h:mm:ss a"
            return formatter.string(from: Date(timeIntervalSince1970: sample.sampledAt / 1000))
        }
        let text = "\(Strings.Monitor.activity(seconds: seconds)) · \(Strings.Monitor.sampled(time, every: (sample?.intervalMs ?? 1000) / 1000))"
        context.items.append(note("monitor:footer", text, context.input, size: MonitorMetrics.smallSize, padding: 16))
    }
}
#endif

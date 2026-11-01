import Foundation
import HappyCore

// Happy Desktop's System Monitor's words, as its machine overview says
// them. happy-app has no System Monitor, so en.ts has none; they stay
// English in every language, as the agent screens' others do.
extension Strings {
    enum Monitor {
        static let title = "System Monitor"
        static let overview = "Machine overview"
        static let waitingHost = "CPU, graphics, memory, and storage at a glance"
        static let unreachable = "The machine could not be reached. Connection retries automatically."

        nonisolated static func status(_ status: SystemMonitorFeed.Status) -> String {
            switch status {
            case .loading: "Connecting to this machine…"
            case .ready: "Live"
            case .reconnecting: "Reconnecting · showing last sample"
            case .missing: "This System Monitor is no longer available."
            case .unsupported: "This Happy Agent does not support System Monitor yet."
            }
        }

        /// The status as short as the host card's line wants it.
        nonisolated static func shortStatus(_ status: SystemMonitorFeed.Status) -> String {
            switch status {
            case .loading: "Connecting…"
            case .ready: "Live"
            case .reconnecting: "Reconnecting"
            case .missing: "Unavailable"
            case .unsupported: "Unsupported"
            }
        }

        static let cpu = "CPU"
        static let gpu = "GPU"
        static let memory = "Memory"
        static let disk = "Disk"
        static let processes = "Processes"

        static let waitingCPU = "Waiting for processor data"
        static let waitingGPU = "Waiting for graphics data"
        static let noGPU = "No GPU detected"
        static let gpuUnavailable = "Graphics metrics are unavailable on this machine."
        static let gpuWaiting = "Graphics metrics will appear here."
        static let waitingMemory = "Waiting for memory data"
        static let noVolumes = "No volumes available"

        static let logicalCores = "Logical cores"
        static let frequency = "Frequency"
        static let temperature = "Temperature"
        static let videoMemory = "Video memory"
        static let power = "Power"
        static let physicalUsed = "Physical memory used"
        static let available = "Available"
        static let cached = "Cached"
        static let swap = "Swap"
        static let read = "Read"
        static let write = "Write"
        static let readIO = "Read I/O"
        static let writeIO = "Write I/O"
        static let unknownFileSystem = "Unknown filesystem"

        nonisolated static func memorySubtitle(_ total: String) -> String { "of \(total) physical memory" }
        nonisolated static func diskSubtitle(used: String, total: String) -> String { "\(used) of \(total) used" }
        nonisolated static func free(_ bytes: String) -> String { "\(bytes) free" }
        nonisolated static func host(os: String, arch: String, uptime: String) -> String { "\(os) · \(arch) · Uptime \(uptime)" }

        static let filter = "Filter processes…"
        static let sort = "Sort"
        static let waitingProcesses = "Waiting for processes"
        static let processesUnavailable = "Process metrics unavailable"
        static let processesUnavailableNote = "This machine is not reporting its process list. Other resource metrics remain live."
        static let noMatches = "No matching processes"
        static let noProcesses = "No processes reported"
        static let lastSample = "Last sample"

        nonisolated static func processCount(total: Int, threads: Int?) -> String {
            let processes = "\(MonitorFormat.count(total)) processes"
            return threads.map { "\(processes) · \(MonitorFormat.count($0)) threads" } ?? processes
        }

        nonisolated static func column(_ column: ProcessTable.Column) -> String {
            switch column {
            case .pid: "PID"
            case .name: "Name"
            case .user: "User"
            case .cpu: "CPU"
            case .memory: "Memory"
            case .state: "State"
            case .threads: "Threads"
            }
        }

        nonisolated static func processMeta(_ process: SystemMonitorSample.Process) -> String {
            var parts = ["PID \(process.pid)"]
            if let user = process.user { parts.append(user) }
            if let state = process.state { parts.append(state) }
            if let threads = process.threads { parts.append(threads == 1 ? "1 thread" : "\(threads) threads") }
            return parts.joined(separator: " · ")
        }

        nonisolated static func shown(_ count: Int, of total: Int) -> String {
            "\(count) of \(total) sampled · Top CPU and memory consumers · CPU is a share of the whole machine · Order updates every 5s"
        }

        nonisolated static func activity(seconds: Int?) -> String {
            seconds.map { "\($0) seconds of activity" } ?? "Collecting activity history"
        }

        nonisolated static func sampled(_ time: String?, every seconds: Double) -> String {
            guard let time else { return "Waiting for the first sample" }
            let interval = seconds.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(seconds)) : String(seconds)
            return "Sampled \(time) · Every \(interval)s"
        }
    }
}

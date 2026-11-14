import Foundation
import HappyCore

extension Strings {
    /// Settings › Compute on Happy Cloud, in desktop's words; no shared
    /// mobile catalog yet.
    enum Compute {
        static let title = "Compute"
        static let loading = "Loading…"
        static let unknown = "Unknown"
        static let denied = "Your role can't use compute on this server."
        static let missing = "This computer is no longer available."
        static let failed = "Couldn’t refresh. Tap to retry."
        static let stale = "Showing the last reading."

        static let computers = "Computers"
        static let noComputers = "No computer has joined yet."
        static func computersNote(_ access: ComputeRole) -> String {
            switch access {
            case .manage: "Agents choose a computer and join it. A shared computer takes the team’s agents, a private one only its owner’s, each approved."
            case .use: "Agents choose a computer and join it. You can add a private computer of your own."
            case .none: "Agents choose a computer and join it. Your role can see them but not add one."
            }
        }
        static let addComputer = "Add Computer"
        static let remove = "Remove from Computer"
        static func removeTitle(_ agent: String) -> String { "Remove \(agent)?" }
        static func removeMessage(_ computer: String) -> String {
            "It runs nothing more on \(computer) until it joins again, and its place goes to another agent."
        }
        static let actionFailed = "That didn’t go through"

        static let joinRequests = "Join requests"
        static let joinRequestsNote = "Your agents are asking to join your private computers. An approved agent can use the computer until it leaves."
        static let approve = "Approve"
        static let deny = "Deny"
        static let anAgent = "An agent"
        static let yourComputer = "your computer"
        static func wantsToJoin(_ computer: String, _ when: String) -> String { "Wants to join \(computer) · \(when)" }

        static func access(_ access: ComputeAccess) -> String {
            switch access {
            case .shared: "Shared"
            case .private: "Private"
            }
        }
        static func accessDescription(_ access: ComputeAccess) -> String {
            switch access {
            case .shared: "For the team. Any agent on this server can join it."
            case .private: "Just for you. Only your agents can join, and you approve each one."
            }
        }
        static let yours = "Yours"
        static func owner(_ name: String?) -> String { name.map { "\($0)’s" } ?? "A member’s" }
        static func agentCount(_ count: Int) -> String { count == 1 ? "1 agent" : "\(count) agents" }
        static func agents(_ count: Int, of concurrency: Int) -> String { "\(count) of \(agentCount(concurrency))" }
        static let fullAccessOnly = "Full access only"

        static func status(_ status: Computer.Status, full: Bool) -> String {
            switch status {
            case .online: full ? "Full" : "Online"
            case .offline: "Offline"
            case .draining: "Draining"
            case .enrolling: "Joining"
            case .revoked: "Removed"
            }
        }
        static func platform(_ os: String?) -> String? {
            switch os {
            case "macos": "macOS"
            case "linux": "Linux"
            case "windows": "Windows"
            default: os
            }
        }

        // Adding a computer.
        static let create = "Create"
        static let accessNeedsAdmin = "Admin only"
        static let accessLockedHint = "Adding a shared computer needs admin permission."
        static let noInstall = "No install command"
        static let installTitle = "Install"
        static func installNote(_ access: ComputeAccess) -> String {
            switch access {
            case .shared: "Run this on the computer. It installs the Happy supervisor and joins the computer for the team."
            case .private: "Run this on your own computer, signed in as yourself. The Happy supervisor runs on your own account, and the computer joins as yours."
            }
        }
        static func expires(_ at: Date, now: Date = Date()) -> String {
            let minutes = Int((at.timeIntervalSince(now) / 60).rounded())
            if minutes <= 0 { return "It has expired." }
            if minutes < 60 { return "It expires in \(minutes) min." }
            let hours = (Double(minutes) / 60).rounded()
            return hours == 1 ? "It expires in 1 hour." : "It expires in \(Int(hours)) hours."
        }
        static func installFooter(_ install: ComputeInstall, now: Date = Date()) -> String {
            [installNote(install.access), install.notice, "The command works once. \(expires(Date(timeIntervalSince1970: install.expiresAt / 1000), now: now))"]
                .compactMap { $0 }.joined(separator: " ")
        }
        static func platforms(_ platforms: [ComputePlatform]) -> String {
            switch platforms {
            case [.linux]: "Linux"
            case [.windows]: "Windows (PowerShell)"
            default: platforms.map { $0 == .macOS ? "macOS" : $0 == .linux ? "Linux" : "Windows" }.joined(separator: " and ")
            }
        }
        static let server = "Server"
        static let joinToken = "Join token"
        static let copy = "Copy"
        static let copied = "Copied"
        static let invalidInstall = "Happy Cloud didn’t send an install command."

        // How many agents run at once.
        static let concurrency = "Concurrency"
        static let concurrencyPrompt = "How many agents can work on it at once?"
        static func concurrencyRange(_ range: ClosedRange<Int>) -> String { "A number from \(range.lowerBound) to \(range.upperBound)." }
        static func concurrencyValue(_ value: Int, isDefault: Bool) -> String { isDefault ? "\(value) (default)" : "\(value)" }
        static let concurrencyNote = "How many agents work on it at once, 1 to 64. A shared computer runs 8 unless you choose, a private one 1."
        static func concurrencyNote(_ node: Computer) -> String {
            let most = node.maxConcurrency.map { " It can run at most \($0)." } ?? ""
            return "It runs up to \(agentCount(node.concurrency)) at once; once full, it takes no more until one leaves.\(most)"
        }
        static let save = "Save"
        static let invalidConcurrency = "That isn’t a number it can run"

        // The agents on a computer.
        static func agentsHeader(_ count: Int, of concurrency: Int) -> String { "Agents · \(count) of \(concurrency)" }
        static let noAgents = "No agents on it"

        // A computer that can't keep an agent's restricted commands in.
        static let boundaryMissing = "Restricted commands can’t run here"
        static let boundaryNote = "Only an agent’s full-access commands run on this computer. Restricted ones are refused."

        // A computer's facts.
        static let cpu = "Logical CPU cores"
        static let memory = "Physical RAM"
        static let disk = "Workspace volume"
        static let lastSeen = "Last seen"
        static let version = "Supervisor version"
        static let operatingSystem = "Operating system"
        static let shell = "Shell"
        static let backend = "Backend"
        static let hostNote = "Startup host totals, not current usage. Disk is the total workspace volume size."
    }
}

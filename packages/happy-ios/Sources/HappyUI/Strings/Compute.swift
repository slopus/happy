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
        static let missing = "This machine is no longer available."
        static let failed = "Couldn’t refresh. Tap to retry."
        static let stale = "Showing the last reading."

        static let machines = "Machines"
        static let noMachines = "No machine has joined yet."
        static func machinesNote(_ access: ComputeAccess) -> String {
            switch access {
            case .manage: "Agents choose a machine and join it. Its mode decides who can join and how agents share it."
            case .use: "Agents choose a machine and join it. You can add a private machine of your own."
            case .none: "Agents choose a machine and join it. Your role can see them but not add one."
            }
        }
        static let addMachine = "Add Machine"
        static let details = "Show Details"
        static let edit = "Edit"
        static let release = "Release"
        static func releaseTitle(_ machine: String) -> String { "Release \(machine)?" }
        static func releaseMessage(_ holder: String) -> String {
            "\(holder) runs nothing more there until it joins again."
        }
        static let releaseNote = "Release frees the machine from the agent holding it, so another agent can join."
        static let actionFailed = "That didn’t go through"

        static let joinRequests = "Join requests"
        static let joinRequestsNote = "Your agents are asking to join your private machines. An approved agent can use the machine until it leaves."
        static let approve = "Approve"
        static let deny = "Deny"
        static let anAgent = "An agent"
        static let yourMachine = "your machine"
        static func wantsToJoin(_ machine: String, _ when: String) -> String { "Wants to join \(machine) · \(when)" }

        static func mode(_ kind: ComputeMode.Kind) -> String {
            switch kind {
            case .sandbox: "Sandbox"
            case .shared: "Shared"
            case .exclusive: "Exclusive"
            case .private: "Private"
            }
        }
        static func modeDescription(_ kind: ComputeMode.Kind) -> String {
            switch kind {
            case .sandbox: "Each agent works in its own isolated sandbox, with optional CPU and memory limits. Linux only."
            case .shared: "Every agent works directly on the host. Only other agents’ workspaces are hidden. Linux only."
            case .exclusive: "One agent at a time works on the host. The rest see it as busy. Linux and macOS."
            case .private: "Your own machine. Only your agents can join, and you approve each one. Linux, macOS and Windows."
            }
        }
        static let yours = "Yours"
        static func owner(_ name: String?) -> String { name.map { "\($0)’s" } ?? "A member’s" }
        static func heldBy(_ title: String?) -> String { "Held by \(title ?? "an agent")" }
        static let free = "Free"

        static func status(_ status: ComputeNode.Status, held: Bool) -> String {
            switch status {
            case .online: held ? "In use" : "Online"
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

        // Adding a machine.
        static let next = "Next"
        static let create = "Create"
        static let modeNeedsAdmin = "Admin only"
        static let modeLockedHint = "Adding a machine in this mode needs admin permission."
        static let name = "Name"
        static let namePlaceholder = "Its hostname"
        static let nameHint = "Optional. Agents see this name; it starts as the machine’s hostname."
        static let description = "Description"
        static let descriptionPlaceholder = "What agents should know about this machine"
        static let descriptionHint = "Optional. Agents read it when they choose a machine."
        static let editDescriptionHint = "Agents read it when they choose a machine."
        static let noInstall = "No install command"
        static let notSaved = "Not saved"
        static let editMachine = "Edit Machine"
        static let installTitle = "Install"
        static func installNote(_ kind: ComputeMode.Kind) -> String {
            switch kind {
            case .sandbox: "Run this on a Linux machine. It installs the Happy supervisor as root, joins the machine, and gives each agent its own sandbox."
            case .shared: "Run this on a Linux machine. It installs the Happy supervisor with sudo and joins the machine in shared mode."
            case .exclusive: "Run this on the machine. It installs the Happy supervisor with sudo and joins the machine in exclusive mode."
            case .private: "Run this on your own machine, signed in as yourself. It needs no sudo: the Happy supervisor runs on your own account, and the machine joins as yours."
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
            "\(installNote(install.mode)) The command works once. \(expires(Date(timeIntervalSince1970: install.expiresAt / 1000), now: now))"
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

        // A machine's facts.
        static let cpu = "Logical CPU cores"
        static let memory = "Physical RAM"
        static let disk = "Workspace volume"
        static let lastSeen = "Last seen"
        static let version = "Supervisor version"
        static let operatingSystem = "Operating system"
        static let backend = "Backend"
        static let capacity = "Sandbox capacity"
        static let emptyPlacements = "No active sandboxes"
        static let hostNote = "Startup host totals, not current usage or sandbox limits. Disk is the total workspace volume size."
        static let placementNote = "Durable sandbox placements, including idle and reserved sandboxes."
        static func sandboxError(_ error: String) -> String { "Sandbox check failed: \(error)" }
        static func capacity(_ value: ComputeCapacity) -> String {
            value.total.map { "\(value.used) / \($0) sandboxes" } ?? "\(value.used) sandboxes"
        }
    }
}

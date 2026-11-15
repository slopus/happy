import Foundation
import HappyCore

extension Strings {
    /// Settings › Compute on Happy Cloud. Not in happy-app's catalogs: every
    /// language's are in `TranslationCatalog.nativeSources`
    /// (`computeSources`), worded as Android's Compute screen where both say
    /// the same thing.
    enum Compute {
        private static func word(_ key: String, _ english: String) -> String {
            localized("native.compute.\(key)", english)
        }

        private static func word(_ key: String, _ values: [String: TranslationValue], _ english: String) -> String {
            localized("native.compute.\(key)", values, english)
        }

        static var title: String { word("title", "Compute") }
        static var loading: String { word("loading", "Loading…") }
        static var unknown: String { word("unknown", "Unknown") }
        static var denied: String { word("denied", "Your role can’t use compute on this server.") }
        static var missing: String { word("missing", "This computer is no longer listed.") }
        static var failed: String { word("failed", "Couldn’t refresh. Tap to retry.") }
        static var stale: String { word("stale", "Showing the last reading.") }

        static var computers: String { word("computers", "Computers") }
        static var noComputers: String { word("noComputers", "No computer has joined yet.") }
        static func computersNote(_ role: ComputeRole) -> String {
            switch role {
            case .manage: word("computersNoteManage", "Agents choose a computer and join it. Any member’s agents can use a shared computer; only its owner’s can use a private one.")
            case .use: word("computersNoteUse", "Agents choose a computer and join it. You can add a private computer of your own.")
            case .none: word("computersNoteNone", "Agents choose a computer and join it. Your role can see them but not add one.")
            }
        }
        static var addComputer: String { word("addComputer", "Add Computer") }
        static var remove: String { word("remove", "Remove") }
        static func removeTitle(_ agent: String) -> String { word("removeTitle", ["name": .text(agent)], "Remove \(agent)?") }
        static var removeMessage: String { word("removeMessage", "The agent stops working on this computer, and its place is freed.") }
        static var actionFailed: String { word("actionFailed", "That didn’t go through") }

        static var joinRequests: String { word("joinRequests", "Join requests") }
        static var joinRequestsNote: String {
            word("joinRequestsNote", "Your agents are asking to join your private computers. An approved agent can use the computer until it leaves.")
        }
        static var approve: String { word("approve", "Approve") }
        static var deny: String { word("deny", "Deny") }
        static var anAgent: String { word("anAgent", "An agent") }
        /// `computer` nil for one of the reader's computers the list doesn't name.
        static func wantsToJoin(_ computer: String?, _ when: String) -> String {
            guard let computer else { return word("wantsToJoinYours", ["when": .text(when)], "Wants to join your computer · \(when)") }
            return word("wantsToJoin", ["computer": .text(computer), "when": .text(when)], "Wants to join \(computer) · \(when)")
        }

        static func access(_ access: ComputeAccess) -> String {
            switch access {
            case .shared: word("shared", "Shared")
            case .private: word("private", "Private")
            }
        }
        static func accessDescription(_ access: ComputeAccess) -> String {
            switch access {
            case .shared: word("sharedDescription", "For your team. Any member’s agents can work on it.")
            case .private: word("privateDescription", "Just for you. Only your agents can join, and you approve each one.")
            }
        }
        static var yours: String { word("yours", "Yours") }
        static func owner(_ name: String?) -> String {
            guard let name else { return word("ownerUnknown", "A member’s") }
            return word("owner", ["name": .text(name)], "\(name)’s")
        }
        /// "2 of 8 agents": the noun agrees with `concurrency`.
        static func agents(_ count: Int, of concurrency: Int) -> String {
            let form = TranslationCatalog.pluralCategory(language: AppLocalization.language, count: concurrency)
            return word("agents.\(form)", ["count": .number(count), "total": .number(concurrency)],
                        concurrency == 1 ? "\(count) of 1 agent" : "\(count) of \(concurrency) agents")
        }
        static var fullAccessOnly: String { word("fullAccessOnly", "Full access only") }

        static func status(_ status: Computer.Status, full: Bool) -> String {
            switch status {
            case .online: full ? word("status.full", "Full") : word("status.online", "Online")
            case .offline: word("status.offline", "Offline")
            case .draining: word("status.draining", "Draining")
            case .enrolling: word("status.joining", "Joining")
            case .revoked: word("status.removed", "Removed")
            }
        }
        /// Systems keep their names in every language.
        static func platform(_ os: String?) -> String? {
            switch os {
            case "macos": "macOS"
            case "linux": "Linux"
            case "windows": "Windows"
            default: os
            }
        }

        // Adding a computer.
        static var create: String { word("create", "Create") }
        static var accessNeedsAdmin: String { word("accessNeedsAdmin", "Admin only") }
        static var accessLockedHint: String { word("accessLockedHint", "Adding a shared computer needs admin permission.") }
        static var noInstall: String { word("noInstall", "No install command") }
        static var installTitle: String { word("installTitle", "Install") }
        static func installNote(_ access: ComputeAccess) -> String {
            switch access {
            case .shared: word("installShared", "Run this on the computer your team’s agents will use. It installs the Happy supervisor and joins the computer as a shared one.")
            case .private: word("installPrivate", "Run this on your own computer, signed in as yourself. It installs the Happy supervisor and joins the computer as yours.")
            }
        }
        static func expires(_ at: Date, now: Date = Date()) -> String {
            guard at > now else { return word("expired", "It has expired.") }
            let time = at.formatted(date: .omitted, time: .shortened)
            return word("expiresAt", ["time": .text(time)], "It expires at \(time).")
        }
        static func installFooter(_ install: ComputeInstall, now: Date = Date()) -> String {
            [installNote(install.access), install.notice, word("commandNote", "The command works once and holds a secret, so keep it private."),
             expires(Date(timeIntervalSince1970: install.expiresAt / 1000), now: now)]
                .compactMap { $0 }.joined(separator: " ")
        }
        /// A command's systems: the shell one's are macOS, Linux or both.
        static func platforms(_ platforms: [ComputePlatform]) -> String {
            switch platforms {
            case [.windows]: "Windows (PowerShell)"
            case [.macOS]: "macOS"
            case [.linux]: "Linux"
            default: word("macOSAndLinux", "macOS and Linux")
            }
        }
        static var server: String { word("server", "Server") }
        static var joinToken: String { word("joinToken", "Join token") }
        static var copy: String { word("copy", "Copy") }
        static var copied: String { word("copied", "Copied") }
        static var invalidInstall: String { word("invalidInstall", "Happy Cloud didn’t send an install command.") }

        // How many agents run at once.
        static var concurrency: String { word("concurrency", "Agents at once") }
        static var concurrencyPrompt: String { word("concurrencyPrompt", "How many agents can work on it at once?") }
        static func concurrencyRange(_ range: ClosedRange<Int>) -> String {
            word("concurrencyRange", ["min": .number(range.lowerBound), "max": .number(range.upperBound)], "A number from \(range.lowerBound) to \(range.upperBound).")
        }
        static func concurrencyValue(_ value: Int, isDefault: Bool) -> String {
            isDefault ? word("concurrencyDefault", ["count": .number(value)], "\(value) (default)") : "\(value)"
        }
        /// What the number means, up to `most`.
        static func concurrencyNote(most: Int) -> String {
            word("concurrencyNote", ["max": .number(most)], "How many agents can work on this computer at the same time, from 1 to \(most).")
        }
        /// Adding a computer: the note, and what it runs unless chosen.
        static var concurrencyAddNote: String {
            "\(concurrencyNote(most: ComputeConcurrency.limit)) \(word("concurrencyDefaults", "A shared computer runs 8 unless you choose, a private one 1."))"
        }
        static var save: String { Strings.Common.save }
        static var invalidConcurrency: String { word("invalidConcurrency", "That isn’t a number it can run") }

        // The agents on a computer.
        static var noAgents: String { word("noAgents", "No agents are working here.") }

        // A computer that can't keep an agent's restricted commands in.
        static var boundaryMissing: String { word("boundaryMissing", "Restricted commands can’t run here") }
        static var boundaryNote: String { word("boundaryNote", "Only full-access commands run on this computer.") }

        // A computer's facts.
        static var cpu: String { word("cpu", "Logical CPU cores") }
        static var memory: String { word("memory", "Physical RAM") }
        static var disk: String { word("disk", "Workspace volume") }
        static var lastSeen: String { word("lastSeen", "Last seen") }
        static var version: String { word("version", "Supervisor version") }
        static var operatingSystem: String { word("operatingSystem", "Operating system") }
        static var shell: String { word("shell", "Shell") }
        static var backend: String { word("backend", "Backend") }
        static var hostNote: String { word("hostNote", "Startup host totals, not current usage. Disk is the total workspace volume size.") }
    }
}

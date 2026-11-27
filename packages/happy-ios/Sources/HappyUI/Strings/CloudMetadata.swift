import Foundation
import HappyCore

extension Strings {
    enum CloudMetadata {
        static var zones: String { localized("cloudSettings.zones", "Zones") }
        static var secrets: String { localized("cloudSettings.secrets", "Secrets") }
        static var defaultZone: String { localized("cloudSettings.defaultZone", "Default zone") }
        static var critical: String { localized("cloudSettings.criticalZone", "Critical zone") }
        static var allMembers: String { localized("cloudSettings.allMembers", "All members") }
        static var noMembers: String { localized("cloudSettings.noMembers", "No members") }
        static func mayJoin(_ names: String) -> String { localized("cloudSettings.mayJoin", ["names": .text(names)], "May join: \(names)") }
        static var manageOnDesktop: String { localized("cloudSettings.manageOnDesktop", "Manage on desktop") }
        static var noZones: String { localized("cloudSettings.noZones", "No zones to show") }
        static var noSecrets: String { localized("cloudSettings.noSecrets", "No secrets to show") }
        static var failed: String { localized("cloudSettings.loadFailed", "Couldn’t load this list") }
        static var loading: String { localized("common.loading", "Loading...") }
        static var retry: String { localized("common.retry", "Retry") }

        static func owner(_ owner: String?) -> String? {
            switch owner {
            case "team": localized("cloudSettings.ownerTeam", "Team")
            case "me": localized("cloudSettings.ownerMine", "Mine")
            case "agent": localized("cloudSettings.ownerAgent", "Agent")
            default: nil
            }
        }
    }
}

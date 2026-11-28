import Foundation
import HappyCore

extension Strings {
    enum CloudMetadata {
        static var zones: String { localized("cloudSettings.zones", "Zones") }
        static var secrets: String { localized("cloudSettings.secrets", "Secrets") }
        static var restricted: String { localized("cloudSettings.restrictedZone", "Restricted zone") }
        static var allMembers: String { localized("cloudSettings.allMembers", "All members") }
        static var noMembers: String { localized("cloudSettings.noMembers", "No members") }
        static func mayJoin(_ names: String) -> String { localized("cloudSettings.mayJoin", ["names": .text(names)], "May join: \(names)") }
        static var manageOnDesktop: String { localized("cloudSettings.manageOnDesktop", "Manage on desktop") }
        static var noZones: String { localized("cloudSettings.noZones", "No zones to show") }
        static var noSecrets: String { localized("cloudSettings.noSecrets", "No secrets to show") }
        static var failed: String { localized("cloudSettings.loadFailed", "Couldn’t load this list") }
        static var loading: String { localized("common.loading", "Loading...") }
        static var retry: String { localized("common.retry", "Retry") }

        static func internet(_ internet: CloudZone.Internet) -> String {
            switch internet {
            case .on: localized("cloudSettings.internetOn", "Internet on")
            case .off: localized("cloudSettings.internetOff", "No internet")
            }
        }

        static func compute(_ compute: CloudZone.Compute) -> String {
            switch compute {
            case .any: localized("cloudSettings.computeAny", "Any computer")
            case .listed: localized("cloudSettings.computeListed", "Listed computers only")
            case .none: localized("cloudSettings.computeNone", "No computers")
            }
        }

        static func owner(_ owner: String?) -> String? {
            switch owner {
            case "team": localized("cloudSettings.ownerTeam", "Server")
            case "me": localized("cloudSettings.ownerMine", "Mine")
            case "agent": localized("cloudSettings.ownerAgent", "Agent")
            default: nil
            }
        }
    }
}

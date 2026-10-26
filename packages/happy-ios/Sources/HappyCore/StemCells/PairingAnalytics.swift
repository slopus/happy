import Foundation

/// How a computer is linked: through the Happy relay, or straight to this
/// phone (the Direct connection experiment).
public enum PairingMethod: String, Sendable {
    case relay
    case direct
}

/// Where linking options were offered.
public enum PairingSurface: String, Sendable {
    case onboarding
    case addComputer = "add_computer"
    case settings
}

/// How a pairing began.
public enum PairingStart: String, Sendable {
    case scan
    case pasteLink = "paste_link"
    /// A link opened from outside the app.
    case openedLink = "opened_link"
}

/// The linking events, with only what they need: which options showed,
/// what was chosen, how a pairing began and ended. Never a link, token,
/// address or device name.
public enum PairingEvent: Equatable, Sendable {
    case optionsShown(options: [PairingMethod], selected: PairingMethod, surface: PairingSurface)
    case optionSelected(from: PairingMethod, to: PairingMethod, surface: PairingSurface)
    case completed(method: PairingMethod, start: PairingStart)
    case failed(method: PairingMethod, start: PairingStart)
    case cancelled(method: PairingMethod, start: PairingStart)
    case experimentToggled(on: Bool, surface: PairingSurface)

    public var name: String {
        switch self {
        case .optionsShown: "pairing_options_shown"
        case .optionSelected: "pairing_option_selected"
        case .completed: "pairing_completed"
        case .failed: "pairing_failed"
        case .cancelled: "pairing_cancelled"
        case .experimentToggled: "direct_connection_experiment_toggled"
        }
    }

    public var properties: [String: AnalyticsValue] {
        switch self {
        case .optionsShown(let options, let selected, let surface):
            ["options": .strings(options.map(\.rawValue)), "default_selected": .string(selected.rawValue), "surface": .string(surface.rawValue)]
        case .optionSelected(let from, let to, let surface):
            ["from": .string(from.rawValue), "to": .string(to.rawValue), "surface": .string(surface.rawValue)]
        case .completed(let method, let start), .failed(let method, let start), .cancelled(let method, let start):
            ["method": .string(method.rawValue), "start": .string(start.rawValue)]
        case .experimentToggled(let on, let surface):
            ["enabled": .bool(on), "surface": .string(surface.rawValue)]
        }
    }
}

public enum AnalyticsValue: Equatable, Sendable {
    case string(String)
    case strings([String])
    case bool(Bool)
}

/// Where pairing events go. happy-ios has no analytics client of its own
/// yet, so nothing is sent until one sets `sink`; whoever does keeps
/// happy-app's rules (`analyticsOptOut` stops everything). Each event
/// carries the app variant.
@MainActor
public final class PairingAnalytics {
    public static let shared = PairingAnalytics()

    /// Given each event's name and properties.
    public var sink: ((String, [String: AnalyticsValue]) -> Void)?
    /// The person opted out of analytics.
    public var isOptedOut: () -> Bool = { false }
    public var variant: AppVariant?

    public init() {}

    public func log(_ event: PairingEvent) {
        guard let sink, !isOptedOut() else { return }
        var properties = event.properties
        if let variant { properties["app_variant"] = .string(variant.rawValue) }
        sink(event.name, properties)
    }
}

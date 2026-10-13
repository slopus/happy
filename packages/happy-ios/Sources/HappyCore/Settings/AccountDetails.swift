import Foundation
import HappyWire

/// Settings › Account's push-token rows (app/(app)/settings/account.tsx).
public enum PushTokenText {
    /// `formatPushTokenFingerprint`: the Expo wrapper stripped, the middle
    /// elided.
    public static func fingerprint(_ token: String) -> String {
        var raw = token
        if raw.hasPrefix("ExponentPushToken[") { raw.removeFirst("ExponentPushToken[".count) }
        if raw.hasSuffix("]") { raw.removeLast() }
        guard raw.count > 12 else { return raw }
        return "\(raw.prefix(6))…\(raw.suffix(6))"
    }

    /// This phone, as `getCurrentPushDeviceMetadata` describes it.
    public struct Device: Equatable, Sendable {
        public var deviceLabel: String
        public var appLabel: String?

        public init(deviceLabel: String, appLabel: String?) {
            self.deviceLabel = deviceLabel
            self.appLabel = appLabel
        }

        /// The device's name, its model when that differs, and the OS; then
        /// the app's version and build, and whether it is a simulator.
        public init(
            name: String?,
            model: String?,
            systemName: String,
            systemVersion: String?,
            appVersion: String?,
            build: String?,
            isSimulator: Bool
        ) {
            let os = [systemName, systemVersion].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            let device = [name, model == name ? nil : model, os]
                .compactMap { $0 }
                .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            let app = [
                appVersion.map { "Happy \($0)" },
                build.map { "build \($0)" },
                isSimulator ? "simulator" : nil,
            ].compactMap { $0 }
            self.init(
                deviceLabel: device.isEmpty ? "ios device" : device.joined(separator: " • "),
                appLabel: app.isEmpty ? nil : app.joined(separator: " • ")
            )
        }
    }

    /// `buildPushTokenSubtitle`: who the token belongs to, then its server
    /// facts. `current` is this phone when the token is its own.
    public static func subtitle(_ token: PushToken, current: Device? = nil, format: (Int64) -> String) -> String {
        var lines: [String] = []
        if let current {
            lines.append(current.deviceLabel)
            if let app = current.appLabel { lines.append(app) }
        } else {
            lines.append("Other device or stale registration")
        }
        lines += [
            "Registered: \(format(token.createdAt))",
            "Last seen: \(format(token.updatedAt))",
            "Server ID: \(token.id)",
            "Token: \(fingerprint(token.token))",
        ]
        return lines.joined(separator: "\n")
    }
}

/// This device's push registration (sync/pushRegistration.ts). The real one
/// (APNs, then an Expo token) belongs to the push notifications work;
/// Settings only shows it and asks it to register again.
public protocol PushRegistration: Sendable {
    /// The token this device registered last, if any.
    func currentToken() async -> String?
    /// Registers this device's current token with `api`'s account and
    /// returns it; nil when the system gives no token.
    func register(api: HappyAPI) async throws -> String?
}

/// The Usage page (components/usage/UsagePanel.tsx, sync/apiUsage.ts).
public struct UsageTotals: Equatable, Sendable {
    public enum Period: String, CaseIterable, Sendable {
        case today
        case sevenDays = "7days"
        case thirtyDays = "30days"

        /// `getUsageForPeriod`: today by the hour from local midnight, the
        /// others by the day.
        public func query(now: Date, calendar: Calendar = .autoupdatingCurrent) -> UsageQuery {
            let end = Int64(now.timeIntervalSince1970)
            let day: Int64 = 24 * 60 * 60
            switch self {
            case .today:
                let midnight = calendar.startOfDay(for: now)
                return UsageQuery(startTime: Int64(midnight.timeIntervalSince1970), endTime: end, groupBy: .hour)
            case .sevenDays:
                return UsageQuery(startTime: end - 7 * day, endTime: end, groupBy: .day)
            case .thirtyDays:
                return UsageQuery(startTime: end - 30 * day, endTime: end, groupBy: .day)
            }
        }
    }

    public var totalTokens: Double = 0
    public var totalCost: Double = 0
    public var tokensByModel: [String: Double] = [:]
    public var costByModel: [String: Double] = [:]

    /// `calculateTotals`.
    public init(_ points: [UsageDataPoint]) {
        for point in points {
            for (model, tokens) in point.tokens {
                totalTokens += tokens
                tokensByModel[model, default: 0] += tokens
            }
            for (model, cost) in point.cost {
                totalCost += cost
                costByModel[model, default: 0] += cost
            }
        }
    }

    /// The five models with the most tokens, most first.
    public var topModels: [(model: String, tokens: Double)] {
        tokensByModel
            .sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
            .prefix(5)
            .map { ($0.key, $0.value) }
    }

    /// `formatTokens`: 1.23M, 4.5K, or the count.
    public static func formatTokens(_ tokens: Double, locale: Locale = .autoupdatingCurrent) -> String {
        if tokens >= 1_000_000 { return String(format: "%.2fM", tokens / 1_000_000) }
        if tokens >= 1_000 { return String(format: "%.1fK", tokens / 1_000) }
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: tokens)) ?? String(Int64(tokens))
    }

    /// `formatCost`: dollars to four places.
    public static func formatCost(_ cost: Double) -> String {
        String(format: "$%.4f", cost)
    }
}

import Foundation
import HappyWire

/// One model's tokens over some span, as the daemon counts them.
public struct TokenCounts: Equatable, Sendable {
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    public var cacheWrite: Int

    public init(input: Int = 0, output: Int = 0, cacheRead: Int = 0, cacheWrite: Int = 0) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
    }

    /// What the activity grid counts: input, output and cache writes.
    /// Cache reads would flatten every other day.
    public var counted: Int { input + output + cacheWrite }
    /// Everything, cache reads included: a model line's totals.
    public var total: Int { input + output + cacheRead + cacheWrite }

    static func read(_ value: JSONValue) -> TokenCounts? {
        guard value.objectValue != nil else { return nil }
        func count(_ key: String) -> Int {
            guard let number = value[key]?.numberValue, number.isFinite, number > 0 else { return 0 }
            return Int(min(number, Double(Int.max / 4)))
        }
        return TokenCounts(input: count("input"), output: count("output"), cacheRead: count("cacheRead"), cacheWrite: count("cacheWrite"))
    }

    /// `{ providerId: { modelId: counts } }`.
    static func byProvider(_ value: JSONValue?) -> [String: [String: TokenCounts]] {
        var providers: [String: [String: TokenCounts]] = [:]
        for (providerId, byModel) in value?.objectValue ?? [:] {
            var models: [String: TokenCounts] = [:]
            for (modelId, counts) in byModel.objectValue ?? [:] {
                if let read = read(counts) { models[modelId] = read }
            }
            if !models.isEmpty { providers[providerId] = models }
        }
        return providers
    }
}

/// `GET /v0/usage/daily`: the local days that spent tokens, oldest first.
/// Only days with usage are listed; a day from `since` to today that is
/// missing spent nothing, and nothing is known before `since`.
public struct DailyUsage: Equatable, Sendable {
    public struct Day: Equatable, Sendable {
        /// `YYYY-MM-DD`, local to the time zone asked for.
        public var date: String
        /// Provider account, then model, then that day's counts.
        public var providers: [String: [String: TokenCounts]]

        public init(date: String, providers: [String: [String: TokenCounts]]) {
            self.date = date
            self.providers = providers
        }
    }

    /// The first local day any usage was recorded.
    public var since: String
    public var days: [Day]

    public init(since: String, days: [Day]) {
        self.since = since
        self.days = days
    }

    /// `{ since, days: [{ date, byProvider }] }`, as desktop's
    /// `happyAgentDailyUsageRead` reads it. No `since` (nothing was ever
    /// recorded) is no history at all; a day before it, or one that isn't a
    /// day, is left out.
    public static func read(_ answer: JSONValue) -> DailyUsage? {
        guard let since = answer["since"]?.stringValue, UsageDates.isDay(since) else { return nil }
        let days = (answer["days"]?.arrayValue ?? []).compactMap { item -> Day? in
            guard let date = item["date"]?.stringValue, UsageDates.isDay(date), date >= since,
                  item["byProvider"]?.objectValue != nil else { return nil }
            return Day(date: date, providers: TokenCounts.byProvider(item["byProvider"]))
        }
        return DailyUsage(since: since, days: days.sorted { $0.date < $1.date })
    }
}

/// What a read of the daily history came to.
public enum DailyUsageAnswer: Equatable, Sendable {
    /// Read; nil where nothing was ever recorded.
    case history(DailyUsage?)
    /// The server keeps no daily history (it has no such route): no grid,
    /// and nothing is asked of that connection again.
    case unsupported
    /// Anything else: what was shown stays.
    case failed
}

/// Where Settings › Usage reads its year of daily totals.
public protocol DailyUsageSource: Sendable {
    func dailyUsage(days: Int, timeZone: String) async -> DailyUsageAnswer
}

/// The connection's own `GET /v0/usage/daily`.
public struct LiveDailyUsage: DailyUsageSource {
    let client: AgentClient

    public init(client: AgentClient) { self.client = client }

    public func dailyUsage(days: Int, timeZone: String) async -> DailyUsageAnswer {
        do {
            return .history(DailyUsage.read(try await client.dailyUsage(days: days, timeZone: timeZone)))
        } catch AgentClientError.status(let status, let code, _) where status == 404 || status == 501 || code == "not_found" {
            return .unsupported
        } catch {
            return .failed
        }
    }
}

/// A fixed answer, for tests and screenshots.
public struct FixtureDailyUsage: DailyUsageSource {
    public var answer: DailyUsageAnswer

    public init(_ answer: DailyUsageAnswer) { self.answer = answer }

    public func dailyUsage(days: Int, timeZone: String) async -> DailyUsageAnswer { answer }
}

/// Where Settings › Usage reads the accounts, their plans and their token
/// windows.
public protocol UsageReader: Sendable {
    /// `GET /v0/usage`.
    func usage() async throws -> JSONValue
    /// The configured accounts: their names, services and order.
    func catalog() async throws -> ModelCatalog
    /// Asks for fresher plan readings; they arrive as `provider.usage.updated`.
    func refresh(_ providerIds: [String]) async
}

public struct LiveUsageReader: UsageReader {
    let client: AgentClient

    public init(client: AgentClient) { self.client = client }

    public func usage() async throws -> JSONValue { try await client.usageResponse() }
    public func catalog() async throws -> ModelCatalog { try await client.modelCatalog() }
    public func refresh(_ providerIds: [String]) async { try? await client.refreshAccountUsage(providerIds) }
}

public struct FixtureUsageReader: UsageReader {
    public var response: JSONValue
    public var models: ModelCatalog

    public init(usage: JSONValue, catalog: ModelCatalog) {
        response = usage
        models = catalog
    }

    public func usage() async throws -> JSONValue { response }
    public func catalog() async throws -> ModelCatalog { models }
    public func refresh(_ providerIds: [String]) async {}
}

/// Local days as `YYYY-MM-DD`, counted on a UTC calendar so no time zone
/// moves one.
public enum UsageDates {
    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    public static func isDay(_ text: String) -> Bool {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        return parts.count == 3 && parts[0].count == 4 && parts[1].count == 2 && parts[2].count == 2
            && parts.allSatisfy { $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) } && date(text) != nil
    }

    /// The day's UTC midnight, which names it.
    public static func date(_ day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        guard components.isValidDate(in: utc) else { return nil }
        return utc.date(from: components)
    }

    /// The local day `date` falls on in `timeZone`.
    public static func day(_ date: Date, in timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    public static func adding(_ days: Int, to day: String) -> String {
        guard let date = date(day), let moved = utc.date(byAdding: .day, value: days, to: date) else { return day }
        return Self.day(moved, in: utc.timeZone)
    }

    /// Monday is 0.
    public static func weekday(_ day: String) -> Int {
        guard let date = date(day) else { return 0 }
        return (utc.component(.weekday, from: date) + 5) % 7
    }

    /// The days from `from` through `through`, both kept.
    public static func span(from: String, through: String) -> [String] {
        guard from <= through else { return [] }
        var days: [String] = []
        var day = from
        while day <= through, days.count < 4000 {
            days.append(day)
            day = adding(1, to: day)
        }
        return days
    }
}

/// One day of the activity grid: its total, and the models that spent it,
/// most first.
public struct UsageActivityDay: Equatable, Sendable {
    public struct Model: Equatable, Sendable {
        public var id: String
        public var tokens: Int
        public init(id: String, tokens: Int) {
            self.id = id
            self.tokens = tokens
        }
    }

    public var date: String
    public var tokens: Int
    public var models: [Model]

    public init(date: String, tokens: Int, models: [Model]) {
        self.date = date
        self.tokens = tokens
        self.models = models
    }

    /// Every day from `from` through `through`, a day the history doesn't
    /// list spending nothing; one account's alone when `provider` names it.
    public static func days(_ history: DailyUsage, from: String, through: String, provider: String? = nil) -> [UsageActivityDay] {
        let listed = Dictionary(history.days.map { ($0.date, $0) }, uniquingKeysWith: { _, last in last })
        return UsageDates.span(from: from, through: through).map { date in
            var models: [String: Int] = [:]
            for (id, byModel) in listed[date]?.providers ?? [:] where provider == nil || id == provider {
                for (model, counts) in byModel { models[model, default: 0] += counts.counted }
            }
            let ranked = models.filter { $0.value > 0 }
                .sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
                .map { Model(id: $0.key, tokens: $0.value) }
            return UsageActivityDay(date: date, tokens: ranked.reduce(0) { $0 + $1.tokens }, models: ranked)
        }
    }

    /// Five shades: none, then the quartiles of the days that used
    /// anything, so one enormous day does not wash every other out to the
    /// palest. Each grid is scaled against its own days.
    public static func levels(_ days: [UsageActivityDay]) -> [Int] {
        let used = days.map(\.tokens).filter { $0 > 0 }.sorted()
        guard !used.isEmpty else { return days.map { _ in 0 } }
        func at(_ share: Double) -> Int { used[min(used.count - 1, Int((share * Double(used.count)).rounded(.down)))] }
        let cuts = [at(0.25), at(0.5), at(0.75)]
        return days.map { day in
            if day.tokens <= 0 { return 0 }
            if day.tokens <= cuts[0] { return 1 }
            if day.tokens <= cuts[1] { return 2 }
            if day.tokens <= cuts[2] { return 3 }
            return 4
        }
    }
}

/// Settings › Usage, as desktop's `HappyAgentUsageSettings` reads it: a
/// year of daily totals over everything, then each service's accounts, the
/// most used first, each with its last 30 days, its plan's windows and one
/// line per model it spent on.
///
/// Only what can be shown is shown. An account with no plan window, no
/// model tokens and no history is left out, a service with no such account
/// loses its section, and no failure is put into words.
public struct UsageOverview: Equatable, Sendable {
    public struct Activity: Equatable, Sendable {
        public var days: [UsageActivityDay]
        public var tokens: Int
        /// The first day known, when it falls inside the year.
        public var since: String?
    }

    public struct ModelLine: Equatable, Sendable {
        public var id: String
        public var day: Int
        public var week: Int
        public var month: Int
    }

    public struct Account: Equatable, Sendable {
        public var id: String
        public var name: String
        public var plan: String?
        /// The plan's windows, when it reports any.
        public var usage: AccountUsage?
        /// Its last 30 days, when it spent anything in them.
        public var strip: [UsageActivityDay]?
        public var models: [ModelLine]
        /// Everything its history spent, which orders it.
        public var tokens: Int
    }

    public struct Vendor: Equatable, Sendable {
        /// The service ("Claude"); nil for accounts the server doesn't configure.
        public var name: String?
        public var accounts: [Account]
    }

    public var activity: Activity?
    public var vendors: [Vendor]

    /// The days the history is asked for: a year and the week it starts in.
    public static let historyDays = 371
    static let yearDays = 364
    static let stripDays = 30

    public static func build(catalog: ModelCatalog?, usage: JSONValue?, history: DailyUsage?, today: String) -> UsageOverview {
        let readings = usage.map(AccountUsage.project) ?? [:]
        let windows: [String: [String: [String: TokenCounts]]] = Dictionary(uniqueKeysWithValues: ["day", "week", "month"].map { ($0, TokenCounts.byProvider(usage?[$0])) })

        var activity: Activity?
        if let history {
            let from = max(history.since, UsageDates.adding(-yearDays, to: today))
            let days = UsageActivityDay.days(history, from: from, through: today)
            let tokens = days.reduce(0) { $0 + $1.tokens }
            if tokens > 0 { activity = Activity(days: days, tokens: tokens, since: from == history.since ? history.since : nil) }
        }
        var historyTokens: [String: Int] = [:]
        for day in history?.days ?? [] {
            for (provider, models) in day.providers { historyTokens[provider, default: 0] += models.values.reduce(0) { $0 + $1.counted } }
        }

        // The configured accounts in the server's order, then any the
        // readings name that it doesn't.
        var order = catalog?.providers.map(\.id) ?? []
        for entry in usage?["providers"]?.arrayValue ?? [] {
            if let id = entry["providerId"]?.stringValue, !order.contains(id) { order.append(id) }
        }
        for window in ["day", "week", "month"] {
            for id in (windows[window] ?? [:]).keys.sorted() where !order.contains(id) { order.append(id) }
        }

        var accounts: [(service: String?, account: Account)] = []
        for id in order {
            let configured = catalog?.providers.first { $0.id == id }
            let reading = readings[id]
            let plan = reading.flatMap { $0.week != nil || $0.session != nil ? $0 : nil }
            var modelIds = configured?.models.map(\.id) ?? []
            for window in ["day", "week", "month"] {
                for model in (windows[window]?[id] ?? [:]).keys.sorted() where !modelIds.contains(model) { modelIds.append(model) }
            }
            let models = modelIds.map { model in
                ModelLine(id: model, day: windows["day"]?[id]?[model]?.total ?? 0, week: windows["week"]?[id]?[model]?.total ?? 0, month: windows["month"]?[id]?[model]?.total ?? 0)
            }
            .filter { $0.day + $0.week + $0.month > 0 }
            .sorted { $0.month != $1.month ? $0.month > $1.month : $0.id < $1.id }
            let tokens = historyTokens[id] ?? 0
            guard plan != nil || !models.isEmpty || tokens > 0 else { continue }
            var strip: [UsageActivityDay]?
            if let history {
                let days = UsageActivityDay.days(history, from: max(history.since, UsageDates.adding(-(stripDays - 1), to: today)), through: today, provider: id)
                if days.contains(where: { $0.tokens > 0 }) { strip = days }
            }
            let account = Account(
                id: id, name: configured?.name ?? accountName(id), plan: reading?.planName,
                usage: plan.map { reading in
                    // Failures and sign-in state are left unsaid here.
                    var reading = reading
                    reading.refreshError = nil
                    reading.signedOut = false
                    return reading
                },
                strip: strip, models: models, tokens: tokens
            )
            accounts.append((configured.map { ModelMenus.serviceName($0.type) }, account))
        }

        // Services and their accounts, the most used first; a tie keeps the
        // server's order.
        let ranked = accounts.enumerated().sorted { left, right in
            left.element.account.tokens != right.element.account.tokens ? left.element.account.tokens > right.element.account.tokens : left.offset < right.offset
        }.map(\.element)
        var vendors: [Vendor] = []
        for (service, account) in ranked {
            if let index = vendors.firstIndex(where: { $0.name == service }) { vendors[index].accounts.append(account) }
            else { vendors.append(Vendor(name: service, accounts: [account])) }
        }
        let total = { (vendor: Vendor) in vendor.accounts.reduce(0) { $0 + $1.tokens } }
        vendors = vendors.enumerated().sorted { left, right in
            total(left.element) != total(right.element) ? total(left.element) > total(right.element) : left.offset < right.offset
        }.map(\.element)
        return UsageOverview(activity: activity, vendors: vendors)
    }

    /// `providerAccountName`: a configured ID read as words.
    public static func accountName(_ id: String) -> String {
        let words = id.split(whereSeparator: { $0 == "_" || $0 == "-" }).map { $0.prefix(1).uppercased() + $0.dropFirst() }
        return words.isEmpty ? id : words.joined(separator: " ")
    }

    /// Tokens as desktop's compact numbers read them: 980, 162.3K, 5.7M,
    /// 134.7M, 1.4B; one decimal at most, none when it is zero.
    public static func compact(_ count: Int) -> String {
        let count = max(0, count)
        guard count >= 1000 else { return String(count) }
        let units: [(Double, String)] = [(1e3, "K"), (1e6, "M"), (1e9, "B"), (1e12, "T")]
        var index = units.lastIndex { Double(count) >= $0.0 } ?? 0
        var value = (Double(count) / units[index].0 * 10).rounded(.toNearestOrAwayFromZero) / 10
        if value >= 1000, index < units.count - 1 {
            index += 1
            value = (Double(count) / units[index].0 * 10).rounded(.toNearestOrAwayFromZero) / 10
        }
        let text = value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
        return text + units[index].1
    }
}

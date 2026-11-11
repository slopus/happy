import Foundation
import HappyWire

/// What this device tells a computer about the time zone, languages,
/// clock, week and calendar its person works in (happy-agent `API.md`,
/// "User environment"), so their agents can be told it. A field this
/// device can't name in the API's terms is left out, never guessed: one
/// bad field refuses the whole report.
public struct UserEnvironment: Equatable, Sendable {
    public enum DeviceKind: String, Sendable { case phone, tablet, desktop }

    public var deviceKind: DeviceKind?
    public var timeZone: String?
    /// Advisory: checked, never stored; agents are told offsets from `timeZone`.
    public var utcOffsetMinutes: Int?
    public var locale: String?
    public var languages: [String]
    public var hourCycle: String?
    /// 1 for Monday through 7 for Sunday.
    public var firstDayOfWeek: Int?
    public var calendar: String?

    public init(deviceKind: DeviceKind?, timeZone: String?, utcOffsetMinutes: Int?, locale: String?, languages: [String],
                hourCycle: String?, firstDayOfWeek: Int?, calendar: String?) {
        self.deviceKind = deviceKind
        self.timeZone = timeZone
        self.utcOffsetMinutes = utcOffsetMinutes
        self.locale = locale
        self.languages = languages
        self.hourCycle = hourCycle
        self.firstDayOfWeek = firstDayOfWeek
        self.calendar = calendar
    }

    /// This device now. `languages` is `Locale.preferredLanguages`,
    /// already BCP 47.
    public static func current(kind: DeviceKind?, timeZone: TimeZone = .autoupdatingCurrent, locale: Locale = .autoupdatingCurrent,
                               calendar: Calendar = .autoupdatingCurrent, languages: [String] = Locale.preferredLanguages, now: Date = Date()) -> UserEnvironment {
        let offset = timeZone.secondsFromGMT(for: now) / 60
        return UserEnvironment(
            deviceKind: kind,
            timeZone: name(timeZone.identifier),
            utcOffsetMinutes: (-720...840).contains(offset) ? offset : nil,
            locale: name(locale.identifier(.bcp47)),
            languages: Array(languages.compactMap(name).prefix(16)),
            hourCycle: hourCycle(locale.hourCycle),
            firstDayOfWeek: isoWeekday(calendar.firstWeekday),
            calendar: calendarName(calendar.identifier))
    }

    /// The report `PUT /v0/environment` takes from device `deviceId`.
    func report(deviceId: String) -> JSONValue {
        var object: [String: JSONValue] = ["deviceId": .string(deviceId)]
        if let deviceKind { object["deviceKind"] = .string(deviceKind.rawValue) }
        if let timeZone { object["timeZone"] = .string(timeZone) }
        if let utcOffsetMinutes { object["utcOffsetMinutes"] = .number(Double(utcOffsetMinutes)) }
        if let locale { object["locale"] = .string(locale) }
        if !languages.isEmpty { object["languages"] = .array(languages.map { .string($0) }) }
        if let hourCycle { object["hourCycle"] = .string(hourCycle) }
        if let firstDayOfWeek { object["firstDayOfWeek"] = .number(Double(firstDayOfWeek)) }
        if let calendar { object["calendar"] = .string(calendar) }
        return .object(object)
    }

    /// 1–64 characters, none of them a control character, as the API takes a name.
    static func name(_ value: String) -> String? {
        (1...64).contains(value.count) && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) } ? value : nil
    }

    static func hourCycle(_ cycle: Locale.HourCycle) -> String {
        switch cycle {
        case .zeroToEleven: "h11"
        case .oneToTwelve: "h12"
        case .zeroToTwentyThree: "h23"
        case .oneToTwentyFour: "h24"
        @unknown default: "h23"
        }
    }

    /// `Calendar.firstWeekday` (1 Sunday … 7 Saturday) in ISO numbering.
    static func isoWeekday(_ firstWeekday: Int) -> Int? {
        (1...7).contains(firstWeekday) ? (firstWeekday + 5) % 7 + 1 : nil
    }

    /// The BCP 47 name of a calendar the API takes; nil for one it doesn't.
    static func calendarName(_ identifier: Calendar.Identifier) -> String? {
        switch identifier {
        case .gregorian: "gregory"
        case .buddhist: "buddhist"
        case .chinese: "chinese"
        case .coptic: "coptic"
        case .ethiopicAmeteAlem: "ethioaa"
        case .ethiopicAmeteMihret: "ethiopic"
        case .hebrew: "hebrew"
        case .indian: "indian"
        case .islamic: "islamic"
        case .islamicCivil: "islamic-civil"
        case .islamicTabular: "islamic-tbla"
        case .islamicUmmAlQura: "islamic-umalqura"
        case .iso8601: "iso8601"
        case .japanese: "japanese"
        case .persian: "persian"
        case .republicOfChina: "roc"
        default: nil
        }
    }
}

/// One computer's side of this device's reports: whether it takes them,
/// and what it was last told. A daemon that doesn't refuses a send naming
/// a device, so `sendingDeviceId` is nil until it says it does: health's
/// `capabilities.userEnvironment`, or a report it took.
public final class UserEnvironmentReports: @unchecked Sendable {
    private let lock = NSLock()
    private var served: Bool?
    private var deviceId: String?
    private var reported: UserEnvironment?

    public init() {}

    /// What to name the sending device as on a send, once the computer takes it.
    public var sendingDeviceId: String? { lock.withLock { served == true ? deviceId : nil } }

    /// Whether the computer said it takes reports; nil before it said either way.
    var takesReports: Bool? { lock.withLock { served } }

    func serves(_ value: Bool, deviceId: String) {
        lock.withLock {
            served = value
            if value { self.deviceId = deviceId } else { reported = nil }
        }
    }

    func told(_ environment: UserEnvironment) -> Bool { lock.withLock { reported == environment } }
    func remember(_ environment: UserEnvironment) { lock.withLock { reported = environment } }
}

/// Where this device's environment is read from: its install's id and
/// what it is set to now. Both are read off the main actor, at each report.
public struct UserEnvironmentSource: Sendable {
    public var deviceId: @Sendable () -> String?
    public var current: @Sendable () -> UserEnvironment

    public init(deviceId: @escaping @Sendable () -> String?, current: @escaping @Sendable () -> UserEnvironment) {
        self.deviceId = deviceId
        self.current = current
    }
}

import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// The shared catalog (`docs/analytics-catalog.json`, byte-identical in the
/// desktop and Android apps) against the Swift one: every event whose
/// clients include `ios`, its properties, each property's values, whether
/// it may be null or left out, and the common properties.
final class AnalyticsCatalogContractTests: XCTestCase {
    private func catalog() throws -> JSONValue {
        var root = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath()
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("docs/analytics-catalog.json"))
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// A catalog property as the Swift schema would describe it.
    private func expected(_ spec: JSONValue, shared: [String: JSONValue]) throws -> AnalyticsSchema.Property {
        func words(_ value: JSONValue?) throws -> [String] {
            let list = value?.stringValue.flatMap { shared[$0] } ?? value
            return try XCTUnwrap(list?.arrayValue?.compactMap(\.stringValue), "\(spec)")
        }
        let kind: AnalyticsSchema.Property.Kind
        if let list = spec["enum[]"] {
            kind = .wordList(try words(list))
        } else if let list = spec["enum"] {
            kind = .words(try words(list))
        } else {
            switch spec["type"]?.stringValue {
            case "count": kind = .count
            case "bool": kind = .bool
            case "version": kind = .version
            case "os_version": kind = .osVersion
            case "model": kind = .model
            case "day": kind = .day
            default: throw XCTSkip("unknown property type \(spec)")
            }
        }
        return AnalyticsSchema.Property(kind: kind, nullable: spec["nullable"] == .bool(true), optional: spec["optional"] == .bool(true))
    }

    /// Word lists compare as sets; their order means nothing.
    private func normalized(_ property: AnalyticsSchema.Property) -> AnalyticsSchema.Property {
        var property = property
        switch property.kind {
        case .words(let words): property.kind = .words(words.sorted())
        case .wordList(let words): property.kind = .wordList(words.sorted())
        default: break
        }
        return property
    }

    private func forIOS(_ spec: JSONValue) -> Bool {
        guard let clients = spec["clients"]?.arrayValue else { return true }
        return clients.contains(.string("ios"))
    }

    func testEveryIOSEventAndPropertyMatchesTheSharedCatalog() throws {
        let catalog = try catalog()
        let shared = try XCTUnwrap(catalog["shared_enums"]?.objectValue)
        let events = try XCTUnwrap(catalog["events"]?.objectValue).filter { forIOS($0.value) }
        XCTAssertEqual(Set(AnalyticsSchema.events.keys), Set(events.keys), "the iOS events")
        for (name, spec) in events {
            let properties = try XCTUnwrap(spec["properties"]?.objectValue, name)
            let swift = try XCTUnwrap(AnalyticsSchema.events[name], name)
            XCTAssertEqual(Set(swift.keys), Set(properties.keys), "\(name)'s properties")
            for (property, propertySpec) in properties {
                guard let ours = swift[property] else { continue }
                XCTAssertEqual(normalized(ours), normalized(try expected(propertySpec, shared: shared)), "\(name).\(property)")
            }
        }
    }

    func testCommonPropertiesMatchTheSharedCatalog() throws {
        let catalog = try catalog()
        let shared = try XCTUnwrap(catalog["shared_enums"]?.objectValue)
        let common = try XCTUnwrap(catalog["common"]?.objectValue).filter { forIOS($0.value) }
        XCTAssertEqual(Set(AnalyticsSchema.common.keys), Set(common.keys))
        for (name, spec) in common {
            guard let ours = AnalyticsSchema.common[name] else { continue }
            XCTAssertEqual(normalized(ours), normalized(try expected(spec, shared: shared)), name)
        }
    }

    /// Each typed event makes properties the schema admits whole: the enums
    /// and the allowlist say the same thing.
    func testEveryTypedEventPassesTheAllowlistUnchanged() throws {
        let samples: [AnalyticsEvent] = [
            .chatFailureShown(kind: .usageLimit, providerKind: .claude, pool: false, target: .session, sessionClient: .happyAgent),
            .chatFailureAction(kind: .rateLimited, action: .switchModel),
            .connectionIssue(transport: .direct, code: .unreachable, outcome: .recovered, duration: .from10sTo30s),
            .errorShown(area: .messageSend, code: .offline, repeatCount: 2),
            .appCrash(process: .app, reason: .hang, crashedVersion: "2.0.0"),
            .pairingResult(method: .direct, start: .scan, result: .failed, errorCode: .emojiMismatch),
            .signInResult(method: .teamServer, result: .ok, errorCode: nil),
            .voiceSessionEnded(result: .ok, errorCode: nil, duration: .from2mTo5m),
            .purchaseResult(product: .pro, result: .cancelled, errorCode: nil),
            .appOpened(launchCount: 3, cold: true),
            .messageSent(.init(source: .chat, target: .bot, sessionClient: .happyAgent, model: "anthropic/claude-opus-4-5",
                               modelProviderKind: .claude, effort: .high, botSystemKey: .chiefOfStaff, taskDepth: 1, hasAttachment: true)),
            .dailySummary(.init(day: 20_397, counts: [.conversationsOpened: 4], config: .init(theme: .dark, providerKinds: [.codex, .claude]))),
            .onboardingStepViewed(step: .pair),
            .onboardingCompleted,
            .pairingOptionsShown(defaultMethod: .relay, surface: .connectAgent),
            .pairingOptionSelected(from: .relay, to: .direct, surface: .connectAgent),
        ]
        XCTAssertEqual(Set(samples.map(\.name)), Set(AnalyticsSchema.events.keys), "one sample per event")
        let common: [String: JSONValue] = [
            "client": .string("ios"), "app_version": .string("2.0.0"), "channel": .string("preview"), "os": .string("ios"),
            "os_version": .string("26.1"), "device_class": .string("phone"), "agent_location": .string("remote"),
            "agent_os": .string("mac"), "happy_agent_version": .string("1.4.2"),
        ]
        for event in samples {
            let admitted = try XCTUnwrap(AnalyticsSchema.admit(event.name, event.properties, common: common), event.name)
            XCTAssertEqual(admitted, common.merging(event.properties) { _, own in own }, event.name)
        }
    }
}

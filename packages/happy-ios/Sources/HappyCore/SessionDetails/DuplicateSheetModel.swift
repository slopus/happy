import Foundation
import HappyStore

/// components/DuplicateSheet.tsx without the drawing: the provider's rewind
/// points (Claude's JSONL turns, Codex's thread items), newest first, and
/// the fork that keeps everything up to the chosen one.
public enum DuplicateSheetModel {
    public struct Point: Equatable, Sendable {
        /// Claude uuid or Codex item id.
        public var id: String
        public var text: String
        /// Milliseconds.
        public var timestamp: Double

        public init(id: String, text: String, timestamp: Double) {
            self.id = id
            self.text = text
            self.timestamp = timestamp
        }
    }

    public enum Points: Equatable, Sendable {
        case loaded([Point])
        /// The provider's own words, or the missing-metadata message.
        case failed(String)
    }

    /// Lists the session's rewind points over its machine, newest first.
    public static func loadPoints(_ session: SessionRecord, machines: MachineActions, missingMetadata: String) async -> Points {
        switch SessionDetails.forkSource(session) {
        case nil:
            return .failed(missingMetadata)
        case .claude(_, let options)?:
            switch await machines.claudeListRewindPoints(options: options) {
            case .success(let points):
                return .loaded(points.reversed().map { Point(id: $0.uuid, text: $0.text, timestamp: $0.timestamp) })
            case .error(let message):
                return .failed(message)
            }
        case .codex(_, let options)?:
            switch await machines.codexListRewindPoints(options: options) {
            case .success(let points):
                return .loaded(points.reversed().map { Point(id: $0.itemId, text: $0.text, timestamp: $0.timestamp) })
            case .error(let message):
                return .failed(message)
            }
        }
    }

    /// Forks the session and cuts it after `point`; the new session's id.
    public static func duplicate(
        _ session: SessionRecord,
        after point: Point,
        machines: MachineActions,
        messages: SessionDetailActions.ForkMessages
    ) async throws -> String {
        guard let source = SessionDetails.forkSource(session) else {
            throw SessionDetailActions.Failure(messages.missingMetadata)
        }
        let options: ForkOptions
        switch source {
        case .claude: options = ForkOptions(cutAfterUuid: point.id)
        case .codex: options = ForkOptions(cutAfterItemId: point.id)
        }
        switch await machines.forkAndSpawn(source: source, options: options) {
        case .success(let sessionId):
            return sessionId
        case .error(let message):
            throw SessionDetailActions.Failure(message)
        default:
            throw SessionDetailActions.Failure(messages.generic)
        }
    }

    /// A row's text: whitespace collapsed, cut at 140 UTF-16 units with `…`.
    public static func preview(_ text: String) -> String {
        let collapsed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        let units = Array(collapsed.utf16)
        guard units.count > 140 else { return collapsed }
        return String(decoding: units.prefix(140), as: UTF16.self) + "…"
    }

    /// DuplicateSheet.tsx `formatRelativeTime`.
    public enum Age: Equatable, Sendable {
        case justNow
        case minutes(Int)
        case hours(Int)
        case days(Int)
    }

    public static func age(of timestamp: Double, now: Double) -> Age {
        let minutes = Int(((now - timestamp) / 60_000).rounded(.down))
        if minutes < 1 { return .justNow }
        if minutes < 60 { return .minutes(minutes) }
        let hours = minutes / 60
        if hours < 24 { return .hours(hours) }
        return .days(hours / 24)
    }
}

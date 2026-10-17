import Foundation

extension Strings {
    /// Native Details recovery and the report copied explicitly from its
    /// header. These controls do not yet have a happy-app equivalent.
    enum SessionInfoLoading {
        static let failed = "Unable to load session details"
        static let delayed = "Session details are taking longer than expected"
        static let copyDiagnostics = "Copy diagnostics"
        static var actions: String { localized("session.actionsTitle", "Session") }
        static var retry: String { localized("common.retry", "Retry") }
    }
}
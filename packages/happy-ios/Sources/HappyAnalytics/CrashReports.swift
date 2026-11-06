#if canImport(MetricKit) && os(iOS)
import Foundation
import MetricKit

/// `app_crashed` from MetricKit: the crashes and hangs iOS reports for this
/// app, delivered at a later launch. Of each, only the exception type and
/// signal (mapped to the catalog's reason) and the build that crashed are
/// read: never its call stack, termination text or memory regions, and
/// nothing is written down.
final class CrashReports: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let shared = CrashReports()

    func install() {
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let thisBuild = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        let thisVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        // MetricKit names the build that crashed; the version is known only when it is this one.
        func version(_ diagnostic: MXDiagnostic) -> String? {
            diagnostic.metaData.applicationBuildVersion == thisBuild ? thisVersion : nil
        }
        var events: [AnalyticsEvent] = []
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                let reason = AnalyticsEvent.CrashReason(exceptionType: crash.exceptionType?.intValue, signal: crash.signal?.intValue)
                events.append(.appCrashed(process: .app, reason: reason, crashedVersion: version(crash)))
            }
            for hang in payload.hangDiagnostics ?? [] {
                events.append(.appCrashed(process: .app, reason: .hang, crashedVersion: version(hang)))
            }
        }
        guard !events.isEmpty else { return }
        Task { @MainActor in
            for event in events { Analytics.shared.log(event) }
        }
    }
}

extension Analytics {
    /// MetricKit's crash and hang reports, from launch.
    public func reportCrashes() {
        CrashReports.shared.install()
    }
}
#endif

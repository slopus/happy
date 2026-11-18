#if canImport(MetricKit) && os(iOS)
import Foundation
import MetricKit

/// `app_crashed` from MetricKit: the crashes and hangs iOS reports for this
/// app, delivered at a later launch. Of each, the exception type and signal
/// (mapped to the catalog's reason) and the build that crashed are read; of
/// a crash, also its `CrashSignature` (the exception's numbers and class,
/// the crashed thread's top frames as binary and offset, the app binary's
/// UUID). Never its termination text, an exception's message, addresses or
/// memory regions, and nothing is written down.
final class CrashReports: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let shared = CrashReports()

    func install() {
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let thisBuild = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        let thisVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let mainBinary = Bundle.main.executableURL?.lastPathComponent
        // MetricKit names the build that crashed; the version is known only when it is this one.
        func version(_ diagnostic: MXDiagnostic) -> String? {
            diagnostic.metaData.applicationBuildVersion == thisBuild ? thisVersion : nil
        }
        var events: [AnalyticsEvent] = []
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                let reason = AnalyticsEvent.CrashReason(exceptionType: crash.exceptionType?.intValue, signal: crash.signal?.intValue)
                let signature = CrashSignature(exceptionType: crash.exceptionType?.intValue, exceptionCode: crash.exceptionCode?.intValue,
                                               signal: crash.signal?.intValue, exceptionClass: crash.exceptionReason?.className,
                                               callStacks: crash.callStackTree.jsonRepresentation(), mainBinary: mainBinary)
                events.append(.appCrashed(process: .app, reason: reason, crashedVersion: version(crash), signature: signature))
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

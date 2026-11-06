import Foundation
import HappyCore

// The app's screens' events, each a plain call with the app's own types:
// no analytics type appears where they are called, so deleting this target
// leaves those lines alone to delete (docs/product-analytics.md).

extension Analytics {
    // MARK: Settings

    /// This phone's own switch, as Settings shows it.
    public var deviceOptOut: Bool { consent.deviceOptOut }

    /// Settings' switch; off deletes what was waiting.
    public func setDeviceOptOut(_ optedOut: Bool) {
        consent.setDeviceOptOut(optedOut)
    }

    // MARK: Errors shown

    /// A diff that couldn't load.
    public func diffLoadFailed(_ error: Error) {
        if let code = AnalyticsEvent.ErrorCode(error) { errorShown(.diffLoad, code) }
    }

    /// An artifact, or a file in a vault (`isFile`), that couldn't load; a
    /// nil `error` is one that is gone.
    public func artifactLoadFailed(_ error: Error?, isFile: Bool) {
        let code: AnalyticsEvent.ErrorCode? = if let error { .init(error) } else { .notFound }
        if let code { errorShown(isFile ? .fileLoad : .artifactLoad, code) }
    }

    /// A file in a conversation that couldn't be opened.
    public func fileLoadFailed() {
        errorShown(.fileLoad, .unknown)
    }

    /// Notifications that couldn't be set up.
    public func pushSetupFailed(_ error: Error) {
        if let code = AnalyticsEvent.ErrorCode(error) { errorShown(.pushSetup, code) }
    }

    /// A browser page that failed, by its kind alone.
    public func browserLoadFailed(_ problem: BrowserProblem) {
        errorShown(.browserLoad, .init(problem))
    }

    // MARK: Signing in

    /// A restore that failed: by QR code, or by the secret key typed in
    /// (`secretKey`), which a refusal means was wrong.
    public func accountRestoreFailed(_ error: Error, secretKey: Bool) {
        log(.signInFailed(method: .relayRestore, errorCode: error is URLError ? .unreachable : secretKey ? .invalidToken : .unknown))
    }

    public func teamServerSignedIn() {
        log(.teamServerSignedIn)
    }

    public func teamServerSignInFailed(_ error: Error) {
        log(.signInFailed(method: .teamServer, errorCode: .init(error)))
    }

    // MARK: Paying

    /// A sheet or page that offers the subscription, each time it opens.
    public func paywallPresented() {
        log(.paywallPresented(product: .pro))
    }

    public func purchaseEnded(_ result: Subscription.PurchaseResult) {
        log(result.event)
    }

    public func restoreEnded(_ result: Subscription.RestoreResult) {
        log(result.event)
    }

    // MARK: Links

    /// A Happy account's relay link, as its headers read it: down while
    /// the socket is, or while there is no network (`network`).
    public func relayLinkChanged(_ session: AccountSession, down: Bool, network: Bool) {
        ConnectionWatch.shared.report(.init(id: Self.watchID(session), transport: .relay, down: down, code: !network ? .unreachable : .unknown))
    }

    /// The link `agent_connection_lost` follows for a Happy account; kept
    /// here only, never sent.
    static func watchID(_ session: AccountSession) -> String { "relay:\(session.keys.anonID)" }
}

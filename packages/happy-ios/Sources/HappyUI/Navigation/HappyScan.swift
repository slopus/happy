#if canImport(UIKit)
import HappyCore
import HappyWire
import OSLog
import UIKit

/// Every scan in the app: the camera reads any code, and whatever it read
/// goes where `ScanRoute` sends it. A code that can't be used says why; none
/// is ignored.
@MainActor
enum HappyScan {
    enum Result: Equatable {
        /// A computer now has the account in use.
        case computerConnected
        /// Another device now has the account in use.
        case deviceLinked
        /// A new account was made, added and handed to the computer.
        case accountAdded
        /// The direct pairing screen opened.
        case pairing
        /// Left, failed or refused; whatever needed saying was said.
        case ended
    }

    static let log = Logger(subsystem: "engineering.happy", category: "scan")

    /// The camera; the first code it reads, nil when closed.
    static func read(from controller: UIViewController, otherWays: [ScannerWay] = []) async -> String? {
        await withCheckedContinuation { continuation in
            let scanner = QRScannerViewController()
            scanner.otherWays = otherWays
            scanner.onFinish = { continuation.resume(returning: $0) }
            controller.present(scanner, animated: true)
        }
    }

    /// Reads a code and opens it. `busy` brackets the network work.
    @discardableResult
    static func scan(
        intent: ScanIntent,
        context: AppContext,
        on controller: UIViewController,
        otherWays: [ScannerWay] = [],
        busy: (Bool) -> Void = { _ in }
    ) async -> Result {
        guard let text = await read(from: controller, otherWays: otherWays) else {
            log.debug("scanner closed without a code")
            return .ended
        }
        return await open(text, intent: intent, context: context, on: controller, start: .scan, busy: busy)
    }

    @discardableResult
    static func open(
        _ text: String,
        intent: ScanIntent,
        context: AppContext,
        on controller: UIViewController,
        start: PairingStart,
        busy: (Bool) -> Void = { _ in }
    ) async -> Result {
        let route = ScanRoute.route(HappyCode(text), intent: intent, hasAccount: context.account.session != nil)
        log.debug("code \(describe(text), privacy: .public) → \(String(describing: route).prefix(40), privacy: .public)")
        switch route {
        case .connectAgent:
            PairingFlow.openIfAgentPairing(text, context: context, on: controller, start: start)
            return .pairing
        case .connectComputer(let key):
            guard let session = context.account.session else { return .ended }
            return await approve(.terminal(publicKey: key), session: session, start: start, on: controller, busy: busy)
        case .linkDevice(let key):
            guard let session = context.account.session else { return .ended }
            return await approve(.account(publicKey: key), session: session, start: start, on: controller, busy: busy)
        case .newAccountForComputer(let key):
            return await newAccount(for: key, context: context, start: start, on: controller, busy: busy)
        case .problem(let problem):
            PairingAnalytics.shared.log(.failed(method: problem.isAgentConnection ? .agentConnection : .relay, start: start))
            report(problem, on: controller)
            return .ended
        }
    }

    private static func approve(
        _ link: LegacyPairingLink,
        session: AccountSession,
        start: PairingStart,
        on controller: UIViewController,
        busy: (Bool) -> Void
    ) async -> Result {
        let kind: LegacyPairingFlow.Kind = if case .account = link { .account } else { .terminal }
        busy(true)
        let outcome = await LegacyPairingFlow.approve(link, session: session)
        busy(false)
        log.debug("approval \(String(describing: outcome), privacy: .public)")
        PairingAnalytics.shared.log(outcome == .approved ? .completed(method: .relay, start: start) : .failed(method: .relay, start: start))
        LegacyPairingFlow.report(outcome, kind: kind, on: controller)
        guard outcome == .approved else { return .ended }
        // happy-app lets the computer turning up say it; from a settings
        // page nothing turns up, and a scan that seems to do nothing reads
        // as broken.
        if kind == .terminal { Alerts.show(Strings.Common.success, Strings.Modals.terminalConnectedSuccessfully, on: controller) }
        return kind == .account ? .deviceLinked : .computerConnected
    }

    /// A new account for the computer, made without asking, as happy-app's
    /// first run makes one (`AccountController.addAccount`): kept and made
    /// active only once the computer has it, so the window's screens become
    /// its home then; a used code or a failure keeps nothing and says so.
    private static func newAccount(
        for key: Data,
        context: AppContext,
        start: PairingStart,
        on controller: UIViewController,
        busy: (Bool) -> Void
    ) async -> Result {
        // The window outlives the screens signIn replaces.
        let window = controller.view.window
        busy(true)
        let outcome: LegacyPairingFlow.Outcome
        do {
            outcome = try await context.account.addAccount(approvingTerminal: key) == .alreadyHandled ? .alreadyHandled : .approved
        } catch LegacyPairingError.terminalNeedsUpdate {
            outcome = .terminalNeedsUpdate
        } catch {
            log.error("adding an account for a computer failed: \(String(describing: type(of: error)), privacy: .public)")
            outcome = .failed
        }
        busy(false)
        PairingAnalytics.shared.log(outcome == .approved ? .completed(method: .relay, start: start) : .failed(method: .relay, start: start))
        guard outcome == .approved else {
            LegacyPairingFlow.report(outcome, kind: .terminal, on: window.flatMap(topmost) ?? controller)
            return .ended
        }
        return .accountAdded
    }

    private static func report(_ problem: ScanProblem, on controller: UIViewController) {
        switch problem {
        case .notHappy:
            Alerts.show(Strings.Scan.notHappyTitle, Strings.Scan.notHappy, on: controller)
        case .invalidTerminal, .invalidAccount:
            Alerts.show(Strings.Common.error, Strings.Modals.invalidAuthUrl, on: controller)
        case .agentConnection(let error):
            Alerts.show("Could not pair", error.localizedDescription, on: controller)
        case .deviceNeedsAccount:
            Alerts.show(Strings.Scan.deviceNeedsAccountTitle, Strings.Scan.deviceNeedsAccount, on: controller)
        }
    }

    /// The screen an alert shows over: the topmost presented, not one
    /// going away.
    static func topmost(in window: UIWindow) -> UIViewController? {
        guard var top = window.rootViewController else { return nil }
        while let next = top.presentedViewController, !next.isBeingDismissed, !(next is UIAlertController) { top = next }
        return top
    }

    /// The scheme and host only: a direct code carries a pairing token.
    private static func describe(_ text: String) -> String {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let head = text.firstIndex(of: "?").map { String(text[..<$0]) } ?? String(text.prefix(24))
        return "\(head) (\(text.utf8.count) bytes)"
    }
}

private extension ScanProblem {
    var isAgentConnection: Bool {
        if case .agentConnection = self { return true }
        return false
    }
}
#endif

import Foundation

/// Serializes publication of account-localized screens, not account switches.
/// The caller captures the current language on main, supplies background
/// resolution/loading, and applies the winning result synchronously on main.
@MainActor
public final class AccountLocalizationGate<Catalog: Sendable> {
    public enum Decision: Sendable {
        /// The caller still installs a new root when the account changed.
        case unchanged
        /// Nil selects the screens' built-in English.
        case replace(Catalog?)
    }

    public private(set) var isPending = false
    public var onPendingChange: ((Bool) -> Void)?

    private var generation: UInt64 = 0
    private var work: Task<Void, Never>?
    private var apply: (@MainActor (Result<Decision, any Error>) -> Void)?

    public init() {}

    /// Holds interaction before starting work. Superseding a request keeps
    /// the hold continuously; its obsolete completion cannot release it.
    public func update(
        currentLanguage: String,
        resolve: @escaping @Sendable () async throws -> String,
        load: @escaping @Sendable (String) async throws -> Catalog?,
        apply: @escaping @MainActor (Result<Decision, any Error>) -> Void
    ) {
        generation += 1
        let token = generation
        work?.cancel()
        work = nil
        self.apply = apply
        setPending(true)
        // An interaction callback may itself request another root.
        guard generation == token, isPending else { return }
        work = Task { [weak self] in
            let result: Result<Decision, any Error>
            do {
                result = .success(try await Self.prepare(
                    currentLanguage: currentLanguage, resolve: resolve, load: load))
            } catch {
                result = .failure(error)
            }
            guard let self, self.generation == token, self.isPending,
                  !Task.isCancelled else { return }
            let apply = self.apply
            self.apply = nil
            apply?(result)
            // Applying can synchronously request a newer root.
            self.finish(token)
        }
    }

    /// Applies cancellation while the current root is still held, allowing
    /// the caller to install a valid fallback before interaction resumes.
    /// Resolution that ignores cancellation cannot later publish a result.
    public func cancel() {
        guard isPending else { return }
        let token = generation
        work?.cancel()
        let apply = self.apply
        self.apply = nil
        apply?(.failure(CancellationError()))
        finish(token)
    }

    private func finish(_ token: UInt64) {
        guard generation == token, isPending else { return }
        work = nil
        apply = nil
        setPending(false)
    }

    private func setPending(_ pending: Bool) {
        guard isPending != pending else { return }
        isPending = pending
        onPendingChange?(pending)
    }

    private nonisolated static func prepare(
        currentLanguage: String,
        resolve: @escaping @Sendable () async throws -> String,
        load: @escaping @Sendable (String) async throws -> Catalog?
    ) async throws -> Decision {
        let worker = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            let language = try await resolve()
            try Task.checkCancellation()
            if language == currentLanguage { return Decision.unchanged }
            if language == "en" { return Decision.replace(nil) }
            let catalog = try await load(language)
            try Task.checkCancellation()
            return Decision.replace(catalog)
        }
        return try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: {
            worker.cancel()
        }
    }

    /// Waits through reentrant replacements; production never needs to wait
    /// for locale work on the main thread.
    func waitForIdle() async {
        while let work { await work.value }
    }

    /// Tests can await a superseded request after deliberately late IO.
    var pendingWork: Task<Void, Never>? { work }
}
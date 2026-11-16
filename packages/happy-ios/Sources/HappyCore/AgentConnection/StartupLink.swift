import Foundation

/// The open agent connection's tunnel, asked for as the app launches
/// (`application(_:didFinishLaunchingWithOptions:)`) rather than once the
/// scene, its window, the account's restore and home's engine are there,
/// as Android's `StartupLink`. Connecting needs only which connection
/// opens, its credentials and the relay map; the bearer isn't sent until
/// the engine's first request. The open account's engine takes the
/// transport (`take`, through `AgentConnections.syncEngine(for:)`), so the
/// connection keeps one transport and one main client. Until then
/// `AgentConnections` lets it go (`keep`) when another account opens, this
/// one is removed or signed out, or the app leaves the foreground. An
/// engine that asked before it was read makes its own, and this one is let
/// go. Whatever fails here leaves the engine to connect as before.
public final class StartupLink: @unchecked Sendable {
    private struct Started {
        let id: String
        let credentials: AgentConnectionCredentials
        let transport: any AgentTransport
    }

    private let lock = NSLock()
    private let make: @Sendable (AgentConnectionCredentials) -> any AgentTransport
    private var started: Started?
    /// Taken or let go: nothing is kept or handed out after.
    private var settled = false
    /// Set once `keep` was told: the one connection whose engine may take it.
    private var keeping: String??
    /// Asked for while `start` was still reading: those engines made their own.
    private var missed: [AgentConnectionCredentials] = []

    public init(make: @escaping @Sendable (AgentConnectionCredentials) -> any AgentTransport = { AgentHTTPTransport(address: $0.address, port: $0.port, publicUrl: $0.publicUrl, tailcatAvailable: $0.tailcatAvailable != false) }) {
        self.make = make
    }

    /// Connects the connection that opens: `read` names it and its
    /// credentials, off the main thread; then its main client connects
    /// (`warm` of no flows).
    @discardableResult
    public func start(_ read: @escaping @Sendable () -> (id: String, credentials: AgentConnectionCredentials)?) -> Task<Void, Never> {
        Task.detached(priority: .userInitiated) { [self] in
            guard let opened = read() else { return }
            let transport = make(opened.credentials)
            let kept = lock.withLock {
                let allowed = keeping.map { $0 == opened.id } ?? true
                guard !settled, allowed, !missed.contains(opened.credentials) else { return false }
                started = Started(id: opened.id, credentials: opened.credentials, transport: transport)
                return true
            }
            guard kept else { await transport.close(); return }
            // A failed connect leaves its slot empty: the engine's first request connects again.
            await transport.warm(0)
        }
    }

    /// `start` over the stores `AgentConnections` keeps: the registry in
    /// `directory` and the Keychain's credentials. A pairing only, opened
    /// and not revoked; nothing without a registry, as `load` would read it.
    @discardableResult
    public func start(directory: URL?, credentials store: any AgentConnectionCredentialStore) -> Task<Void, Never> {
        start {
            guard let open = AgentConnectionStorage.open(directory: directory),
                  let credentials = try? store.all()[open], credentials.signIn == nil else { return nil }
            return (open, credentials)
        }
    }

    /// The transport `start` made for `credentials`, once: what the open
    /// engine's link is made of. Nil for any other credentials, while it is
    /// still reading (that engine makes its own), or once let go. Other
    /// credentials (the open one's changed since) let it go.
    public func take(_ credentials: AgentConnectionCredentials) -> (any AgentTransport)? {
        let (taken, dropped): ((any AgentTransport)?, (any AgentTransport)?) = lock.withLock {
            guard !settled else { return (nil, nil) }
            guard let held = started else {
                missed.append(credentials)
                return (nil, nil)
            }
            settled = true
            started = nil
            return held.credentials == credentials ? (held.transport, nil) : (nil, held.transport)
        }
        if let dropped { Task { await dropped.close() } }
        return taken
    }

    /// Only `id`'s engine may take it now; for any other, or none, it is
    /// let go. Once taken, the engine's to close.
    public func keep(_ id: String?) {
        let dropped: (any AgentTransport)? = lock.withLock {
            guard !settled else { return nil }
            keeping = .some(id)
            guard let held = started, held.id != id else { return nil }
            settled = true
            started = nil
            return held.transport
        }
        if let dropped { Task { await dropped.close() } }
    }
}

extension AgentConnectionStorage {
    /// The connection the registry in `directory` opens, read as `load`
    /// reads it, before any storage is made: nil without a registry, with
    /// none open, or with the open one revoked.
    nonisolated static func open(directory: URL?) -> String? {
        guard let file = directory?.appendingPathComponent(fileName),
              let data = try? Data(contentsOf: file),
              let registry = try? JSONDecoder().decode(Registry.self, from: data),
              let id = registry.activeID,
              let account = registry.accounts.first(where: { $0.id == id }), !account.revoked else { return nil }
        return id
    }
}

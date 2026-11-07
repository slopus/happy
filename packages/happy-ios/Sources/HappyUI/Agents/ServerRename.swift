#if canImport(UIKit)
import HappyCore
import UIKit

/// "Edit name" on a Happy Cloud server renames the server itself
/// (`PATCH /v0/config` `node.name`, `AgentConnections.rename`): its name
/// is the server's, not its Chief of Staff's to change. Only a member
/// who may manage its settings is offered it (`config.manage`).
@MainActor
enum ServerRename {
    /// Whether "Edit name" on `session` renames the server.
    static func renames(_ session: Session) -> Bool { session.isCloud }

    /// Whether "Edit name" is offered on `session` at all.
    static func offered(_ session: Session) -> Bool {
        !renames(session) || session.gate.allows(.configManage)
    }

    /// A prompt with the server's name in it; the new one is saved, or the
    /// server's refusal said.
    static func ask(_ id: String, context: AppContext, on controller: UIViewController) {
        typealias S = Strings.ServerName
        let connections = context.account.agentConnections
        guard let current = connections.accounts.first(where: { $0.id == id })?.name else { return }
        Task { @MainActor [weak controller] in
            guard let controller, let typed = await DetailAlerts.prompt(S.title, S.message, defaultValue: current, placeholder: current, confirmTitle: S.save, on: controller) else { return }
            let name = typed.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name != current else { return }
            do {
                try await connections.rename(id, to: name)
                Haptics.play(.renamed)
            } catch {
                let message = Store.describe(error)
                Alerts.show(S.couldNotSave, message.isEmpty ? error.localizedDescription : message, on: controller)
            }
        }
    }
}
#endif

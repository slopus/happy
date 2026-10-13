#if canImport(UIKit)
import HappyCore
import UIKit

// The session info, machine and changes screens reach the account's machine
// operations and git status through these, which are the account session's
// own: one `GitStatusSync` per account, the one the realtime route
// invalidates.

extension AccountSession {
    var detailMachineActions: MachineActions { machineActions }

    var detailActions: SessionDetailActions {
        SessionDetailActions(sessions: actions, machines: machineActions, store: store, sync: sync, metadataTransport: realtime)
    }

    var detailGitStatus: GitStatusSync { gitStatus }
}
#endif
